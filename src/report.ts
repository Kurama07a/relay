import { db } from "./db.js";
import { listTasks, ref, type Task } from "./store.js";
import { effortFor, formatExact, formatRounded, sessionsFor, sessionSeconds } from "./sessions.js";
import { STATUS, KIND } from "./slack/design.js";
import { knownName } from "./slack/names.js";

/**
 * Turns the ledger into flat rows for anything that isn't Slack — CSV files,
 * Google Sheets, whatever comes next. Kept in one place so every destination
 * shows the same columns and the same wording.
 *
 * Deliberately reads from the database only: no Slack calls, so an export works
 * offline and can't be slowed down or broken by rate limits.
 */

export interface Sheet {
  name: string;
  header: string[];
  rows: string[][];
}

/** Spreadsheets sort text dates correctly only if they're zero-padded. */
function date(value: string | null): string {
  return value ? value.replace("T", " ").slice(0, 19) : "";
}

export function tasksSheet(): Sheet {
  const tasks = listTasks({ limit: 100_000 }).reverse(); // oldest first reads better
  return {
    name: "Tasks",
    header: [
      "Ref",
      "Status",
      "Kind",
      "Title",
      "Requested by",
      "Client channel",
      "Assignee",
      "Opened",
      "Claimed",
      "Started",
      "Completed",
      "Effort",
      "Effort (hours)",
      "Told client",
      "Sessions",
      "Slack link",
      "Request",
    ],
    rows: tasks.map((task) => {
      const effort = effortFor(task.id);
      return [
        ref(task),
        STATUS[task.status].label,
        KIND[task.kind].label,
        task.title,
        knownName(task.client_user),
        knownName(task.client_channel),
        task.assignee ? knownName(task.assignee) : "",
        date(task.created_at),
        date(task.claimed_at),
        date(task.started_at),
        date(task.completed_at),
        effort.totalSeconds > 0 ? formatExact(effort.totalSeconds) : "",
        // A number, so the spreadsheet can sum and average it.
        effort.totalSeconds > 0 ? (effort.totalSeconds / 3600).toFixed(2) : "",
        effort.totalSeconds > 0 ? formatRounded(effort.totalSeconds) : "",
        String(effort.sessionCount),
        task.client_permalink ?? "",
        task.body.replace(/\r?\n/g, " ").trim(),
      ];
    }),
  };
}

export function sessionsSheet(): Sheet {
  const tasks = listTasks({ limit: 100_000 }).reverse();
  const rows: string[][] = [];

  for (const task of tasks) {
    for (const session of sessionsFor(task.id)) {
      rows.push([
        ref(task),
        task.title,
        knownName(session.engineer),
        session.source,
        date(session.started_at),
        date(session.ended_at),
        session.end_reason ?? (session.ended_at ? "" : "running"),
        formatExact(sessionSeconds(session)),
        (sessionSeconds(session) / 3600).toFixed(2),
        session.adjustment_seconds !== 0
          ? String(Math.round(session.adjustment_seconds / 60))
          : "",
        session.note ?? "",
      ]);
    }
  }

  return {
    name: "Sessions",
    header: [
      "Ref",
      "Title",
      "Engineer",
      "Source",
      "Started",
      "Ended",
      "How it ended",
      "Duration",
      "Hours",
      "Adjustment (min)",
      "Note",
    ],
    rows,
  };
}

export function eventsSheet(): Sheet {
  const rows = db
    .prepare(
      `SELECT e.task_id, e.type, e.actor, e.detail, e.created_at
       FROM events e ORDER BY e.id`,
    )
    .all() as Array<{
    task_id: number;
    type: string;
    actor: string | null;
    detail: string | null;
    created_at: string;
  }>;

  return {
    name: "Activity",
    header: ["Ref", "When", "What", "Who", "Detail"],
    rows: rows.map((row) => [
      `REL-${row.task_id}`,
      date(row.created_at),
      row.type,
      row.actor ? knownName(row.actor) : "",
      (row.detail ?? "").replace(/\r?\n/g, " "),
    ]),
  };
}

/** A small at-a-glance tab: counts and totals, so nobody has to write formulas. */
export function summarySheet(): Sheet {
  const tasks = listTasks({ limit: 100_000 });
  const rows: string[][] = [];

  const byStatus = new Map<string, number>();
  for (const task of tasks) {
    const label = STATUS[task.status].label;
    byStatus.set(label, (byStatus.get(label) ?? 0) + 1);
  }
  for (const [label, count] of byStatus) rows.push(["Status", label, String(count)]);

  const byKind = new Map<string, number>();
  for (const task of tasks) {
    const label = KIND[task.kind].label;
    byKind.set(label, (byKind.get(label) ?? 0) + 1);
  }
  for (const [label, count] of byKind) rows.push(["Kind", label, String(count)]);

  const byEngineer = new Map<string, number>();
  for (const task of tasks) {
    if (!task.assignee) continue;
    const seconds = effortFor(task.id).totalSeconds;
    byEngineer.set(task.assignee, (byEngineer.get(task.assignee) ?? 0) + seconds);
  }
  for (const [engineer, seconds] of byEngineer) {
    rows.push(["Hours logged", knownName(engineer), (seconds / 3600).toFixed(2)]);
  }

  const total = tasks.reduce((sum, task) => sum + effortFor(task.id).totalSeconds, 0);
  rows.push(["Total", "Tasks", String(tasks.length)]);
  rows.push(["Total", "Hours logged", (total / 3600).toFixed(2)]);
  rows.push(["Total", "Generated", date(new Date().toISOString())]);

  return { name: "Summary", header: ["Group", "Item", "Value"], rows };
}

export function allSheets(): Sheet[] {
  return [summarySheet(), tasksSheet(), sessionsSheet(), eventsSheet()];
}

/**
 * RFC 4180 CSV. Fields containing a comma, quote, or newline are quoted, and
 * embedded quotes are doubled — the usual reason an export looks fine until
 * somebody's bug report contains a comma.
 */
export function toCsv(sheet: Sheet): string {
  const escape = (field: string): string =>
    /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;

  return [sheet.header, ...sheet.rows]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
}

/** Excel assumes the system codepage unless a UTF-8 BOM says otherwise. */
export const UTF8_BOM = "﻿";
