import { app, botUserId, client } from "./app.js";
import { asHumanMessage, mentionsBot, stripMention } from "./messages.js";
import { requestBlocks, requestColor, requestFallback } from "./blocks.js";
import { ICON } from "./design.js";
import { channelName, userName } from "./names.js";
import { classify, titleFrom } from "../classify.js";
import { config } from "../config.js";
import { routeForClient, type Route } from "../routes.js";
import { log } from "../log.js";
import {
  addEvent,
  createTask,
  deleteTask,
  getByClientMessage,
  ref,
  updateTask,
  type Task,
} from "../store.js";
import { handleInternalThreadMessage } from "./thread.js";

export function registerIngest(): void {
  app.event("message", async ({ event }) => {
    const message = asHumanMessage(event, botUserId);
    if (!message) return;

    try {
      const route = routeForClient(message.channel);
      if (route) {
        if (message.threadTs) {
          await relayClientReply(message.channel, message.threadTs, message.user, message.text);
        } else {
          await relayNewRequest(route, message.ts, message.user, message.text);
        }
        return;
      }

      // Anything else is only interesting if it's a reply under a relayed card.
      // Looking the task up directly means this works for every team channel
      // without the handler needing to know which channels those are.
      if (message.threadTs) {
        await handleInternalThreadMessage(message);
      }
    } catch (error) {
      log.error("message handler failed", error);
    }
  });
}

/** A fresh top-level message in a client channel becomes a relayed request. */
async function relayNewRequest(
  route: Route,
  ts: string,
  user: string,
  rawText: string,
): Promise<void> {
  const channel = route.client_channel;

  if (route.ingest_mode === "mention" && !mentionsBot(rawText, botUserId)) {
    log.debug(`ignoring message in ${channel} (route is mention-only)`);
    return;
  }

  // Slack retries deliveries it thinks we missed; never relay the same message twice.
  if (getByClientMessage(channel, ts)) {
    log.debug(`already relayed ${channel}/${ts}`);
    return;
  }

  const text = stripMention(rawText, botUserId);
  if (!text) return;

  const permalink = await getPermalink(channel, ts);

  // The relayed message needs the task's own id in its header, so the row is
  // written first under a placeholder ts and corrected once Slack assigns one.
  let task: Task;
  try {
    task = createTask({
      kind: classify(text),
      title: titleFrom(text),
      body: text,
      client_channel: channel,
      client_ts: ts,
      client_user: user,
      client_permalink: permalink,
      internal_channel: route.team_channel,
      internal_ts: `pending:${channel}:${ts}`,
    });
  } catch (error) {
    // Unique index tripped — a concurrent delivery won the race. Nothing to do.
    log.debug(`skipping duplicate relay for ${channel}/${ts}`, error);
    return;
  }

  const ctx = {
    clientName: await userName(user),
    channelLabel: await channelName(channel),
  };

  try {
    const posted = await client.chat.postMessage({
      channel: route.team_channel,
      text: requestFallback(task, ctx),
      // Wrapped in an attachment for the status colour stripe; see blocks.ts.
      attachments: [{ color: requestColor(task), blocks: requestBlocks(task, ctx) }],
      unfurl_links: false,
    });

    if (!posted.ts) throw new Error("Slack accepted the relay but returned no ts");
    task = updateTask(task.id, { internal_ts: posted.ts });
  } catch (error) {
    deleteTask(task.id);
    log.error(`could not relay ${channel}/${ts} to the internal channel`, error);
    return;
  }

  addEvent(task.id, "relayed", user, `from ${ctx.channelLabel}`);
  log.info(`relayed ${ref(task)} from ${ctx.channelLabel} (${task.kind})`);

  await seedReactions(task);
  await ackClientMessage(channel, ts);
}

/** Puts the claim/dismiss reactions in place so triage is one click. */
async function seedReactions(task: Task): Promise<void> {
  for (const name of [config.emoji.claim.primary, config.emoji.dismiss.primary]) {
    try {
      await client.reactions.add({
        channel: task.internal_channel,
        timestamp: task.internal_ts,
        name,
      });
    } catch (error) {
      log.warn(`could not seed :${name}: on ${ref(task)}`, error);
    }
  }
}

/** Marks the client's message as received without adding thread noise. */
async function ackClientMessage(channel: string, ts: string): Promise<void> {
  if (!config.emoji.ack || config.emoji.ack === "none") return;
  try {
    await client.reactions.add({ channel, timestamp: ts, name: config.emoji.ack });
  } catch (error) {
    log.debug("could not ack client message", error);
  }
}

/**
 * A client replying under their own request — usually answering a follow-up —
 * gets mirrored into the internal thread so the team sees it without leaving
 * their channel.
 */
async function relayClientReply(
  channel: string,
  threadTs: string,
  user: string,
  text: string,
): Promise<void> {
  const task = getByClientMessage(channel, threadTs);
  if (!task) return;

  const name = await userName(user);
  await client.chat.postMessage({
    channel: task.internal_channel,
    thread_ts: task.internal_ts,
    text: `${ICON.reply} *${name}* replied in ${await channelName(channel)}:\n${blockquote(text)}`,
    unfurl_links: false,
  });

  addEvent(task.id, "client_reply", user, text.slice(0, 500));
  log.info(`relayed client reply on ${ref(task)}`);
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

async function getPermalink(channel: string, ts: string): Promise<string | null> {
  try {
    const result = await client.chat.getPermalink({ channel, message_ts: ts });
    return result.permalink ?? null;
  } catch (error) {
    log.debug("could not fetch permalink", error);
    return null;
  }
}
