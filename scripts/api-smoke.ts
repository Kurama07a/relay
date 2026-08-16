/**
 * Drives the real HTTP API and the real CLI against a throwaway database.
 *
 * Slack is unreachable throughout (the tokens are fake), which is the point:
 * every route here must still work and report honestly, because a Slack outage
 * should not stop an engineer from tracking their own work.
 *
 * Run with `npm run smoke:api`.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "relay-api-"));
const PORT = 37371;

// Bolt fires auth.test as soon as the App is constructed, and the fake token
// here guarantees it rejects. That is the condition under test, not a fault —
// index.ts installs the same handler so a live Relay survives it too.
process.on("unhandledRejection", () => {});

process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.INTERNAL_CHANNEL = "C_INTERNAL";
process.env.CLIENT_CHANNELS = "C_CLIENT";
process.env.DB_PATH = join(scratch, "api.db");
process.env.LOG_LEVEL = "error";
process.env.API_PORT = String(PORT);
process.env.API_HOST = "127.0.0.1";

const store = await import("../src/store.js");
const { startApi } = await import("../src/api.js");
const { db } = await import("../src/db.js");

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${label}` +
      (ok ? "" : `\n         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

const ENGINEER = "U_ENG";
const BASE = `http://127.0.0.1:${PORT}`;

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "x-relay-user": ENGINEER },
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

// A task as it would exist after being relayed from a client channel.
const task = store.createTask({
  kind: "bug",
  title: "Checkout is broken",
  body: "the checkout page is broken, throws a 500",
  client_channel: "C_CLIENT",
  client_ts: "1700000000.000100",
  client_user: "U_CLIENT",
  client_permalink: null,
  internal_channel: "C_INTERNAL",
  internal_ts: "1700000001.000200",
});

startApi();
await new Promise((resolve) => setTimeout(resolve, 300));

console.log("\nhealth + auth");
check("health needs no identity", (await api("GET", "/health", undefined, {})).status, 200);
check("a route without identity is rejected", (await api("GET", "/tasks", undefined, {})).status, 401);
check("a bogus bearer token is rejected", (await api("GET", "/tasks", undefined, { authorization: "Bearer nope" })).status, 401);
check("declared identity works on loopback", (await api("GET", "/me")).status, 200);

console.log("\nreading the ledger");
const open = await api("GET", "/tasks?scope=open");
check("open tasks are listed", open.json.tasks.length, 1);
check("task is serialized with its ref", open.json.tasks[0].ref, "REL-1");
check("effort starts empty", open.json.tasks[0].effort.seconds, 0);
check("unclaimed scope finds it", (await api("GET", "/tasks?scope=unclaimed")).json.tasks.length, 1);
check("mine is empty before claiming", (await api("GET", "/tasks?scope=mine")).json.tasks.length, 0);
check("a missing task 404s", (await api("GET", "/tasks/REL-999")).status, 404);
check("a junk ref 400s", (await api("GET", "/tasks/banana")).status, 400);

console.log("\nclaiming + working, with Slack down");
const claimed = await api("POST", "/tasks/REL-1/claim");
check("claim succeeds despite Slack being unreachable", claimed.status, 200);
check("claim assigns to the caller", claimed.json.assignee, ENGINEER);
check("claimed task moves out of triage", claimed.json.status, "open");
check("mine now finds it", (await api("GET", "/tasks?scope=mine")).json.tasks.length, 1);

const started = await api("POST", "/tasks/REL-1/start", { source: "claude-code" });
check("start succeeds", started.status, 200);
check("start moves to in_progress", started.json.status, "in_progress");
check("first start is not a resume", started.json.resumed, false);
check("effort is now running", started.json.effort.active, true);

check("heartbeat reports the running task", (await api("POST", "/sessions/heartbeat")).json.task, "REL-1");

const stopped = await api("POST", "/sessions/stop");
check("stop closes the session", stopped.json.stopped, true);
check("the task stays in progress after a stop", stopped.json.taskStatus, "in_progress");
check("stopping twice is harmless", (await api("POST", "/sessions/stop")).json.stopped, false);

const resumed = await api("POST", "/tasks/REL-1/start", { source: "claude-code" });
check("restarting is flagged as a resume", resumed.json.resumed, true);
check("a resumed task has two sessions", (await api("GET", "/tasks/REL-1")).json.sessions.length, 2);

console.log("\ntime corrections");
await api("POST", "/sessions/adjust", { minutes: 45 });
const adjusted = await api("GET", "/tasks/REL-1");
check("adjustment lands in the total", adjusted.json.effort.seconds >= 45 * 60, true);
check("adjustment is invalid without a number", (await api("POST", "/sessions/adjust", { minutes: "soon" })).status, 400);

console.log("\nreaching the client");
const asked = await api("POST", "/tasks/REL-1/ask", { question: "which browser?" });
check("an ask that cannot reach the client reports failure", asked.status, 500);
check("an empty question is rejected before sending", (await api("POST", "/tasks/REL-1/ask", { question: "  " })).status, 400);
check("an internal note succeeds without Slack", (await api("POST", "/tasks/REL-1/note", { note: "checked the logs" })).status, 200);

console.log("\nfinishing");
const done = await api("POST", "/tasks/REL-1/done", { note: "fixed the timeout" });
check("done succeeds", done.status, 200);
check("done sets the status", done.json.status, "done");
check("the client is given a rounded figure", done.json.toldClient, "about 45 minutes");
check("the exact figure is kept internally", done.json.effort.exact, "45m");
check("finishing closes the running session", done.json.effort.active, false);

const reopened = await api("POST", "/tasks/REL-1/reopen", { reason: "still broken" });
check("reopen works", reopened.json.status, "open");
check("reopen clears the completion time", reopened.json.completedAt, null);

console.log("\nthe CLI against the same server");
const env = { ...process.env, RELAY_URL: BASE, RELAY_USER: ENGINEER };
const listed = await run(process.execPath, ["bin/relay.mjs", "tasks", "mine"], { env });
check("cli lists the engineer's tasks", listed.stdout.includes("REL-1"), true);

const shown = await run(process.execPath, ["bin/relay.mjs", "show", "REL-1", "--json"], { env });
check("cli --json emits parseable output", JSON.parse(shown.stdout).ref, "REL-1");

const beat = await run(process.execPath, ["bin/relay.mjs", "heartbeat", "--force"], { env });
check("cli heartbeat runs clean", beat.stderr, "");

// A hook firing against a dead server must not break the editor session.
const offline = await run(
  process.execPath,
  ["bin/relay.mjs", "session-end"],
  { env: { ...env, RELAY_URL: "http://127.0.0.1:1" } },
).then(
  () => "exited-0",
  () => "exited-nonzero",
);
check("a hook against an unreachable Relay still exits 0", offline, "exited-0");

db.close();
rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll API checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
