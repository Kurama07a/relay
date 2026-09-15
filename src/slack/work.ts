import { assign, postToInternal, refreshInternalMessage, transition } from "./actions.js";
import { notices } from "./notices.js";
import { dot, ICON } from "./design.js";
import { userName } from "./names.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { addEvent, getTask, ref, type Task } from "../store.js";
import {
  effortFor,
  endSession,
  formatExact,
  openSessionFor,
  openSessionsOn,
  sessionSeconds,
  startSession,
  type SessionSource,
  type WorkSession,
} from "../sessions.js";
import { formatSlab, needsSplitting } from "../slabs.js";
import { closeUnit, loggedSeconds } from "../worklogs.js";
import { markSubtaskDone, subtasksFor, type Subtask } from "../jira/stories.js";

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
  subtask: Subtask | null = null,
): Promise<StartWorkResult> {
  // Picking work up from an editor is as much a claim as reacting in Slack —
  // except for sprint stories, which are assigned in Jira and nowhere else.
  const owned = task.source === "jira" || task.assignee ? task : await assign(task, engineer, engineer);

  const { session, superseded, firstEver } = startSession(owned.id, engineer, source, subtask?.id ?? null);
  const isFirstStart = !owned.started_at;

  const updated = await transition(owned, "in_progress", engineer, {
    fields: owned.started_at ? {} : { started_at: session.started_at },
    detail: `session ${session.id} via ${source}${subtask ? ` on ${subtask.jira_key}` : ""}`,
    // Only the very first start is announced; resumes stay internal.
    clientMessage: isFirstStart
      ? notices.started(owned, await userName(engineer))
      : undefined,
  });

  addEvent(updated.id, "session:start", engineer, subtask ? `${source} on ${subtask.jira_key}` : source);

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

  addEvent(task.id, "session:end", engineer, formatExact(sessionSeconds(closed)));
  await refreshInternalMessage(task);

  log.info(`${ref(task)} session ${closed.id} closed (${formatExact(sessionSeconds(closed))})`);
  return { session: closed, task };
}

function splitNote(exactSeconds: number): string {
  return needsSplitting(exactSeconds)
    ? `\n${ICON.warning} That's over ${config.slabs.splitWarningHours}h on one piece of work — worth splitting it next time.`
    : "";
}

/**
 * Closes one subtask of a story: stops the clocks on it and fixes its slab.
 * Nothing is said to the client beyond the tick on their card.
 */
export async function finishSubtask(
  task: Task,
  subtask: Subtask,
  engineer: string,
): Promise<{ exactSeconds: number; slabSeconds: number }> {
  for (const session of openSessionsOn(task.id)) {
    if (session.subtask_id === subtask.id) endSession(session.id, "explicit");
  }

  const unit = closeUnit(task.id, subtask.id);
  markSubtaskDone(subtask.id, engineer);
  addEvent(task.id, "subtask:done", engineer, `${subtask.jira_key} exact=${unit.exactSeconds}s logged=${unit.slabSeconds}s`);

  await refreshInternalMessage(getTask(task.id)!);
  await postToInternal(
    task,
    dot(
      `${ICON.done} *${subtask.jira_key}* closed by <@${engineer}>`,
      unit.exactSeconds > 0
        ? `${formatExact(unit.exactSeconds)} → logged *${formatSlab(unit.slabSeconds)}*`
        : "no time recorded on it",
    ) + splitNote(unit.exactSeconds),
  );

  return { exactSeconds: unit.exactSeconds, slabSeconds: unit.slabSeconds };
}

/**
 * Marks the task done and tells the client what was logged. Time is fixed into
 * slabs here — per subtask for a story, per task otherwise — because a precise
 * figure invites a line-item argument about work that was already agreed. The
 * exact total stays in the ledger.
 */
export async function finishWork(
  task: Task,
  engineer: string,
  note?: string,
): Promise<{ task: Task; effortSeconds: number; loggedSeconds: number }> {
  for (const session of openSessionsOn(task.id)) {
    endSession(session.id, "explicit");
  }

  // Closing a story closes whatever subtasks are still open, each logged on its own.
  if (task.source === "jira") {
    for (const subtask of subtasksFor(task.id)) {
      if (subtask.done_at) continue;
      closeUnit(task.id, subtask.id);
      markSubtaskDone(subtask.id, engineer);
    }
  }
  const own = closeUnit(task.id, null);

  const effort = effortFor(task.id);
  const logged = loggedSeconds(task.id);
  const told = logged > 0 ? formatSlab(logged) : null;

  const updated = await transition(task, "done", engineer, {
    fields: { completed_at: new Date().toISOString() },
    detail: note,
    clientMessage: notices.done(task, await userName(engineer), note, told),
  });

  if (effort.totalSeconds > 0) {
    await postToInternal(
      updated,
      `${ICON.timer} Exact time *${formatExact(effort.totalSeconds)}* across ${effort.sessionCount} session${effort.sessionCount === 1 ? "" : "s"}, logged as *${told ?? "0h"}*. ` +
        (told ? `The client was told "${told}".` : "The client wasn't given a time.") +
        splitNote(own.exactSeconds),
    );
  }

  addEvent(updated.id, "effort", engineer, `exact=${effort.totalSeconds}s logged=${logged}s`);
  return { task: updated, effortSeconds: effort.totalSeconds, loggedSeconds: logged };
}

/** Reopens a completed task, e.g. when the client says it isn't fixed. */
export async function reopenWork(task: Task, engineer: string, why?: string): Promise<Task> {
  return transition(task, task.assignee ? "open" : "triage", engineer, {
    fields: { completed_at: null },
    detail: why,
    clientMessage: notices.reopened(task, why),
  });
}
