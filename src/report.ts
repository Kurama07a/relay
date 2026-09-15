import { db } from "./db.js";
import { listTasks, ref, type Task } from "./store.js";
import { effortFor, formatExact, secondsByEngineer, sessionsFor, sessionSeconds } from "./sessions.js";
import { formatSlab } from "./slabs.js";
import { loggedForSubtask, loggedSeconds } from "./worklogs.js";
import { BUCKET_STYLE, KIND, STATUS } from "./slack/design.js";
import { knownName } from "./slack/names.js";
import { isBucket } from "./jira/buckets.js";
import { displayName } from "./jira/members.js";
import { subtasksFor } from "./jira/stories.js";

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

const hours = (seconds: number) => (seconds > 0 ? (seconds / 3600).toFixed(2) : "");

function owner(slackUser: string | null, jiraAccount: string | null): string {
  if (slackUser) return knownName(slackUser);
  if (jiraAccount) return displayName(jiraAccount);
  return "";
}

function groupLabel(bucket: string | null): string {
  return bucket && isBucket(bucket) ? BUCKET_STYLE[bucket].label : "";
}

export function tasksSheet(): Sheet {
  const tasks = listTasks({ limit: 100_000, includeArchived: true }).reverse(); // oldest first reads better
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
      "Logged",
      "Sessions",
      "Slack link",
      "Request",
    ],
    rows: tasks.map((task) => {
      const effort = effortFor(task.id);
      const logged = loggedSeconds(task.id);
      return [
        ref(task),
        STATUS[task.status].label,
        KIND[task.kind].label,
        task.title,
        task.source === "jira" ? task.jira_key ?? "" : knownName(task.client_user),
        knownName(task.client_channel),
        owner(task.assignee, task.jira_assignee),
        date(task.created_at),
        date(task.claimed_at),
        date(task.started_at),
        date(task.completed_at),
        effort.totalSeconds > 0 ? formatExact(effort.totalSeconds) : "",
        // A number, so the spreadsheet can sum and average it.
        hours(effort.totalSeconds),
        logged > 0 ? formatSlab(logged) : "",
        String(effort.sessionCount),
        task.client_permalink ?? "",
        task.body.replace(/\r?\n/g, " ").trim(),
      ];
    }),
  };
}

export function sessionsSheet(): Sheet {
  const tasks = listTasks({ limit: 100_000, includeArchived: true }).reverse();
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
  const tasks = listTasks({ limit: 100_000, includeArchived: true });
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

/** Every story in a running sprint, each followed by its subtasks. */
export function currentSprintSheet(): Sheet {
  const stories = db
    .prepare(
      `SELECT t.*, s.name AS sprint_name FROM tasks t LEFT JOIN sprints s ON s.jira_sprint_id = t.sprint_id
       WHERE t.source = 'jira' AND t.archived_at IS NULL ORDER BY t.jira_key`,
    )
    .all() as Array<Task & { sprint_name: string | null }>;
  const rows: string[][] = [];

  for (const story of stories) {
    const exact = effortFor(story.id).totalSeconds;
    rows.push([
      story.jira_key ?? ref(story),
      "",
      story.title,
      owner(story.assignee, story.jira_assignee),
      story.jira_status ?? "",
      groupLabel(story.bucket),
      STATUS[story.status].label,
      exact > 0 ? formatExact(exact) : "",
      hours(exact),
      hours(loggedSeconds(story.id)),
      story.sprint_name ?? "",
    ]);

    for (const subtask of subtasksFor(story.id)) {
      const subExact = [...secondsByEngineer(story.id, subtask.id).values()].reduce((sum, seconds) => sum + seconds, 0);
      rows.push([
        subtask.jira_key,
        story.jira_key ?? "",
        subtask.title,
        owner(subtask.assignee, subtask.jira_assignee),
        subtask.jira_status ?? "",
        groupLabel(subtask.bucket),
        subtask.done_at ? "Done" : "Open",
        subExact > 0 ? formatExact(subExact) : "",
        hours(subExact),
        hours(loggedForSubtask(subtask.id)),
        story.sprint_name ?? "",
      ]);
    }
  }

  return {
    name: "Current sprint",
    header: [
      "Issue",
      "Story",
      "Title",
      "Owner",
      "Jira status",
      "Group",
      "In Relay",
      "Exact",
      "Exact (hours)",
      "Logged (hours)",
      "Sprint",
    ],
    rows,
  };
}

/** One row per story from an ended sprint, with what it logged. */
export function pastSprintsSheet(): Sheet {
  const stories = db
    .prepare(
      `SELECT t.*, s.name AS sprint_name, s.start_at AS sprint_start, s.end_at AS sprint_end
       FROM tasks t LEFT JOIN sprints s ON s.jira_sprint_id = t.sprint_id
       WHERE t.source = 'jira' AND t.archived_at IS NOT NULL
       ORDER BY t.archived_at DESC, t.jira_key`,
    )
    .all() as Array<Task & { sprint_name: string | null; sprint_start: string | null; sprint_end: string | null }>;

  return {
    name: "Past sprints",
    header: ["Sprint", "Dates", "Issue", "Title", "Owner", "Logged (hours)", "Times carried", "Archived"],
    rows: stories.map((story) => [
      story.sprint_name ?? "",
      [date(story.sprint_start).slice(0, 10), date(story.sprint_end).slice(0, 10)].filter(Boolean).join(" → "),
      story.jira_key ?? ref(story),
      story.title,
      owner(story.assignee, story.jira_assignee),
      hours(loggedSeconds(story.id)),
      String(story.carried_count),
      date(story.archived_at),
    ]),
  };
}

export function allSheets(): Sheet[] {
  return [summarySheet(), tasksSheet(), sessionsSheet(), eventsSheet(), currentSprintSheet(), pastSprintsSheet()];
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
