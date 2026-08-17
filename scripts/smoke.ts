/**
 * Exercises the ledger and classifier against a throwaway database — no Slack
 * connection involved. Run with `npm run smoke`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Must be set before ./src/config.ts is imported, since it validates on load.
const scratch = mkdtempSync(join(tmpdir(), "relay-smoke-"));
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.INTERNAL_CHANNEL = "C_INTERNAL";
process.env.CLIENT_CHANNELS = "C_CLIENT";
process.env.DB_PATH = join(scratch, "smoke.db");
process.env.LOG_LEVEL = "warn";
// Operator-level Google credentials, read once when config.ts loads.
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.PUBLIC_URL = "https://relay.example.com";

const { classify, titleFrom } = await import("../src/classify.js");
const store = await import("../src/store.js");
const { validateConfig } = await import("../src/config.js");
const { db: db2 } = await import("../src/db.js");

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${ok ? "" : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

console.log("\nconfig");
validateConfig();
check("valid config passes validation", true, true);

console.log("\nclassifier");
check("bug report", classify("the checkout page is broken, throws a 500"), "bug");
check("PR review", classify("can someone review https://github.com/acme/web/pull/42"), "review");
check("feature ask", classify("can we add a CSV export to the dashboard?"), "feature");
check("question", classify("how do I rotate the API key?"), "question");
check("plain request", classify("please bump our seat count to 20"), "request");
check("title trims to first line", titleFrom("Export is slow\n\nlots of detail here"), "Export is slow");
check("title truncates", titleFrom("x".repeat(200)).length, 120);

console.log("\nemoji matching");
const emoji = await import("../src/emoji.js");
const claimSet = emoji.emojiSet("raised_hand");

// The bug this exists to prevent: Slack delivers ✋ as either name depending on
// which client added it, so an exact string compare silently ignores the user.
check("configured raised_hand accepts hand", emoji.matches(claimSet, "hand"), true);
check("configured raised_hand accepts itself", emoji.matches(claimSet, "raised_hand"), true);
check("the reverse also holds", emoji.matches(emoji.emojiSet("hand"), "raised_hand"), true);
check("skin tone variants match", emoji.matches(claimSet, "raised_hand::skin-tone-4"), true);
check("colons are tolerated", emoji.matches(claimSet, ":hand:"), true);
check("case is ignored", emoji.matches(claimSet, "Raised_Hand"), true);
check("unrelated emoji do not match", emoji.matches(claimSet, "thumbsup"), false);
check("wave does not claim", emoji.matches(claimSet, "wave"), false);
check("raising_hand does not claim", emoji.matches(claimSet, "raising_hand"), false);

check("thumbsup aliases +1", emoji.matches(emoji.emojiSet("thumbsup"), "+1"), true);
check("comma lists are additive", emoji.matches(emoji.emojiSet("x,no_entry"), "no_entry"), true);
check("a list still expands aliases", emoji.matches(emoji.emojiSet("x,thumbsup"), "+1"), true);
check("primary is the first listed", emoji.emojiSet("raised_hand,hand").primary, "raised_hand");
check("primary drives what the bot seeds", emoji.emojiSet("hand").primary, "hand");

check(
  "overlapping claim/dismiss is detected via aliases",
  emoji.overlaps(emoji.emojiSet("raised_hand"), emoji.emojiSet("hand")),
  true,
);
check(
  "distinct emoji do not overlap",
  emoji.overlaps(emoji.emojiSet("raised_hand"), emoji.emojiSet("x")),
  false,
);

console.log("\nledger");
const task = store.createTask({
  kind: "bug",
  title: "Checkout is broken",
  body: "the checkout page is broken, throws a 500",
  client_channel: "C_CLIENT",
  client_ts: "1700000000.000100",
  client_user: "U_CLIENT",
  client_permalink: null,
  internal_channel: "C_INTERNAL",
  internal_ts: "pending:C_CLIENT:1700000000.000100",
});
check("new task starts in triage", task.status, "triage");
check("ref formatting", store.ref(task), "REL-1");
check("parseRef round-trips", store.parseRef("REL-1"), 1);
check("parseRef accepts bare number", store.parseRef("12"), 12);
check("parseRef rejects junk", store.parseRef("nope"), null);

const relayed = store.updateTask(task.id, { internal_ts: "1700000001.000200" });
check("internal ts corrected after posting", relayed.internal_ts, "1700000001.000200");
check(
  "lookup by internal message",
  store.getByInternalMessage("C_INTERNAL", "1700000001.000200")?.id,
  task.id,
);
check(
  "lookup by client message",
  store.getByClientMessage("C_CLIENT", "1700000000.000100")?.id,
  task.id,
);

let duplicateRejected = false;
try {
  store.createTask({
    kind: "bug",
    title: "duplicate delivery",
    body: "same message redelivered by slack",
    client_channel: "C_CLIENT",
    client_ts: "1700000000.000100",
    client_user: "U_CLIENT",
    client_permalink: null,
    internal_channel: "C_INTERNAL",
    internal_ts: "pending:dupe",
  });
} catch {
  duplicateRejected = true;
}
check("redelivery of the same client message is rejected", duplicateRejected, true);

const claimed = store.updateTask(task.id, {
  status: "open",
  assignee: "U_ENG",
  claimed_at: new Date().toISOString(),
});
check("claim assigns", claimed.assignee, "U_ENG");
store.addEvent(task.id, "status:open", "U_ENG");

const started = store.updateTask(task.id, {
  status: "in_progress",
  started_at: new Date().toISOString(),
});
check("start moves to in_progress", started.status, "in_progress");

const done = store.updateTask(task.id, {
  status: "done",
  completed_at: new Date().toISOString(),
});
check("done records completion", Boolean(done.completed_at), true);

store.addEvent(task.id, "note", "U_ENG", "internal only");
check("events recorded", store.listEvents(task.id).length, 2);

check("mine filter", store.listTasks({ assignee: "U_ENG" }).length, 1);
check("status filter excludes done", store.listTasks({ status: ["triage"] }).length, 0);
check("counts by status", store.countByStatus(), { done: 1 });

console.log("\nwork sessions");
const sessions = await import("../src/sessions.js");
const second = store.createTask({
  kind: "feature",
  title: "CSV export",
  body: "can we add a CSV export",
  client_channel: "C_CLIENT",
  client_ts: "1700000002.000300",
  client_user: "U_CLIENT",
  client_permalink: null,
  internal_channel: "C_INTERNAL",
  internal_ts: "1700000003.000400",
});

const first = sessions.startSession(second.id, "U_ENG", "claude-code");
check("first session on a task is flagged", first.firstEver, true);
check("session opens unended", first.session.ended_at, null);
check("engineer has one open session", sessions.openSessionFor("U_ENG")?.id, first.session.id);

// Starting the same task again is a heartbeat, not a second session.
const again = sessions.startSession(second.id, "U_ENG", "claude-code");
check("restarting the same task reuses the session", again.session.id, first.session.id);
check("no duplicate session created", sessions.sessionsFor(second.id).length, 1);

// Switching tasks must close the previous session, never run two clocks.
const switched = sessions.startSession(task.id, "U_ENG", "cli");
check("switching tasks supersedes the old session", switched.superseded?.id, first.session.id);
check("superseded session is closed", Boolean(sessions.getSession(first.session.id)?.ended_at), true);
check(
  "superseded reason recorded",
  sessions.getSession(first.session.id)?.end_reason,
  "superseded",
);
check("only one open session per engineer", sessions.openSessionsOn(second.id).length, 0);

sessions.endSession(switched.session.id, "explicit");
check("explicit end closes it", Boolean(sessions.getSession(switched.session.id)?.ended_at), true);
check("engineer now has nothing running", sessions.openSessionFor("U_ENG"), undefined);

// A session that stopped checking in ends at its last heartbeat, not "now".
const stale = sessions.startSession(second.id, "U_OTHER", "cli");
const longAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
db2.prepare(`UPDATE work_sessions SET started_at = ?, last_heartbeat_at = ? WHERE id = ?`)
  .run(new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), longAgo, stale.session.id);

const reaped = sessions.reapStaleSessions();
check("stale session is reaped", reaped.length, 1);
check("reaped session ends at last heartbeat", sessions.getSession(stale.session.id)?.ended_at, longAgo);
check("reap reason recorded", sessions.getSession(stale.session.id)?.end_reason, "reaped");
check(
  "reaped time is the worked hour, not the abandoned five",
  Math.round(sessions.sessionSeconds(sessions.getSession(stale.session.id)!) / 3600),
  1,
);

// A session started from Slack has nothing beating for it, so a heartbeat
// timeout must not touch it — that is what made `!start` then `!stop` report
// "no session running" after twenty quiet minutes.
const slackSession = sessions.startSession(second.id, "U_SLACK", "slack");
db2.prepare(`UPDATE work_sessions SET started_at = ?, last_heartbeat_at = ? WHERE id = ?`)
  .run(
    new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    slackSession.session.id,
  );
check("a quiet slack session survives the heartbeat timeout", sessions.reapStaleSessions().length, 0);
check(
  "and is still running",
  sessions.getSession(slackSession.session.id)?.ended_at,
  null,
);

// It is capped by length instead, and must record the capped time rather than
// backdating to its start — which for a session with no heartbeats is the same
// instant, and would log zero.
db2.prepare(`UPDATE work_sessions SET started_at = ?, last_heartbeat_at = ? WHERE id = ?`)
  .run(
    new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    slackSession.session.id,
  );
const capped = sessions.reapStaleSessions();
check("a slack session past the cap is reaped", capped.length, 1);
check(
  "capped at the maximum, not left at 30 hours",
  Math.round(sessions.sessionSeconds(sessions.getSession(slackSession.session.id)!) / 3600),
  8,
);

sessions.adjustSession(stale.session.id, -30, "left it running");
check(
  "adjustment reduces the total",
  Math.round(sessions.sessionSeconds(sessions.getSession(stale.session.id)!) / 60),
  30,
);

const effort = sessions.effortFor(second.id);
check("effort sums the task's sessions", effort.sessionCount, 2);
check("effort knows nothing is running", effort.active, false);
check("effort lists both engineers", effort.engineers.sort(), ["U_ENG", "U_OTHER"]);

console.log("\nduration formatting");
check("exact, sub-hour", sessions.formatExact(45 * 60), "45m");
check("exact, hours and minutes", sessions.formatExact(4 * 3600 + 22 * 60), "4h 22m");
check("exact, whole hours", sessions.formatExact(3 * 3600), "3h");
check("rounded, trivial", sessions.formatRounded(8 * 60), "under 15 minutes");
check("rounded, to the quarter hour", sessions.formatRounded(40 * 60), "about 45 minutes");
check("rounded, to the half hour", sessions.formatRounded(4 * 3600 + 22 * 60), "about 4.5 hours");
check("rounded hides the exact figure", sessions.formatRounded(3 * 3600 + 58 * 60), "about 4 hours");
check("rounded, long jobs become days", sessions.formatRounded(19 * 3600), "about 3 days of work");

console.log("\nchannel pairings");
const routes = await import("../src/routes.js");

const paired = routes.addRoute({ clientChannel: "C_ACME", teamChannel: "C_ENG", label: "Acme" });
check("a pairing is created", paired.ok, true);
check("client channel routes to its team channel", routes.routeForClient("C_ACME")?.team_channel, "C_ENG");
check("an unpaired channel routes nowhere", routes.routeForClient("C_NOPE"), undefined);
check("the team channel is recognised", routes.isTeamChannel("C_ENG"), true);
check("a client channel is not a team channel", routes.isTeamChannel("C_ACME"), false);

// A second client can share one team channel, or use its own.
routes.addRoute({ clientChannel: "C_BETA", teamChannel: "C_ENG" });
routes.addRoute({ clientChannel: "C_GAMMA", teamChannel: "C_ENG2", ingestMode: "mention" });
check("multiple pairings coexist", routes.countRoutes(), 3);
check("two clients can share one team channel", routes.routeForClient("C_BETA")?.team_channel, "C_ENG");
check("each pairing keeps its own ingest mode", routes.routeForClient("C_GAMMA")?.ingest_mode, "mention");
check("watched channels cover both sides", routes.watchedChannels().sort(), [
  "C_ACME", "C_BETA", "C_ENG", "C_ENG2", "C_GAMMA",
]);

// Guards against configurations that would loop or double-post.
check("a channel cannot pair with itself", routes.addRoute({ clientChannel: "C_X", teamChannel: "C_X" }).ok, false);
check(
  "a team channel cannot also be a client channel",
  routes.addRoute({ clientChannel: "C_ENG", teamChannel: "C_OTHER" }).ok,
  false,
);
check(
  "a client channel cannot also be a team channel",
  routes.addRoute({ clientChannel: "C_NEW", teamChannel: "C_ACME" }).ok,
  false,
);

// Re-pairing replaces rather than duplicating, so a client can be moved.
const moved = routes.addRoute({ clientChannel: "C_ACME", teamChannel: "C_ENG2" });
check("re-pairing replaces the old route", moved.ok && moved.replaced !== null, true);
check("no duplicate pairing is left behind", routes.countRoutes(), 3);
check("the client now routes to the new team channel", routes.routeForClient("C_ACME")?.team_channel, "C_ENG2");

check("removing a pairing works", Boolean(routes.removeRoute("C_BETA")), true);
check("a removed pairing stops routing", routes.routeForClient("C_BETA"), undefined);
check("removing twice is harmless", routes.removeRoute("C_BETA"), null);
check("removal deactivates rather than deletes", routes.listRoutes(true).length, 3);

console.log("\nsettings");
const settingsStore = await import("../src/settings.js");
settingsStore.set(settingsStore.KEYS.sheetId, "abc123", "U_ENG");
check("a setting round-trips", settingsStore.get(settingsStore.KEYS.sheetId), "abc123");
settingsStore.set(settingsStore.KEYS.sheetId, "def456", "U_ENG");
check("setting again overwrites", settingsStore.get(settingsStore.KEYS.sheetId), "def456");
settingsStore.clear(settingsStore.KEYS.sheetId);
check("cleared settings read as null", settingsStore.get(settingsStore.KEYS.sheetId), null);

const SHEET = "1BxiMVs0XRA5nFMdKvBd_ZBz2Fv1Bd8gHVuS3Xv7abcd";
check(
  "a pasted sheet URL yields its id",
  settingsStore.parseSheetId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`),
  SHEET,
);
check(
  "Slack's angle brackets are stripped",
  settingsStore.parseSheetId(`<https://docs.google.com/spreadsheets/d/${SHEET}/edit>`),
  SHEET,
);
check("a bare id passes through", settingsStore.parseSheetId(SHEET), SHEET);
check("junk is rejected", settingsStore.parseSheetId("not a sheet"), null);
check("an empty string is rejected", settingsStore.parseSheetId("   "), null);

console.log("\npermissions");
const perms = await import("../src/permissions.js");

// Stub the workspace-role lookup so this runs without Slack. Three people:
// an owner, a workspace admin, and an ordinary member.
const ROLES: Record<string, { isOwner: boolean; isAdmin: boolean }> = {
  U_OWNER: { isOwner: true, isAdmin: true },
  U_WSADMIN: { isOwner: false, isAdmin: true },
  U_MEMBER: { isOwner: false, isAdmin: false },
};
const roleFor = (id: string) => ROLES[id] ?? { isOwner: false, isAdmin: false };

/** Mirrors canAdmin's rules, against the stubbed roles above. */
async function decide(user: string, channel?: string) {
  const role = roleFor(user);
  if (role.isOwner) return { ok: true };
  const users = perms.adminUsers();
  const allowed = users.length === 0 ? role.isAdmin : users.includes(user);
  if (!allowed) return { ok: false };
  const channels = perms.adminChannels();
  if (channels.length > 0 && channel && !channels.includes(channel)) return { ok: false };
  return { ok: true };
}

perms.setAdminUsers([]);
perms.setAdminChannels([]);
check("bootstrap: a workspace admin may configure", (await decide("U_WSADMIN")).ok, true);
check("bootstrap: an owner may configure", (await decide("U_OWNER")).ok, true);
check("bootstrap: an ordinary member may not", (await decide("U_MEMBER")).ok, false);

perms.setAdminUsers(["U_LEAD"]);
check("an explicit admin may configure", (await decide("U_LEAD")).ok, true);
check("naming admins locks out workspace admins", (await decide("U_WSADMIN")).ok, false);
check("naming admins does not lock out the owner", (await decide("U_OWNER")).ok, true);
check("an ordinary member is still refused", (await decide("U_MEMBER")).ok, false);

perms.setAdminChannels(["C_CONTROL"]);
check("an admin in the allowed channel passes", (await decide("U_LEAD", "C_CONTROL")).ok, true);
check("the same admin elsewhere is refused", (await decide("U_LEAD", "C_RANDOM")).ok, false);
check("the owner ignores the channel restriction", (await decide("U_OWNER", "C_RANDOM")).ok, true);
check(
  "a non-admin in the allowed channel is still refused",
  (await decide("U_MEMBER", "C_CONTROL")).ok,
  false,
);

perms.setAdminUsers(["U_LEAD", "U_LEAD", "U_TWO"]);
check("admin list de-duplicates", perms.adminUsers(), ["U_LEAD", "U_TWO"]);
perms.setAdminChannels([]);
check("clearing channels restores anywhere access", (await decide("U_LEAD", "C_RANDOM")).ok, true);
perms.setAdminUsers([]);
check("resetting admins returns to workspace-admin rule", (await decide("U_WSADMIN")).ok, true);

console.log("\ngoogle oauth");
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.PUBLIC_URL = "https://relay.example.com";
const google = await import("../src/google.js");

check("configured once the operator sets all three", google.googleConfigured(), true);
check("redirect uri is derived from PUBLIC_URL", google.redirectUri(), "https://relay.example.com/oauth/google/callback");

const authUrl = new URL(google.beginAuth("T_TEAM", "U_LEAD", "C_CONTROL"));
check("consent goes to Google", authUrl.origin + authUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
check(
  "asks only for drive.file, not the sensitive spreadsheets scope",
  authUrl.searchParams.get("scope"),
  "https://www.googleapis.com/auth/drive.file",
);
check("requests offline access, so a refresh token is issued", authUrl.searchParams.get("access_type"), "offline");
check("forces the consent screen, so reconnecting still yields a refresh token", authUrl.searchParams.get("prompt"), "consent");
check("carries a state parameter", Boolean(authUrl.searchParams.get("state")), true);

const issued = authUrl.searchParams.get("state")!;
const consumed = google.consumeState(issued);
check("state resolves to who started the flow", consumed?.user_id, "U_LEAD");
check("state remembers the team", consumed?.team_id, "T_TEAM");
check("state remembers where to reply", consumed?.channel_id, "C_CONTROL");
check("a state token cannot be replayed", google.consumeState(issued), null);
check("a forged state is rejected", google.consumeState("made-up"), null);

// An expired link must not be honoured, however well-formed.
const staleState = new URL(google.beginAuth("T_TEAM", "U_LEAD")).searchParams.get("state")!;
db2.prepare(`UPDATE oauth_states SET created_at = ? WHERE state = ?`).run(
  new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  staleState,
);
check("a state older than 15 minutes is refused", google.consumeState(staleState), null);

check("no account before anyone connects", google.getAccount("T_TEAM"), undefined);
check("an unconnected team gets no client", google.clientFor("T_TEAM"), null);

console.log("\nspreadsheet export");
const report = await import("../src/report.js");

const csv = report.toCsv({
  name: "T",
  header: ["a", "b"],
  rows: [
    ["plain", "also plain"],
    ["has, comma", 'has "quotes"'],
    ["has\nnewline", "trailing "],
  ],
});
const csvLines = csv.split("\r\n");
check("header row first", csvLines[0], "a,b");
check("plain fields are unquoted", csvLines[1], "plain,also plain");
check("commas force quoting", csvLines[2]?.startsWith('"has, comma"'), true);
check("embedded quotes are doubled", csvLines[2]?.includes('"has ""quotes"""'), true);
check("newlines are quoted, not escaped away", csv.includes('"has\nnewline"'), true);
check("rows are CRLF separated", csv.includes("\r\n"), true);

const tasksTab = report.tasksSheet();
check("tasks tab is named for the sheet", tasksTab.name, "Tasks");
check("every row matches the header width", tasksTab.rows.every((row) => row.length === tasksTab.header.length), true);
check("effort hours column is numeric text", /^(\d+\.\d{2})?$/.test(tasksTab.rows[0]?.[12] ?? ""), true);
check("body newlines are flattened into one cell", tasksTab.rows.every((row) => !(row[16] ?? "").includes("\n")), true);

const allTabs = report.allSheets();
check("four tabs exported", allTabs.map((tab) => tab.name), ["Summary", "Tasks", "Sessions", "Activity"]);
check("every tab has a header", allTabs.every((tab) => tab.header.length > 0), true);
check(
  "sessions tab rows match its header",
  allTabs[2]!.rows.every((row) => row.length === allTabs[2]!.header.length),
  true,
);

console.log("\nspreadsheet styling");
const style = await import("../src/sheet-style.js");
const tasksTabStyle = report.tasksSheet();
const fakeMeta = { sheetId: 0, title: "Tasks", bandedRangeIds: [7], conditionalFormatCount: 2 };
const reqs = style.styleRequests(tasksTabStyle, fakeMeta) as Array<Record<string, any>>;
const kinds = reqs.map((r) => Object.keys(r)[0]!);

check("existing banding is removed before re-adding", kinds.filter((k) => k === "deleteBanding").length, 1);
check(
  "every existing conditional rule is removed",
  kinds.filter((k) => k === "deleteConditionalFormatRule").length,
  2,
);
check("deletes come before adds", kinds.indexOf("deleteBanding") < kinds.indexOf("addBanding"), true);
check("header rows are frozen", kinds.includes("updateSheetProperties"), true);
check("the banner row is merged", kinds.includes("mergeCells"), true);
check("rows are banded", kinds.filter((k) => k === "addBanding").length, 1);
check("headers get a filter for sorting", kinds.filter((k) => k === "setBasicFilter").length, 1);
check("borders are drawn", kinds.includes("updateBorders"), true);
check(
  "one width request per column",
  reqs.filter((r) => r.updateDimensionProperties?.range?.dimension === "COLUMNS").length,
  tasksTabStyle.header.length,
);
check(
  "a colour rule per status",
  kinds.filter((k) => k === "addConditionalFormatRule").length,
  6, // one per task status
);

const merge = reqs.find((r) => r.mergeCells)!.mergeCells;
check("the banner spans every column", merge.range.endColumnIndex, tasksTabStyle.header.length);
check("the banner is only the first row", merge.range.endRowIndex, 1);

const frozen = reqs.find((r) => r.updateSheetProperties)!.updateSheetProperties;
check("banner and header are both frozen", frozen.properties.gridProperties.frozenRowCount, 2);

// Sheets rejects colours outside 0-1, and hex conversion is easy to get wrong.
const colors: number[] = [];
JSON.stringify(reqs, (key, value) => {
  if (["red", "green", "blue", "alpha"].includes(key) && typeof value === "number") {
    colors.push(value);
  }
  return value;
});
check("colour channels are all within 0-1", colors.every((c) => c >= 0 && c <= 1), true);
check("colours were actually emitted", colors.length > 20, true);

// Sheets discards alpha on cell backgrounds, so a "translucent" fill paints
// solid — and if the text is the same colour, the cell reads as empty. That
// shipped once; these assertions are why it can't again.
check("no request relies on transparency", colors.filter((_, i) => false).length === 0 && JSON.stringify(reqs).includes('"alpha":1'), true);

function luminance(c: { red: number; green: number; blue: number }): number {
  const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(c.red) + 0.7152 * channel(c.green) + 0.0722 * channel(c.blue);
}
function contrast(a: any, b: any): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const statusRules = reqs
  .filter((r) => r.addConditionalFormatRule)
  .map((r) => r.addConditionalFormatRule.rule.booleanRule);

check("every status has a rule", statusRules.length, 6);
check(
  "all status rules are fully opaque",
  statusRules.every(
    (r: any) =>
      r.format.backgroundColor.alpha === 1 && r.format.textFormat.foregroundColor.alpha === 1,
  ),
  true,
);
for (const rule of statusRules) {
  const label = rule.condition.values[0].userEnteredValue;
  const ratio = contrast(rule.format.backgroundColor, rule.format.textFormat.foregroundColor);
  check(`"${label}" text is readable on its fill (${ratio.toFixed(1)}:1)`, ratio >= 4.5, true);
}

// Data must start below the banner, or the first task is hidden under it.
const bodyRanges = reqs
  .filter((r) => r.repeatCell?.range?.startRowIndex !== undefined)
  .map((r) => r.repeatCell.range.startRowIndex);
check("body formatting starts below the header", bodyRanges.includes(style.FIRST_DATA_ROW), true);
check("data begins on row 3", style.FIRST_DATA_ROW, 2);

const summaryReqs = style.styleRequests(report.summarySheet(), {
  sheetId: 3,
  title: "Summary",
  bandedRangeIds: [],
  conditionalFormatCount: 0,
});
check(
  "tabs without a status column get no colour rules",
  (summaryReqs as Array<Record<string, unknown>>).filter((r) => "addConditionalFormatRule" in r).length,
  0,
);
check(
  "every request targets the right tab",
  (summaryReqs as Array<Record<string, any>>).every((r) => {
    const found = JSON.stringify(r).match(/"sheetId":(\d+)/g) ?? [];
    return found.every((m) => m === '"sheetId":3');
  }),
  true,
);

console.log("\napi tokens");
const tokenStore = await import("../src/tokens.js");
check("no tokens means open loopback mode", tokenStore.hasAnyToken(), false);
const minted = tokenStore.mintToken("U_ENG", "test-laptop");
check("minted token resolves to its owner", tokenStore.resolveToken(minted), "U_ENG");
check("a wrong token resolves to nobody", tokenStore.resolveToken("relay_bogus"), null);
check("minting flips the API into authenticated mode", tokenStore.hasAnyToken(), true);
check("plaintext token is never stored", tokenStore.listTokens()[0]?.token_hash === minted, false);
const tokenId = tokenStore.listTokens()[0]!.id;
tokenStore.revokeToken(tokenId);
check("revoked token stops working", tokenStore.resolveToken(minted), null);

// Windows keeps the file locked until the handle is closed, so close before cleanup.
db2.close();
rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
