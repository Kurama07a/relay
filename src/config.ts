import "dotenv/config";
import { emojiSet, overlaps } from "./emoji.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in (see SETUP.md).`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return parsed;
}

/** Parses "C123, C456" into ["C123", "C456"]. */
function list(name: string): string[] {
  return optional(name, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Slack sends reaction names without colons (`raised_hand`), so we strip any
 * the operator typed in the .env out of habit. Skin-tone variants arrive as
 * `raised_hand::skin-tone-3`, which `normalizeEmoji` in reactions.ts folds back
 * down to the base name before comparing against these.
 */
function emoji(name: string, fallback: string): string {
  return optional(name, fallback).replace(/:/g, "").trim();
}

export type IngestMode = "all" | "mention";

const ingestModeRaw = optional("INGEST_MODE", "all");
if (ingestModeRaw !== "all" && ingestModeRaw !== "mention") {
  throw new Error(`INGEST_MODE must be "all" or "mention", got "${ingestModeRaw}".`);
}

export const config = {
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    appToken: required("SLACK_APP_TOKEN"),
    signingSecret: optional("SLACK_SIGNING_SECRET", ""),
  },

  /**
   * Bootstrap only. Channel pairings live in the database and are managed with
   * `/relay setup` in Slack; these are read once on first run to migrate an
   * older `.env` setup, then ignored.
   */
  clientChannels: list("CLIENT_CHANNELS"),
  internalChannel: optional("INTERNAL_CHANNEL", ""),

  /**
   * `all`   - every top-level message in a client channel is relayed.
   * `mention` - only messages that @-mention the bot are relayed.
   */
  ingestMode: ingestModeRaw as IngestMode,

  emoji: {
    /**
     * Reacting with this in the internal channel claims + assigns the task.
     * Expands to include Slack's aliases for the same glyph, so ✋ works whether
     * the reacting client calls it `raised_hand` or `hand`. Comma-separated
     * values are additive.
     */
    claim: emojiSet(optional("CLAIM_EMOJI", "raised_hand")),
    /** Reacting with this dismisses the request without creating a task. */
    dismiss: emojiSet(optional("DISMISS_EMOJI", "x")),
    /**
     * Dropped on the client's own message so they can see it was picked up by
     * the relay. Set `ACK_EMOJI=none` to leave client messages untouched.
     */
    ack: emoji("ACK_EMOJI", "eyes"),
  },

  /** Prefix for in-thread commands, e.g. `!start`. */
  commandPrefix: optional("COMMAND_PREFIX", "!"),

  sessions: {
    /** A session with no heartbeat for this long is closed at its last beat. */
    staleAfterMinutes: number("SESSION_STALE_MINUTES", 20),
    /** How often the reaper sweeps for abandoned sessions. */
    reapIntervalMinutes: number("SESSION_REAP_INTERVAL_MINUTES", 5),
    /** Used only to phrase long durations as "days of work" for the client. */
    hoursPerDay: number("HOURS_PER_DAY", 6),
  },

  api: {
    enabled: optional("API_ENABLED", "true") !== "false",
    port: number("API_PORT", 3737),
    /**
     * Defaults to loopback. Binding anywhere else forces token auth on, so the
     * API cannot be exposed to a network unauthenticated by accident.
     */
    host: optional("API_HOST", "127.0.0.1"),
  },

  sheets: {
    /** Legacy single-tenant fallback; workspaces now connect their own account. */
    id: optional("SHEETS_ID", ""),
    /**
     * How often to check whether anything changed. The check itself is three
     * local COUNT queries, so this can be short — Google is only contacted when
     * the data has actually moved.
     */
    syncSeconds: number("SHEETS_SYNC_SECONDS", 15),
  },

  /**
   * Registered once by whoever operates Relay. Workspaces connect their own
   * Google account against these; they never see or need them.
   */
  google: {
    clientId: optional("GOOGLE_CLIENT_ID", ""),
    clientSecret: optional("GOOGLE_CLIENT_SECRET", ""),
  },

  /**
   * Where Google sends people back to after they click Allow, e.g.
   * https://relay.example.com — must be publicly reachable over HTTPS.
   */
  publicUrl: optional("PUBLIC_URL", ""),

  dbPath: optional("DB_PATH", "./relay.db"),
  logLevel: optional("LOG_LEVEL", "info"),

  /**
   * Logs one line for every event Slack delivers, whatever the log level.
   * The point is to separate "the event never arrived" from "the event arrived
   * and was ignored" — two failures that look identical from inside Slack.
   */
  logEvents: optional("LOG_EVENTS", "false") === "true",
} as const;

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function validateConfig(): void {
  // Channel pairing is validated where it's created — in Slack, where the
  // person making the mistake can be told about it immediately — rather than
  // by refusing to start.
  if (config.internalChannel && config.clientChannels.includes(config.internalChannel)) {
    throw new Error(
      "INTERNAL_CHANNEL must not also be listed in CLIENT_CHANNELS — that would relay the bot's own posts back into itself.",
    );
  }
  if (overlaps(config.emoji.claim, config.emoji.dismiss)) {
    throw new Error(
      `CLAIM_EMOJI and DISMISS_EMOJI overlap (claim accepts ${config.emoji.claim.accepts.join("/")}, ` +
        `dismiss accepts ${config.emoji.dismiss.accepts.join("/")}). They must be distinct emoji.`,
    );
  }
  if (!config.emoji.claim.primary) throw new Error("CLAIM_EMOJI is empty.");
  if (!config.emoji.dismiss.primary) throw new Error("DISMISS_EMOJI is empty.");
}
