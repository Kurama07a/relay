import { botUserId, client } from "../slack/app.js";
import { postToInternal, refreshInternalMessage } from "../slack/actions.js";
import { mention } from "../slack/names.js";
import { ICON } from "../slack/design.js";
import { config } from "../config.js";
import { log } from "../log.js";
import * as settings from "../settings.js";
import { listRoutes, type Route } from "../routes.js";
import { addEvent, createTask, updateTask, type Task, type TaskKind } from "../store.js";
import { endSession, openSessionsOn } from "../sessions.js";
import {
  activeSprint,
  describeJiraError,
  fieldIds,
  issueById,
  jiraConfigured,
  searchIssues,
  sprintById,
  type JiraIssue,
  type JiraSprint,
} from "./client.js";
import { bucketForStatus, guessBucket, isBucket, type Bucket } from "./buckets.js";
import { displayName, slackUserFor, syncMembers } from "./members.js";
import {
  archiveMissingSubtasks,
  liveStories,
  markPolled,
  storedActiveSprint,
  storyByIssueId,
  subtasksFor,
  upsertSprint,
  upsertSubtask,
  type SprintRow,
} from "./stories.js";

/**
 * Keeps the ledger in step with each connected board's active sprint.
 *
 * Every poll reads the whole sprint — one search for its stories and one per
 * fifty stories for their subtasks. For a sprint of a few dozen stories that's
 * cheap, and it's what makes the sync self-correcting: nothing depends on
 * having seen a particular change, so a missed poll or a redeploy costs a few
 * minutes' delay and nothing else. Reads only; Jira is never changed.
 */

interface IssueFields {
  summary?: string;
  description?: unknown;
  status?: { id: string; name: string };
  assignee?: {
    accountId: string;
    displayName: string;
    emailAddress?: string;
    active?: boolean;
    accountType?: string;
  } | null;
  issuetype?: { name: string; subtask?: boolean; hierarchyLevel?: number };
  parent?: { id: string; key: string };
  updated?: string;
  [custom: string]: unknown;
}

/** One line on a sprint board: a story, or a subtask shown under its owner. */
export interface BoardItem {
  key: string;
  title: string;
  bucket: Bucket;
  jiraAssignee: string | null;
  slackUser: string | null;
  /** The story's ledger row, when it has threads. */
  taskId: number | null;
  /** Set for subtasks: the story they belong to. */
  parentKey: string | null;
}

export interface BoardSnapshot {
  route: Route;
  /** Null between sprints, when stories carried over wait for the next one. */
  sprint: SprintRow | null;
  stories: BoardItem[];
  subtasks: BoardItem[];
  takenAt: string;
}

const STORY_FIELDS = ["summary", "description", "status", "assignee", "issuetype", "parent", "updated"];
const SUBTASK_FIELDS = ["summary", "status", "assignee", "parent", "updated"];

const snapshots = new Map<number, BoardSnapshot>();
const listeners: Array<(snapshot: BoardSnapshot) => void> = [];
const warnedUnlinked = new Set<string>();

/** Called after every sync of a board, with what it now looks like. */
export function onBoardSynced(listener: (snapshot: BoardSnapshot) => void): void {
  listeners.push(listener);
}

export function latestSnapshot(routeId: number): BoardSnapshot | undefined {
  return snapshots.get(routeId);
}

const fieldsOf = (issue: JiraIssue) => issue.fields as IssueFields;

let customFields: { sprint?: string; flagged?: string } | null = null;

/** "Sprint" and "Flagged" are custom fields whose ids differ per Jira site. */
async function customFieldIds(): Promise<{ sprint?: string; flagged?: string }> {
  if (!customFields) {
    const ids = await fieldIds(["Sprint", "Flagged"]);
    customFields = { sprint: ids.Sprint, flagged: ids.Flagged };
  }
  return customFields;
}

function kindOf(issueType: string | undefined): TaskKind {
  const name = (issueType ?? "").toLowerCase();
  if (name.includes("bug")) return "bug";
  if (/feature|story|improvement/.test(name)) return "feature";
  return "request";
}

/** Jira descriptions are rich-text documents; a card only needs the words. */
export function plainText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const { type, text, content } = node as { type?: string; text?: string; content?: unknown[] };
  if (type === "text") return text ?? "";
  if (type === "hardBreak") return "\n";
  const inner = (content ?? []).map(plainText).join("");
  return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(type ?? "") ? `${inner}\n` : inner;
}

function asBucket(value: string | null): Bucket {
  return value && isBucket(value) ? value : "todo";
}

/** Flagged in Jira means blocked, whatever column the issue sits in. */
export function bucketFor(boardId: number, fields: IssueFields, flaggedField?: string): Bucket {
  const flag = flaggedField ? fields[flaggedField] : null;
  if (Array.isArray(flag) ? flag.length > 0 : Boolean(flag)) return "blocked";
  if (!fields.status) return "todo";
  return bucketForStatus(boardId, fields.status.id) ?? guessBucket(fields.status.name);
}

/** Records whoever Jira says owns an issue, and who they are in Slack if linked. */
function ownerOf(fields: IssueFields): { jiraAssignee: string | null; slackUser: string | null } {
  const assignee = fields.assignee;
  if (!assignee?.accountId) return { jiraAssignee: null, slackUser: null };
  syncMembers([
    {
      accountId: assignee.accountId,
      displayName: assignee.displayName,
      emailAddress: assignee.emailAddress,
      active: assignee.active ?? true,
      accountType: assignee.accountType ?? "atlassian",
    },
  ]);
  return { jiraAssignee: assignee.accountId, slackUser: slackUserFor(assignee.accountId) };
}

async function tellControlChannel(text: string): Promise<void> {
  const channel = settings.get(settings.KEYS.controlChannel);
  if (!channel) {
    log.info(text);
    return;
  }
  try {
    await client.chat.postMessage({ channel, text, unfurl_links: false });
  } catch (error) {
    log.warn("could not post to the control channel", error);
  }
}

async function fetchSubtasks(parentKeys: string[], flaggedField?: string): Promise<JiraIssue[]> {
  const found: JiraIssue[] = [];
  for (let start = 0; start < parentKeys.length; start += 50) {
    const chunk = parentKeys.slice(start, start + 50);
    found.push(
      ...(await searchIssues(`parent in (${chunk.join(",")}) ORDER BY key ASC`, [
        ...SUBTASK_FIELDS,
        ...(flaggedField ? [flaggedField] : []),
      ])),
    );
  }
  return found;
}

/** Brings a story's subtasks in line with Jira. Returns whether anything changed. */
function syncSubtasks(boardId: number, taskId: number, children: JiraIssue[], flaggedField?: string): boolean {
  let changed = false;
  for (const child of children) {
    const fields = fieldsOf(child);
    const owner = ownerOf(fields);
    changed =
      upsertSubtask(taskId, {
        jiraIssueId: child.id,
        key: child.key,
        title: fields.summary?.trim() || child.key,
        status: fields.status?.name ?? null,
        bucket: bucketFor(boardId, fields, flaggedField),
        jiraAssignee: owner.jiraAssignee,
        assignee: owner.slackUser,
        updatedAt: fields.updated ?? null,
      }) || changed;
  }
  return archiveMissingSubtasks(taskId, children.map((child) => child.id)) > 0 || changed;
}

async function createStory(
  route: Route,
  sprint: JiraSprint,
  issue: JiraIssue,
  children: JiraIssue[],
  facts: { jiraAssignee: string | null; slackUser: string | null; bucket: Bucket; title: string },
  flaggedField?: string,
): Promise<Task> {
  const fields = fieldsOf(issue);
  const draft = createTask({
    kind: kindOf(fields.issuetype?.name),
    title: facts.title,
    body: plainText(fields.description).trim().slice(0, 3000) || facts.title,
    client_channel: route.sprint_channel!,
    // Stories have no messages of their own; these only keep the columns unique.
    client_ts: `desk:jira:${issue.id}:client`,
    client_user: botUserId || "jira",
    client_permalink: null,
    internal_channel: route.team_channel,
    internal_ts: `desk:jira:${issue.id}:internal`,
  });

  const story = updateTask(draft.id, {
    source: "jira",
    status: "open",
    claimed_at: new Date().toISOString(),
    jira_issue_id: issue.id,
    jira_key: issue.key,
    jira_status: fields.status?.name ?? null,
    jira_assignee: facts.jiraAssignee,
    assignee: facts.slackUser,
    bucket: facts.bucket,
    jira_updated_at: fields.updated ?? null,
    sprint_id: sprint.id,
  });
  syncSubtasks(route.jira_board_id!, story.id, children, flaggedField);

  addEvent(story.id, "jira:created", null, `${issue.key} in ${sprint.name}`);
  log.info(`recorded ${issue.key} (${sprint.name})`);

  if (facts.jiraAssignee && !facts.slackUser && !warnedUnlinked.has(facts.jiraAssignee)) {
    warnedUnlinked.add(facts.jiraAssignee);
    await tellControlChannel(
      `${ICON.warning} ${displayName(facts.jiraAssignee)} owns ${issue.key} in Jira but isn't linked to Slack. ` +
        "Link them in `/relay setup` → Jira members.",
    );
  }

  return story;
}

/** Creates or updates one story, assigned or not. */
async function reconcileStory(
  route: Route,
  sprint: JiraSprint,
  issue: JiraIssue,
  children: JiraIssue[],
  flaggedField?: string,
): Promise<Task> {
  const boardId = route.jira_board_id!;
  const fields = fieldsOf(issue);
  const { jiraAssignee, slackUser } = ownerOf(fields);
  const bucket = bucketFor(boardId, fields, flaggedField);
  const title = fields.summary?.trim() || issue.key;
  let story = storyByIssueId(issue.id);

  if (!story) {
    return createStory(route, sprint, issue, children, { jiraAssignee, slackUser, bucket, title }, flaggedField);
  }

  const notes: string[] = [];
  const updates: Partial<Task> = {};

  if (story.archived_at) {
    updates.archived_at = null;
    notes.push(`back in ${sprint.name}`);
  }
  if (story.sprint_id !== sprint.id) updates.sprint_id = sprint.id;

  if (story.jira_updated_at !== (fields.updated ?? null)) {
    if (story.jira_status !== (fields.status?.name ?? null)) notes.push(`moved to *${fields.status?.name}*`);
    if (story.jira_assignee !== jiraAssignee) {
      notes.push(jiraAssignee ? `assigned to ${slackUser ? mention(slackUser) : displayName(jiraAssignee)}` : "unassigned");
    }
    if (story.title !== title) notes.push(`renamed to "${title}"`);
    Object.assign(updates, {
      title,
      kind: kindOf(fields.issuetype?.name),
      jira_key: issue.key,
      jira_status: fields.status?.name ?? null,
      jira_assignee: jiraAssignee,
      jira_updated_at: fields.updated ?? null,
    });
  }
  // A link made in Slack, or a column remapped, changes these without Jira noticing.
  if (story.assignee !== slackUser) updates.assignee = slackUser;
  if (story.bucket !== bucket) updates.bucket = bucket;

  const subtasksChanged = syncSubtasks(boardId, story.id, children, flaggedField);

  if (Object.keys(updates).length > 0) story = updateTask(story.id, updates);
  if (notes.length > 0) {
    addEvent(story.id, "jira:update", null, notes.join("; "));
    await postToInternal(story, `${ICON.sync} Jira: ${notes.join(", ")}.`);
  }
  if (Object.keys(updates).length > 0 || subtasksChanged) await refreshInternalMessage(story);
  return story;
}

/** Hides a story that's no longer in the sprint. Its time and history stay. */
async function archiveStory(story: Task, reason: string): Promise<void> {
  for (const session of openSessionsOn(story.id)) endSession(session.id, "archived");
  const archived = updateTask(story.id, { archived_at: new Date().toISOString() });
  addEvent(story.id, "archived", null, reason);
  await postToInternal(archived, `${ICON.archived} Archived — ${reason}. Its time and history stay in the ledger.`);
}

/**
 * A sprint Relay saw running has ended. Stories Jira moved into another sprint
 * carry over with their threads and time; the rest are archived.
 */
async function rollover(route: Route, previous: SprintRow, sprintField?: string): Promise<void> {
  const boardId = route.jira_board_id!;
  const fresh = await sprintById(previous.jira_sprint_id).catch(() => null);
  upsertSprint(boardId, {
    ...(fresh ?? {
      id: previous.jira_sprint_id,
      name: previous.name,
      startDate: previous.start_at ?? undefined,
      endDate: previous.end_at ?? undefined,
      completeDate: new Date().toISOString(),
    }),
    // It stopped being the active sprint, which is all that matters here.
    state: "closed",
  });

  const stories = liveStories(boardId).filter((story) => story.sprint_id === previous.jira_sprint_id);
  let carried = 0;

  for (const story of stories) {
    const issue = story.jira_issue_id && sprintField ? await issueById(story.jira_issue_id, [sprintField]) : null;
    const sprints = ((sprintField ? issue?.fields[sprintField] : null) ?? []) as Array<{
      id: number;
      name: string;
      state: JiraSprint["state"];
      startDate?: string;
      endDate?: string;
    }>;
    const next = sprints.find((sprint) => sprint.state === "active") ?? sprints.find((sprint) => sprint.state === "future");

    if (!next) {
      await archiveStory(story, `${previous.name} closed`);
      continue;
    }

    upsertSprint(boardId, next);
    const updated = updateTask(story.id, {
      sprint_id: next.id,
      carried_count: story.carried_count + 1,
      carried_from_sprint_id: previous.jira_sprint_id,
    });
    addEvent(story.id, "jira:carried", null, `${previous.name} → ${next.name}`);
    await postToInternal(updated, `${ICON.carried} Carried over from ${previous.name} into ${next.name}.`);
    carried++;
  }

  if (stories.length > 0) {
    await tellControlChannel(
      `${ICON.note} *${previous.name}* closed: ${carried} carried over, ${stories.length - carried} archived.`,
    );
  }
}

function buildSnapshot(route: Route, sprint: SprintRow | null): BoardSnapshot {
  const stories: BoardItem[] = [];
  const subtasks: BoardItem[] = [];

  for (const story of liveStories(route.jira_board_id!)) {
    if (sprint && story.sprint_id !== sprint.jira_sprint_id) continue;
    stories.push({
      key: story.jira_key ?? "",
      title: story.title,
      bucket: asBucket(story.bucket),
      jiraAssignee: story.jira_assignee,
      slackUser: story.assignee,
      taskId: story.id,
      parentKey: null,
    });
    for (const subtask of subtasksFor(story.id)) {
      subtasks.push({
        key: subtask.jira_key,
        title: subtask.title,
        bucket: subtask.done_at ? "done" : asBucket(subtask.bucket),
        jiraAssignee: subtask.jira_assignee,
        slackUser: subtask.assignee,
        taskId: story.id,
        parentKey: story.jira_key,
      });
    }
  }

  return { route, sprint, stories, subtasks, takenAt: new Date().toISOString() };
}

async function syncBoard(route: Route): Promise<void> {
  const boardId = route.jira_board_id!;
  const custom = await customFieldIds();
  const active = await activeSprint(boardId);
  const previous = storedActiveSprint(boardId);

  if (previous && previous.jira_sprint_id !== active?.id) {
    await rollover(route, previous, custom.sprint);
  }

  let sprint: SprintRow | null = null;

  if (active) {
    sprint = upsertSprint(boardId, active);
    const found = await searchIssues(`sprint = ${active.id} ORDER BY key ASC`, [
      ...STORY_FIELDS,
      ...(custom.flagged ? [custom.flagged] : []),
    ]);
    // Epics and subtasks aren't stories; subtasks are fetched under their parents.
    const stories = found.filter((issue) => {
      const type = fieldsOf(issue).issuetype;
      return !type?.subtask && (type?.hierarchyLevel ?? 0) < 1;
    });
    const children = await fetchSubtasks(stories.map((story) => story.key), custom.flagged);
    const seen = new Set<string>();

    for (const issue of stories) {
      seen.add(issue.id);
      const own = children.filter((child) => fieldsOf(child).parent?.id === issue.id);
      await reconcileStory(route, active, issue, own, custom.flagged);
    }

    // Stories that left the sprint without it closing — sent to the backlog, or deleted.
    for (const story of liveStories(boardId)) {
      if (story.sprint_id === active.id && story.jira_issue_id && !seen.has(story.jira_issue_id)) {
        await archiveStory(story, `it left ${active.name} in Jira`);
      }
    }
    markPolled(active.id);
  }

  const snapshot = buildSnapshot(route, sprint);
  snapshots.set(route.id, snapshot);
  for (const listener of listeners) listener(snapshot);
}

let running: Promise<void> | null = null;

/** Syncs every connected board now. Overlapping calls share one run. */
export function syncJiraNow(): Promise<void> {
  if (!running) {
    running = (async () => {
      const routes = listRoutes().filter((route) => route.jira_board_id && route.sprint_channel && route.jira_project_key);
      for (const route of routes) {
        try {
          await syncBoard(route);
        } catch (error) {
          log.warn(`jira sync for board ${route.jira_board_id} failed: ${describeJiraError(error)}`);
        }
      }
    })().finally(() => {
      running = null;
    });
  }
  return running;
}

export function startJiraSync(): NodeJS.Timeout | null {
  if (!jiraConfigured()) return null;
  void syncJiraNow();
  const timer = setInterval(() => void syncJiraNow(), config.jira.pollMinutes * 60_000);
  timer.unref();
  log.info(`jira sync every ${config.jira.pollMinutes} min`);
  return timer;
}
