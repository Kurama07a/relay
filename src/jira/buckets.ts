import { db } from "../db.js";
import type { BoardColumn } from "./client.js";

/**
 * The five groups a sprint board is shown in, whatever the Jira board calls
 * its columns. Mapping a board's columns onto these is a one-time admin choice,
 * pre-filled from the column names so the usual case is just "Save".
 */
export const BUCKETS = ["todo", "in_progress", "in_review", "blocked", "done"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
};

export function isBucket(value: string): value is Bucket {
  return (BUCKETS as readonly string[]).includes(value);
}

/**
 * A best guess from a column's name. Order matters: "Blocked in review" is
 * blocked, and "Ready for QA" is review rather than to do.
 */
export function guessBucket(columnName: string): Bucket {
  const name = columnName.toLowerCase();
  if (/block|on hold|imped|stuck|waiting/.test(name)) return "blocked";
  if (/review|\bqa\b|test|verif|approv|uat/.test(name)) return "in_review";
  if (/done|closed|complete|resolved|shipped|released/.test(name)) return "done";
  if (/progress|doing|develop|build|active|\bwip\b/.test(name)) return "in_progress";
  return "todo";
}

export interface BucketRow {
  board_id: number;
  jira_status_id: string;
  column_name: string;
  bucket: Bucket;
  updated_at: string;
  updated_by: string | null;
}

export function bucketsFor(boardId: number): BucketRow[] {
  return db
    .prepare(`SELECT * FROM jira_buckets WHERE board_id = ? ORDER BY rowid`)
    .all(boardId) as BucketRow[];
}

/** The saved group for a status on a board, or null if it has never been mapped. */
export function bucketForStatus(boardId: number, statusId: string): Bucket | null {
  const row = db
    .prepare(`SELECT bucket FROM jira_buckets WHERE board_id = ? AND jira_status_id = ?`)
    .get(boardId, statusId) as { bucket: Bucket } | undefined;
  return row?.bucket ?? null;
}

/** What the mapping form should show for a column: the saved choice, else a guess. */
export function savedBucketForColumn(boardId: number, column: BoardColumn): Bucket {
  for (const statusId of column.statusIds) {
    const saved = bucketForStatus(boardId, statusId);
    if (saved) return saved;
  }
  return guessBucket(column.name);
}

/**
 * Brings the saved mapping in line with the board's current columns. New
 * statuses get a guess, statuses that left the board are dropped, and anything
 * already saved — an admin's choice especially — is kept.
 *
 * Returns how many statuses were newly guessed.
 */
export function seedBuckets(boardId: number, columns: BoardColumn[]): number {
  const saved = new Map(bucketsFor(boardId).map((row) => [row.jira_status_id, row]));
  const current = new Set<string>();
  const now = new Date().toISOString();
  let guessed = 0;

  const upsert = db.prepare(
    `INSERT INTO jira_buckets (board_id, jira_status_id, column_name, bucket, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(board_id, jira_status_id) DO UPDATE SET column_name = excluded.column_name`,
  );
  const remove = db.prepare(`DELETE FROM jira_buckets WHERE board_id = ? AND jira_status_id = ?`);

  db.transaction(() => {
    for (const column of columns) {
      for (const statusId of column.statusIds) {
        current.add(statusId);
        if (!saved.has(statusId)) guessed++;
        upsert.run(boardId, statusId, column.name, guessBucket(column.name), now);
      }
    }
    for (const statusId of saved.keys()) {
      if (!current.has(statusId)) remove.run(boardId, statusId);
    }
  })();

  return guessed;
}

/** Saves an admin's choices, one group per column, replacing the board's mapping. */
export function saveBuckets(
  boardId: number,
  choices: Array<{ column: BoardColumn; bucket: Bucket }>,
  by: string,
): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO jira_buckets
       (board_id, jira_status_id, column_name, bucket, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    db.prepare(`DELETE FROM jira_buckets WHERE board_id = ?`).run(boardId);
    for (const { column, bucket } of choices) {
      for (const statusId of column.statusIds) {
        insert.run(boardId, statusId, column.name, bucket, now, by);
      }
    }
  })();
}
