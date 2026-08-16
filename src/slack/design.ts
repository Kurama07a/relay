import type { TaskKind, TaskStatus } from "../store.js";

/**
 * The visual language, in one place.
 *
 * Slack gives you almost no styling: no CSS, no fonts, no arbitrary colour.
 * What you get is a left-edge stripe on an attachment, three text weights, and
 * emoji. That scarcity is exactly why the vocabulary has to be defined once and
 * reused — a bot that picks a fresh emoji per message reads as noise.
 */

/**
 * Stripe colour per status. The point is that a channel of cards can be
 * scanned by colour instead of read: amber means nobody has it yet, red means
 * it is stuck. Chosen to stay legible against both light and dark Slack.
 */
export const STATUS: Record<
  TaskStatus,
  { icon: string; label: string; color: string }
> = {
  triage: { icon: "🆕", label: "Needs triage", color: "#E8A33D" },
  open: { icon: "📋", label: "Claimed", color: "#5B8DEF" },
  in_progress: { icon: "🔧", label: "In progress", color: "#22B8CF" },
  blocked: { icon: "⛔", label: "Blocked", color: "#E5484D" },
  done: { icon: "✅", label: "Done", color: "#30A46C" },
  dismissed: { icon: "🗑️", label: "Dismissed", color: "#8B8D98" },
};

export const KIND: Record<TaskKind, { icon: string; label: string }> = {
  bug: { icon: "🐞", label: "Bug" },
  feature: { icon: "✨", label: "Feature" },
  review: { icon: "🔍", label: "Review" },
  question: { icon: "❓", label: "Question" },
  request: { icon: "📨", label: "Request" },
};

/**
 * Icons for things that happen, as opposed to states. Kept deliberately small —
 * every addition dilutes the ones already here.
 */
export const ICON = {
  claim: "🙌",
  handoff: "🔄",
  start: "🔧",
  pause: "⏸️",
  resume: "▶️",
  done: "✅",
  blocked: "⛔",
  reopen: "↩️",
  question: "❓",
  reply: "💬",
  note: "🔒",
  timer: "⏱️",
  active: "🟢",
  warning: "⚠️",
  dismissed: "🗑️",
  greeting: "👋",
} as const;

export function statusLabel(status: TaskStatus): string {
  return `${STATUS[status].icon} ${STATUS[status].label}`;
}

/** Joins parts with a middot, dropping anything empty. */
export function dot(...parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(" · ");
}

/** Slack section text caps at 3000 characters. */
export function truncate(text: string, max = 2800): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…_(truncated)_`;
}

/** Renders text as a blockquote so it reads as somebody else's words. */
export function quote(text: string): string {
  return truncate(
    text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  );
}

/** `header` blocks are plain_text and cap at 150 characters. */
export function headerText(text: string, max = 150): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A Slack date that renders in each reader's own timezone. */
export function when(iso: string): string {
  const epoch = Math.floor(new Date(iso).getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|${iso}>`;
}
