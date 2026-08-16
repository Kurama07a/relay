import type { KnownBlock } from "@slack/types";
import { config } from "../config.js";
import { ref, type Task } from "../store.js";
import { effortFor, formatExact } from "../sessions.js";
import { mention } from "./names.js";
import { dot, headerText, ICON, KIND, quote, STATUS, when } from "./design.js";

export { statusLabel } from "./design.js";

export interface RequestContext {
  clientName: string;
  channelLabel: string;
}

/**
 * The triage card in the internal channel.
 *
 * Built for a channel with twenty of these stacked in it, so the request title
 * is the only thing at full size and everything else is demoted to small grey
 * context. The stripe colour carries status, which means triage is a colour
 * scan rather than a reading task.
 *
 * Rebuilt in full on every change and pushed with `chat.update`, so the top of
 * the thread is always the task's real state rather than a stale snapshot.
 */
export function requestBlocks(task: Task, ctx: RequestContext): KnownBlock[] {
  const kind = KIND[task.kind];

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText(`${kind.icon}  ${task.title}`), emoji: true },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: dot(`*${ref(task)}*`, kind.label, `${ctx.clientName} in ${ctx.channelLabel}`),
        },
      ],
    },
  ];

  // For a one-line request the title already is the body; quoting it again just
  // says the same thing twice at two different sizes.
  const body = task.body.replace(/\s+/g, " ").trim();
  if (body !== task.title) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: quote(task.body) } });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: statusLine(task) }],
  });

  if (task.client_permalink) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: `Open in ${ctx.channelLabel}`, emoji: false },
          url: task.client_permalink,
          action_id: "open_client_message",
        },
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: hintLine(task) }],
  });

  return blocks;
}

/** The stripe colour down the left edge of the card. */
export function requestColor(task: Task): string {
  return STATUS[task.status].color;
}

/** Everything the card says about state, on one line. */
function statusLine(task: Task): string {
  const status = STATUS[task.status];
  const effort = effortFor(task.id);

  const owner = task.assignee ? mention(task.assignee) : "_unassigned_";
  const spent = effort.totalSeconds > 0 ? formatExact(effort.totalSeconds) : null;

  const timing = effort.active
    ? `${ICON.active} active now${spent ? ` · ${spent}` : ""}`
    : spent
      ? `${ICON.timer} ${spent}`
      : null;

  return dot(
    `${status.icon} *${status.label}*`,
    task.status === "dismissed" ? null : owner,
    timing,
  );
}

/** What to do next, phrased for whichever state the task is in. */
function hintLine(task: Task): string {
  const p = config.commandPrefix;

  if (task.status === "triage") {
    return `React :${config.emoji.claim.primary}: to claim · :${config.emoji.dismiss.primary}: to dismiss`;
  }
  if (task.status === "done") {
    return dot(
      task.completed_at ? `Completed ${when(task.completed_at)}` : null,
      `\`${p}reopen\` if it comes back`,
    );
  }
  if (task.status === "dismissed") {
    return `React :${config.emoji.claim.primary}: to bring this back`;
  }
  return `\`${p}start\` \`${p}pause\` \`${p}done\` \`${p}ask\` \`${p}block\` \`${p}help\``;
}

/** Fallback text for notifications and clients that can't render blocks. */
export function requestFallback(task: Task, ctx: RequestContext): string {
  return `${ref(task)} · ${KIND[task.kind].label} from ${ctx.clientName} in ${ctx.channelLabel}: ${task.title}`;
}
