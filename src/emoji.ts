/**
 * Slack emoji names are not unique. The same glyph can arrive under several
 * names depending on which one the reacting client used — ✋ comes through as
 * either `raised_hand` or `hand`, and comparing the raw string means a reaction
 * that looks correct to the user is silently ignored.
 *
 * So a configured emoji expands into the set of names that mean the same thing,
 * and matching is done against the whole set.
 */

/**
 * Names Slack treats as the same emoji. Kept deliberately conservative: only
 * true aliases belong here, never two glyphs that merely look similar. If you
 * want unrelated emoji to work, list them in the env var instead —
 * `CLAIM_EMOJI=raised_hand,point_up` — which is additive to these.
 */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["raised_hand", "hand"], // ✋
  ["thumbsup", "+1", "thumbs_up"], // 👍
  ["thumbsdown", "-1", "thumbs_down"], // 👎
  ["raising_hand", "person_raising_hand"], // 🙋
  ["raised_hands", "raising_hands"], // 🙌
];

export interface EmojiSet {
  /** The name used when the bot adds the reaction itself, and in help text. */
  primary: string;
  /** Every name that counts as this reaction. */
  accepts: string[];
}

/** Strips colons and any skin-tone suffix: `:raised_hand::skin-tone-3:` → `raised_hand`. */
export function normalizeEmoji(name: string): string {
  return (name.split("::")[0] ?? name).replace(/:/g, "").trim().toLowerCase();
}

/**
 * Builds the matching set for a configured value. Accepts a comma-separated
 * list, and folds in the known aliases of everything listed.
 */
export function emojiSet(configured: string): EmojiSet {
  const listed = configured
    .split(",")
    .map(normalizeEmoji)
    .filter(Boolean);

  const accepts = new Set<string>(listed);
  for (const name of listed) {
    for (const group of ALIAS_GROUPS) {
      if (group.includes(name)) group.forEach((alias) => accepts.add(alias));
    }
  }

  return { primary: listed[0] ?? "", accepts: [...accepts] };
}

export function matches(set: EmojiSet, reaction: string): boolean {
  return set.accepts.includes(normalizeEmoji(reaction));
}

/** True if two sets share any name — an ambiguous configuration. */
export function overlaps(a: EmojiSet, b: EmojiSet): boolean {
  return a.accepts.some((name) => b.accepts.includes(name));
}
