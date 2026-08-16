import { WebClient } from "@slack/web-api";
import { db } from "./db.js";
import { log } from "./log.js";

/**
 * Fills in display names for any user or channel the ledger references but
 * hasn't learned a name for yet.
 *
 * Names are normally cached as a side effect of the bot running, so this only
 * matters for rows written before that caching existed, or for a database
 * copied to a machine that has never talked to Slack. Uses its own WebClient so
 * it can run from a script without starting the socket connection.
 */
export async function backfillNames(botToken: string): Promise<number> {
  const client = new WebClient(botToken);

  const ids = new Set<string>();
  for (const row of db
    .prepare(
      `SELECT client_user AS id FROM tasks
       UNION SELECT assignee FROM tasks WHERE assignee IS NOT NULL
       UNION SELECT actor FROM events WHERE actor IS NOT NULL
       UNION SELECT engineer FROM work_sessions
       UNION SELECT client_channel FROM tasks
       UNION SELECT internal_channel FROM tasks`,
    )
    .all() as Array<{ id: string | null }>) {
    if (row.id) ids.add(row.id);
  }

  const known = new Set(
    (db.prepare(`SELECT id FROM slack_names`).all() as Array<{ id: string }>).map((r) => r.id),
  );

  const missing = [...ids].filter((id) => !known.has(id));
  if (missing.length === 0) return 0;

  const upsert = db.prepare(
    `INSERT INTO slack_names (id, kind, name, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );

  let resolved = 0;
  for (const id of missing) {
    const isChannel = /^[CGD]/.test(id);
    try {
      if (isChannel) {
        const info = await client.conversations.info({ channel: id });
        const name = info.channel?.name ? `#${info.channel.name}` : id;
        upsert.run(id, "channel", name, new Date().toISOString());
      } else {
        const info = await client.users.info({ user: id });
        const profile = info.user?.profile;
        const name =
          profile?.display_name?.trim() || profile?.real_name?.trim() || info.user?.name || id;
        upsert.run(id, "user", name, new Date().toISOString());
      }
      resolved++;
    } catch (error) {
      const reason = (error as { data?: { error?: string } })?.data?.error ?? error;
      log.debug(`could not resolve ${id}: ${reason}`);
    }
  }

  return resolved;
}
