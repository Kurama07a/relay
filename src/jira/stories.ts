import { db } from "../db.js";
import type { Task } from "../store.js";
import type { JiraSprint } from "./client.js";

/**
 * The ledger's side of a Jira sprint: stories (which are tasks), their
 * subtasks, and the sprints themselves. Database only — no Jira or Slack calls.
 */

export interface Subtask {
  id: number;
  task_id: number;
  jira_issue_id: string;
  jira_key: string;
  title: string;
  jira_status: string | null;
  bucket: string | null;
  jira_assignee: string | null;
  assignee: string | null;
  jira_updated_at: string | null;
  done_at: string | null;
  done_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SprintRow {
  jira_sprint_id: number;
  board_id: number;
  name: string;
  state: string;
  start_at: string | null;
  end_at: string | null;
  completed_at: string | null;
  polled_until: string | null;
  updated_at: string;
}

const now = () => new Date().toISOString();

export function storyByIssueId(issueId: string): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE jira_issue_id = ?`).get(issueId) as Task | undefined;
}

/** A story by its Jira key, however it was typed. Live stories win over archived ones. */
export function storyByKey(key: string): Task | undefined {
  return db
    .prepare(`SELECT * FROM tasks WHERE source = 'jira' AND UPPER(jira_key) = UPPER(?) ORDER BY archived_at IS NOT NULL, id DESC`)
    .get(key.trim()) as Task | undefined;
}

/** Stories still on a board's sprint, i.e. not archived. */
export function liveStories(boardId: number): Task[] {
  return db
    .prepare(
      `SELECT t.* FROM tasks t JOIN sprints s ON s.jira_sprint_id = t.sprint_id
       WHERE t.source = 'jira' AND t.archived_at IS NULL AND s.board_id = ?
       ORDER BY t.jira_key`,
    )
    .all(boardId) as Task[];
}

export function subtasksFor(taskId: number): Subtask[] {
  return db
    .prepare(`SELECT * FROM subtasks WHERE task_id = ? AND archived_at IS NULL ORDER BY id`)
    .all(taskId) as Subtask[];
}

export function getSubtask(id: number): Subtask | undefined {
  return db.prepare(`SELECT * FROM subtasks WHERE id = ?`).get(id) as Subtask | undefined;
}

/** Finds a story's subtask by its Jira key, however it was typed. */
export function subtaskByKey(taskId: number, key: string): Subtask | undefined {
  return db
    .prepare(`SELECT * FROM subtasks WHERE task_id = ? AND UPPER(jira_key) = UPPER(?) AND archived_at IS NULL`)
    .get(taskId, key.trim()) as Subtask | undefined;
}

export interface SubtaskInput {
  jiraIssueId: string;
  key: string;
  title: string;
  status: string | null;
  bucket: string | null;
  jiraAssignee: string | null;
  assignee: string | null;
  updatedAt: string | null;
}

/** Records a subtask as Jira reports it. Returns whether anything changed. */
export function upsertSubtask(taskId: number, input: SubtaskInput): boolean {
  const existing = db.prepare(`SELECT * FROM subtasks WHERE jira_issue_id = ?`).get(input.jiraIssueId) as
    | Subtask
    | undefined;

  if (existing && existing.jira_updated_at === input.updatedAt && existing.task_id === taskId && !existing.archived_at) {
    // The Slack link can change without Jira noticing, when someone is linked later.
    if (existing.assignee !== input.assignee) {
      db.prepare(`UPDATE subtasks SET assignee = ?, updated_at = ? WHERE id = ?`).run(input.assignee, now(), existing.id);
      return true;
    }
    return false;
  }

  const timestamp = now();
  db.prepare(
    `INSERT INTO subtasks (task_id, jira_issue_id, jira_key, title, jira_status, bucket, jira_assignee, assignee,
                           jira_updated_at, created_at, updated_at)
     VALUES (@taskId, @jiraIssueId, @key, @title, @status, @bucket, @jiraAssignee, @assignee, @updatedAt, @timestamp, @timestamp)
     ON CONFLICT(jira_issue_id) DO UPDATE SET
       task_id = excluded.task_id, jira_key = excluded.jira_key, title = excluded.title,
       jira_status = excluded.jira_status, bucket = excluded.bucket, jira_assignee = excluded.jira_assignee,
       assignee = excluded.assignee, jira_updated_at = excluded.jira_updated_at,
       archived_at = NULL, updated_at = excluded.updated_at`,
  ).run({ ...input, taskId, timestamp });
  return true;
}

/** Subtasks Jira no longer lists under their story — moved or deleted. */
export function archiveMissingSubtasks(taskId: number, presentIssueIds: string[]): number {
  const present = new Set(presentIssueIds);
  let archived = 0;
  for (const subtask of subtasksFor(taskId)) {
    if (present.has(subtask.jira_issue_id)) continue;
    db.prepare(`UPDATE subtasks SET archived_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), subtask.id);
    archived++;
  }
  return archived;
}

export function markSubtaskDone(id: number, by: string): void {
  db.prepare(`UPDATE subtasks SET done_at = ?, done_by = ?, updated_at = ? WHERE id = ?`).run(now(), by, now(), id);
}

export function reopenSubtask(id: number): void {
  db.prepare(`UPDATE subtasks SET done_at = NULL, done_by = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
}

export function upsertSprint(boardId: number, sprint: JiraSprint): SprintRow {
  db.prepare(
    `INSERT INTO sprints (jira_sprint_id, board_id, name, state, start_at, end_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jira_sprint_id) DO UPDATE SET
       board_id = excluded.board_id, name = excluded.name, state = excluded.state, start_at = excluded.start_at,
       end_at = excluded.end_at, completed_at = excluded.completed_at, updated_at = excluded.updated_at`,
  ).run(
    sprint.id,
    boardId,
    sprint.name,
    sprint.state,
    sprint.startDate ?? null,
    sprint.endDate ?? null,
    sprint.completeDate ?? null,
    now(),
  );
  return getSprint(sprint.id)!;
}

export function getSprint(id: number): SprintRow | undefined {
  return db.prepare(`SELECT * FROM sprints WHERE jira_sprint_id = ?`).get(id) as SprintRow | undefined;
}

/** The sprint Relay last saw running on a board. */
export function storedActiveSprint(boardId: number): SprintRow | undefined {
  return db
    .prepare(`SELECT * FROM sprints WHERE board_id = ? AND state = 'active' ORDER BY start_at DESC LIMIT 1`)
    .get(boardId) as SprintRow | undefined;
}

export function markPolled(sprintId: number): void {
  db.prepare(`UPDATE sprints SET polled_until = ? WHERE jira_sprint_id = ?`).run(now(), sprintId);
}
