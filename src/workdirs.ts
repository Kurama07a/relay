import { db } from "./db.js";
import { listTasks, type Task } from "./store.js";
import { openSessionFor } from "./sessions.js";

/**
 * Binds a working directory to the task being done in it.
 *
 * The point is to stop asking. An engineer who opens their editor in a repo is
 * almost always continuing the same work they left there, so remembering that
 * association turns "start the clock" from a command into a side effect of
 * opening the editor.
 */

/** Directories are matched exactly, so normalise separators and trailing slashes. */
export function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function remember(engineer: string, workdir: string, taskId: number): void {
  db.prepare(
    `INSERT INTO workdirs (engineer, workdir, task_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(engineer, workdir) DO UPDATE SET
       task_id = excluded.task_id, updated_at = excluded.updated_at`,
  ).run(engineer, normalizeDir(workdir), taskId, new Date().toISOString());
}

export function taskForDir(engineer: string, workdir: string): number | null {
  const row = db
    .prepare(`SELECT task_id FROM workdirs WHERE engineer = ? AND workdir = ?`)
    .get(engineer, normalizeDir(workdir)) as { task_id: number } | undefined;
  return row?.task_id ?? null;
}

export function forgetDir(engineer: string, workdir: string): void {
  db.prepare(`DELETE FROM workdirs WHERE engineer = ? AND workdir = ?`)
    .run(engineer, normalizeDir(workdir));
}

export interface Guess {
  taskId: number;
  reason: "branch" | "workdir" | "only-in-progress" | "only-assigned";
}

/**
 * Works out which task someone means when they don't say.
 *
 * Ordered by how much the signal actually implies intent: a branch named for a
 * ticket is deliberate, a remembered directory is habit, and having exactly one
 * task in flight is inference. Anything less certain returns nothing rather
 * than guessing — starting a clock on the wrong task is worse than asking.
 */
export function guessTask(
  engineer: string,
  options: { workdir?: string; branch?: string } = {},
): Guess | null {
  // A branch like `rel-7-fix-checkout` names the task outright.
  if (options.branch) {
    const match = /(?:^|[^a-z])rel[-_ ]?(\d+)/i.exec(options.branch);
    const id = match?.[1] ? Number(match[1]) : null;
    if (id && taskExists(id)) return { taskId: id, reason: "branch" };
  }

  if (options.workdir) {
    const id = taskForDir(engineer, options.workdir);
    if (id && taskExists(id)) return { taskId: id, reason: "workdir" };
  }

  const assigned = listTasks({ assignee: engineer, limit: 200 });

  const inProgress = assigned.filter((task) => task.status === "in_progress");
  if (inProgress.length === 1) return { taskId: inProgress[0]!.id, reason: "only-in-progress" };

  const live = assigned.filter((task) => task.status === "open" || task.status === "in_progress");
  if (live.length === 1) return { taskId: live[0]!.id, reason: "only-assigned" };

  return null;
}

function taskExists(id: number): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM tasks WHERE id = ?`).get(id) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

/** Human phrasing for why a task was picked, so the choice is never silent. */
export function explainGuess(guess: Guess): string {
  return {
    branch: "from your branch name",
    workdir: "you were last working on it here",
    "only-in-progress": "it's the only task you have in progress",
    "only-assigned": "it's the only task assigned to you",
  }[guess.reason];
}

/** Tasks an engineer could plausibly resume, for a disambiguation prompt. */
export function candidates(engineer: string): Task[] {
  return listTasks({ assignee: engineer, status: ["open", "in_progress", "blocked"], limit: 10 });
}

export function hasOpenSession(engineer: string): boolean {
  return Boolean(openSessionFor(engineer));
}
