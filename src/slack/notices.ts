import type { KnownBlock } from "@slack/types";
import { ref, type Task } from "../store.js";
import { dot, ICON } from "./design.js";

/**
 * Everything the bot says in a client's thread.
 *
 * Kept apart from the internal card on purpose. The client is not a user of
 * this system: they should never meet a status name, a command, or the word
 * "assignee". They get a sentence a person could have written, with the ticket
 * reference demoted to small grey text in case they ever need to quote it.
 *
 * Every function returns fallback `text` as well as blocks, because `text` is
 * what shows up in the client's push notification.
 */
export interface Notice {
  text: string;
  blocks: KnownBlock[];
}

/** A sentence, optionally with a small grey footnote beneath it. */
function say(lead: string, footnote?: string | null): Notice {
  const blocks: KnownBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: lead } },
  ];
  if (footnote) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footnote }] });
  }
  return { text: stripMarkup(lead), blocks };
}

/** Notification previews render markup literally, so flatten it. */
function stripMarkup(text: string): string {
  return text.replace(/\*/g, "").replace(/_/g, "").trim();
}

export const notices = {
  claimed(task: Task, name: string): Notice {
    return say(
      `${ICON.greeting} *${name}* is picking this up.\nI'll post updates here as it moves.`,
      ref(task),
    );
  },

  reassigned(task: Task, name: string): Notice {
    return say(`${ICON.handoff} *${name}* has taken this over.`, ref(task));
  },

  /** Sent when a claim is released, so the client isn't left with a wrong name. */
  releasing(task: Task): Notice {
    return say(
      `${ICON.handoff} This is being reassigned — I'll confirm the new owner here shortly.`,
      ref(task),
    );
  },

  started(_task: Task, name: string): Notice {
    return say(`${ICON.start} *${name}* has started on this.`);
  },

  blocked(_task: Task, reason: string): Notice {
    return say(`${ICON.pause} On hold — ${reason}`);
  },

  unblocked(_task: Task): Notice {
    return say(`${ICON.resume} Back on this one.`);
  },

  question(_task: Task, name: string, question: string): Notice {
    return say(
      `${ICON.question} *${name}* asks: ${question}`,
      "Reply here and it reaches the team.",
    );
  },

  message(_task: Task, name: string, body: string): Notice {
    return say(`${ICON.reply} *${name}*: ${body}`);
  },

  /**
   * The completion message. Effort is phrased loosely and lives in the
   * footnote — precise figures invite a line-item argument about work that was
   * already agreed, and the exact total stays in the internal ledger.
   */
  done(_task: Task, name: string, note: string | undefined, roundedEffort: string | null): Notice {
    const lead = note ? `${ICON.done} Done — ${note}` : `${ICON.done} Done.`;
    return say(lead, dot(name, roundedEffort));
  },

  reopened(task: Task, why?: string): Notice {
    return say(
      `${ICON.reopen} Reopened${why ? ` — ${why}` : ""}. We'll pick this back up.`,
      ref(task),
    );
  },
};

/** Escape hatch for one-off text that doesn't warrant a named notice. */
export function plain(text: string): Notice {
  return say(text);
}
