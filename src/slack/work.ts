import { assign, postToInternal, refreshInternalMessage, transition } from "./actions.js";
import { notices } from "./notices.js";
import { ICON } from "./design.js";
import { userName } from "./names.js";
import { log } from "../log.js";
import { addEvent, getTask, ref, type Task } from "../store.js";
import {
  effortFor,
  endSession,
  formatExact,
  formatRounded,
  openSessionFor,
  openSessionsOn,
  startSession,
  type SessionSource,
  type WorkSession,
} from "../sessions.js";

/**
 * Work-session lifecycle, shared by the API and the Slack thread commands.
 *
 * The rule that shapes all of it: sessions are high-frequency and internal,
 * so only the transitions a client would actually care about are spoken aloud.
 * Starting work for the first time is worth a message. Resuming after lunch,
 * on the eighth day, is not.
 */

export interface StartWorkResult {
  task: Task;
  session: WorkSession;
  resumed: boolean;
  superseded: { session: WorkSession; task: Task | undefined } | null;
}

export async function startWork(
  task: Task,
  engineer: string,
  source: SessionSource = "cli",
): Promise<StartWorkResult> {
  // Picking work up from an editor is as much a claim as reacting in Slack.
  const owned = task.assignee ? task : await assign(task, engineer, engineer);

  const { session, superseded, firstEver } = startSession(owned.id, engineer, source);
  const isFirstStart = !owned.started_at;

  const updated = await transition(owned, "in_progress", engineer, {
    fields: owned.started_at ? {} : { started_at: session.started_at },
    detail: `session ${session.id} via ${source}`,
    // Only the very first start is announced; resumes stay internal.
    clientMessage: isFirstStart
      ? notices.started(owned, await userName(engineer))
      : undefined,
  });

  addEvent(updated.id, "session:start", engineer, source);

  if (superseded) {
    const other = getTask(superseded.task_id);
    if (other && other.id !== updated.id) {
      await refreshInternalMessage(other);
      await postToInternal(
        other,
        `${ICON.pause} Paused automatically — <@${engineer}> moved to ${ref(updated)}.`,
      );
    }
    return {
      task: updated,
      session,
      resumed: !firstEver,
      superseded: { session: superseded, task: other },
    };
  }

  return { task: updated, session, resumed: !firstEver, superseded: null };
}

export interface StopWorkResult {
  session: WorkSession;
  task: Task;
}

/** Ends whatever the engineer has running. The task keeps its status. */
export async function stopWork(engineer: string): Promise<StopWorkResult | null> {
  const open = openSessionFor(engineer);
  if (!open) return null;

  const closed = endSession(open.id, "explicit");
  if (!closed) return null;

  const task = getTask(closed.task_id);
  if (!task) return null;

  addEvent(task.id, "session:end", engineer, formatExact(sessionLength(closed)));
  await refreshInternalMessage(task);

  log.info(`${ref(task)} session ${closed.id} closed (${formatExact(sessionLength(closed))})`);
  return { session: closed, task };
}

/**
 * Marks the task done and tells the client how long it took — rounded, because
 * a precise figure invites a line-item argument about work that was already
 * agreed. The exact total stays in the ledger for capacity planning.
 */
export async function finishWork(
  task: Task,
  engineer: string,
  note?: string,
): Promise<{ task: Task; effortSeconds: number }> {
  for (const session of openSessionsOn(task.id)) {
    endSession(session.id, "explicit");
  }

  const effort = effortFor(task.id);
  const name = await userName(engineer);
  const rounded = effort.totalSeconds > 0 ? formatRounded(effort.totalSeconds) : null;

  const updated = await transition(task, "done", engineer, {
    fields: { completed_at: new Date().toISOString() },
    detail: note,
    clientMessage: notices.done(task, name, note, rounded),
  });

  if (effort.totalSeconds > 0) {
    await postToInternal(
      updated,
      `${ICON.timer} Logged *${formatExact(effort.totalSeconds)}* across ${effort.sessionCount} session${effort.sessionCount === 1 ? "" : "s"}. The client was told "${rounded}".`,
    );
  }

  addEvent(updated.id, "effort", engineer, `${effort.totalSeconds}s`);
  return { task: updated, effortSeconds: effort.totalSeconds };
}

/** Reopens a completed task, e.g. when the client says it isn't fixed. */
export async function reopenWork(task: Task, engineer: string, why?: string): Promise<Task> {
  return transition(task, task.assignee ? "open" : "triage", engineer, {
    fields: { completed_at: null },
    detail: why,
    clientMessage: notices.reopened(task, why),
  });
}

function sessionLength(session: WorkSession): number {
  const end = session.ended_at ?? new Date().toISOString();
  return Math.max(
    0,
    Math.round((new Date(end).getTime() - new Date(session.started_at).getTime()) / 1000) +
      session.adjustment_seconds,
  );
}
