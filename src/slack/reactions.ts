import { app, botUserId } from "./app.js";
import { assign, postEphemeral, postToClient, postToInternal, transition } from "./actions.js";
import { mention, userName } from "./names.js";
import { config } from "../config.js";
import { isTeamChannel } from "../routes.js";
import { matches, normalizeEmoji } from "../emoji.js";
import { ICON } from "./design.js";
import { notices } from "./notices.js";
import { log } from "../log.js";
import { addEvent, getByInternalMessage, ref } from "../store.js";

interface ReactionEvent {
  user: string;
  reaction: string;
  item: { type: string; channel?: string; ts?: string };
}

export function registerReactions(): void {
  app.event("reaction_added", async ({ event }) => {
    try {
      await onReactionAdded(event as unknown as ReactionEvent);
    } catch (error) {
      log.error("reaction_added handler failed", error);
    }
  });

  app.event("reaction_removed", async ({ event }) => {
    try {
      await onReactionRemoved(event as unknown as ReactionEvent);
    } catch (error) {
      log.error("reaction_removed handler failed", error);
    }
  });
}

async function onReactionAdded(event: ReactionEvent): Promise<void> {
  if (event.user === botUserId) return; // our own seeded reactions
  if (event.item.type !== "message" || !event.item.channel || !event.item.ts) return;

  const reaction = normalizeEmoji(event.reaction);

  // Every rejection below is logged. A reaction that does nothing and says
  // nothing is the hardest failure to diagnose in this whole bot — from the
  // outside it is indistinguishable from the event never arriving at all.
  //
  // The task lookup is the only gate that matters: if a message is a relayed
  // card, it is triageable, whichever team channel it landed in.
  const task = getByInternalMessage(event.item.channel, event.item.ts);
  if (!task) {
    log.debug(
      `:${reaction}: was on ${event.item.channel}/${event.item.ts}, which is not a relayed card` +
        (isTeamChannel(event.item.channel) ? "" : " (and that channel isn't paired with anything)"),
    );
    return;
  }

  const isClaim = matches(config.emoji.claim, reaction);
  const isDismiss = matches(config.emoji.dismiss, reaction);

  if (!isClaim && !isDismiss) {
    log.info(
      `ignoring :${reaction}: on ${ref(task)} — claim accepts ${config.emoji.claim.accepts.map((name) => `:${name}:`).join("/")}, ` +
        `dismiss accepts ${config.emoji.dismiss.accepts.map((name) => `:${name}:`).join("/")}`,
    );
    return;
  }

  if (isClaim) {
    if (task.status === "dismissed") {
      // Reviving something triaged away is a legitimate correction.
      await postToInternal(task, `${ICON.reopen} ${mention(event.user)} reopened this.`);
      await assign(task, event.user, event.user);
      return;
    }

    if (task.assignee && task.assignee !== event.user) {
      await postEphemeral(
        event.item.channel,
        event.user,
        `${ref(task)} is already assigned to ${await userName(task.assignee)}. Reply \`${config.commandPrefix}assign @you\` in its thread if you're taking it over.`,
      );
      return;
    }

    if (task.assignee === event.user) return; // idempotent re-react

    const updated = await assign(task, event.user, event.user);
    await postToInternal(
      updated,
      `${ICON.claim} ${mention(event.user)} has this one. \`${config.commandPrefix}start\` when you begin, \`${config.commandPrefix}done\` when it ships.`,
    );
    return;
  }

  if (isDismiss) {
    if (task.status !== "triage") {
      await postEphemeral(
        event.item.channel,
        event.user,
        `${ref(task)} is already ${task.status.replace("_", " ")} — dismissing only applies to untriaged requests.`,
      );
      return;
    }

    await transition(task, "dismissed", event.user, { detail: "dismissed via reaction" });
    await postToInternal(
      task,
      `${ICON.dismissed} Dismissed by ${mention(event.user)} — no task created. The client was not notified.`,
    );
  }
}

/**
 * Un-claiming: pulling the claim reaction back off releases the task, but only
 * while it is still untouched. Once work has started, the reaction is just
 * decoration and removing it should not silently drop the assignment.
 */
async function onReactionRemoved(event: ReactionEvent): Promise<void> {
  if (event.user === botUserId) return;
  if (event.item.type !== "message" || !event.item.channel || !event.item.ts) return;
  if (!matches(config.emoji.claim, event.reaction)) return;

  const task = getByInternalMessage(event.item.channel, event.item.ts);
  if (!task || task.assignee !== event.user) return;

  if (task.status !== "open") {
    await postEphemeral(
      event.item.channel,
      event.user,
      `${ref(task)} is ${task.status.replace("_", " ")}, so it stays assigned to you. Use \`${config.commandPrefix}assign @someone\` in the thread to hand it off.`,
    );
    return;
  }

  const updated = await transition(task, "triage", event.user, {
    fields: { assignee: null, claimed_at: null },
    detail: "unclaimed via reaction",
  });
  addEvent(updated.id, "unclaimed", event.user);

  await postToInternal(
    updated,
    `${ICON.handoff} ${mention(event.user)} released this — it's back in triage.`,
  );

  // The client was already told someone picked this up, so they're owed the correction.
  try {
    await postToClient(updated, notices.releasing(updated));
  } catch (error) {
    log.warn(`could not tell the client ${ref(updated)} was released`, error);
  }
}
