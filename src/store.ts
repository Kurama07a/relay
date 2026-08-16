import { db } from "./db.js";

export type TaskStatus =
  | "triage" // relayed to the team, nobody has claimed it
  | "open" // claimed + assigned, not started
  | "in_progress"
  | "blocked"
  | "done"
  | "dismissed"; // triaged away, no work needed

export type TaskKind = "bug" | "feature" | "review" | "question" | "request";

export interface Task {
  id: number;
  status: TaskStatus;
  kind: TaskKind;
  title: string;
  body: string;
  client_channel: string;
  client_ts: string;
  client_user: string;
  client_permalink: string | null;
  internal_channel: string;
  internal_ts: string;
  assignee: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface NewTask {
  kind: TaskKind;
  title: string;
  body: string;
  client_channel: string;
  client_ts: string;
  client_user: string;
  client_permalink: string | null;
  internal_channel: string;
  internal_ts: string;
}

/** Human-facing ticket reference, e.g. `REL-12`. */
export function ref(task: Pick<Task, "id">): string {
  return `REL-${task.id}`;
}

/** Parses `REL-12`, `rel-12`, `#12` or `12` into a numeric id. */
export function parseRef(input: string): number | null {
  const match = /^(?:rel[-\s]?|#)?(\d+)$/i.exec(input.trim());
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
}

const now = () => new Date().toISOString();

export function createTask(input: NewTask): Task {
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO tasks (
         status, kind, title, body,
         client_channel, client_ts, client_user, client_permalink,
         internal_channel, internal_ts,
         created_at, updated_at
       ) VALUES (
         'triage', @kind, @title, @body,
         @client_channel, @client_ts, @client_user, @client_permalink,
         @internal_channel, @internal_ts,
         @timestamp, @timestamp
       )`,
    )
    .run({ ...input, timestamp });

  return getTask(Number(result.lastInsertRowid))!;
}

/** Only used to roll back a task row whose relay post failed to send. */
export function deleteTask(id: number): void {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

export function getTask(id: number): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | undefined;
}

export function getByInternalMessage(channel: string, ts: string): Task | undefined {
  return db
    .prepare(`SELECT * FROM tasks WHERE internal_channel = ? AND internal_ts = ?`)
    .get(channel, ts) as Task | undefined;
}

export function getByClientMessage(channel: string, ts: string): Task | undefined {
  return db
    .prepare(`SELECT * FROM tasks WHERE client_channel = ? AND client_ts = ?`)
    .get(channel, ts) as Task | undefined;
}

export function updateTask(id: number, fields: Partial<Task>): Task {
  const columns = Object.keys(fields).filter((key) => key !== "id");
  if (columns.length > 0) {
    const assignments = columns.map((column) => `${column} = @${column}`).join(", ");
    db.prepare(`UPDATE tasks SET ${assignments}, updated_at = @updated_at WHERE id = @id`).run({
      ...fields,
      id,
      updated_at: now(),
    });
  }
  return getTask(id)!;
}

export function listTasks(options: { status?: TaskStatus[]; assignee?: string; limit?: number }): Task[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.status?.length) {
    // Statuses are a closed union, but bind them anyway rather than interpolating.
    const placeholders = options.status.map((_, index) => `@status${index}`);
    options.status.forEach((status, index) => {
      params[`status${index}`] = status;
    });
    clauses.push(`status IN (${placeholders.join(", ")})`);
  }
  if (options.assignee) {
    clauses.push(`assignee = @assignee`);
    params.assignee = options.assignee;
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.limit = options.limit ?? 25;

  return db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY id DESC LIMIT @limit`)
    .all(params) as Task[];
}

export function countByStatus(): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS count FROM tasks GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export function addEvent(
  taskId: number,
  type: string,
  actor: string | null,
  detail?: string,
): void {
  db.prepare(
    `INSERT INTO events (task_id, type, actor, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, type, actor, detail ?? null, now());
}

export function listEvents(taskId: number, limit = 20): Array<{
  type: string;
  actor: string | null;
  detail: string | null;
  created_at: string;
}> {
  return db
    .prepare(
      `SELECT type, actor, detail, created_at FROM events
       WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(taskId, limit) as Array<{
    type: string;
    actor: string | null;
    detail: string | null;
    created_at: string;
  }>;
}
