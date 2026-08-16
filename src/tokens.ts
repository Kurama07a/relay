import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

export interface ApiToken {
  id: number;
  token_hash: string;
  slack_user_id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a token for one engineer. The plaintext is returned exactly once and
 * never stored — only its hash goes in the database.
 */
export function mintToken(slackUserId: string, label?: string): string {
  const token = `relay_${randomBytes(24).toString("base64url")}`;
  db.prepare(
    `INSERT INTO api_tokens (token_hash, slack_user_id, label, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hash(token), slackUserId, label ?? null, new Date().toISOString());
  return token;
}

/** Resolves a bearer token to the Slack user it belongs to. */
export function resolveToken(token: string): string | null {
  const candidate = hash(token);
  const rows = db
    .prepare(`SELECT * FROM api_tokens WHERE revoked_at IS NULL`)
    .all() as ApiToken[];

  // Compared in constant time so a wrong token cannot be narrowed down by timing.
  const candidateBuffer = Buffer.from(candidate, "hex");
  for (const row of rows) {
    const storedBuffer = Buffer.from(row.token_hash, "hex");
    if (
      storedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(storedBuffer, candidateBuffer)
    ) {
      db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), row.id);
      return row.slack_user_id;
    }
  }
  return null;
}

export function listTokens(): ApiToken[] {
  return db
    .prepare(`SELECT * FROM api_tokens ORDER BY id DESC`)
    .all() as ApiToken[];
}

export function revokeToken(id: number): boolean {
  const result = db
    .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function hasAnyToken(): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM api_tokens WHERE revoked_at IS NULL`)
    .get() as { count: number };
  return row.count > 0;
}
