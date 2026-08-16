import { client } from "./app.js";
import { channelName, mention, userName } from "./names.js";
import { requestBlocks, requestColor, requestFallback, statusLabel } from "./blocks.js";
import { notices, plain, type Notice } from "./notices.js";
import { ICON } from "./design.js";
import { addEvent, ref, updateTask, type Task, type TaskStatus } from "../store.js";
import { log } from "../log.js";

/** Posts into the client's original message thread. */
export async function postToClient(task: Task, notice: Notice | string): Promise<void> {
  const payload = typeof notice === "string" ? plain(notice) : notice;
  await client.chat.postMessage({
    channel: task.client_channel,
    thread_ts: task.client_ts,
    text: payload.text,
    blocks: payload.blocks,
    unfurl_links: false,
  });
}

/**
 * Posts into the relayed message's thread in the internal channel.
 *
 * Best-effort by design: these are announcements about work that already
 * happened. If Slack is unreachable, the ledger is still correct and the caller
 * should not be told their action failed — unlike `postToClient`, where
 * delivery is the whole point and a failure must surface.
 */
export async function postToInternal(task: Task, text: string): Promise<void> {
  try {
    await client.chat.postMessage({
      channel: task.internal_channel,
      thread_ts: task.internal_ts,
      text,
      unfurl_links: false,
    });
  } catch (error) {
    log.warn(`could not post to the internal thread for ${ref(task)}`, error);
  }
}

/** Only the reacting user sees this — used for errors and "already claimed". */
export async function postEphemeral(
  channel: string,
  user: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  try {
    await client.chat.postEphemeral({ channel, user, text, thread_ts: threadTs });
  } catch (error) {
    log.warn("postEphemeral failed", error);
  }
}

/** Re-renders the relayed message so its status/assignee fields stay current. */
export async function refreshInternalMessage(task: Task): Promise<void> {
  const ctx = {
    clientName: await userName(task.client_user),
    channelLabel: await channelName(task.client_channel),
  };
  try {
    await client.chat.update({
      channel: task.internal_channel,
      ts: task.internal_ts,
      text: requestFallback(task, ctx),
      // The card lives inside an attachment purely for the colour stripe, which
      // is the only colour affordance Slack offers. Blocks must move with it —
      // leaving any at top level would render the card twice.
      blocks: [],
      attachments: [{ color: requestColor(task), blocks: requestBlocks(task, ctx) }],
    });
  } catch (error) {
    log.warn(`could not refresh internal message for ${ref(task)}`, error);
  }
}

/** Acknowledges a thread command by reacting to it, rather than replying. */
export async function ackCommand(
  channel: string,
  ts: string,
  emoji: string = "white_check_mark",
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp: ts, name: emoji });
  } catch (error) {
    // already_reacted is expected when a command is retried; anything else is worth seeing.
    const message = (error as { data?: { error?: string } })?.data?.error;
    if (message !== "already_reacted") log.warn("reaction add failed", error);
  }
}

export interface TransitionOptions {
  /** Message sent into the client's thread; omit to keep the change internal. */
  clientMessage?: Notice;
  /** Extra columns to write alongside the status. */
  fields?: Partial<Task>;
  detail?: string;
}

/**
 * Single path for every status change: write the row, log the event, re-render
 * the relayed message, and tell the client. Keeping this in one place is what
 * stops the internal card and the client thread from drifting apart.
 */
export async function transition(
  task: Task,
  status: TaskStatus,
  actor: string,
  options: TransitionOptions = {},
): Promise<Task> {
  const updated = updateTask(task.id, { status, ...options.fields });
  addEvent(task.id, `status:${status}`, actor, options.detail);

  await refreshInternalMessage(updated);

  if (options.clientMessage) {
    try {
      await postToClient(updated, options.clientMessage);
    } catch (error) {
      log.error(`could not notify client for ${ref(updated)}`, error);
      // The status change already happened and is the thing worth keeping —
      // failing to raise the alarm about it must not roll the caller back.
      try {
        await postToInternal(
          updated,
          `${ICON.warning} Status is now *${statusLabel(status)}*, but I couldn't post the update to ${await channelName(updated.client_channel)}. Someone may need to tell them directly.`,
        );
      } catch (nested) {
        log.error(`could not warn the team about the failed client notice on ${ref(updated)}`, nested);
      }
    }
  }

  log.info(`${ref(updated)} → ${status} by ${actor}`);
  return updated;
}

/** Assigns (or reassigns) a task and announces it on both sides. */
export async function assign(task: Task, assignee: string, actor: string): Promise<Task> {
  const previous = task.assignee;
  const timestamps: Partial<Task> = task.claimed_at
    ? {}
    : { claimed_at: new Date().toISOString() };

  const status: TaskStatus = task.status === "triage" ? "open" : task.status;
  const name = await userName(assignee);

  const handover = Boolean(previous && previous !== assignee);

  const updated = await transition(task, status, actor, {
    fields: { assignee, ...timestamps },
    detail: `assignee=${assignee}`,
    clientMessage: handover ? notices.reassigned(task, name) : notices.claimed(task, name),
  });

  if (handover) {
    await postToInternal(
      updated,
      `${ICON.handoff} Reassigned from ${mention(previous)} to ${mention(assignee)} by ${mention(actor)}.`,
    );
  }

  return updated;
}
