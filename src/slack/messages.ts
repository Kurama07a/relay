/**
 * Slack's `message` event covers a lot of ground — edits, deletions, channel
 * joins, bot posts. This narrows it to "a human said something", which is the
 * only case any of our handlers care about.
 */
export interface HumanMessage {
  channel: string;
  ts: string;
  /** Present when the message is a reply inside a thread. */
  threadTs: string | null;
  user: string;
  text: string;
}

/** Subtypes that still represent a person typing into the channel. */
const HUMAN_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

export function asHumanMessage(event: unknown, botUserId: string): HumanMessage | null {
  const message = event as {
    channel?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    subtype?: string;
    bot_id?: string;
  };

  if (!message.channel || !message.ts || !message.user) return null;
  if (message.bot_id) return null;
  if (message.user === botUserId) return null;
  if (message.subtype && !HUMAN_SUBTYPES.has(message.subtype)) return null;

  const text = (message.text ?? "").trim();
  if (!text) return null;

  return {
    channel: message.channel,
    ts: message.ts,
    threadTs: message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : null,
    user: message.user,
    text,
  };
}

/** Removes `<@U123>` mentions of the bot so relayed text reads naturally. */
export function stripMention(text: string, botUserId: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").replace(/\s+/g, " ").trim();
}

export function mentionsBot(text: string, botUserId: string): boolean {
  return Boolean(botUserId) && text.includes(`<@${botUserId}>`);
}
