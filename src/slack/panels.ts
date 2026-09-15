import type { View } from "@slack/types";
import { app, client } from "./app.js";
import { userName } from "./names.js";
import { dot, ICON } from "./design.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { addEvent, getTask, ref, type Task } from "../store.js";
import { adjustSession, formatExact, openSessionFor, sessionSeconds } from "../sessions.js";
import { formatSlab } from "../slabs.js";
import { canSeeTasks, isGuest } from "../permissions.js";
import { subtasksFor } from "../jira/stories.js";
import { listRoutes } from "../routes.js";
import { finishSubtask, finishWork, startWork, stopWork } from "./work.js";
import {
  DESK,
  clientStoryView,
  personView,
  refreshDesksFor,
  routeForDeskChannel,
  storyOptions,
  teamStoryView,
  timesheetView,
} from "./desk.js";

/**
 * Everything the desks' dropdowns, buttons and panels do.
 *
 * Anyone in a sprint channel — clients included — can open a story from the
 * Sprint desk and add an update. The Team desk and its panels are for the team
 * only, and that's checked on every interaction rather than trusted from where
 * the button happened to be.
 */

interface Payload {
  user?: { id?: string };
  trigger_id?: string;
  channel?: { id?: string };
  container?: { channel_id?: string };
  view?: {
    id?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
  actions?: Array<{ value?: string; selected_option?: { value?: string } }>;
}

const plain = (text: string) => ({ type: "plain_text" as const, text });
const payloadOf = (body: unknown) => body as Payload;

function actionValue(payload: Payload): string {
  const action = payload.actions?.[0];
  return action?.selected_option?.value ?? action?.value ?? "";
}

function channelOf(payload: Payload): string {
  return payload.channel?.id ?? payload.container?.channel_id ?? "";
}

/** A sprint story from a dropdown or button value like `12` or `12:34`. */
function storyFrom(value: string): Task | undefined {
  const task = getTask(Number(value.split(":")[0]));
  return task?.source === "jira" ? task : undefined;
}

async function safely(what: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    log.error(`desk: ${what} failed`, error);
  }
}

async function openView(triggerId: string | undefined, view: View): Promise<void> {
  if (triggerId) await client.views.open({ trigger_id: triggerId, view });
}

/** Team-only interactions stop here for anyone else, with the reason in a small panel. */
async function teamOnly(user: string, triggerId?: string): Promise<boolean> {
  const decision = await canSeeTasks(user);
  if (decision.ok) return true;
  await openView(triggerId, {
    type: "modal",
    title: plain("Team desk"),
    close: plain("Close"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `${ICON.warning} ${decision.reason}` } }],
  });
  return false;
}

async function refreshPanel(payload: Payload, task: Task, viewer: string, notice: string): Promise<void> {
  if (!payload.view?.id) return;
  await client.views.update({ view_id: payload.view.id, view: await teamStoryView(getTask(task.id)!, viewer, notice) });
}

/** A client wrote on a story: its owner hears about it directly. */
async function tellOwner(task: Task, author: string, text: string): Promise<void> {
  if (!task.assignee || task.assignee === author) return;
  const name = await userName(author);
  try {
    await client.chat.postMessage({
      channel: task.assignee,
      text: `${name} added an update on ${task.jira_key}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📨 *${name}* added an update on *${task.jira_key} · ${task.title}*\n>${text.replace(/\n/g, "\n>")}`,
          },
        },
        {
          type: "actions",
          elements: [
            { type: "button", text: plain(`Open ${task.jira_key}`), action_id: DESK.openTeamFromDm, value: String(task.id) },
          ],
        },
      ],
    });
  } catch (error) {
    log.warn(`could not tell the owner of ${task.jira_key} about an update`, error);
  }
}

/** The team wrote on a story: clients who have written on it before hear about it. */
async function tellClients(task: Task, author: string): Promise<void> {
  const rows = db
    .prepare(`SELECT DISTINCT actor FROM events WHERE task_id = ? AND type = 'client_update' AND actor IS NOT NULL`)
    .all(task.id) as Array<{ actor: string }>;
  if (rows.length === 0) return;

  const name = await userName(author);
  for (const { actor } of rows) {
    if (actor === author) continue;
    try {
      await client.chat.postMessage({
        channel: actor,
        text: `${name} posted an update on ${task.jira_key}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `💬 *${name}* posted an update on *${task.jira_key} · ${task.title}*` } },
          {
            type: "actions",
            elements: [
              { type: "button", text: plain(`Open ${task.jira_key}`), action_id: DESK.openClientFromDm, value: String(task.id) },
            ],
          },
        ],
      });
    } catch (error) {
      log.warn(`could not tell a client about an update on ${task.jira_key}`, error);
    }
  }
}

/** Opens a story's team panel — used by `/relay story ACME-12`. */
export async function openTeamPanel(triggerId: string, task: Task, viewer: string): Promise<void> {
  await client.views.open({ trigger_id: triggerId, view: await teamStoryView(task, viewer) });
}

export function registerDesks(): void {
  for (const actionId of [DESK.story, DESK.teamStory]) {
    app.options(actionId, async ({ ack, body }) => {
      const payload = body as Payload & { value?: string };
      const route = routeForDeskChannel(channelOf(payload));
      const response = route ? storyOptions(route, payload.value ?? "") : { options: [] };
      await ack(response as Parameters<typeof ack>[0]);
    });
  }

  app.action(DESK.story, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    await safely("open story", async () => {
      const task = storyFrom(actionValue(payload));
      if (task) await openView(payload.trigger_id, await clientStoryView(task));
    });
  });

  app.action(DESK.openClientFromDm, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    await safely("open story from a DM", async () => {
      const task = storyFrom(actionValue(payload));
      if (task) await openView(payload.trigger_id, await clientStoryView(task));
    });
  });

  app.action(DESK.person, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    await safely("open person", async () => {
      const route = routeForDeskChannel(channelOf(payload));
      if (route) await openView(payload.trigger_id, await personView(route, actionValue(payload), "client"));
    });
  });

  app.action(DESK.teamStory, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("open team story", async () => {
      if (!(await teamOnly(user, payload.trigger_id))) return;
      const task = storyFrom(actionValue(payload));
      if (task) await openView(payload.trigger_id, await teamStoryView(task, user));
    });
  });

  app.action(DESK.openTeamFromDm, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("open team story from a DM", async () => {
      if (!(await teamOnly(user, payload.trigger_id))) return;
      const task = storyFrom(actionValue(payload));
      if (task) await openView(payload.trigger_id, await teamStoryView(task, user));
    });
  });

  app.action(DESK.teamPerson, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    await safely("open team person", async () => {
      if (!(await teamOnly(payload.user?.id ?? "", payload.trigger_id))) return;
      const route = routeForDeskChannel(channelOf(payload));
      if (route) await openView(payload.trigger_id, await personView(route, actionValue(payload), "team"));
    });
  });

  app.action(DESK.timesheet, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    await safely("open timesheet", async () => {
      if (!(await teamOnly(payload.user?.id ?? "", payload.trigger_id))) return;
      const route = listRoutes().find((candidate) => String(candidate.id) === actionValue(payload));
      if (route) await openView(payload.trigger_id, await timesheetView(route));
    });
  });

  app.action(DESK.start, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("start the clock", async () => {
      if (!(await teamOnly(user))) return;
      const [taskPart = "", subtaskPart = "0"] = actionValue(payload).split(":");
      const task = storyFrom(taskPart);
      if (!task) return;
      const subtask = subtasksFor(task.id).find((candidate) => candidate.id === Number(subtaskPart)) ?? null;
      const result = await startWork(task, user, "slack", subtask);
      const paused = result.superseded?.task;
      await refreshPanel(
        payload,
        task,
        user,
        dot(
          `${ICON.start} Clock started on *${subtask?.jira_key ?? task.jira_key}*`,
          paused && paused.id !== task.id ? `paused your session on ${paused.jira_key ?? ref(paused)}` : null,
        ),
      );
    });
  });

  app.action(DESK.pause, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("pause the clock", async () => {
      if (!(await teamOnly(user))) return;
      const task = storyFrom(actionValue(payload));
      if (!task) return;
      const stopped = await stopWork(user);
      await refreshPanel(
        payload,
        task,
        user,
        stopped ? `${ICON.pause} Paused after ${formatExact(sessionSeconds(stopped.session))}` : "You had no clock running.",
      );
    });
  });

  app.action(DESK.closeSubtask, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("close a subtask", async () => {
      if (!(await teamOnly(user))) return;
      const [taskPart = "", subtaskPart = ""] = actionValue(payload).split(":");
      const task = storyFrom(taskPart);
      const subtask = task ? subtasksFor(task.id).find((candidate) => candidate.id === Number(subtaskPart)) : undefined;
      if (!task || !subtask || subtask.done_at) return;
      const logged = await finishSubtask(task, subtask, user);
      await refreshPanel(payload, task, user, `${ICON.done} Closed *${subtask.jira_key}* — logged *${formatSlab(logged.slabSeconds)}*`);
    });
  });

  app.action(DESK.done, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("close a story", async () => {
      if (!(await teamOnly(user))) return;
      const task = storyFrom(actionValue(payload));
      if (!task || task.status === "done") return;
      const note = Object.entries(payload.view?.state?.values ?? {})
        .find(([blockId]) => blockId.startsWith("client_update_"))?.[1]?.value?.value?.trim();
      const result = await finishWork(task, user, note || undefined);
      await refreshPanel(
        payload,
        task,
        user,
        `${ICON.done} Story closed — logged *${formatSlab(result.loggedSeconds)}*. The client sees it in the Sprint desk.`,
      );
      await tellClients(task, user);
    });
  });

  app.view(DESK.clientPanel, async ({ ack, body, view }) => {
    const user = body.user.id;
    const { taskId } = JSON.parse(view.private_metadata) as { taskId: number };
    const task = getTask(taskId);
    const entry = Object.entries(view.state.values).find(([blockId]) => blockId.startsWith("update_"));
    const text = entry?.[1]?.value?.value?.trim() ?? "";

    if (!task || task.source !== "jira" || task.archived_at) {
      await ack();
      return;
    }
    if (!text) {
      await ack({ response_action: "errors", errors: { [entry?.[0] ?? "update"]: "Write something first." } });
      return;
    }

    const guest = await isGuest(user);
    addEvent(task.id, guest ? "client_update" : "team_update", user, text);
    refreshDesksFor(task);
    await ack({
      response_action: "update",
      view: await clientStoryView(task, `${ICON.done} Sent.${guest && task.assignee ? " Its owner has been told." : ""}`),
    });

    if (guest) await tellOwner(task, user, text);
    else await tellClients(task, user);
  });

  app.view(DESK.teamPanel, async ({ ack, body, view }) => {
    const user = body.user.id;
    const { taskId } = JSON.parse(view.private_metadata) as { taskId: number };
    const task = getTask(taskId);
    if (!task) {
      await ack();
      return;
    }

    const field = (prefix: string) => {
      const entry = Object.entries(view.state.values).find(([blockId]) => blockId.startsWith(prefix));
      return { blockId: entry?.[0] ?? prefix, value: entry?.[1]?.value?.value?.trim() ?? "" };
    };
    const update = field("client_update_");
    const note = field("note_");
    const time = field("time_");
    const reason = field("reason_");

    const decision = await canSeeTasks(user);
    if (!decision.ok) {
      await ack({ response_action: "errors", errors: { [update.blockId]: decision.reason } });
      return;
    }

    let delta: number | null = null;
    if (time.value) {
      const minutes = Number(time.value.replace(/\s*m(in(ute)?s?)?$/i, ""));
      if (!Number.isFinite(minutes) || minutes === 0) {
        await ack({ response_action: "errors", errors: { [time.blockId]: "Minutes, like -30 or 45." } });
        return;
      }
      const running = openSessionFor(user);
      if (!running || running.task_id !== task.id) {
        await ack({
          response_action: "errors",
          errors: { [time.blockId]: "Start the clock on this story first — corrections apply to the session you're in." },
        });
        return;
      }
      delta = minutes;
    }

    if (!update.value && !note.value && delta === null) {
      await ack({
        response_action: "errors",
        errors: { [update.blockId]: "Nothing to save — write an update or a note, or correct your time." },
      });
      return;
    }

    const saved: string[] = [];
    if (update.value) {
      addEvent(task.id, "team_update", user, update.value);
      saved.push("Update sent to the client");
    }
    if (note.value) {
      addEvent(task.id, "note", user, note.value);
      saved.push("note saved");
    }
    if (delta !== null) {
      const counted = adjustSession(openSessionFor(user)!.id, delta, reason.value || undefined);
      addEvent(task.id, "time_adjust", user, `${delta > 0 ? "+" : ""}${delta}m${reason.value ? ` ${reason.value}` : ""}`);
      saved.push(`your session now counts ${formatExact(counted)}`);
    }

    refreshDesksFor(task);
    const summary = saved.join(", ");
    await ack({
      response_action: "update",
      view: await teamStoryView(getTask(task.id)!, user, `${ICON.done} ${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`),
    });

    if (update.value) await tellClients(task, user);
  });
}
