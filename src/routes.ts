import { db } from "./db.js";
import { log } from "./log.js";

export type IngestMode = "all" | "mention";

export interface Route {
  id: number;
  client_channel: string;
  team_channel: string;
  label: string | null;
  ingest_mode: IngestMode;
  active: number;
  created_at: string;
  created_by: string | null;
  /** The Jira board this pairing follows, if any, and where its stories go. */
  sprint_channel: string | null;
  jira_board_id: number | null;
  jira_board_name: string | null;
  jira_project_key: string | null;
}

/**
 * Channel pairings: which client channel relays into which team channel.
 *
 * Read on every inbound message, so it's cached in memory and rebuilt whenever
 * something changes. The table is tiny — this is about avoiding a query per
 * Slack event, not about the data being expensive.
 */
let cache: Route[] | null = null;

function load(): Route[] {
  if (cache) return cache;
  cache = db.prepare(`SELECT * FROM routes WHERE active = 1 ORDER BY id`).all() as Route[];
  return cache;
}

export function invalidate(): void {
  cache = null;
}

export function listRoutes(includeInactive = false): Route[] {
  return includeInactive
    ? (db.prepare(`SELECT * FROM routes ORDER BY id`).all() as Route[])
    : load();
}

/** The pairing a client message belongs to, if any. */
export function routeForClient(channel: string): Route | undefined {
  return load().find((route) => route.client_channel === channel);
}

/** True if this channel receives relayed cards for at least one pairing. */
export function isTeamChannel(channel: string): boolean {
  return load().some((route) => route.team_channel === channel);
}

/** The pairing whose Jira stories are threaded in this channel, if any. */
export function routeForSprintChannel(channel: string): Route | undefined {
  return load().find((route) => route.sprint_channel === channel);
}

/** Every channel the bot needs to be a member of. */
export function watchedChannels(): string[] {
  const channels = new Set<string>();
  for (const route of load()) {
    channels.add(route.client_channel);
    channels.add(route.team_channel);
    if (route.sprint_channel) channels.add(route.sprint_channel);
  }
  return [...channels];
}

export interface AddRouteInput {
  clientChannel: string;
  teamChannel: string;
  label?: string;
  ingestMode?: IngestMode;
  createdBy?: string;
}

export type AddRouteResult =
  | { ok: true; route: Route; replaced: Route | null }
  | { ok: false; error: string };

export function addRoute(input: AddRouteInput): AddRouteResult {
  if (input.clientChannel === input.teamChannel) {
    return {
      ok: false,
      error: "A channel can't be paired with itself — the bot would relay its own posts back into it.",
    };
  }

  // A client channel routing to two team channels would double-post every
  // request, so pairing an already-paired channel replaces the old route.
  const existing = db
    .prepare(`SELECT * FROM routes WHERE client_channel = ?`)
    .get(input.clientChannel) as Route | undefined;

  if (isTeamChannel(input.clientChannel)) {
    return {
      ok: false,
      error: "That channel already receives relayed cards for another pairing. It can't also be a client channel.",
    };
  }
  if (
    listRoutes().some(
      (route) => route.sprint_channel === input.clientChannel || route.sprint_channel === input.teamChannel,
    )
  ) {
    return {
      ok: false,
      error: "That channel holds sprint threads for a Jira board. Pick a different one.",
    };
  }
  if (listRoutes().some((route) => route.client_channel === input.teamChannel)) {
    return {
      ok: false,
      error: "That team channel is already used as a client channel in another pairing.",
    };
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE routes SET team_channel = ?, label = ?, ingest_mode = ?, active = 1,
                         created_at = ?, created_by = ? WHERE id = ?`,
    ).run(
      input.teamChannel,
      input.label ?? null,
      input.ingestMode ?? "all",
      now,
      input.createdBy ?? null,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO routes (client_channel, team_channel, label, ingest_mode, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.clientChannel,
      input.teamChannel,
      input.label ?? null,
      input.ingestMode ?? "all",
      now,
      input.createdBy ?? null,
    );
  }

  invalidate();
  const route = db
    .prepare(`SELECT * FROM routes WHERE client_channel = ?`)
    .get(input.clientChannel) as Route;

  log.info(`route ${route.client_channel} → ${route.team_channel} (${route.ingest_mode})`);
  return { ok: true, route, replaced: existing ?? null };
}

/**
 * Deactivates rather than deletes. Tasks already relayed keep working — they
 * carry their own channel ids — and the history of what was once paired stays
 * readable.
 */
export function removeRoute(clientChannel: string): Route | null {
  const route = db
    .prepare(`SELECT * FROM routes WHERE client_channel = ? AND active = 1`)
    .get(clientChannel) as Route | undefined;
  if (!route) return null;

  db.prepare(`UPDATE routes SET active = 0 WHERE id = ?`).run(route.id);
  invalidate();
  log.info(`route removed: ${route.client_channel} → ${route.team_channel}`);
  return route;
}

export function countRoutes(): number {
  return load().length;
}

export interface JiraBoardInput {
  boardId: number;
  boardName: string;
  projectKey: string;
  sprintChannel: string;
}

/**
 * Connects a Jira board to a pairing, along with the channel its sprint threads
 * go to. That channel is client-facing and gets one thread per story, so it has
 * to be a channel of its own: not either side of any pairing, and not another
 * board's sprint channel.
 */
export function setJiraBoard(
  routeId: number,
  input: JiraBoardInput,
): { ok: true; route: Route } | { ok: false; error: string } {
  const routes = listRoutes();
  if (!routes.some((route) => route.id === routeId)) {
    return { ok: false, error: "That pairing no longer exists." };
  }

  const clash = routes.some(
    (route) =>
      route.client_channel === input.sprintChannel ||
      route.team_channel === input.sprintChannel ||
      (route.id !== routeId && route.sprint_channel === input.sprintChannel),
  );
  if (clash) {
    return {
      ok: false,
      error: "That channel is already part of a pairing. Sprint threads need a channel of their own.",
    };
  }

  db.prepare(
    `UPDATE routes SET jira_board_id = ?, jira_board_name = ?, jira_project_key = ?, sprint_channel = ?
     WHERE id = ?`,
  ).run(input.boardId, input.boardName, input.projectKey, input.sprintChannel, routeId);
  invalidate();

  const route = listRoutes().find((candidate) => candidate.id === routeId)!;
  log.info(`route ${route.client_channel} follows jira board ${input.boardId} (${input.projectKey})`);
  return { ok: true, route };
}
