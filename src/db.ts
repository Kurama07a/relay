import Database from "better-sqlite3";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./log.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Adds a column if an older database doesn't have it yet. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and every deploy must upgrade an existing ledger
 * in place.
 */
function addColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Bump whenever migrate() changes the schema. A ledger below this version is
 * copied before it's upgraded, so a migration that goes wrong never costs the
 * data — and the deploy doesn't depend on anyone remembering to take a backup.
 */
export const SCHEMA_VERSION = 3;

/**
 * Copies an existing ledger to `relay.db.before-v<N>` beside it, once per
 * schema version. `VACUUM INTO` writes a consistent copy even while an old
 * container still has the file open during a redeploy. If the copy can't be
 * made, this throws and Relay refuses to start rather than upgrading without one.
 */
function snapshotBeforeUpgrade(): void {
  if ((db.pragma("user_version", { simple: true }) as number) >= SCHEMA_VERSION) return;
  if (config.dbPath === ":memory:") return;

  const hasLedger = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`).get();
  if (!hasLedger) return;

  const target = `${config.dbPath}.before-v${SCHEMA_VERSION}`;
  if (existsSync(target)) return; // an earlier boot already made it

  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (error) {
    throw new Error(
      `Could not copy the database to ${target} before upgrading it (${(error as Error).message}). ` +
        `Relay won't change the schema without a copy — check the volume has free space.`,
    );
  }
  log.info(`copied the ledger to ${target} before upgrading it to schema v${SCHEMA_VERSION}`);
}

/**
 * Brings the schema up to date. Safe on every boot and on a database that is
 * already current: tables are created `IF NOT EXISTS`, and columns are only
 * ever added.
 */
export function migrate(): void {
  snapshotBeforeUpgrade();

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

  // Jira sprint sync. A pairing can follow one Jira board, whose stories land
  // in its own client-facing sprint channel.
  addColumn("routes", "sprint_channel", "TEXT");
  addColumn("routes", "jira_board_id", "INTEGER");
  addColumn("routes", "jira_board_name", "TEXT");
  addColumn("routes", "jira_project_key", "TEXT");

  // A story from Jira is a task like any other, plus where it came from.
  addColumn("tasks", "source", "TEXT NOT NULL DEFAULT 'slack'");
  addColumn("tasks", "jira_issue_id", "TEXT");
  addColumn("tasks", "jira_key", "TEXT");
  addColumn("tasks", "jira_status", "TEXT");
  addColumn("tasks", "jira_assignee", "TEXT");
  addColumn("tasks", "bucket", "TEXT");
  addColumn("tasks", "jira_updated_at", "TEXT");
  addColumn("tasks", "sprint_id", "INTEGER");
  addColumn("tasks", "carried_count", "INTEGER NOT NULL DEFAULT 0");
  addColumn("tasks", "carried_from_sprint_id", "INTEGER");
  addColumn("tasks", "archived_at", "TEXT");

  db.exec(`
-- A Jira issue becomes at most one task, however many polls see it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_jira_issue
  ON tasks (jira_issue_id) WHERE jira_issue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sprints (
  jira_sprint_id INTEGER PRIMARY KEY,
  board_id       INTEGER NOT NULL,
  name           TEXT NOT NULL,
  -- future | active | closed, as Jira reports it
  state          TEXT NOT NULL,
  start_at       TEXT,
  end_at         TEXT,
  completed_at   TEXT,
  -- how far polling has got, so a restart knows how far back to look
  polled_until   TEXT,
  updated_at     TEXT NOT NULL
);

-- Subtasks belong to a story; time can be tracked against each one.
CREATE TABLE IF NOT EXISTS subtasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  jira_issue_id   TEXT NOT NULL UNIQUE,
  jira_key        TEXT NOT NULL,
  title           TEXT NOT NULL,
  jira_status     TEXT,
  bucket          TEXT,
  jira_assignee   TEXT,
  -- the Slack member linked to jira_assignee, when there is one
  assignee        TEXT,
  jira_updated_at TEXT,
  done_at         TEXT,
  done_by         TEXT,
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks (task_id);

-- The slab a unit of work was logged as when it was closed, kept so what the
-- client was told never drifts. One row per engineer per subtask, or per task
-- when there are no subtasks; closing again replaces it.
CREATE TABLE IF NOT EXISTS work_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  subtask_id    INTEGER REFERENCES subtasks (id) ON DELETE CASCADE,
  engineer      TEXT NOT NULL,
  exact_seconds INTEGER NOT NULL,
  slab_seconds  INTEGER NOT NULL,
  closed_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_logs_unit
  ON work_logs (task_id, COALESCE(subtask_id, 0), engineer);

-- Jira members and the Slack accounts an admin linked them to.
CREATE TABLE IF NOT EXISTS jira_members (
  jira_account_id TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  email           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  slack_user      TEXT UNIQUE,
  linked_by       TEXT,
  linked_at       TEXT,
  updated_at      TEXT NOT NULL
);

-- Which of Relay's five groups each status on a board is shown in.
CREATE TABLE IF NOT EXISTS jira_buckets (
  board_id       INTEGER NOT NULL,
  jira_status_id TEXT NOT NULL,
  column_name    TEXT NOT NULL,
  bucket         TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT,
  PRIMARY KEY (board_id, jira_status_id)
);

-- Board messages Relay edits in place, and the bookmarks that open them.
CREATE TABLE IF NOT EXISTS board_messages (
  channel      TEXT NOT NULL,
  -- everyone | member | unassigned | timesheet
  kind         TEXT NOT NULL,
  member       TEXT NOT NULL DEFAULT '',
  ts           TEXT NOT NULL,
  bookmark_id  TEXT,
  content_hash TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (channel, kind, member)
);
`);

  addColumn("work_sessions", "subtask_id", "INTEGER REFERENCES subtasks (id)");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_subtask ON work_sessions (subtask_id)`);

  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

migrate();

log.debug(`sqlite ready at ${config.dbPath}`);
