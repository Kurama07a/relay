import type { TaskKind } from "./store.js";

interface Rule {
  kind: TaskKind;
  pattern: RegExp;
}

/**
 * Keyword classification, checked in order — first match wins, so the more
 * specific categories (a PR link is unambiguous) come before the vaguer ones.
 * It only decides the label on the relayed message; anyone can correct it in
 * the thread with `!kind`, so a wrong guess is cheap.
 */
const RULES: Rule[] = [
  {
    kind: "review",
    pattern:
      /\b(pr|pull request|merge request|mr)\b|\breview(ed|ing)?\b|\bgithub\.com\/[^\s]+\/pull\/\d+|\bgitlab\.com\/[^\s]+\/merge_requests\/\d+/i,
  },
  {
    kind: "bug",
    pattern:
      /\bbug\b|\bbroken\b|\bbreaks?\b|\bcrash(es|ing|ed)?\b|\berror\b|\bfail(s|ed|ing|ure)?\b|\bnot working\b|\bdoesn'?t work\b|\bregression\b|\bstack ?trace\b|\b5\d{2}\b/i,
  },
  {
    kind: "feature",
    pattern:
      /\bfeature\b|\bcan (we|you) (add|build|make|have)\b|\bwould like\b|\bimplement\b|\bsupport for\b|\bnew (page|screen|endpoint|flow)\b|\brequest(ing)? (a|an|the)\b/i,
  },
  {
    kind: "question",
    pattern: /\?\s*$|\bhow (do|does|would|can)\b|\bwhat('s| is)\b|\bwhen (will|can|do)\b|\bis it possible\b/i,
  },
];

export function classify(text: string): TaskKind {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.kind;
  }
  return "request";
}

/**
 * How each kind is presented lives in `slack/design.ts`, alongside the rest of
 * the visual language — this module decides what something *is*, not how it
 * looks.
 */

/** First line, trimmed to something that reads as a title in a list. */
export function titleFrom(text: string, max = 120): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const base = (firstLine ?? text).replace(/\s+/g, " ").trim();
  if (base.length <= max) return base || "(no text)";
  return `${base.slice(0, max - 1).trimEnd()}…`;
}
