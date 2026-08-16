import { db } from "./db.js";

/**
 * Runtime configuration that lives in the database instead of `.env`, so it can
 * be changed from Slack without touching a file or restarting anything.
 *
 * `.env` still holds the things that genuinely belong to the machine — tokens,
 * database path, log level. Everything about *how the team works* belongs here.
 */
export const KEYS = {
  sheetId: "sheet_id",
  sheetTitle: "sheet_title",
  controlChannel: "control_channel",
  claimEmoji: "claim_emoji",
  dismissEmoji: "dismiss_emoji",
} as const;

export function get(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function set(key: string, value: string, updatedBy?: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(key, value, new Date().toISOString(), updatedBy ?? null);
}

export function clear(key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

export function all(): Array<{ key: string; value: string; updated_at: string }> {
  return db
    .prepare(`SELECT key, value, updated_at FROM settings ORDER BY key`)
    .all() as Array<{ key: string; value: string; updated_at: string }>;
}

/**
 * Accepts a full Google Sheets URL or a bare id, and returns the id.
 * People paste the URL — asking them to extract the id is the kind of small
 * friction this whole change exists to remove.
 */
export function parseSheetId(input: string): string | null {
  const trimmed = input.trim().replace(/^<|>$/g, "");
  if (!trimmed) return null;

  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  if (fromUrl?.[1]) return fromUrl[1];

  // A bare id: Google's are long and have no slashes or spaces.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

export function sheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
