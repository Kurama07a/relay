import { db } from "./db.js";
import { config } from "./config.js";

export type SessionSource = "claude-code" | "codex" | "cli" | "slack";
export type EndReason = "explicit" | "reaped" | "superseded";

export interface WorkSession {
  id: number;
  task_id: number;
  engineer: string;
  source: SessionSource;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  end_reason: EndReason | null;
  adjustment_seconds: number;
  note: string | null;
}

const now = () => new Date().toISOString();
const seconds = (from: string, to: string) =>
  Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));

/** The open session for an engineer, if they have one anywhere. */
export function openSessionFor(engineer: string): WorkSession | undefined {
  return db
    .prepare(`SELECT * FROM work_sessions WHERE engineer = ? AND ended_at IS NULL`)
    .get(engineer) as WorkSession | undefined;
}

/** All currently-running sessions on a task, across engineers. */
export function openSessionsOn(taskId: number): WorkSession[] {
  return db
    .prepare(`SELECT * FROM work_sessions WHERE task_id = ? AND ended_at IS NULL`)
    .all(taskId) as WorkSession[];
}

export function sessionsFor(taskId: number): WorkSession[] {
  return db
    .prepare(`SELECT * FROM work_sessions WHERE task_id = ? ORDER BY id`)
    .all(taskId) as WorkSession[];
}

export interface StartResult {
  session: WorkSession;
  /** A session on a different task that had to be closed first. */
  superseded: WorkSession | null;
  /** True the first time anyone works on this task. */
  firstEver: boolean;
}

/**
 * Opens a work session. An engineer can only run one at a time, so an existing
 * session elsewhere is closed rather than left to accrue time in the background
 * — double-counting is the fastest way to make these numbers untrustworthy.
 */
export function startSession(
  taskId: number,
  engineer: string,
  source: SessionSource = "cli",
): StartResult {
  const existing = openSessionFor(engineer);

  if (existing?.task_id === taskId) {
    // Already running on this task — treat as a heartbeat, not a new session.
    heartbeat(existing.id);
    return { session: getSession(existing.id)!, superseded: null, firstEver: false };
  }

  let superseded: WorkSession | null = null;
  if (existing) {
    endSession(existing.id, "superseded");
    superseded = getSession(existing.id)!;
  }

  const firstEver = sessionsFor(taskId).length === 0;
  const timestamp = now();

  const result = db
    .prepare(
      `INSERT INTO work_sessions (task_id, engineer, source, started_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(taskId, engineer, source, timestamp, timestamp);

  return { session: getSession(Number(result.lastInsertRowid))!, superseded, firstEver };
}

export function getSession(id: number): WorkSession | undefined {
  return db.prepare(`SELECT * FROM work_sessions WHERE id = ?`).get(id) as
    | WorkSession
    | undefined;
}

export function heartbeat(sessionId: number): void {
  db.prepare(`UPDATE work_sessions SET last_heartbeat_at = ? WHERE id = ? AND ended_at IS NULL`)
    .run(now(), sessionId);
}

/**
 * Closes a session. A reaped session ends at its last heartbeat, not at the
 * moment we noticed — a laptop that slept at 6pm should not bill until the
 * reaper ran the next morning.
 */
export function endSession(
  sessionId: number,
  reason: EndReason = "explicit",
  at?: string,
): WorkSession | undefined {
  const session = getSession(sessionId);
  if (!session || session.ended_at) return session;

  const endedAt = at ?? (reason === "reaped" ? session.last_heartbeat_at : now());
  db.prepare(`UPDATE work_sessions SET ended_at = ?, end_reason = ? WHERE id = ?`)
    .run(endedAt, reason, sessionId);

  return getSession(sessionId);
}

/** Sources that emit heartbeats, so silence from them means "gone away". */
const HEARTBEAT_SOURCES: SessionSource[] = ["claude-code", "codex", "cli"];

/** Adds a correction, in minutes, to a session's measured span. */
export function adjustSession(sessionId: number, deltaMinutes: number, note?: string): void {
  db.prepare(
    `UPDATE work_sessions
     SET adjustment_seconds = adjustment_seconds + ?, note = COALESCE(?, note)
     WHERE id = ?`,
  ).run(Math.round(deltaMinutes * 60), note ?? null, sessionId);
}

/** Elapsed seconds for one session, counting an open one up to right now. */
export function sessionSeconds(session: WorkSession): number {
  const end = session.ended_at ?? now();
  return Math.max(0, seconds(session.started_at, end) + session.adjustment_seconds);
}

export interface Effort {
  totalSeconds: number;
  sessionCount: number;
  engineers: string[];
  /** Whether any session is still running. */
  active: boolean;
  lastActivityAt: string | null;
}

export function effortFor(taskId: number): Effort {
  const sessions = sessionsFor(taskId);
  const totalSeconds = sessions.reduce((sum, session) => sum + sessionSeconds(session), 0);
  const lastActivity = sessions
    .map((session) => session.ended_at ?? session.last_heartbeat_at)
    .sort()
    .pop();

  return {
    totalSeconds,
    sessionCount: sessions.length,
    engineers: [...new Set(sessions.map((session) => session.engineer))],
    active: sessions.some((session) => session.ended_at === null),
    lastActivityAt: lastActivity ?? null,
  };
}

/**
 * Closes sessions that stopped checking in — a crashed editor, a closed laptop,
 * a killed terminal. Without this, one missed SessionEnd hook turns into an
 * overnight session that lands in a client-facing number.
 */
export function reapStaleSessions(): WorkSession[] {
  const open = db
    .prepare(`SELECT * FROM work_sessions WHERE ended_at IS NULL`)
    .all() as WorkSession[];

  const heartbeatCutoff = Date.now() - config.sessions.staleAfterMinutes * 60_000;
  const maxLength = config.sessions.maxHours * 3_600_000;
  const reaped: WorkSession[] = [];

  for (const session of open) {
    if (HEARTBEAT_SOURCES.includes(session.source)) {
      // An editor stopped checking in: it closed, crashed, or the laptop slept.
      // End at the last beat, since that's the last moment work was observed.
      if (new Date(session.last_heartbeat_at).getTime() < heartbeatCutoff) {
        const closed = endSession(session.id, "reaped");
        if (closed) reaped.push(closed);
      }
      continue;
    }

    // Sessions started from Slack have nothing beating for them, so silence
    // means nothing. They're capped by length instead, and end at the cap
    // rather than at their start — backdating to the last heartbeat would
    // record zero time, since for these that *is* the start.
    const startedAt = new Date(session.started_at).getTime();
    if (Date.now() - startedAt > maxLength) {
      const closed = endSession(
        session.id,
        "reaped",
        new Date(startedAt + maxLength).toISOString(),
      );
      if (closed) reaped.push(closed);
    }
  }

  return reaped;
}

/** Precise duration, for the team's own eyes: `4h 22m`. */
export function formatExact(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Deliberately vague duration for the client.
 *
 * Rounds outward to a granularity that grows with the number, so a figure that
 * reaches a client reads as an honest approximation rather than a timesheet
 * line to be argued with. The exact seconds stay in the ledger.
 */
export function formatRounded(totalSeconds: number): string {
  const minutes = totalSeconds / 60;

  if (minutes < 15) return "under 15 minutes";
  if (minutes < 60) return `about ${Math.round(minutes / 15) * 15} minutes`;

  const hours = minutes / 60;
  if (hours < 8) {
    const halves = Math.max(1, Math.round(hours * 2) / 2);
    return `about ${halves % 1 === 0 ? halves : halves.toFixed(1)} hours`;
  }

  const days = hours / config.sessions.hoursPerDay;
  if (days < 2) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(days * 2) / 2} days of work`;
}
