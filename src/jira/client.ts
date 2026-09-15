import { config } from "../config.js";
import { log } from "../log.js";

/**
 * Relay's one way into Jira, and a read-only one by construction.
 *
 * The account behind JIRA_API_TOKEN may be allowed to edit, move and assign
 * issues — it's often a project admin. So "Relay never changes Jira" is not
 * left to that account's permissions: every request below is a GET, and there
 * is no path through this module that sends anything else. Writes, if they
 * ever come, get their own module behind their own switch.
 */

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
  projectKey: string | null;
}

export type SprintState = "future" | "active" | "closed";

export interface JiraSprint {
  id: number;
  name: string;
  state: SprintState;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId?: number;
}

export interface BoardColumn {
  name: string;
  statusIds: string[];
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active: boolean;
  accountType: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

type Fetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

let send: Fetch = (url, init) => fetch(url, init);

/** Swaps the network out for tests. Nothing else should call this. */
export function useFetchForTests(fake: Fetch): void {
  send = fake;
}

export function jiraConfigured(): boolean {
  return Boolean(config.jira.url && config.jira.email && config.jira.apiToken);
}

export function describeJiraError(error: unknown): string {
  if (error instanceof JiraError) return error.message;
  return (error as Error)?.message ?? String(error);
}

const MAX_ATTEMPTS = 3;

async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!jiraConfigured()) {
    throw new JiraError(0, "Jira isn't configured. Set JIRA_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
  }

  const url = new URL(`${config.jira.url}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const auth = Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString("base64");

  for (let attempt = 1; ; attempt++) {
    const response = await send(url.toString(), {
      method: "GET",
      headers: { authorization: `Basic ${auth}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });

    if (response.ok) return (await response.json()) as T;

    // Jira Cloud rate-limits by cost and says how long to back off. Honouring
    // it keeps a busy poll from turning into a string of failures.
    if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
      const header = response.headers.get("retry-after");
      const seconds =
        header !== null && header.trim() !== "" && Number.isFinite(Number(header))
          ? Number(header)
          : 2 ** attempt;
      const wait = Math.min(seconds, 30);
      log.warn(`jira ${response.status} on ${url.pathname}, retrying in ${wait}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }

    throw new JiraError(response.status, await describeFailure(response));
  }
}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let detail = "";
  try {
    const body = JSON.parse(text) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    detail = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {}), body.message ?? ""]
      .filter(Boolean)
      .join("; ");
  } catch {
    detail = text.slice(0, 200);
  }

  const hint =
    response.status === 401
      ? " Check JIRA_EMAIL and JIRA_API_TOKEN — the token may have been revoked or expired."
      : response.status === 403
        ? " The Jira account isn't allowed to see this. Does it have Browse projects permission?"
        : response.status === 404
          ? " It doesn't exist, or it's hidden from this Jira account."
          : "";

  return `Jira answered ${response.status}${detail ? ` (${detail})` : ""}.${hint}`;
}

/** The account Relay is acting as. Used at startup to prove the token works. */
export async function myself(): Promise<{ accountId: string; displayName: string; timeZone?: string }> {
  return get("/rest/api/3/myself");
}

export async function listBoards(): Promise<JiraBoard[]> {
  const boards: JiraBoard[] = [];
  for (let startAt = 0; ; ) {
    const page = await get<{
      values: Array<{ id: number; name: string; type: string; location?: { projectKey?: string } }>;
      isLast?: boolean;
    }>("/rest/agile/1.0/board", { startAt, maxResults: 50 });

    for (const board of page.values) {
      boards.push({
        id: board.id,
        name: board.name,
        type: board.type,
        projectKey: board.location?.projectKey ?? null,
      });
    }
    if (page.isLast !== false || page.values.length === 0) return boards;
    startAt += page.values.length;
  }
}

/** The board's columns, left to right, with the Jira statuses each one holds. */
export async function boardColumns(boardId: number): Promise<BoardColumn[]> {
  const configuration = await get<{
    columnConfig?: { columns?: Array<{ name: string; statuses?: Array<{ id: string }> }> };
  }>(`/rest/agile/1.0/board/${boardId}/configuration`);

  return (configuration.columnConfig?.columns ?? []).map((column) => ({
    name: column.name,
    statusIds: (column.statuses ?? []).map((status) => status.id),
  }));
}

export async function listSprints(
  boardId: number,
  states: SprintState[] = ["active", "future", "closed"],
): Promise<JiraSprint[]> {
  const sprints: JiraSprint[] = [];
  for (let startAt = 0; ; ) {
    const page = await get<{ values: JiraSprint[]; isLast?: boolean }>(
      `/rest/agile/1.0/board/${boardId}/sprint`,
      { state: states.join(","), startAt, maxResults: 50 },
    );
    sprints.push(...page.values);
    if (page.isLast !== false || page.values.length === 0) return sprints;
    startAt += page.values.length;
  }
}

export async function activeSprint(boardId: number): Promise<JiraSprint | null> {
  const [sprint] = await listSprints(boardId, ["active"]);
  return sprint ?? null;
}

export async function sprintById(sprintId: number): Promise<JiraSprint> {
  return get(`/rest/agile/1.0/sprint/${sprintId}`);
}

/** One issue, or null if it has been deleted or hidden from this account. */
export async function issueById(issueId: string, fields: string[]): Promise<JiraIssue | null> {
  try {
    return await get<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(issueId)}`, { fields: fields.join(",") });
  } catch (error) {
    if (error instanceof JiraError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Everyone who can be assigned issues in a project. Jira filters this list by
 * permission after paging, so a short page doesn't always mean the last one —
 * but it's the signal Jira gives, and the cap stops a runaway loop.
 */
export async function assignableMembers(projectKey: string): Promise<JiraUser[]> {
  const users: JiraUser[] = [];
  const pageSize = 100;
  for (let startAt = 0; startAt < 2000; startAt += pageSize) {
    const page = await get<JiraUser[]>("/rest/api/3/user/assignable/search", {
      project: projectKey,
      startAt,
      maxResults: pageSize,
    });
    users.push(...page);
    if (page.length < pageSize) break;
  }
  return users;
}

/**
 * Every issue matching a JQL query, following Jira's page tokens. Capped so a
 * query that accidentally matches the whole site can't become a runaway poll.
 */
export async function searchIssues(jql: string, fields: string[], maxPages = 20): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await get<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>(
      "/rest/api/3/search/jql",
      { jql, fields: fields.join(","), maxResults: 100, nextPageToken },
    );
    issues.push(...(result.issues ?? []));
    if (!result.nextPageToken || result.isLast) return issues;
    nextPageToken = result.nextPageToken;
  }

  log.warn(`jira search stopped after ${maxPages} pages: ${jql}`);
  return issues;
}

/** Custom field ids by display name. "Sprint" and "Flagged" differ per site. */
export async function fieldIds(names: string[]): Promise<Record<string, string | undefined>> {
  const fields = await get<Array<{ id: string; name: string }>>("/rest/api/3/field");
  return Object.fromEntries(names.map((name) => [name, fields.find((field) => field.name === name)?.id]));
}
