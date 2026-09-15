import { createHash } from "node:crypto";
import type { KnownBlock, PlainTextOption, View } from "@slack/types";
import { client, teamUrl } from "./app.js";
import { mention, userName } from "./names.js";
import { BUCKET_STYLE, dateRange, dot, ICON, KIND } from "./design.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { ref, type Task } from "../store.js";
import { effortFor, formatExact, type WorkSession } from "../sessions.js";
import { formatSlab } from "../slabs.js";
import { loggedSeconds } from "../worklogs.js";
import { isBucket, type Bucket } from "../jira/buckets.js";
import { displayName, slackUserFor } from "../jira/members.js";
import { getSprint, liveStories, storedActiveSprint, subtasksFor, type SprintRow, type Subtask } from "../jira/stories.js";
import { listRoutes, type Route } from "../routes.js";
import { latestSnapshot, type BoardSnapshot } from "../jira/sync.js";

/**
 * The sprint desks, and the panels they open.
 *
 * Stories don't get threads: a channel of one thread per story is miserable to
 * search. Instead each sprint channel has one pinned *Sprint desk* — counts,
 * the latest updates, and a dropdown to pick a story or a person — and the team
 * channel has a *Team desk* with the same dropdowns plus the clock controls.
 * Picking something opens a panel (a modal), and updates live there, so the
 * channels stay quiet. Desks are edited in place, only when their content
 * changed.
 */

export const DESK = {
  story: "desk_story",
  person: "desk_person",
  openFromDm: "dm_open_story",
  clientPanel: "client_story_panel",
  viewTime: "team_desk_view_time",
  logTime: "team_desk_log_time",
  pickPerson: "time_pick_person",
  pickStory: "time_pick_story",
  start: "time_start",
  pause: "time_pause",
  closeSubtask: "time_close_subtask",
  done: "time_done",
  timePanel: "time_panel",
} as const;

/** What a client-side panel shows: updates people wrote, and what Relay told the client. */
export const CLIENT_FEED = ["client_update", "team_update", "client_notice"];

const ORDER: Bucket[] = ["in_progress", "in_review", "blocked", "todo", "done"];
export const plain = (text: string) => ({ type: "plain_text" as const, text });
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
export const bucketOf = (value: string | null): Bucket => (value && isBucket(value) ? value : "todo");
const ago = (iso: string) =>
  `<!date^${Math.floor(new Date(iso).getTime() / 1000)}^{ago}|${iso.slice(0, 16).replace("T", " ")}>`;
export const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

interface FeedEvent {
  task_id: number;
  type: string;
  actor: string | null;
  detail: string | null;
  created_at: string;
}

/** The pairing a story belongs to. */
export function routeForStory(task: Task): Route | undefined {
  return listRoutes().find((route) => route.sprint_channel === task.client_channel);
}

/** The pairing whose sprint or team desk lives in a channel. */
export function routeForDeskChannel(channel: string): Route | undefined {
  return listRoutes().find(
    (route) => route.jira_board_id && (route.sprint_channel === channel || route.team_channel === channel),
  );
}

export function currentSprint(route: Route): SprintRow | null {
  return latestSnapshot(route.id)?.sprint ?? storedActiveSprint(route.jira_board_id!) ?? null;
}

/** The stories a desk shows: the running sprint's, or everything carried over between sprints. */
export function deskStories(route: Route): Task[] {
  const sprint = currentSprint(route);
  return liveStories(route.jira_board_id!).filter((story) => !sprint || story.sprint_id === sprint.jira_sprint_id);
}

export function sprintLine(sprint: SprintRow | null): string {
  return sprint
    ? dot(`*${sprint.name}*`, dateRange(sprint.start_at, sprint.end_at))
    : "*Between sprints* — stories carried over wait here for the next one";
}

/** Plain names for the client side, where mentions don't resolve; mentions for the team. */
export async function ownerLabel(
  owner: { assignee: string | null; jira_assignee: string | null },
  side: "client" | "team",
): Promise<string> {
  if (owner.assignee) return side === "team" ? mention(owner.assignee) : userName(owner.assignee);
  if (owner.jira_assignee) {
    return side === "team" ? `${displayName(owner.jira_assignee)} _(not linked)_` : displayName(owner.jira_assignee);
  }
  return side === "team" ? "_unassigned_" : "Unassigned";
}

function countsLine(stories: Task[]): string {
  return ORDER.map(
    (bucket) => `${BUCKET_STYLE[bucket].icon} ${BUCKET_STYLE[bucket].label} ${stories.filter((story) => bucketOf(story.bucket) === bucket).length}`,
  ).join(" · ");
}

export function carriedNote(task: Task): string | null {
  if (!task.carried_from_sprint_id) return null;
  const sprint = getSprint(task.carried_from_sprint_id);
  return `${ICON.carried} carried from ${sprint ? dot(sprint.name, dateRange(sprint.start_at, sprint.end_at)) : "an earlier sprint"}`;
}

/** Section blocks hold 3,000 characters, so long content is split across several. */
export function sections(lines: string[], maxBlocks = 40): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 2 > 2800) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: current } });
      current = "";
    }
    current += `${clip(line, 2700)}\n\n`;
  }
  if (current.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: current.trimEnd() } });
  return blocks.slice(0, maxBlocks);
}

function feedFor(taskId: number, types: string[] | null, limit: number): FeedEvent[] {
  const filter = types ? `AND type IN (${types.map(() => "?").join(", ")})` : "";
  return db
    .prepare(`SELECT task_id, type, actor, detail, created_at FROM events WHERE task_id = ? ${filter} ORDER BY id DESC LIMIT ?`)
    .all(taskId, ...(types ?? []), limit) as FeedEvent[];
}

async function feedLines(events: FeedEvent[]): Promise<string[]> {
  const lines: string[] = [];
  for (const event of events) {
    const who = event.actor ? `*${await userName(event.actor)}*` : "*Relay*";
    const label =
      event.type === "client_update"
        ? `📨 ${who}`
        : event.type === "team_update"
          ? `💬 ${who}`
          : event.type === "note"
            ? `${ICON.note} ${who} · internal note`
            : event.type === "client_notice"
              ? "📣 *Relay*"
              : `${ICON.sync} _${event.type.replace(/[:_]/g, " ")}_`;
    const text = (event.detail ?? "").trim();
    lines.push(`${label} · ${ago(event.created_at)}${text ? `\n${clip(text, 900)}` : ""}`);
  }
  return lines;
}

// ---- the desk messages ------------------------------------------------------

export async function peopleOptions(stories: Task[]): Promise<PlainTextOption[]> {
  const people = new Map<string, string | null>();
  for (const story of stories) {
    if (story.jira_assignee && !people.has(story.jira_assignee)) people.set(story.jira_assignee, story.assignee);
    for (const subtask of subtasksFor(story.id)) {
      if (subtask.jira_assignee && !people.has(subtask.jira_assignee)) people.set(subtask.jira_assignee, subtask.assignee);
    }
  }

  const options: PlainTextOption[] = [];
  for (const [accountId, assignee] of people) {
    options.push({ text: plain(clip(await ownerLabel({ assignee, jira_assignee: accountId }, "client"), 70)), value: accountId });
  }
  options.sort((a, b) => a.text.text.localeCompare(b.text.text));
  if (stories.some((story) => !story.jira_assignee)) options.push({ text: plain("Unassigned"), value: "unassigned" });
  return options.slice(0, 100);
}

function pickers(storyAction: string, personAction: string, people: PlainTextOption[]) {
  return [
    {
      type: "external_select" as const,
      action_id: storyAction,
      placeholder: plain("Pick a story…"),
      min_query_length: 0,
    },
    ...(people.length > 0
      ? [{ type: "static_select" as const, action_id: personAction, placeholder: plain("Pick a person…"), options: people }]
      : []),
  ];
}

async function sprintDeskBlocks(route: Route, stories: Task[]): Promise<KnownBlock[]> {
  const latest = db
    .prepare(
      `SELECT e.task_id, e.type, e.actor, e.detail, e.created_at FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE t.client_channel = ? AND t.archived_at IS NULL AND e.type IN ('client_update', 'team_update')
       ORDER BY e.id DESC LIMIT 3`,
    )
    .all(route.sprint_channel) as FeedEvent[];

  const latestLines: string[] = [];
  for (const event of latest) {
    const story = stories.find((candidate) => candidate.id === event.task_id);
    const who = event.actor ? await userName(event.actor) : "Relay";
    latestLines.push(`• *${story?.jira_key ?? ""}* · ${who} · ${ago(event.created_at)}: ${clip((event.detail ?? "").replace(/\s+/g, " "), 90)}`);
  }

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `📋 *Sprint desk* · ${sprintLine(currentSprint(route))} · ${stories.length} stories` },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: countsLine(stories) }] },
    ...(latestLines.length > 0
      ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `*Latest updates*\n${latestLines.join("\n")}` } }]
      : []),
    { type: "actions", block_id: "desk_pickers", elements: pickers(DESK.story, DESK.person, await peopleOptions(stories)) },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Pick a story to see where it is and send the team an update, or a person to see their board." }],
    },
  ];
}

async function teamDeskBlocks(route: Route, stories: Task[]): Promise<KnownBlock[]> {
  const ids = stories.map((story) => story.id);
  const running = ids.length
    ? (db
        .prepare(`SELECT * FROM work_sessions WHERE ended_at IS NULL AND task_id IN (${ids.map(() => "?").join(", ")})`)
        .all(...ids) as WorkSession[])
    : [];

  const runningLines = running.map((session) => {
    const story = stories.find((candidate) => candidate.id === session.task_id);
    const subtask = session.subtask_id ? subtasksFor(session.task_id).find((candidate) => candidate.id === session.subtask_id) : undefined;
    const elapsed = formatExact(Math.max(0, (Date.now() - new Date(session.started_at).getTime()) / 1000 + session.adjustment_seconds));
    return `${ICON.active} ${mention(session.engineer)} on *${subtask?.jira_key ?? story?.jira_key}* · ${elapsed}`;
  });

  const exact = sum(stories.map((story) => effortFor(story.id).totalSeconds));
  const logged = sum(stories.map((story) => loggedSeconds(story.id)));

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `🛠️ *Team desk* · ${sprintLine(currentSprint(route))} · ${stories.length} stories` },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: countsLine(stories) }] },
    ...(runningLines.length > 0
      ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: `*Running now*\n${runningLines.join("\n")}` } }]
      : []),
    { type: "context", elements: [{ type: "mrkdwn", text: dot(`Exact *${formatExact(exact)}*`, `logged *${formatSlab(logged)}*`, "internal only") }] },
    {
      type: "actions",
      block_id: "team_desk_time",
      elements: [
        { type: "button", text: plain("⏱ View time"), action_id: DESK.viewTime, value: String(route.id) },
        { type: "button", text: plain("✍️ Log time"), style: "primary", action_id: DESK.logTime, value: String(route.id) },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Both let you narrow the stories down to one person first." }],
    },
  ];
}

// ---- publishing -------------------------------------------------------------

interface DeskMessageRow {
  channel: string;
  kind: string;
  member: string;
  ts: string;
  bookmark_id: string | null;
  content_hash: string | null;
}

const warnedScopes = new Set<string>();

function scopeProblem(error: unknown, what: string): boolean {
  const code = (error as { data?: { error?: string } })?.data?.error;
  if (code !== "missing_scope" && code !== "not_allowed_token_type") return false;
  if (!warnedScopes.has(what)) {
    warnedScopes.add(what);
    log.warn(`the desks can't ${what} yet — Relay's Slack app needs its new permissions approved and reinstalled`);
  }
  return true;
}

/** Pins a desk and bookmarks it so it's one click away. Retried until both work. */
async function attach(row: DeskMessageRow, title: string, emoji: string): Promise<void> {
  try {
    await client.pins.add({ channel: row.channel, timestamp: row.ts });
  } catch (error) {
    const code = (error as { data?: { error?: string } })?.data?.error;
    if (code !== "already_pinned") {
      if (!scopeProblem(error, "pin messages")) log.warn("could not pin a desk", error);
      return;
    }
  }

  if (!teamUrl) return;
  const link = `${teamUrl.replace(/\/$/, "")}/archives/${row.channel}/p${row.ts.replace(".", "")}`;
  try {
    const added = await client.bookmarks.add({ channel_id: row.channel, title, type: "link", link, emoji });
    db.prepare(`UPDATE board_messages SET bookmark_id = ? WHERE channel = ? AND kind = ? AND member = ?`).run(
      added.bookmark?.id ?? "added",
      row.channel,
      row.kind,
      row.member,
    );
  } catch (error) {
    if (!scopeProblem(error, "add bookmarks")) log.warn("could not bookmark a desk", error);
  }
}

async function publish(channel: string, kind: string, member: string, title: string, emoji: string, blocks: KnownBlock[]): Promise<void> {
  const hash = createHash("sha1").update(JSON.stringify(blocks)).digest("hex");
  let row = db
    .prepare(`SELECT * FROM board_messages WHERE channel = ? AND kind = ? AND member = ?`)
    .get(channel, kind, member) as DeskMessageRow | undefined;

  if (row && row.content_hash !== hash) {
    try {
      await client.chat.update({ channel, ts: row.ts, text: title, blocks });
      db.prepare(`UPDATE board_messages SET content_hash = ?, updated_at = ? WHERE channel = ? AND kind = ? AND member = ?`)
        .run(hash, new Date().toISOString(), channel, kind, member);
    } catch (error) {
      if ((error as { data?: { error?: string } })?.data?.error !== "message_not_found") throw error;
      // Someone deleted it; post a fresh one.
      db.prepare(`DELETE FROM board_messages WHERE channel = ? AND kind = ? AND member = ?`).run(channel, kind, member);
      row = undefined;
    }
  }

  if (!row) {
    const posted = await client.chat.postMessage({ channel, text: title, blocks, unfurl_links: false });
    if (!posted.ts) return;
    db.prepare(`INSERT INTO board_messages (channel, kind, member, ts, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(channel, kind, member, posted.ts, hash, new Date().toISOString());
    row = { channel, kind, member, ts: posted.ts, bookmark_id: null, content_hash: hash };
  }

  if (!row.bookmark_id) await attach(row, title, emoji);
}

async function renderDesks(routeId: number): Promise<void> {
  const route = listRoutes().find((candidate) => candidate.id === routeId);
  if (!route?.jira_board_id || !route.sprint_channel) return;
  const stories = deskStories(route);

  await publish(route.sprint_channel, "desk", "", "Sprint desk", ":clipboard:", await sprintDeskBlocks(route, stories));
  await publish(route.team_channel, "team_desk", String(route.id), "Team desk", ":hammer_and_wrench:", await teamDeskBlocks(route, stories));
}

const pendingRoutes = new Set<number>();
let deskTimer: NodeJS.Timeout | null = null;

function scheduleRoute(routeId: number): void {
  pendingRoutes.add(routeId);
  if (deskTimer) return;
  deskTimer = setTimeout(() => {
    deskTimer = null;
    const ids = [...pendingRoutes];
    pendingRoutes.clear();
    void (async () => {
      for (const id of ids) {
        try {
          await renderDesks(id);
        } catch (error) {
          log.warn("could not update the desks", error);
        }
      }
    })();
  }, 5_000);
  deskTimer.unref();
}

/** Called after every Jira sync. */
export function scheduleDesks(snapshot: BoardSnapshot): void {
  scheduleRoute(snapshot.route.id);
}

/** Called whenever a story changes in Relay: time, updates, closing work. */
export function refreshDesksFor(task: Task): void {
  const route = routeForStory(task);
  if (route) scheduleRoute(route.id);
}

// ---- the dropdown -------------------------------------------------------------

/** Stories matching what someone typed, grouped by where they are on the board. */
export function storyOptions(route: Route, query: string) {
  const needle = query.trim().toLowerCase();
  const stories = deskStories(route).filter(
    (story) => !needle || `${story.jira_key} ${story.title}`.toLowerCase().includes(needle),
  );

  let budget = 100; // Slack shows at most 100 options
  const groups = ORDER.map((bucket) => {
    const options = stories
      .filter((story) => bucketOf(story.bucket) === bucket)
      .slice(0, budget)
      .map((story) => ({ text: plain(clip(`${story.jira_key} · ${story.title}`, 75)), value: String(story.id) }));
    budget -= options.length;
    return { label: plain(`${BUCKET_STYLE[bucket].icon} ${BUCKET_STYLE[bucket].label}`), options };
  }).filter((group) => group.options.length > 0);

  return groups.length > 0 ? { option_groups: groups } : { options: [] };
}

// ---- panels -------------------------------------------------------------------

export function subtaskIcon(subtask: Subtask): string {
  return subtask.done_at ? ICON.done : BUCKET_STYLE[bucketOf(subtask.bucket)].icon;
}

/** The client-side panel: where a story is, and its updates. Anyone can add one. */
export async function clientStoryView(task: Task, notice?: string): Promise<View> {
  const style = BUCKET_STYLE[bucketOf(task.bucket)];
  const subtasks = subtasksFor(task.id);
  const blocks: KnownBlock[] = [];

  if (notice) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: notice }] });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${task.title}*` } });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: dot(`${style.icon} *${style.label}*`, await ownerLabel(task, "client"), KIND[task.kind].label, carriedNote(task)),
      },
    ],
  });
  if (subtasks.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: clip(subtasks.map((subtask) => `${subtask.done_at || subtask.bucket === "done" ? ICON.done : "▫️"} ${subtask.jira_key}  ${subtask.title}`).join("\n"), 2900),
      },
    });
  }

  blocks.push({ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: "*Updates*" } });
  const feed = await feedLines(feedFor(task.id, CLIENT_FEED, 10));
  blocks.push(...(feed.length > 0 ? sections(feed, 12) : sections(["_No updates yet._"])));

  if (!task.archived_at) {
    blocks.push({
      type: "input",
      block_id: `update_${Date.now().toString(36)}`,
      label: plain("Send the team an update"),
      hint: plain("Anyone who opens this story sees it, and its owner gets a message."),
      element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2000 },
    });
  }

  return {
    type: "modal",
    callback_id: DESK.clientPanel,
    private_metadata: JSON.stringify({ taskId: task.id }),
    title: plain(clip(task.jira_key ?? ref(task), 24)),
    ...(task.archived_at ? {} : { submit: plain("Send") }),
    close: plain("Close"),
    blocks,
  };
}

/** One person's sprint, grouped like a board. No time — clients see this. */
export async function personView(route: Route, accountId: string): Promise<View> {
  const stories = deskStories(route);
  const unassigned = accountId === "unassigned";
  const own = stories.filter((story) => (unassigned ? !story.jira_assignee : story.jira_assignee === accountId));
  const others: Array<{ subtask: Subtask; story: Task }> = [];
  if (!unassigned) {
    for (const story of stories) {
      if (story.jira_assignee === accountId) continue;
      for (const subtask of subtasksFor(story.id)) {
        if (subtask.jira_assignee === accountId) others.push({ subtask, story });
      }
    }
  }

  const name = unassigned
    ? "Unassigned"
    : await ownerLabel({ assignee: slackUserFor(accountId), jira_assignee: accountId }, "client");

  const lines: string[] = [];
  for (const bucket of ORDER) {
    const mine = own.filter((story) => bucketOf(story.bucket) === bucket);
    const theirs = others.filter(({ subtask }) => (subtask.done_at ? "done" : bucketOf(subtask.bucket)) === bucket);
    if (mine.length + theirs.length === 0) continue;

    const rows = mine.map((story) => {
      const subtasks = subtasksFor(story.id);
      return dot(
        `*${story.jira_key}*  ${story.title}`,
        subtasks.length > 0 ? `${subtasks.filter((subtask) => subtask.done_at || subtask.bucket === "done").length} of ${subtasks.length} subtasks` : null,
        carriedNote(story),
      );
    });
    rows.push(...theirs.map(({ subtask, story }) => `↳ *${subtask.jira_key}*  ${subtask.title} · on ${story.jira_key}`));
    lines.push(`${BUCKET_STYLE[bucket].icon} *${BUCKET_STYLE[bucket].label} · ${rows.length}*\n${rows.join("\n")}`);
  }

  return {
    type: "modal",
    title: plain(clip(name, 24)),
    close: plain("Close"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${unassigned ? "❔" : "👤"} *${name}* · ${sprintLine(currentSprint(route))}` } },
      ...sections(lines.length > 0 ? lines : ["_Nothing here this sprint._"]),
      { type: "context", elements: [{ type: "mrkdwn", text: "Pick a story from the desk to open it." }] },
    ],
  };
}

