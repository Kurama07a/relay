import { client } from "./app.js";
import { log } from "../log.js";
import { db } from "../db.js";

const userNames = new Map<string, string>();
const channelNames = new Map<string, string>();

/**
 * Writes a resolved name through to the database as well as memory, so exports
 * and reports can show people's names without a live Slack connection.
 */
export function remember(id: string, kind: "user" | "channel", name: string): void {
  (kind === "user" ? userNames : channelNames).set(id, name);
  try {
    db.prepare(
      `INSERT INTO slack_names (id, kind, name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(id, kind, name, new Date().toISOString());
  } catch (error) {
    log.debug(`could not cache name for ${id}`, error);
  }
}

/**
 * Best known name for a user or channel, without calling Slack. Falls back to
 * the raw id, which is at least still a usable identifier.
 */
export function knownName(id: string | null | undefined): string {
  if (!id) return "";
  const cached = userNames.get(id) ?? channelNames.get(id);
  if (cached) return cached;
  const row = db.prepare(`SELECT name FROM slack_names WHERE id = ?`).get(id) as
    | { name: string }
    | undefined;
  return row?.name ?? id;
}

/**
 * Display name for a user id.
 *
 * Used when writing INTO a client channel: a raw `<@U123>` mention of an
 * internal teammate does not resolve for people on the other side of a Slack
 * Connect channel, so they would see a bare id. Plain text always renders.
 */
export async function userName(userId: string): Promise<string> {
  if (!userId) return "someone";
  const cached = userNames.get(userId);
  if (cached) return cached;

  try {
    const result = await client.users.info({ user: userId });
    const profile = result.user?.profile;
    const name =
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.name ||
      userId;
    remember(userId, "user", name);
    return name;
  } catch (error) {
    log.warn(`could not resolve user ${userId}`, error);
    // A name learned earlier is better than falling back to a raw id.
    return knownName(userId);
  }
}

/** `#channel-name` for a channel id, falling back to the raw id. */
export async function channelName(channelId: string): Promise<string> {
  if (!channelId) return "unknown";
  const cached = channelNames.get(channelId);
  if (cached) return cached;

  try {
    const result = await client.conversations.info({ channel: channelId });
    const name = result.channel?.name ? `#${result.channel.name}` : channelId;
    remember(channelId, "channel", name);
    return name;
  } catch (error) {
    log.warn(`could not resolve channel ${channelId}`, error);
    return knownName(channelId);
  }
}

/** Mention markup — only safe inside the internal workspace's own channel. */
export function mention(userId: string | null | undefined): string {
  return userId ? `<@${userId}>` : "_unassigned_";
}
