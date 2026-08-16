/**
 * Renders every card state and client notice, and prints a Block Kit Builder
 * link for each so you can see the real thing in Slack's own renderer without
 * deploying anything.
 *
 *   npm run preview
 *   npm run preview -- --json    # raw payloads instead of links
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "relay-preview-"));
process.env.SLACK_BOT_TOKEN = "xoxb-preview";
process.env.SLACK_APP_TOKEN = "xapp-preview";
process.env.INTERNAL_CHANNEL = "C_INTERNAL";
process.env.CLIENT_CHANNELS = "C_CLIENT";
process.env.DB_PATH = join(scratch, "preview.db");
process.env.LOG_LEVEL = "error";

const store = await import("../src/store.js");
const sessions = await import("../src/sessions.js");
const { requestBlocks, requestColor } = await import("../src/slack/blocks.js");
const { notices } = await import("../src/slack/notices.js");
const { db } = await import("../src/db.js");

const jsonOnly = process.argv.includes("--json");

const ctx = { clientName: "Jane Doe", channelLabel: "#acme-corp" };

function builderLink(payload: unknown): string {
  return `https://app.slack.com/block-kit-builder/#${encodeURIComponent(JSON.stringify(payload))}`;
}

function show(label: string, payload: unknown): void {
  console.log(`\n\x1b[1m${label}\x1b[0m`);
  if (jsonOnly) console.log(JSON.stringify(payload, null, 2));
  else console.log(`  ${builderLink(payload)}`);
}

// One task, walked through its whole life.
const task = store.createTask({
  kind: "bug",
  title: "Checkout is broken",
  body: "the checkout page is broken, throws a 500 on submit.\n\nHappens every time for me on Safari, works fine in Chrome.",
  client_channel: "C_CLIENT",
  client_ts: "1700000000.000100",
  client_user: "U_CLIENT",
  client_permalink: "https://example.slack.com/archives/C_CLIENT/p1700000000000100",
  internal_channel: "C_INTERNAL",
  internal_ts: "1700000001.000200",
});

const card = (t: typeof task) => ({
  attachments: [{ color: requestColor(t), blocks: requestBlocks(t, ctx) }],
});

console.log("\n" + "═".repeat(70));
console.log("  INTERNAL CARD — one task through every state");
console.log("═".repeat(70));

show("1. Needs triage (amber)", card(task));

let current = store.updateTask(task.id, {
  status: "open",
  assignee: "U_SAM",
  claimed_at: new Date().toISOString(),
});
show("2. Claimed (blue)", card(current));

const { session } = sessions.startSession(task.id, "U_SAM", "claude-code");
// Backdate it so the card shows a realistic duration rather than "0m".
const startedAgo = new Date(Date.now() - 82 * 60 * 1000).toISOString();
db.prepare(`UPDATE work_sessions SET started_at = ?, last_heartbeat_at = ? WHERE id = ?`)
  .run(startedAgo, new Date().toISOString(), session.id);

current = store.updateTask(task.id, { status: "in_progress", started_at: startedAgo });
show("3. In progress, clock running (cyan)", card(current));

sessions.endSession(session.id, "explicit");
current = store.updateTask(task.id, { status: "blocked" });
show("4. Blocked (red)", card(current));

current = store.updateTask(task.id, { status: "done", completed_at: new Date().toISOString() });
show("5. Done (green)", card(current));

current = store.updateTask(task.id, { status: "dismissed", assignee: null });
show("6. Dismissed (grey)", card(current));

// A one-line request: the body should not be repeated under the title.
const terse = store.createTask({
  kind: "review",
  title: "can someone review https://github.com/acme/web/pull/42",
  body: "can someone review https://github.com/acme/web/pull/42",
  client_channel: "C_CLIENT",
  client_ts: "1700000002.000300",
  client_user: "U_CLIENT",
  client_permalink: null,
  internal_channel: "C_INTERNAL",
  internal_ts: "1700000003.000400",
});
show("7. One-line request (no duplicated body, no button)", card(terse));

console.log("\n" + "═".repeat(70));
console.log("  CLIENT THREAD — what the customer sees");
console.log("═".repeat(70));

const clientMessages = [
  ["Picked up", notices.claimed(task, "Sam")],
  ["Started", notices.started(task, "Sam")],
  ["Question", notices.question(task, "Sam", "which browser are you on?")],
  ["On hold", notices.blocked(task, "waiting on API credentials from your side")],
  ["Done", notices.done(task, "Sam", "fixed the timeout on CSV export", "about 4 hours")],
  ["Reassigned", notices.reassigned(task, "Priya")],
  ["Reopened", notices.reopened(task, "still failing on Safari")],
] as const;

for (const [label, notice] of clientMessages) {
  show(label, { blocks: notice.blocks });
}

if (!jsonOnly) {
  console.log(`
${"─".repeat(70)}
Open any link to see it rendered in Slack's own Block Kit Builder.
The colour stripe only shows on the card previews (it lives on the
attachment, which the builder renders too).

Client notices deliberately carry no ticket jargon beyond a small grey
reference line — pass --json to inspect the raw payloads.
`);
}

db.close();
rmSync(scratch, { recursive: true, force: true });
