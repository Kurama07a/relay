import { db } from "./db.js";
import { secondsByEngineer } from "./sessions.js";
import { slabSeconds } from "./slabs.js";

/**
 * The slab each unit of work was logged as when it was closed.
 *
 * A unit is a subtask, or a task's own time — an ad-hoc request, or a story
 * with no subtasks. Slabs are fixed per engineer, from the exact total across
 * every session, at the moment the unit is closed. Storing the result is what
 * keeps the figure a client was told from drifting if the rules change later.
 */

export interface WorkLog {
  id: number;
  task_id: number;
  subtask_id: number | null;
  engineer: string;
  exact_seconds: number;
  slab_seconds: number;
  closed_at: string;
}

export interface ClosedUnit {
  exactSeconds: number;
  slabSeconds: number;
  engineers: Array<{ engineer: string; exactSeconds: number; slabSeconds: number }>;
}

/**
 * Logs a unit from its sessions, replacing any earlier log for it — closing
 * something twice recomputes from the new exact total rather than adding a
 * second slab on top of the first.
 */
export function closeUnit(taskId: number, subtaskId: number | null): ClosedUnit {
  const closedAt = new Date().toISOString();
  const engineers = [...secondsByEngineer(taskId, subtaskId)]
    .filter(([, seconds]) => seconds > 0)
    .map(([engineer, exactSeconds]) => ({ engineer, exactSeconds, slabSeconds: slabSeconds(exactSeconds) }));

  db.transaction(() => {
    db.prepare(`DELETE FROM work_logs WHERE task_id = ? AND subtask_id IS ?`).run(taskId, subtaskId);
    const insert = db.prepare(
      `INSERT INTO work_logs (task_id, subtask_id, engineer, exact_seconds, slab_seconds, closed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of engineers) {
      insert.run(taskId, subtaskId, entry.engineer, entry.exactSeconds, entry.slabSeconds, closedAt);
    }
  })();

  return {
    exactSeconds: engineers.reduce((sum, entry) => sum + entry.exactSeconds, 0),
    slabSeconds: engineers.reduce((sum, entry) => sum + entry.slabSeconds, 0),
    engineers,
  };
}

export function logsFor(taskId: number): WorkLog[] {
  return db.prepare(`SELECT * FROM work_logs WHERE task_id = ? ORDER BY id`).all(taskId) as WorkLog[];
}

/** Everything logged against a task: its own time plus every closed subtask. */
export function loggedSeconds(taskId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(slab_seconds), 0) AS total FROM work_logs WHERE task_id = ?`)
    .get(taskId) as { total: number };
  return row.total;
}

export function loggedForSubtask(subtaskId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(slab_seconds), 0) AS total FROM work_logs WHERE subtask_id = ?`)
    .get(subtaskId) as { total: number };
  return row.total;
}
