import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./log.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  status            TEXT NOT NULL,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,

  -- where the client originally asked
  client_channel    TEXT NOT NULL,
  client_ts         TEXT NOT NULL,
  client_user       TEXT NOT NULL,
  client_permalink  TEXT,

  -- where we relayed it for the engineering team
  internal_channel  TEXT NOT NULL,
  internal_ts       TEXT NOT NULL,

  assignee          TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  claimed_at        TEXT,
  started_at        TEXT,
  completed_at      TEXT
);

-- Slack retries event deliveries; these keep a redelivery from relaying twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_msg
  ON tasks (client_channel, client_ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_internal_msg
  ON tasks (internal_channel, internal_ts);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor      TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task ON events (task_id);

-- One row per stretch of actual work. A task accumulates many of these across
-- its life; closing one never closes the task.
CREATE TABLE IF NOT EXISTS work_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  engineer           TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'cli',
  started_at         TEXT NOT NULL,
  last_heartbeat_at  TEXT NOT NULL,
  ended_at           TEXT,
  -- explicit | reaped | superseded — how the session came to an end, kept so a
  -- suspiciously long session can be explained rather than just distrusted.
  end_reason         TEXT,
  -- Manual correction in seconds, applied on top of the measured span.
  adjustment_seconds INTEGER NOT NULL DEFAULT 0,
  note               TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_task     ON work_sessions (task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_engineer ON work_sessions (engineer);
-- An engineer may have at most one session running at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_open
  ON work_sessions (engineer) WHERE ended_at IS NULL;

-- Channel pairings. Each client channel relays into exactly one team channel,
-- so an agency can run several clients side by side with separate internal
-- channels. Configured from Slack rather than a .env file.
CREATE TABLE IF NOT EXISTS routes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  client_channel TEXT NOT NULL UNIQUE,
  team_channel   TEXT NOT NULL,
  label          TEXT,
  -- 'all' relays every top-level message; 'mention' only those @-mentioning
  -- the bot. Per-route, because a chatty channel and a quiet one want different
  -- answers.
  ingest_mode    TEXT NOT NULL DEFAULT 'all',
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  created_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_routes_team ON routes (team_channel);

-- Everything else that used to live in .env: the spreadsheet link, which
-- channel is the control room. Key/value so adding a setting needs no migration.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Display names for users and channels, written through whenever one is
-- resolved from Slack. Exports and reports read from here so they can render
-- "Sam Patel" and "#acme-corp" rather than raw IDs without needing Slack to be
-- reachable. User and channel IDs share a namespace safely (U/W vs C/G/D).
CREATE TABLE IF NOT EXISTS slack_names (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Google accounts, one per Slack workspace. Users authorise Relay with their
-- own Google login; nobody needs a Google Cloud project except whoever operates
-- Relay, and they need exactly one.
--
-- Keyed by team_id from the outset so this survives the move to multi-tenant
-- without a migration.
CREATE TABLE IF NOT EXISTS google_accounts (
  team_id        TEXT PRIMARY KEY,
  refresh_token  TEXT NOT NULL,
  access_token   TEXT,
  expires_at     TEXT,
  email          TEXT,
  spreadsheet_id TEXT,
  connected_by   TEXT,
  connected_at   TEXT NOT NULL
);

-- Short-lived CSRF tokens for the OAuth round trip. The callback arrives from
-- the user's browser, so without this anyone could forge one.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  channel_id TEXT,
  created_at TEXT NOT NULL
);

-- Which task an engineer was last working on in a given directory. This is what
-- lets opening an editor resume the clock by itself: the directory is a far
-- better guess at "what am I working on" than asking every time.
CREATE TABLE IF NOT EXISTS workdirs (
  engineer   TEXT NOT NULL,
  workdir    TEXT NOT NULL,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (engineer, workdir)
);

-- Bearer tokens for the local API, one per engineer machine. Only the hash is
-- stored, so the database is not a pile of working credentials.
CREATE TABLE IF NOT EXISTS api_tokens (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash     TEXT NOT NULL UNIQUE,
  slack_user_id  TEXT NOT NULL,
  label          TEXT,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT
);
`);

log.debug(`sqlite ready at ${config.dbPath}`);
