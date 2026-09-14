import { db } from "../db.js";
import type { JiraUser } from "./client.js";

/**
 * Who's who across Jira and Slack.
 *
 * Jira identifies people by account id and usually hides their email — often
 * for all but a few accounts — so the link to a Slack member is
 * made by an admin, once, in a form. Suggestions pre-fill that form; nothing is
 * linked until the admin saves it.
 */

export interface JiraMember {
  jira_account_id: string;
  display_name: string;
  email: string | null;
  active: number;
  slack_user: string | null;
  linked_by: string | null;
  linked_at: string | null;
  updated_at: string;
}

/** The parts of a Slack user that matter for linking. */
export interface SlackPerson {
  id: string;
  names: string[];
  email: string | null;
  isBot: boolean;
  isGuest: boolean;
  deleted: boolean;
}

export interface LinkChoice {
  accountId: string;
  slackUser: string | null;
}

export type Suggestion = { slackUser: string; via: "email" | "name" };

/**
 * Records the people Jira says can work on a project. Apps and automation
 * accounts are left out: they can be assigned issues, but nobody links them.
 */
export function syncMembers(users: JiraUser[]): { added: number; total: number } {
  const humans = users.filter((user) => user.accountType === "atlassian");
  const now = new Date().toISOString();
  let added = 0;

  const exists = db.prepare(`SELECT 1 FROM jira_members WHERE jira_account_id = ?`);
  const upsert = db.prepare(
    `INSERT INTO jira_members (jira_account_id, display_name, email, active, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(jira_account_id) DO UPDATE SET
       display_name = excluded.display_name,
       email = COALESCE(excluded.email, jira_members.email),
       active = excluded.active,
       updated_at = excluded.updated_at`,
  );

  db.transaction(() => {
    for (const user of humans) {
      if (!exists.get(user.accountId)) added++;
      upsert.run(user.accountId, user.displayName, user.emailAddress || null, user.active ? 1 : 0, now);
    }
  })();

  return { added, total: humans.length };
}

export function listMembers(): JiraMember[] {
  return db
    .prepare(`SELECT * FROM jira_members WHERE active = 1 ORDER BY display_name COLLATE NOCASE`)
    .all() as JiraMember[];
}

export function slackUserFor(accountId: string): string | null {
  const row = db
    .prepare(`SELECT slack_user FROM jira_members WHERE jira_account_id = ?`)
    .get(accountId) as { slack_user: string | null } | undefined;
  return row?.slack_user ?? null;
}

export function memberForSlackUser(slackUser: string): JiraMember | undefined {
  return db.prepare(`SELECT * FROM jira_members WHERE slack_user = ?`).get(slackUser) as
    | JiraMember
    | undefined;
}

function displayName(accountId: string): string {
  const row = db
    .prepare(`SELECT display_name FROM jira_members WHERE jira_account_id = ?`)
    .get(accountId) as { display_name: string } | undefined;
  return row?.display_name ?? accountId;
}

/**
 * Problems with a set of choices, keyed by Jira account id. A Slack member can
 * stand for one Jira member only; when two rows pick the same person, the later
 * row gets the error, next to the choice that caused it.
 */
export function linkProblems(
  choices: LinkChoice[],
  people: Map<string, SlackPerson>,
): Record<string, string> {
  const problems: Record<string, string> = {};
  const inForm = new Set(choices.map((choice) => choice.accountId));
  const taken = new Map<string, string>();
  const heldBy = db.prepare(`SELECT jira_account_id, display_name FROM jira_members WHERE slack_user = ?`);

  for (const choice of choices) {
    if (!choice.slackUser) continue;
    const person = people.get(choice.slackUser);

    if (person?.isBot) {
      problems[choice.accountId] = "That's an app, not a person.";
      continue;
    }
    if (person?.isGuest) {
      problems[choice.accountId] = "That's a guest account. Only team members can be linked to Jira.";
      continue;
    }

    const earlier = taken.get(choice.slackUser);
    if (earlier) {
      problems[choice.accountId] = `Already chosen for ${earlier}. Each Slack member can be linked once.`;
      continue;
    }

    const existing = heldBy.get(choice.slackUser) as
      | { jira_account_id: string; display_name: string }
      | undefined;
    if (existing && !inForm.has(existing.jira_account_id)) {
      problems[choice.accountId] = `Already linked to ${existing.display_name}.`;
      continue;
    }

    taken.set(choice.slackUser, displayName(choice.accountId));
  }

  return problems;
}

/**
 * Saves the form. Rows in it are cleared before any are set, so two people can
 * swap links in one save without tripping the one-link-per-person rule midway.
 *
 * Returns how many rows are linked.
 */
export function saveLinks(choices: LinkChoice[], by: string): number {
  const now = new Date().toISOString();
  let linked = 0;

  const clear = db.prepare(`UPDATE jira_members SET slack_user = NULL WHERE jira_account_id = ?`);
  const set = db.prepare(
    `UPDATE jira_members SET slack_user = ?, linked_by = ?, linked_at = ? WHERE jira_account_id = ?`,
  );

  db.transaction(() => {
    for (const choice of choices) clear.run(choice.accountId);
    for (const choice of choices) {
      if (!choice.slackUser) continue;
      set.run(choice.slackUser, by, now, choice.accountId);
      linked++;
    }
  })();

  return linked;
}

/** Removes whatever Jira link a Slack member has. Slack's pickers can't be emptied. */
export function unlinkSlackUser(slackUser: string): JiraMember | undefined {
  const member = memberForSlackUser(slackUser);
  if (!member) return undefined;
  db.prepare(
    `UPDATE jira_members SET slack_user = NULL, linked_by = NULL, linked_at = NULL WHERE jira_account_id = ?`,
  ).run(member.jira_account_id);
  return member;
}

/** Folds a name down for comparison: case, accents and punctuation don't count. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Likely Slack accounts for unlinked Jira members. Email first, because it's
 * unambiguous; then an exact full-name match, but only when exactly one team
 * member has that name. Guests, apps, deactivated accounts and anyone already
 * linked are never suggested.
 */
export function suggestLinks(members: JiraMember[], people: SlackPerson[]): Map<string, Suggestion> {
  const linked = new Set(members.map((member) => member.slack_user).filter(Boolean));
  const available = people.filter(
    (person) => !person.isBot && !person.isGuest && !person.deleted && !linked.has(person.id),
  );
  const unlinked = members.filter((member) => !member.slack_user);
  const suggestions = new Map<string, Suggestion>();
  const claimed = new Set<string>();

  const only = (matches: SlackPerson[]) => (matches.length === 1 ? matches[0] : undefined);

  for (const member of unlinked) {
    const email = member.email?.toLowerCase();
    if (!email) continue;
    const match = only(available.filter((person) => person.email?.toLowerCase() === email));
    if (match && !claimed.has(match.id)) {
      suggestions.set(member.jira_account_id, { slackUser: match.id, via: "email" });
      claimed.add(match.id);
    }
  }

  for (const member of unlinked) {
    if (suggestions.has(member.jira_account_id)) continue;
    const name = normalizeName(member.display_name);
    if (!name) continue;
    const match = only(
      available.filter((person) => person.names.some((candidate) => normalizeName(candidate) === name)),
    );
    if (match && !claimed.has(match.id)) {
      suggestions.set(member.jira_account_id, { slackUser: match.id, via: "name" });
      claimed.add(match.id);
    }
  }

  return suggestions;
}
