import {
  ackCommand,
  assign,
  postEphemeral,
  postToClient,
  postToInternal,
  refreshInternalMessage,
  transition,
} from "./actions.js";
import { statusLabel } from "./blocks.js";
import { notices } from "./notices.js";
import { ICON, KIND } from "./design.js";
import { channelName, mention, userName } from "./names.js";
import type { HumanMessage } from "./messages.js";
import { config } from "../config.js";
import { log } from "../log.js";
import {
  addEvent,
  getByInternalMessage,
  listEvents,
  ref,
  updateTask,
  type Task,
  type TaskKind,
} from "../store.js";
import {
  adjustSession,
  effortFor,
  formatExact,
  formatRounded,
  openSessionFor,
  sessionsFor,
  sessionSeconds,
} from "../sessions.js";
import { finishWork, startWork, stopWork } from "./work.js";

const KINDS: TaskKind[] = ["bug", "feature", "review", "question", "request"];

/**
 * Handles a reply inside the internal channel.
 *
 * Only messages starting with the command prefix do anything. Everything else
 * is left alone on purpose: the thread doubles as the team's working space, and
 * silently forwarding that chatter to the client would be a nasty surprise.
 * Reaching the client is always an explicit `!ask`.
 */
export async function handleInternalThreadMessage(message: HumanMessage): Promise<void> {
  const task = getByInternalMessage(message.channel, message.threadTs!);
  if (!task) return;

  const prefix = config.commandPrefix;
  if (!message.text.startsWith(prefix)) {
    // Ordinary discussion in the thread is recorded but never relayed. It is
    // the context an engineer picking this up later actually needs, and keeping
    // it here means their tools can read the conversation without a second
    // Slack integration.
    addEvent(task.id, "thread_note", message.user, message.text.slice(0, 2000));
    return;
  }

  const withoutPrefix = message.text.slice(prefix.length);
  const spaceAt = withoutPrefix.search(/\s/);
  const command = (spaceAt === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceAt)).toLowerCase();
  const rest = (spaceAt === -1 ? "" : withoutPrefix.slice(spaceAt + 1)).trim();

  try {
    await dispatch(task, command, rest, message);
  } catch (error) {
    log.error(`command ${prefix}${command} failed on ${ref(task)}`, error);
    await postEphemeral(
      message.channel,
      message.user,
      `Something went wrong running \`${prefix}${command}\`. It has been logged.`,
      message.threadTs ?? undefined,
    );
  }
}

async function dispatch(
  task: Task,
  command: string,
  rest: string,
  message: HumanMessage,
): Promise<void> {
  const actor = message.user;
  const actorName = await userName(actor);
  const thread = message.threadTs ?? undefined;
  const ack = (emoji?: string) => ackCommand(message.channel, message.ts, emoji);

  switch (command) {
    case "start": {
      if (task.status === "done") {
        await postEphemeral(message.channel, actor, `${ref(task)} is already done.`, thread);
        return;
      }
      const result = await startWork(task, actor, "slack");
      if (result.superseded?.task) {
        await postEphemeral(
          message.channel,
          actor,
          `Started the clock here. Your session on ${ref(result.superseded.task)} was paused.`,
          thread,
        );
      }
      await ack();
      return;
    }

    case "pause":
    case "stop": {
      const stopped = await stopWork(actor);
      if (!stopped) {
        await postEphemeral(message.channel, actor, "You have no session running.", thread);
        return;
      }
      await postEphemeral(
        message.channel,
        actor,
        `Paused ${ref(stopped.task)} after ${formatExact(sessionSeconds(stopped.session))}. It stays ${stopped.task.status.replace("_", " ")} — use \`${config.commandPrefix}done\` when it's finished.`,
        thread,
      );
      await ack("pause_button");
      return;
    }

    case "done":
    case "finish":
    case "complete": {
      await finishWork(task, actor, rest || undefined);
      await ack();
      return;
    }

    case "time": {
      const match = /^([+-]?\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes)?\s*(.*)$/i.exec(rest);
      if (!match?.[1]) {
        await usage(message, `${config.commandPrefix}time -30 left it running over lunch`);
        return;
      }
      const open = openSessionFor(actor);
      if (!open || open.task_id !== task.id) {
        await postEphemeral(
          message.channel,
          actor,
          `You have no running session on ${ref(task)} to correct. Adjustments apply to the session you're in.`,
          thread,
        );
        return;
      }
      adjustSession(open.id, Number(match[1]), match[2] || undefined);
      addEvent(task.id, "time_adjust", actor, rest);
      await refreshInternalMessage(task);
      await ack();
      return;
    }

    case "sessions": {
      await postToInternal(task, sessionBreakdown(task));
      return;
    }

    case "block": {
      if (!rest) {
        await usage(message, `${config.commandPrefix}block <what's blocking it>`);
        return;
      }
      await transition(task, "blocked", actor, {
        detail: rest,
        clientMessage: notices.blocked(task, rest),
      });
      await ack();
      return;
    }

    case "unblock": {
      const next = task.started_at ? "in_progress" : "open";
      await transition(task, next, actor, {
        clientMessage: notices.unblocked(task),
      });
      await ack();
      return;
    }

    case "ask": {
      if (!rest) {
        await usage(message, `${config.commandPrefix}ask <question for the client>`);
        return;
      }
      await postToClient(task, notices.question(task, actorName, rest));
      addEvent(task.id, "question", actor, rest);
      await ack();
      return;
    }

    case "reply":
    case "tell": {
      if (!rest) {
        await usage(message, `${config.commandPrefix}reply <message for the client>`);
        return;
      }
      await postToClient(task, notices.message(task, actorName, rest));
      addEvent(task.id, "reply", actor, rest);
      await ack();
      return;
    }

    case "note": {
      if (!rest) {
        await usage(message, `${config.commandPrefix}note <internal note>`);
        return;
      }
      addEvent(task.id, "note", actor, rest);
      await ack("lock"); // padlock = recorded, stays internal
      return;
    }

    case "assign": {
      const target = /<@([A-Z0-9]+)(?:\|[^>]*)?>/i.exec(rest)?.[1];
      if (!target) {
        await usage(message, `${config.commandPrefix}assign @teammate`);
        return;
      }
      await assign(task, target, actor);
      await ack();
      return;
    }

    case "kind": {
      const next = rest.toLowerCase() as TaskKind;
      if (!KINDS.includes(next)) {
        await usage(message, `${config.commandPrefix}kind ${KINDS.join("|")}`);
        return;
      }
      const updated = updateTask(task.id, { kind: next });
      addEvent(task.id, "kind", actor, next);
      await refreshInternalMessage(updated);
      await ack();
      return;
    }

    case "status": {
      await postToInternal(task, await statusSummary(task));
      return;
    }

    case "help": {
      await postEphemeral(message.channel, actor, helpText(), thread);
      return;
    }

    default: {
      await postEphemeral(
        message.channel,
        actor,
        `Unknown command \`${config.commandPrefix}${command}\`.\n${helpText()}`,
        thread,
      );
    }
  }
}

async function usage(message: HumanMessage, text: string): Promise<void> {
  await postEphemeral(
    message.channel,
    message.user,
    `Usage: \`${text}\``,
    message.threadTs ?? undefined,
  );
}

async function statusSummary(task: Task): Promise<string> {
  const lines = [
    `*${ref(task)}* · ${KIND[task.kind].icon} ${KIND[task.kind].label}`,
    `*Status:* ${statusLabel(task.status)}`,
    `*Assignee:* ${mention(task.assignee)}`,
    `*Client:* ${await userName(task.client_user)} in ${await channelName(task.client_channel)}`,
    `*Opened:* ${task.created_at}`,
  ];
  if (task.started_at) lines.push(`*Started:* ${task.started_at}`);
  if (task.completed_at) lines.push(`*Completed:* ${task.completed_at}`);

  const events = listEvents(task.id, 8);
  if (events.length) {
    lines.push("", "*Recent activity*");
    for (const event of events.reverse()) {
      const who = event.actor ? await userName(event.actor) : "system";
      const detail = event.detail ? ` — ${event.detail.slice(0, 140)}` : "";
      lines.push(`• \`${event.created_at.slice(0, 16).replace("T", " ")}\` ${event.type} by ${who}${detail}`);
    }
  }
  return lines.join("\n");
}

/** Per-session detail — internal only, and always the exact figures. */
function sessionBreakdown(task: Task): string {
  const sessions = sessionsFor(task.id);
  if (sessions.length === 0) return `*${ref(task)}* — no work sessions yet.`;

  const effort = effortFor(task.id);
  const lines = sessions.map((session) => {
    const state = session.ended_at
      ? session.end_reason === "reaped"
        ? " _(auto-closed — no heartbeat)_"
        : session.end_reason === "superseded"
          ? " _(auto-paused — moved to another task)_"
          : ""
      : " *· running*";
    const adjusted =
      session.adjustment_seconds !== 0
        ? ` _(adjusted ${session.adjustment_seconds > 0 ? "+" : ""}${Math.round(session.adjustment_seconds / 60)}m)_`
        : "";
    return `• <@${session.engineer}> — ${formatExact(sessionSeconds(session))} via ${session.source}${state}${adjusted}`;
  });

  return [
    `*${ref(task)} · work sessions*`,
    ...lines,
    "",
    `*Total:* ${formatExact(effort.totalSeconds)} across ${effort.sessionCount} session${effort.sessionCount === 1 ? "" : "s"}`,
    `_On completion the client would be told "${formatRounded(effort.totalSeconds)}"._`,
  ].join("\n");
}

function helpText(): string {
  const p = config.commandPrefix;
  return [
    "*Relay thread commands*",
    `\`${p}start\` — start the clock (claims it if nobody has) and tell the client`,
    `\`${p}pause\` — stop the clock; the task stays open`,
    `\`${p}done [note]\` — mark finished and tell the client how long it took`,
    `\`${p}block <why>\` — mark blocked and tell the client why`,
    `\`${p}unblock\` — resume`,
    `\`${p}ask <question>\` — ask the client, in their original thread`,
    `\`${p}reply <message>\` — send the client an update without a question`,
    `\`${p}note <text>\` — record an internal note (never leaves this channel)`,
    `\`${p}assign @teammate\` — hand it over`,
    `\`${p}kind ${KINDS.join("|")}\` — fix the category`,
    `\`${p}time -30 <why>\` — correct the running session, in minutes`,
    `\`${p}sessions\` — who worked on this, and for how long`,
    `\`${p}status\` — full history for this task`,
    "",
    "_Anything else you type here stays internal — only these commands reach the client._",
  ].join("\n");
}
