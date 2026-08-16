import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config, isLoopback } from "./config.js";
import { log } from "./log.js";
import { hasAnyToken, resolveToken } from "./tokens.js";
import {
  getTask,
  listTasks,
  parseRef,
  ref,
  type Task,
  type TaskStatus,
} from "./store.js";
import {
  adjustSession,
  effortFor,
  formatExact,
  formatRounded,
  heartbeat,
  openSessionFor,
  sessionsFor,
  sessionSeconds,
} from "./sessions.js";
import { finishWork, reopenWork, startWork, stopWork } from "./slack/work.js";
import type { SessionSource } from "./sessions.js";
import { assign, postToClient, postToInternal, transition } from "./slack/actions.js";
import { notices } from "./slack/notices.js";
import {
  completeAuth,
  consumeState,
  createSpreadsheet,
  spreadsheetUrl,
} from "./google.js";
import { ICON } from "./slack/design.js";
import { desiredTitle } from "./sheets.js";
import {
  candidates,
  explainGuess,
  guessTask,
  remember as rememberDir,
} from "./workdirs.js";
import { addEvent, listEvents } from "./store.js";
import { userName } from "./slack/names.js";

const ACTIVE: TaskStatus[] = ["triage", "open", "in_progress", "blocked"];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Ctx {
  engineer: string;
  body: Record<string, unknown>;
  query: URLSearchParams;
}

/**
 * Auth model, deliberately two-mode so this works before any deployment
 * decision is made:
 *
 *   - Bound to loopback with no tokens minted: trusted local use. The caller
 *     states who they are via `X-Relay-User`.
 *   - Any token minted, or bound to a non-loopback address: bearer token
 *     required, and identity comes from the token rather than the caller.
 *
 * The second rule is the important one — it makes it impossible to expose this
 * on a network interface without authentication by changing a single setting.
 */
function authenticate(req: IncomingMessage): string {
  const tokensExist = hasAnyToken();
  const requireToken = tokensExist || !isLoopback(config.api.host);

  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (bearer) {
    const engineer = resolveToken(bearer);
    if (!engineer) throw new HttpError(401, "Invalid or revoked token.");
    return engineer;
  }

  if (requireToken) {
    throw new HttpError(
      401,
      tokensExist
        ? "This Relay requires a token. Run `npm run token -- --user <SLACK_ID>` on the server and set RELAY_TOKEN."
        : "Relay is bound to a non-loopback address, so a token is required. Mint one with `npm run token`.",
    );
  }

  const declared = req.headers["x-relay-user"];
  const engineer = Array.isArray(declared) ? declared[0] : declared;
  if (!engineer) {
    throw new HttpError(
      401,
      "No identity. Set RELAY_USER to your Slack user ID, or mint a token with `npm run token`.",
    );
  }
  return engineer;
}

function taskFromPath(segment: string | undefined): Task {
  const id = segment ? parseRef(segment) : null;
  if (id === null) throw new HttpError(400, `"${segment}" is not a task reference like REL-7.`);
  const task = getTask(id);
  if (!task) throw new HttpError(404, `No task ${segment}.`);
  return task;
}

/** Shape returned to the CLI — flat, and already carrying formatted durations. */
function serialize(task: Task) {
  const effort = effortFor(task.id);
  return {
    ref: ref(task),
    id: task.id,
    title: task.title,
    body: task.body,
    kind: task.kind,
    status: task.status,
    assignee: task.assignee,
    requestedBy: task.client_user,
    permalink: task.client_permalink,
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    effort: {
      seconds: effort.totalSeconds,
      exact: formatExact(effort.totalSeconds),
      rounded: formatRounded(effort.totalSeconds),
      sessions: effort.sessionCount,
      active: effort.active,
      lastActivityAt: effort.lastActivityAt,
    },
  };
}

type Handler = (ctx: Ctx, params: string[]) => Promise<unknown>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  {
    method: "GET",
    pattern: /^\/health$/,
    handler: async () => ({ ok: true, version: "0.3.0" }),
  },

  {
    method: "GET",
    pattern: /^\/me$/,
    handler: async ({ engineer }) => {
      const open = openSessionFor(engineer);
      return {
        engineer,
        name: await userName(engineer),
        activeSession: open
          ? {
              task: ref({ id: open.task_id }),
              startedAt: open.started_at,
              elapsed: formatExact(sessionSeconds(open)),
            }
          : null,
      };
    },
  },

  {
    method: "GET",
    pattern: /^\/tasks$/,
    handler: async ({ engineer, query }) => {
      const scope = query.get("scope") ?? "open";
      const limit = Number(query.get("limit") ?? 25);

      const tasks =
        scope === "mine"
          ? listTasks({ status: ACTIVE, assignee: engineer, limit })
          : scope === "unclaimed"
            ? listTasks({ status: ["triage"], limit })
            : scope === "all"
              ? listTasks({ limit })
              : scope === "done"
                ? listTasks({ status: ["done"], limit })
                : listTasks({ status: ACTIVE, limit });

      return { scope, tasks: tasks.map(serialize) };
    },
  },

  {
    method: "GET",
    pattern: /^\/tasks\/([^/]+)$/,
    handler: async (_ctx, [refString]) => {
      const task = taskFromPath(refString);

      // The whole conversation, both sides, so an agent can read the context
      // without anyone forwarding messages by hand.
      const conversation = await Promise.all(
        listEvents(task.id, 100)
          .reverse()
          .filter((event) =>
            ["client_reply", "question", "reply", "note", "thread_note"].includes(event.type),
          )
          .map(async (event) => ({
            at: event.created_at,
            from: event.actor ? await userName(event.actor) : "system",
            channel: event.type === "client_reply" ? "client" : "internal",
            kind: event.type,
            text: event.detail ?? "",
          })),
      );

      return {
        ...serialize(task),
        conversation,
        sessions: sessionsFor(task.id).map((session) => ({
          id: session.id,
          engineer: session.engineer,
          source: session.source,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          endReason: session.end_reason,
          duration: formatExact(sessionSeconds(session)),
        })),
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/claim$/,
    handler: async ({ engineer }, [refString]) => {
      const task = taskFromPath(refString);
      if (task.assignee && task.assignee !== engineer) {
        throw new HttpError(
          409,
          `${ref(task)} is already assigned to ${await userName(task.assignee)}. Pass force to take it over.`,
        );
      }
      const updated = await assign(task, engineer, engineer);
      await postToInternal(
        updated,
        `:raising_hand: <@${engineer}> claimed this from their editor.`,
      );
      return serialize(updated);
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/start$/,
    handler: async ({ engineer, body }, [refString]) => {
      const task = taskFromPath(refString);
      if (task.status === "done") throw new HttpError(409, `${ref(task)} is already done.`);

      const source = (body.source as string) === "codex" ? "codex" : (body.source as string) === "claude-code" ? "claude-code" : "cli";
      const result = await startWork(task, engineer, source);

      // Remember where this happened, so next time nobody has to say which task.
      if (body.workdir) rememberDir(engineer, body.workdir as string, task.id);

      return {
        ...serialize(result.task),
        session: { id: result.session.id, startedAt: result.session.started_at },
        resumed: result.resumed,
        supersededTask: result.superseded?.task ? ref(result.superseded.task) : null,
      };
    },
  },

  {
    /**
     * Resume whatever this engineer was doing here, without being told.
     * Called by the editor's session-start hook — the whole point is that
     * opening a project is enough to restart the clock.
     */
    method: "POST",
    pattern: /^\/sessions\/resume$/,
    handler: async ({ engineer, body }) => {
      const open = openSessionFor(engineer);
      if (open) {
        heartbeat(open.id);
        const task = getTask(open.task_id);
        return {
          resumed: false,
          alreadyRunning: true,
          task: task ? ref(task) : null,
          title: task?.title ?? null,
          elapsed: formatExact(sessionSeconds(open)),
        };
      }

      const guess = guessTask(engineer, {
        workdir: body.workdir as string | undefined,
        branch: body.branch as string | undefined,
      });
      if (!guess) {
        return {
          resumed: false,
          alreadyRunning: false,
          candidates: candidates(engineer).map((task) => ({
            ref: ref(task),
            title: task.title,
            status: task.status,
          })),
        };
      }

      const task = getTask(guess.taskId);
      if (!task || task.status === "done") return { resumed: false, alreadyRunning: false };

      const result = await startWork(task, engineer, (body.source as SessionSource) ?? "claude-code");
      if (body.workdir) rememberDir(engineer, body.workdir as string, task.id);

      return {
        resumed: true,
        task: ref(result.task),
        title: result.task.title,
        why: explainGuess(guess),
        supersededTask: result.superseded?.task ? ref(result.superseded.task) : null,
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/sessions\/heartbeat$/,
    handler: async ({ engineer }) => {
      const open = openSessionFor(engineer);
      if (!open) return { active: false };
      heartbeat(open.id);
      return {
        active: true,
        task: ref({ id: open.task_id }),
        elapsed: formatExact(sessionSeconds(open)),
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/sessions\/stop$/,
    handler: async ({ engineer }) => {
      const result = await stopWork(engineer);
      if (!result) return { stopped: false };
      return {
        stopped: true,
        task: ref(result.task),
        duration: formatExact(sessionSeconds(result.session)),
        taskStatus: result.task.status,
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/sessions\/adjust$/,
    handler: async ({ engineer, body }) => {
      const minutes = Number(body.minutes);
      if (!Number.isFinite(minutes)) throw new HttpError(400, "minutes must be a number.");
      const open = openSessionFor(engineer);
      if (!open) throw new HttpError(404, "You have no active session to adjust.");
      adjustSession(open.id, minutes, body.note as string | undefined);
      return { adjusted: minutes, elapsed: formatExact(sessionSeconds(openSessionFor(engineer)!)) };
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/done$/,
    handler: async ({ engineer, body }, [refString]) => {
      const task = taskFromPath(refString);
      const result = await finishWork(task, engineer, body.note as string | undefined);
      return {
        ...serialize(result.task),
        toldClient: formatRounded(result.effortSeconds),
      };
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/reopen$/,
    handler: async ({ engineer, body }, [refString]) => {
      const task = taskFromPath(refString);
      return serialize(await reopenWork(task, engineer, body.reason as string | undefined));
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/ask$/,
    handler: async ({ engineer, body }, [refString]) => {
      const task = taskFromPath(refString);
      const question = String(body.question ?? "").trim();
      if (!question) throw new HttpError(400, "question is required.");

      const name = await userName(engineer);
      await postToClient(task, notices.question(task, name, question));
      await postToInternal(task, `${ICON.question} <@${engineer}> asked the client:\n> ${question}`);
      addEvent(task.id, "question", engineer, question);
      return { sent: true };
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/note$/,
    handler: async ({ engineer, body }, [refString]) => {
      const task = taskFromPath(refString);
      const note = String(body.note ?? "").trim();
      if (!note) throw new HttpError(400, "note is required.");
      addEvent(task.id, "note", engineer, note);
      await postToInternal(task, `:lock: <@${engineer}> noted:\n> ${note}`);
      return { recorded: true };
    },
  },

  {
    method: "POST",
    pattern: /^\/tasks\/([^/]+)\/block$/,
    handler: async ({ engineer, body }, [refString]) => {
      const task = taskFromPath(refString);
      const reason = String(body.reason ?? "").trim();
      if (!reason) throw new HttpError(400, "reason is required.");

      // Blocking implies you have stopped working on it.
      const open = openSessionFor(engineer);
      if (open?.task_id === task.id) await stopWork(engineer);

      return serialize(
        await transition(task, "blocked", engineer, {
          detail: reason,
          clientMessage: notices.blocked(task, reason),
        }),
      );
    },
  },
];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    throw new HttpError(400, "Body must be valid JSON.");
  }
}

/** A plain page, because the person seeing this is in a browser, not a terminal. */
function sendPage(res: ServerResponse, status: number, heading: string, body: string): void {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 15vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; opacity: .85; }
  .ok { color: #30A46C; } .bad { color: #E5484D; }
</style>
<h1 class="${status === 200 ? "ok" : "bad"}">${heading}</h1><p>${body}</p>`;

  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

/**
 * Finishes the Google consent round trip: validate the state, exchange the
 * code, create the workspace's spreadsheet, and tell them in Slack.
 */
async function handleGoogleCallback(url: URL, res: ServerResponse): Promise<void> {
  const error = url.searchParams.get("error");
  if (error) {
    sendPage(res, 400, "Not connected", `Google reported: ${escapeHtml(error)}. You can close this tab and try again.`);
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    sendPage(res, 400, "Something's missing", "That link was incomplete. Start again from Slack.");
    return;
  }

  const resolved = consumeState(state);
  if (!resolved) {
    sendPage(res, 400, "Link expired", "Authorisation links are single-use and last 15 minutes. Run <code>/relay sheet connect</code> in Slack again.");
    return;
  }

  try {
    const account = await completeAuth(code, resolved);
    const id =
      account.spreadsheet_id ?? (await createSpreadsheet(resolved.team_id, desiredTitle()));

    sendPage(res, 200, "Connected", "Your spreadsheet is ready — the link is waiting in Slack. You can close this tab.");
    await notifyConnected(resolved, id, account.email);
  } catch (err) {
    log.error("google oauth callback failed", err);
    sendPage(res, 500, "Couldn't finish", `${escapeHtml((err as Error).message)} Try again from Slack.`);
  }
}

async function notifyConnected(
  resolved: { user_id: string; channel_id: string | null },
  spreadsheetId: string,
  email: string | null,
): Promise<void> {
  const { client: slack } = await import("./slack/app.js");
  try {
    await slack.chat.postMessage({
      channel: resolved.channel_id ?? resolved.user_id,
      text: `Google Sheets connected — ${spreadsheetUrl(spreadsheetId)}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `✅ *Google Sheets connected*${email ? ` as ${email}` : ""}.\nYour ledger now syncs to <${spreadsheetUrl(spreadsheetId)}|this spreadsheet>.`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "It's in your Google Drive and private to you — share it with your team from Google if they need it.",
            },
          ],
        },
      ],
      unfurl_links: false,
    });
  } catch (error) {
    log.warn("could not confirm the Google connection in Slack", error);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
  );
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function startApi(): void {
  if (!config.api.enabled) {
    log.info("api disabled (API_ENABLED=false)");
    return;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const route = routes.find(
        (candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname),
      );

      try {
        // The Google callback arrives from a user's browser with no bearer
        // token — it authenticates itself with a single-use `state` parameter
        // instead, which is checked inside the handler.
        if (url.pathname === "/oauth/google/callback") {
          await handleGoogleCallback(url, res);
          return;
        }

        if (!route) throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);

        const params = url.pathname.match(route.pattern)?.slice(1) ?? [];
        const engineer =
          url.pathname === "/health" ? "anonymous" : authenticate(req);
        const body = req.method === "POST" ? await readBody(req) : {};

        const result = await route.handler(
          { engineer, body, query: url.searchParams },
          params.map((param) => decodeURIComponent(param)),
        );
        send(res, 200, result);
      } catch (error) {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message });
          return;
        }
        log.error(`api ${req.method} ${url.pathname} failed`, error);
        send(res, 500, { error: "Internal error. Check the Relay logs." });
      }
    })();
  });

  server.listen(config.api.port, config.api.host, () => {
    const mode = hasAnyToken()
      ? "token auth"
      : isLoopback(config.api.host)
        ? "loopback, no auth"
        : "token auth (required: non-loopback bind)";
    log.info(`api listening on http://${config.api.host}:${config.api.port} (${mode})`);
  });

  server.on("error", (error) => log.error("api server error", error));
}
