#!/usr/bin/env node
/**
 * Relay CLI — the surface Claude Code, Codex, and humans all drive.
 *
 * Deliberately dependency-free and single-file: an engineer can copy it onto a
 * machine, or run it via npx, without a build step or an install. It only needs
 * a Node with global fetch (18+).
 *
 * Configuration, all optional except identity:
 *   RELAY_URL    where Relay is listening   (default http://127.0.0.1:3737)
 *   RELAY_TOKEN  bearer token, if the server requires one
 *   RELAY_USER   your Slack user ID, for token-less local use
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Identity, in precedence order: environment first so CI and one-off overrides
 * work, then the file written by `relay login`. The file is what makes this
 * pleasant for a team — each engineer runs one command instead of maintaining
 * shell exports on every machine.
 */
const CONFIG_PATH = join(homedir(), ".relay", "config.json");

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

const stored = loadConfig();
const BASE = (process.env.RELAY_URL ?? stored.url ?? "http://127.0.0.1:3737").replace(/\/$/, "");
const TOKEN = (process.env.RELAY_TOKEN ?? stored.token)?.trim();
const USER = (process.env.RELAY_USER ?? stored.user)?.trim();

/** Current directory and git branch — the two hints for "which task is this?". */
function context() {
  let branch = null;
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git repo, or no git. The directory alone is still a useful hint.
  }
  return { workdir: process.cwd(), branch };
}

const argv = process.argv.slice(2);
const jsonOutput = argv.includes("--json");
const args = argv.filter((arg) => arg !== "--json");
const [command, ...rest] = args;

/** Hook-invoked commands must never break the editor session they run inside. */
const QUIET_COMMANDS = new Set(["heartbeat", "session-end", "session-start"]);
const QUIET = QUIET_COMMANDS.has(command) && !argv.includes("--verbose");

function flag(name, fallback = null) {
  const index = rest.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return rest[index + 1] ?? fallback;
}

function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      i++; // skip the flag's value
      continue;
    }
    out.push(rest[i]);
  }
  return out;
}

async function call(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  else if (USER) headers["x-relay-user"] = USER;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(
      `Cannot reach Relay at ${BASE} — is it running? (${error.message})\n` +
        `Set RELAY_URL if it lives somewhere else.`,
    );
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

const STATUS_ICON = {
  triage: "🆕",
  open: "📋",
  in_progress: "🔧",
  blocked: "⛔",
  done: "✅",
  dismissed: "🗑️",
};

function renderTask(task) {
  const active = task.effort.active ? " 🟢" : "";
  const spent = task.effort.seconds > 0 ? `  ·  ${task.effort.exact}${active}` : "";
  return `${STATUS_ICON[task.status] ?? "•"} ${task.ref.padEnd(7)} ${task.title}\n   ${task.status}${spent}`;
}

function out(human, data) {
  if (jsonOutput) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}

const commands = {
  async tasks() {
    const scope = flag("scope", positional()[0] ?? "open");
    const data = await call("GET", `/tasks?scope=${encodeURIComponent(scope)}`);
    if (data.tasks.length === 0) {
      out(`No ${scope} tasks.`, data);
      return;
    }
    out(
      `${scope} tasks\n${"─".repeat(40)}\n${data.tasks.map(renderTask).join("\n")}`,
      data,
    );
  },

  async show() {
    const task = await call("GET", `/tasks/${encodeURIComponent(positional()[0])}`);
    const lines = [
      `${STATUS_ICON[task.status] ?? "•"} ${task.ref} · ${task.kind} · ${task.status}`,
      "",
      task.body,
      "",
      `Assignee : ${task.assignee ?? "unassigned"}`,
      `Effort   : ${task.effort.exact} across ${task.effort.sessions} session(s)${task.effort.active ? " · 🟢 running" : ""}`,
    ];
    if (task.permalink) lines.push(`Slack    : ${task.permalink}`);

    // The conversation is usually the part that actually explains the task.
    if (task.conversation?.length) {
      lines.push("", "Conversation:");
      for (const entry of task.conversation) {
        const side = entry.channel === "client" ? "client" : "team";
        const when = entry.at.replace("T", " ").slice(5, 16);
        lines.push(`  [${when}] ${entry.from} (${side}):`);
        for (const line of entry.text.split("\n")) lines.push(`      ${line}`);
      }
    }

    if (task.sessions?.length) {
      lines.push("", "Sessions:");
      for (const session of task.sessions) {
        lines.push(
          `  ${session.duration.padEnd(8)} ${session.engineer} via ${session.source}${session.endedAt ? "" : "  (running)"}`,
        );
      }
    }
    out(lines.join("\n"), task);
  },

  async claim() {
    const task = await call("POST", `/tasks/${encodeURIComponent(positional()[0])}/claim`);
    out(`Claimed ${task.ref} — ${task.title}\nThe client has been told you picked it up.`, task);
  },

  /**
   * `relay start` with no task figures out which one you mean — from the branch
   * name, from what you were last doing in this directory, or from having only
   * one thing in flight. It only asks when genuinely ambiguous.
   */
  async start() {
    const target = positional()[0];
    const source = flag("source", "cli");
    const ctx = context();

    if (!target) {
      const data = await call("POST", "/sessions/resume", { ...ctx, source });
      if (data.alreadyRunning) {
        out(`▶ Already running on ${data.task} — ${data.title} (${data.elapsed})`, data);
        return;
      }
      if (!data.resumed) {
        const list = (data.candidates ?? [])
          .map((t) => `  ${t.ref}  ${t.title}  (${t.status})`)
          .join("\n");
        out(
          list
            ? `Not sure which task you mean. Pick one:\n${list}\n\n  relay start REL-7`
            : "Nothing assigned to you to resume. `relay tasks unclaimed` to find something.",
          data,
        );
        return;
      }
      out(`▶ Clock running on ${data.task} — ${data.title}\nPicked it ${data.why}.`, data);
      return;
    }

    const data = await call("POST", `/tasks/${encodeURIComponent(target)}/start`, {
      source,
      ...ctx,
    });
    const notes = [];
    if (data.supersededTask) notes.push(`Paused your session on ${data.supersededTask}.`);
    notes.push(
      data.resumed
        ? "Resumed — the client was not notified again."
        : "The client has been told work has started.",
    );
    out(`▶ Clock running on ${data.ref} — ${data.title}\n${notes.join("\n")}`, data);
  },

  /** Writes identity to ~/.relay/config.json so each engineer sets up once. */
  async login() {
    const url = flag("url", BASE);
    const token = flag("token", null);
    const user = flag("user", null);

    if (!token && !user) {
      console.error(`
Usage:
  relay login --url http://relay.internal:3737 --token relay_xxxx
  relay login --user U0123ABCD          (loopback, no token needed)

Your Slack member ID is in your profile under "More".
`);
      process.exit(1);
    }

    mkdirSync(join(homedir(), ".relay"), { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ url, ...(token ? { token } : {}), ...(user ? { user } : {}) }, null, 2),
    );

    // Prove the credentials work now, rather than at the worst moment later.
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    else headers["x-relay-user"] = user;

    const response = await fetch(`${url.replace(/\/$/, "")}/me`, { headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      console.error(`✗ Saved to ${CONFIG_PATH}, but Relay rejected it: ${body.error ?? response.status}`);
      process.exit(1);
    }
    const me = await response.json();
    console.log(`Signed in as ${me.name} (${me.engineer}).\nSaved to ${CONFIG_PATH}`);
  },

  async stop() {
    const data = await call("POST", "/sessions/stop");
    if (!data.stopped) {
      out("No session was running.", data);
      return;
    }
    out(
      `⏸ Paused ${data.task} after ${data.duration}.\nStill ${data.taskStatus} — run \`relay done ${data.task}\` when it's actually finished.`,
      data,
    );
  },

  /**
   * Throttled, because this is wired to fire on every tool call. Once a beat
   * has landed, subsequent invocations inside the window cost a process start
   * and nothing else — no socket, no server work.
   */
  async heartbeat() {
    const windowSeconds = Number(flag("throttle", "120"));
    const force = rest.includes("--force");

    if (!force && windowSeconds > 0) {
      const stampPath = join(tmpdir(), `relay-heartbeat-${USER ?? "default"}`);
      try {
        const last = Number(readFileSync(stampPath, "utf8"));
        if (Date.now() - last < windowSeconds * 1000) return;
      } catch {
        // No stamp yet — fall through and beat.
      }
      try {
        writeFileSync(stampPath, String(Date.now()));
      } catch {
        // A read-only temp dir just means we beat every time; not worth failing.
      }
    }

    const data = await call("POST", "/sessions/heartbeat");
    if (!QUIET) out(data.active ? `🟢 ${data.task} · ${data.elapsed}` : "No active session.", data);
  },

  async done() {
    const [target, ...noteParts] = positional();
    const note = noteParts.join(" ") || undefined;
    const data = await call("POST", `/tasks/${encodeURIComponent(target)}/done`, { note });
    out(
      `✅ ${data.ref} done.\nLogged ${data.effort.exact}; the client was told "${data.toldClient}".`,
      data,
    );
  },

  async ask() {
    const [target, ...question] = positional();
    const data = await call("POST", `/tasks/${encodeURIComponent(target)}/ask`, {
      question: question.join(" "),
    });
    out(`Sent to the client. Their reply will appear in the Slack thread.`, data);
  },

  async note() {
    const [target, ...note] = positional();
    const data = await call("POST", `/tasks/${encodeURIComponent(target)}/note`, {
      note: note.join(" "),
    });
    out("Recorded internally. The client sees nothing.", data);
  },

  async block() {
    const [target, ...reason] = positional();
    const data = await call("POST", `/tasks/${encodeURIComponent(target)}/block`, {
      reason: reason.join(" "),
    });
    out(`⛔ ${data.ref} marked blocked; the client was told why. Your clock is stopped.`, data);
  },

  async reopen() {
    const [target, ...reason] = positional();
    const data = await call("POST", `/tasks/${encodeURIComponent(target)}/reopen`, {
      reason: reason.join(" ") || undefined,
    });
    out(`↩ ${data.ref} reopened.`, data);
  },

  async time() {
    const [minutes, ...note] = positional();
    const data = await call("POST", "/sessions/adjust", {
      minutes: Number(minutes),
      note: note.join(" ") || undefined,
    });
    out(`Adjusted by ${minutes}m — session now reads ${data.elapsed}.`, data);
  },

  async me() {
    const data = await call("GET", "/me");
    out(
      data.activeSession
        ? `${data.name} — 🟢 ${data.activeSession.task} for ${data.activeSession.elapsed}`
        : `${data.name} — no session running.`,
      data,
    );
  },

  /** Editor lifecycle hooks. Quiet, and never fatal. */
  async "session-end"() {
    const data = await call("POST", "/sessions/stop");
    if (data.stopped) console.log(`Relay: paused ${data.task} after ${data.duration}.`);
  },

  /**
   * Fired when an editor session opens. Resumes whatever was being done in this
   * directory, so the clock starts without anybody typing a command.
   */
  async "session-start"() {
    const data = await call("POST", "/sessions/resume", {
      ...context(),
      source: "claude-code",
    });
    if (data.alreadyRunning) {
      console.log(`Relay: still on ${data.task} (${data.elapsed}).`);
    } else if (data.resumed) {
      console.log(`Relay: resumed ${data.task} — ${data.title} (${data.why}).`);
    }
    // Silent when there's nothing to resume — an editor opening in an unrelated
    // repo should say nothing at all.
  },

  async help() {
    console.log(`
relay — claim and track client work without leaving your editor

  relay login --token relay_xxx                sign in once, on this machine
  relay tasks [open|mine|unclaimed|all|done]   list the ledger
  relay show REL-7                             detail, conversation, sessions
  relay claim REL-7                            assign it to yourself
  relay start [REL-7]                          start the clock (infers the task)
  relay stop                                   pause the clock (task stays open)
  relay done REL-7 [note]                      finish it; client hears the rounded time
  relay ask REL-7 <question>                   ask the client, in their thread
  relay note REL-7 <text>                      internal note
  relay block REL-7 <reason>                   mark blocked and stop the clock
  relay reopen REL-7 [reason]                  undo a premature done
  relay time -30 [why]                         correct the running session
  relay me                                     what you have running

  --json    machine-readable output on any command

Environment: RELAY_URL, RELAY_TOKEN, RELAY_USER
`);
  },
};

const handler = commands[command ?? "help"];

if (!handler) {
  console.error(`Unknown command "${command}". Try \`relay help\`.`);
  process.exit(1);
}

try {
  await handler();
} catch (error) {
  // A failing hook must not interrupt the engineer's actual work.
  if (QUIET_COMMANDS.has(command)) {
    if (process.env.RELAY_DEBUG) console.error(`Relay: ${error.message}`);
    process.exit(0);
  }
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
