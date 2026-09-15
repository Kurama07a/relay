import type { View } from "@slack/types";
import { app, client } from "./app.js";
import { userName } from "./names.js";
import { dot, ICON } from "./design.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { addEvent, getTask, ref, type Task } from "../store.js";
import { formatExact, logManualSession, parseDuration, sessionSeconds } from "../sessions.js";
import { formatSlab } from "../slabs.js";
import { canSeeTasks, isGuest } from "../permissions.js";
import { subtasksFor, type Subtask } from "../jira/stories.js";
import { listRoutes, type Route } from "../routes.js";
import { finishSubtask, finishWork, startWork, stopWork } from "./work.js";
import {
  DESK,
  clientStoryView,
  personView,
  refreshDesksFor,
  routeForDeskChannel,
  routeForStory,
  storyOptions,
} from "./desk.js";
import { EVERYONE, freshNonce, initialTimeState, storiesFor, timeView, type TimeMode, type TimeState } from "./time.js";

/**
 * Everything the desks' dropdowns, buttons and panels do.
 *
 * Anyone in a sprint channel — clients included — can open a story from the
 * Sprint desk and add an update. The Team desk's time panels are for the team
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
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null }>>;
    };
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

/** A sprint story from a dropdown or button value. */
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

// ---- time panel state -------------------------------------------------------

function stateOf(payload: Payload): { state: TimeState; route: Route } | null {
  if (!payload.view?.private_metadata) return null;
  const state = JSON.parse(payload.view.private_metadata) as TimeState;
  const route = listRoutes().find((candidate) => candidate.id === state.routeId);
  return route ? { state, route } : null;
}

async function rerender(payload: Payload, route: Route, user: string, state: TimeState, notice?: string): Promise<void> {
  if (!payload.view?.id) return;
  await client.views.update({ view_id: payload.view.id, view: await timeView(route, user, state, notice) });
}

/** The subtask picked in the Log time panel's "On" field, or null for the story itself. */
function pickedUnit(values: NonNullable<NonNullable<Payload["view"]>["state"]>["values"], state: TimeState, task: Task): Subtask | null {
  const picked = values?.[`unit_${state.nonce}`]?.value?.selected_option?.value ?? "0";
  return subtasksFor(task.id).find((subtask) => String(subtask.id) === picked) ?? null;
}

// ---- messages to people -----------------------------------------------------

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
          elements: [{ type: "button", text: plain(`Open ${task.jira_key}`), action_id: DESK.openFromDm, value: String(task.id) }],
        },
      ],
    });
  } catch (error) {
    log.warn(`could not tell the owner of ${task.jira_key} about an update`, error);
  }
}

/** The team wrote on or closed a story: clients who have written on it hear about it. */
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
            elements: [{ type: "button", text: plain(`Open ${task.jira_key}`), action_id: DESK.openFromDm, value: String(task.id) }],
          },
        ],
      });
    } catch (error) {
      log.warn(`could not tell a client about an update on ${task.jira_key}`, error);
    }
  }
}

/** Opens Log time on one story — used by `/relay story ACME-12`. */
export async function openLogTime(triggerId: string, task: Task, viewer: string): Promise<void> {
  const route = routeForStory(task);
  if (!route) return;
  await client.views.open({ trigger_id: triggerId, view: await timeView(route, viewer, initialTimeState(route, "log", viewer, task.id)) });
}

export function registerDesks(): void {
  // ---- the Sprint desk: anyone in the channel --------------------------------

  app.options(DESK.story, async ({ ack, body }) => {
    const payload = body as Payload & { value?: string };
    const route = routeForDeskChannel(channelOf(payload));
    const response = route ? storyOptions(route, payload.value ?? "") : { options: [] };
    await ack(response as Parameters<typeof ack>[0]);
  });

  app.action(DESK.story, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    await safely("open story", async () => {
      const task = storyFrom(actionValue(payload));
      if (task) await openView(payload.trigger_id, await clientStoryView(task));
    });
  });

  app.action(DESK.openFromDm, async ({ ack, body }) => {
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
      if (route) await openView(payload.trigger_id, await personView(route, actionValue(payload)));
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

  // ---- the Team desk: View time and Log time ---------------------------------

  for (const [actionId, mode] of [
    [DESK.viewTime, "view"],
    [DESK.logTime, "log"],
  ] as Array<[string, TimeMode]>) {
    app.action(actionId, async ({ ack, body }) => {
      await ack();
      const payload = payloadOf(body);
      const user = payload.user?.id ?? "";
      await safely(`open ${mode} time`, async () => {
        if (!(await teamOnly(user, payload.trigger_id))) return;
        const route = listRoutes().find((candidate) => String(candidate.id) === actionValue(payload));
        if (route) await openView(payload.trigger_id, await timeView(route, user, initialTimeState(route, mode, user)));
      });
    });
  }

  app.action(DESK.pickPerson, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("pick a person", async () => {
      const current = stateOf(payload);
      if (!current || !(await teamOnly(user))) return;
      const value = actionValue(payload);
      const person = value === EVERYONE ? null : value;
      const keep = current.state.taskId && storiesFor(current.route, person).some((story) => story.id === current.state.taskId);
      await rerender(payload, current.route, user, { ...current.state, person, taskId: keep ? current.state.taskId : null });
    });
  });

  app.action(DESK.pickStory, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("pick a story", async () => {
      const current = stateOf(payload);
      if (!current || !(await teamOnly(user))) return;
      await rerender(payload, current.route, user, { ...current.state, taskId: Number(actionValue(payload)) || null });
    });
  });

  app.action(DESK.start, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("start the clock", async () => {
      const current = stateOf(payload);
      const task = storyFrom(actionValue(payload));
      if (!current || !task || !(await teamOnly(user))) return;
      const subtask = pickedUnit(payload.view?.state?.values, current.state, task);
      const result = await startWork(task, user, "slack", subtask);
      const paused = result.superseded?.task;
      await rerender(
        payload,
        current.route,
        user,
        current.state,
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
      const current = stateOf(payload);
      if (!current || !(await teamOnly(user))) return;
      const stopped = await stopWork(user);
      await rerender(
        payload,
        current.route,
        user,
        current.state,
        stopped ? `${ICON.pause} Paused after ${formatExact(sessionSeconds(stopped.session))}` : "You had no clock running.",
      );
    });
  });

  app.action(DESK.closeSubtask, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("close a subtask", async () => {
      const current = stateOf(payload);
      const task = storyFrom(actionValue(payload));
      if (!current || !task || !(await teamOnly(user))) return;
      const subtask = pickedUnit(payload.view?.state?.values, current.state, task);
      if (!subtask) {
        await rerender(payload, current.route, user, current.state, `${ICON.warning} Pick the subtask to close in *On* first.`);
        return;
      }
      const logged = await finishSubtask(task, subtask, user);
      await rerender(
        payload,
        current.route,
        user,
        { ...current.state, nonce: freshNonce() },
        `${ICON.done} Closed *${subtask.jira_key}* — logged *${formatSlab(logged.slabSeconds)}*`,
      );
    });
  });

  app.action(DESK.done, async ({ ack, body }) => {
    await ack();
    const payload = payloadOf(body);
    const user = payload.user?.id ?? "";
    await safely("close a story", async () => {
      const current = stateOf(payload);
      const task = storyFrom(actionValue(payload));
      if (!current || !task || task.status === "done" || !(await teamOnly(user))) return;
      const result = await finishWork(task, user);
      await rerender(
        payload,
        current.route,
        user,
        current.state,
        `${ICON.done} *${task.jira_key}* closed — logged *${formatSlab(result.loggedSeconds)}*. The client sees it in the Sprint desk.`,
      );
      await tellClients(task, user);
    });
  });

  app.view(DESK.timePanel, async ({ ack, body, view }) => {
    const user = body.user.id;
    const state = JSON.parse(view.private_metadata) as TimeState;
    const route = listRoutes().find((candidate) => candidate.id === state.routeId);
    const task = state.taskId ? getTask(state.taskId) : undefined;
    const values = view.state.values;
    const n = state.nonce;

    if (!route || !task || task.source !== "jira") {
      await ack();
      return;
    }

    const decision = await canSeeTasks(user);
    if (!decision.ok) {
      await ack({ response_action: "errors", errors: { [`duration_${n}`]: decision.reason } });
      return;
    }

    const seconds = parseDuration(values[`duration_${n}`]?.value?.value ?? "");
    if (!seconds || seconds <= 0) {
      await ack({ response_action: "errors", errors: { [`duration_${n}`]: "How long, like 1h 30m, 45m or 1.5h." } });
      return;
    }
    if (seconds > 24 * 3600) {
      await ack({ response_action: "errors", errors: { [`duration_${n}`]: "That's more than a day — log it one day at a time." } });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const date = values[`date_${n}`]?.value?.selected_date ?? today;
    if (date > today) {
      await ack({ response_action: "errors", errors: { [`date_${n}`]: "Time can't be logged for a day that hasn't happened yet." } });
      return;
    }

    const subtask = pickedUnit(values as Parameters<typeof pickedUnit>[0], state, task);
    const note = values[`note_${n}`]?.value?.value?.trim() || undefined;
    // Today's entries end now; earlier days end at midday, clear of timezone edges.
    const endedAt = date === today ? new Date() : new Date(`${date}T12:00:00Z`);

    logManualSession(task.id, subtask?.id ?? null, user, seconds, endedAt, note);
    addEvent(
      task.id,
      "time_logged",
      user,
      `${formatExact(seconds)} on ${subtask?.jira_key ?? task.jira_key}${date === today ? "" : ` for ${date}`}${note ? ` — ${note}` : ""}`,
    );
    refreshDesksFor(task);

    await ack({
      response_action: "update",
      view: await timeView(
        route,
        user,
        { ...state, nonce: freshNonce() },
        `${ICON.done} Logged *${formatExact(seconds)}* on *${subtask?.jira_key ?? task.jira_key}*${date === today ? "" : ` for ${date}`}.`,
      ),
    });
  });
}
