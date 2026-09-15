/**
 * Exercises Relay's Jira side against a throwaway database and a fake network:
 * no Jira site and no Slack involved. Run with `npm run smoke:jira`.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JiraUser } from "../src/jira/client.js";
import type { SlackPerson } from "../src/jira/members.js";

// Importing the sync module constructs the Slack app, whose auth check against
// these fake tokens rejects in the background. That's expected here.
process.on("unhandledRejection", () => {});

// Must be set before ./src/config.ts is imported, since it reads them on load.
const scratch = mkdtempSync(join(tmpdir(), "relay-jira-"));
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.DB_PATH = join(scratch, "jira.db");
process.env.LOG_LEVEL = "error";
process.env.JIRA_URL = "https://example.atlassian.net/";
process.env.JIRA_EMAIL = "relay@example.com";
process.env.JIRA_API_TOKEN = "token-123";

const { config, jiraSettingsProblem, validateConfig } = await import("../src/config.js");
const { db, migrate, SCHEMA_VERSION } = await import("../src/db.js");
const store = await import("../src/store.js");
const routes = await import("../src/routes.js");
const jira = await import("../src/jira/client.js");
const buckets = await import("../src/jira/buckets.js");
const members = await import("../src/jira/members.js");

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

console.log("\nconfig");
check("a trailing slash is dropped from JIRA_URL", config.jira.url, "https://example.atlassian.net");
check("complete settings pass", jiraSettingsProblem(config.jira), null);
check("no settings at all is fine — Jira stays off", jiraSettingsProblem({ url: "", email: "", apiToken: "" }), null);
check(
  "a partial setup is refused",
  typeof jiraSettingsProblem({ url: "https://x.atlassian.net", email: "", apiToken: "t" }),
  "string",
);
check(
  "a URL with a path is refused",
  typeof jiraSettingsProblem({ url: "https://x.atlassian.net/jira", email: "a@b.c", apiToken: "t" }),
  "string",
);
check(
  "plain http is refused",
  typeof jiraSettingsProblem({ url: "http://x.atlassian.net", email: "a@b.c", apiToken: "t" }),
  "string",
);
validateConfig();
check("the whole config validates", true, true);
check("the poll interval defaults to 3 minutes", config.jira.pollMinutes, 3);

console.log("\nschema");
const columnsOf = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

check("tasks can carry a Jira issue", columnsOf("tasks").includes("jira_issue_id"), true);
check(
  "pairings can carry a board and a sprint channel",
  ["jira_board_id", "jira_board_name", "jira_project_key", "sprint_channel"].every((column) =>
    columnsOf("routes").includes(column),
  ),
  true,
);
check("sessions can point at a subtask", columnsOf("work_sessions").includes("subtask_id"), true);
migrate();
check(
  "migrating an up-to-date database changes nothing",
  columnsOf("tasks").filter((column) => column === "jira_issue_id").length,
  1,
);

const snapshot = `${process.env.DB_PATH}.before-v${SCHEMA_VERSION}`;
check("a brand-new database isn't copied", existsSync(snapshot), false);
check("it's stamped with the current schema version", db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

// An older ledger, like production's before this deploy.
db.pragma("user_version = 1");
migrate();
check("an older ledger is copied before its schema is upgraded", existsSync(snapshot), true);
const { default: Database } = await import("better-sqlite3");
const copy = new Database(snapshot, { readonly: true });
check(
  "the copy is a readable database with the ledger in it",
  Boolean(copy.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get()),
  true,
);
copy.close();
check("the version is bumped after upgrading", db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
db.pragma("user_version = 1");
migrate();
check("a repeated upgrade keeps the first copy instead of failing", db.pragma("user_version", { simple: true }), SCHEMA_VERSION);

const base = {
  kind: "feature" as const,
  title: "Checkout redesign",
  body: "from Jira",
  client_channel: "C_SPRINT",
  client_user: "U_RELAY",
  client_permalink: null,
  internal_channel: "C_TEAM",
};
const story = store.createTask({ ...base, client_ts: "1.1", internal_ts: "2.1" });
db.prepare(`UPDATE tasks SET source = 'jira', jira_issue_id = '20001', jira_key = 'ACME-323' WHERE id = ?`).run(
  story.id,
);
const request = store.createTask({ ...base, client_ts: "1.2", internal_ts: "2.2" });

let duplicateIssue = false;
try {
  db.prepare(`UPDATE tasks SET jira_issue_id = '20001' WHERE id = ?`).run(request.id);
} catch {
  duplicateIssue = true;
}
check("a Jira issue can only become one task", duplicateIssue, true);
check(
  "ordinary requests default to the slack source",
  (db.prepare(`SELECT source FROM tasks WHERE id = ?`).get(request.id) as { source: string }).source,
  "slack",
);

const logWork = db.prepare(
  `INSERT INTO work_logs (task_id, subtask_id, engineer, exact_seconds, slab_seconds, closed_at)
   VALUES (?, NULL, 'U_ENG', 1500, 3600, '2026-09-14T00:00:00Z')`,
);
logWork.run(request.id);
let secondLog = false;
try {
  logWork.run(request.id);
} catch {
  secondLog = true;
}
check("one stored slab per engineer for an ad-hoc task", secondLog, true);

console.log("\ncolumn groups");
const scrumColumns = [
  { name: "To Do", statusIds: ["10000"] },
  { name: "Blocked", statusIds: ["10001"] },
  { name: "In Progress", statusIds: ["10002"] },
  { name: "In Review", statusIds: ["10003"] },
  { name: "Done", statusIds: ["10004"] },
];
check(
  "ACME's columns map one to one",
  scrumColumns.map((column) => buckets.guessBucket(column.name)),
  ["todo", "blocked", "in_progress", "in_review", "done"],
);
check("QA counts as review", buckets.guessBucket("Ready for QA"), "in_review");
check("on hold counts as blocked", buckets.guessBucket("On hold"), "blocked");
check("doing counts as in progress", buckets.guessBucket("Doing"), "in_progress");
check("an unknown column starts as to do", buckets.guessBucket("Backlog"), "todo");

check("seeding guesses every status", buckets.seedBuckets(1, scrumColumns), 5);
buckets.saveBuckets(
  1,
  scrumColumns.map((column) => ({
    column,
    bucket: column.name === "Blocked" ? ("in_progress" as const) : buckets.guessBucket(column.name),
  })),
  "U_ADMIN",
);
check("an admin's choice is saved", buckets.bucketForStatus(1, "10001"), "in_progress");
buckets.seedBuckets(1, scrumColumns);
check("re-seeding keeps the admin's choice", buckets.bucketForStatus(1, "10001"), "in_progress");
check(
  "the form shows the saved choice, not the guess",
  buckets.savedBucketForColumn(1, scrumColumns[1]!),
  "in_progress",
);
check("a new column is guessed", buckets.seedBuckets(1, [...scrumColumns, { name: "QA", statusIds: ["10005"] }]), 1);
check("and lands in review", buckets.bucketForStatus(1, "10005"), "in_review");
buckets.seedBuckets(1, scrumColumns);
check("a status that left the board is dropped", buckets.bucketForStatus(1, "10005"), null);
check("other boards are untouched", buckets.bucketForStatus(2, "10000"), null);

console.log("\nmember links");
const jiraUsers: JiraUser[] = [
  { accountId: "a-sam", displayName: "Sam Patel", emailAddress: "sam@acme.dev", active: true, accountType: "atlassian" },
  { accountId: "a-priya", displayName: "Priya Rao", active: true, accountType: "atlassian" },
  { accountId: "a-arjun", displayName: "Arjun M.", active: true, accountType: "atlassian" },
  { accountId: "a-bot", displayName: "Automation for Jira", active: true, accountType: "app" },
];
check("apps are left out of the member list", members.syncMembers(jiraUsers).total, 3);
check("a second sync adds nobody new", members.syncMembers(jiraUsers).added, 0);

const person = (id: string, names: string[], extra: Partial<SlackPerson> = {}): SlackPerson => ({
  id,
  names,
  email: null,
  isBot: false,
  isGuest: false,
  deleted: false,
  ...extra,
});
const people: SlackPerson[] = [
  person("U_SAM", ["Sam P", "sam"], { email: "SAM@acme.dev" }),
  person("U_PRIYA", ["Priya Rao"]),
  person("U_PRIYA_CLIENT", ["Priya Rao"], { isGuest: true }),
  person("U_ARJUN", ["Arjun M"]),
  person("U_ARJUN_2", ["Arjun M."]),
  person("U_CLIENT", ["Jane Client"], { isGuest: true }),
  person("U_RELAY", ["Relay"], { isBot: true }),
];
const peopleById = new Map(people.map((entry) => [entry.id, entry]));

check("names fold case, accents and punctuation", members.normalizeName("José  Ñúñez-Smith"), "jose nunez smith");

const suggested = members.suggestLinks(members.listMembers(), people);
check("email matches regardless of case", suggested.get("a-sam"), { slackUser: "U_SAM", via: "email" });
check(
  "a unique name match is suggested, and guests don't count",
  suggested.get("a-priya"),
  { slackUser: "U_PRIYA", via: "name" },
);
check("an ambiguous name suggests nobody", suggested.get("a-arjun"), undefined);

check(
  "a clean set of links has no problems",
  members.linkProblems(
    [
      { accountId: "a-sam", slackUser: "U_SAM" },
      { accountId: "a-priya", slackUser: "U_PRIYA" },
    ],
    peopleById,
  ),
  {},
);
check(
  "choosing someone twice flags the later row",
  Object.keys(
    members.linkProblems(
      [
        { accountId: "a-sam", slackUser: "U_SAM" },
        { accountId: "a-priya", slackUser: "U_SAM" },
      ],
      peopleById,
    ),
  ),
  ["a-priya"],
);
check(
  "a guest can be linked — client staff own Jira issues too",
  Object.keys(members.linkProblems([{ accountId: "a-arjun", slackUser: "U_CLIENT" }], peopleById)),
  [],
);
check(
  "a guest is suggested when nobody on the team matches",
  members
    .suggestLinks(
      [
        {
          jira_account_id: "a-jane",
          display_name: "Jane Client",
          email: null,
          active: 1,
          slack_user: null,
          linked_by: null,
          linked_at: null,
          updated_at: "",
        },
      ],
      people,
    )
    .get("a-jane"),
  { slackUser: "U_CLIENT", via: "name" },
);
check(
  "an app can't be linked",
  Object.keys(members.linkProblems([{ accountId: "a-arjun", slackUser: "U_RELAY" }], peopleById)),
  ["a-arjun"],
);

check(
  "saving links",
  members.saveLinks(
    [
      { accountId: "a-sam", slackUser: "U_SAM" },
      { accountId: "a-priya", slackUser: "U_PRIYA" },
      { accountId: "a-arjun", slackUser: null },
    ],
    "U_ADMIN",
  ),
  2,
);
check("lookup by Jira account", members.slackUserFor("a-sam"), "U_SAM");
check(
  "two people can swap links in one save",
  members.saveLinks(
    [
      { accountId: "a-sam", slackUser: "U_PRIYA" },
      { accountId: "a-priya", slackUser: "U_SAM" },
    ],
    "U_ADMIN",
  ),
  2,
);
check("and the swap took", [members.slackUserFor("a-sam"), members.slackUserFor("a-priya")], ["U_PRIYA", "U_SAM"]);
check(
  "a link held by someone outside the form is protected",
  Object.keys(members.linkProblems([{ accountId: "a-arjun", slackUser: "U_SAM" }], peopleById)),
  ["a-arjun"],
);
check(
  "people already linked are never suggested",
  members.suggestLinks(members.listMembers(), people).get("a-arjun"),
  undefined,
);
check("unlinking by Slack member", members.unlinkSlackUser("U_SAM")?.jira_account_id, "a-priya");
check("and the link is gone", members.slackUserFor("a-priya"), null);

console.log("\njira client");
const calls: Array<{ url: string; auth: string }> = [];
const methods = new Set<string>();
let responses: Array<() => Response> = [];

jira.useFetchForTests(async (url, init) => {
  calls.push({ url, auth: init.headers.authorization ?? "" });
  methods.add(init.method);
  const next = responses.shift();
  if (!next) throw new Error(`unexpected request to ${url}`);
  return next();
});

const reply =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

responses = [reply({ accountId: "acc-1", displayName: "Relay Bot" })];
check("myself", (await jira.myself()).displayName, "Relay Bot");
check("requests go to the site", calls[0]?.url, "https://example.atlassian.net/rest/api/3/myself");
check(
  "with basic auth from the email and token",
  calls[0]?.auth,
  `Basic ${Buffer.from("relay@example.com:token-123").toString("base64")}`,
);

calls.length = 0;
responses = [
  reply({ issues: [{ id: "1", key: "ACME-1", fields: {} }], nextPageToken: "page-2", isLast: false }),
  reply({ issues: [{ id: "2", key: "ACME-2", fields: {} }], isLast: true }),
];
const found = await jira.searchIssues("project = ACME AND sprint in openSprints()", ["summary", "status"]);
check("search follows page tokens", found.map((issue) => issue.key), ["ACME-1", "ACME-2"]);
check("the second page sends the token", new URL(calls[1]!.url).searchParams.get("nextPageToken"), "page-2");
check("fields are sent comma-separated", new URL(calls[0]!.url).searchParams.get("fields"), "summary,status");
check(
  "the JQL survives encoding",
  new URL(calls[0]!.url).searchParams.get("jql"),
  "project = ACME AND sprint in openSprints()",
);

calls.length = 0;
responses = [
  reply({ errorMessages: ["Rate limit exceeded"] }, 429, { "retry-after": "0" }),
  reply({ values: [{ id: 201, name: "Sprint 6", state: "active" }], isLast: true }),
];
check("a rate limit is retried", (await jira.activeSprint(1))?.id, 201);
check("after exactly one retry", calls.length, 2);

responses = [
  reply({
    columnConfig: {
      columns: [
        { name: "To Do", statuses: [{ id: "10000" }] },
        { name: "Empty", statuses: [] },
      ],
    },
  }),
];
check("board columns carry their status ids", await jira.boardColumns(1), [
  { name: "To Do", statusIds: ["10000"] },
  { name: "Empty", statusIds: [] },
]);

responses = [reply({ errorMessages: ["Client must be authenticated to access this resource."] }, 401)];
let authMessage = "";
try {
  await jira.myself();
} catch (error) {
  authMessage = jira.describeJiraError(error);
}
check("a 401 says which settings to check", authMessage.includes("JIRA_API_TOKEN"), true);
check("and passes on Jira's own words", authMessage.includes("must be authenticated"), true);

check("every request was a GET", [...methods], ["GET"]);

console.log("\npairings");
routes.addRoute({ clientChannel: "C_CLIENT", teamChannel: "C_TEAM" });
const pairing = routes.listRoutes()[0]!;
const board = { boardId: 1, boardName: "SCRUM board", projectKey: "ACME" };

check(
  "a sprint channel can't be the client channel",
  routes.setJiraBoard(pairing.id, { ...board, sprintChannel: "C_CLIENT" }).ok,
  false,
);
check(
  "or the team channel",
  routes.setJiraBoard(pairing.id, { ...board, sprintChannel: "C_TEAM" }).ok,
  false,
);
const connected = routes.setJiraBoard(pairing.id, { ...board, sprintChannel: "C_SPRINT" });
check("connecting a board", connected.ok ? connected.route.jira_project_key : null, "ACME");
check("the board's name is kept for display", routes.listRoutes()[0]?.jira_board_name, "SCRUM board");
check(
  "the sprint channel can't then be paired as a client channel",
  routes.addRoute({ clientChannel: "C_SPRINT", teamChannel: "C_OTHER" }).ok,
  false,
);
check(
  "or as a team channel",
  routes.addRoute({ clientChannel: "C_OTHER", teamChannel: "C_SPRINT" }).ok,
  false,
);

console.log("\ntime slabs");
const slabs = await import("../src/slabs.js");
const minutes = (value: number) => value * 60;
check("under 5 minutes logs nothing", slabs.slabSeconds(minutes(4)), 0);
check("5 minutes is half an hour", slabs.slabSeconds(minutes(5)), 1800);
check("19 minutes is still half an hour", slabs.slabSeconds(minutes(19)), 1800);
check("20 minutes is an hour", slabs.slabSeconds(minutes(20)), 3600);
check("1h 19m is still an hour", slabs.slabSeconds(minutes(79)), 3600);
check("1h 20m is two hours", slabs.slabSeconds(minutes(80)), 7200);
check("2h 20m is three hours", slabs.slabSeconds(minutes(140)), 10800);
check("formatting", [0, 1800, 3600, 5400, 25200].map(slabs.formatSlab), ["0h", "30m", "1h", "1h 30m", "7h"]);
check("12 hours on one unit suggests splitting", slabs.needsSplitting(12 * 3600), true);
check("just under does not", slabs.needsSplitting(12 * 3600 - 60), false);

console.log("\nwork logs");
const worklogs = await import("../src/worklogs.js");
const storiesDb = await import("../src/jira/stories.js");
const addSession = db.prepare(
  `INSERT INTO work_sessions (task_id, subtask_id, engineer, source, started_at, last_heartbeat_at, ended_at, end_reason)
   VALUES (?, ?, ?, 'slack', ?, ?, ?, 'explicit')`,
);
const logTime = (taskId: number, subtaskId: number | null, engineer: string, spanMinutes: number, hoursAgo: number) => {
  const start = new Date(Date.now() - hoursAgo * 3_600_000);
  const end = new Date(start.getTime() + spanMinutes * 60_000);
  addSession.run(taskId, subtaskId, engineer, start.toISOString(), start.toISOString(), end.toISOString());
};

for (let i = 0; i < 4; i++) logTime(request.id, null, "U_ENG", 25, 10 - i);
const closedRequest = worklogs.closeUnit(request.id, null);
check("four 25-minute sessions log once, as 2h — not four hours", closedRequest.slabSeconds, 7200);
check("from 1h 40m of exact time", Math.round(closedRequest.exactSeconds / 60), 100);
worklogs.closeUnit(request.id, null);
check("closing again replaces the log instead of adding to it", worklogs.loggedSeconds(request.id), 7200);
logTime(request.id, null, "U_OTHER", 27, 3);
check("each engineer gets their own slab", worklogs.closeUnit(request.id, null).slabSeconds, 7200 + 3600);

const subtaskFacts = {
  jiraIssueId: "30001",
  key: "ACME-2",
  title: "API endpoint",
  status: "In Progress",
  bucket: "in_progress",
  jiraAssignee: "a-sam",
  assignee: null,
  updatedAt: "2026-09-14T10:00:00.000+0000",
};
check("a new subtask is recorded", storiesDb.upsertSubtask(story.id, subtaskFacts), true);
check("an unchanged subtask reports no change", storiesDb.upsertSubtask(story.id, subtaskFacts), false);
check("a newly linked owner counts as a change", storiesDb.upsertSubtask(story.id, { ...subtaskFacts, assignee: "U_SAM" }), true);
storiesDb.upsertSubtask(story.id, { ...subtaskFacts, jiraIssueId: "30002", key: "ACME-3", title: "Tests" });
const endpoint = storiesDb.subtaskByKey(story.id, "acme-2");
const tests = storiesDb.subtaskByKey(story.id, "ACME-3");
check("subtasks are found by key in any case", endpoint?.jira_key, "ACME-2");

logTime(story.id, endpoint!.id, "U_SAM", 125, 8);
logTime(story.id, tests!.id, "U_SAM", 27, 5);
check("a subtask of 2h 05m logs 2h", worklogs.closeUnit(story.id, endpoint!.id).slabSeconds, 7200);
check("a subtask of 27m logs 1h", worklogs.closeUnit(story.id, tests!.id).slabSeconds, 3600);
check("the story's total is the sum of its subtask slabs", worklogs.loggedSeconds(story.id), 10800);
check("and each subtask keeps its own", worklogs.loggedForSubtask(endpoint!.id), 7200);
check("a subtask that left the story is archived", storiesDb.archiveMissingSubtasks(story.id, ["30001"]), 1);
check("and no longer listed", storiesDb.subtasksFor(story.id).map((subtask) => subtask.jira_key), ["ACME-2"]);

console.log("\nsprints");
storiesDb.upsertSprint(1, { id: 201, name: "Sprint 6", state: "active", startDate: "2026-09-08T00:00:00Z", endDate: "2026-09-22T00:00:00Z" });
check("the running sprint is remembered", storiesDb.storedActiveSprint(1)?.jira_sprint_id, 201);
db.prepare(`UPDATE tasks SET sprint_id = 201 WHERE id = ?`).run(story.id);
check("its stories are live", storiesDb.liveStories(1).map((task) => task.id), [story.id]);
db.prepare(`UPDATE tasks SET archived_at = ? WHERE id = ?`).run(new Date().toISOString(), story.id);
check("archived stories drop out of the live list", storiesDb.liveStories(1).length, 0);
check("and out of task lists", store.listTasks({ limit: 50 }).some((task) => task.id === story.id), false);
check("but reports still see them", store.listTasks({ limit: 50, includeArchived: true }).some((task) => task.id === story.id), true);
storiesDb.upsertSprint(1, { id: 201, name: "Sprint 6", state: "closed" });
check("a closed sprint isn't the running one any more", storiesDb.storedActiveSprint(1), undefined);

console.log("\nfrom jira to the board");
const sync = await import("../src/jira/sync.js");
check(
  "rich-text descriptions become plain text",
  sync.plainText({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello" }, { type: "hardBreak" }, { type: "text", text: "world" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
    ],
  }),
  "Hello\nworld\nSecond\n",
);
check("a mapped status lands in its group", sync.bucketFor(1, { status: { id: "10003", name: "In Review" } }), "in_review");
check(
  "a flagged issue is blocked whatever its column",
  sync.bucketFor(1, { status: { id: "10000", name: "To Do" }, flag: [{ value: "Impediment" }] }, "flag"),
  "blocked",
);
check("an unflagged issue ignores the empty flag", sync.bucketFor(1, { status: { id: "10000", name: "To Do" }, flag: null }, "flag"), "todo");
check("a status the board never mapped is guessed from its name", sync.bucketFor(1, { status: { id: "99999", name: "QA" } }), "in_review");

console.log("\nsheets");
const report = await import("../src/report.js");
const sprintTab = report.currentSprintSheet();
check("the current sprint tab rows match its header", sprintTab.rows.every((row) => row.length === sprintTab.header.length), true);
const pastTab = report.pastSprintsSheet();
check("an archived story appears under past sprints", pastTab.rows.map((row) => row[2]), ["ACME-323"]);
check("with what it logged, in hours", pastTab.rows[0]?.[5], "3.00");

// Windows keeps the file locked until the handle is closed, so close before cleanup.
db.close();
rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
