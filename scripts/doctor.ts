/**
 * Checks a running configuration against what Slack actually granted.
 *
 *   npm run doctor
 *
 * Written for the failure that gives you nothing to go on: the bot connects,
 * relays messages, and then silently ignores your reactions. Almost always that
 * is a missing scope, a channel that isn't the one in .env, or a conversation
 * type this app never subscribed to — none of which surface in the logs.
 */
import "dotenv/config";
import { WebClient } from "@slack/web-api";

const REQUIRED_SCOPES = [
  "channels:history",
  "groups:history",
  "channels:read",
  "groups:read",
  "chat:write",
  "reactions:read",
  "reactions:write",
  "users:read",
  "commands",
];

const botToken = process.env.SLACK_BOT_TOKEN?.trim();
const appToken = process.env.SLACK_APP_TOKEN?.trim();
// Pairings live in the database now; .env is only a first-run fallback.
const { listRoutes } = await import("../src/routes.js");
const configuredRoutes = listRoutes();

const envInternal = process.env.INTERNAL_CHANNEL?.trim();
const envClients = (process.env.CLIENT_CHANNELS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const internalChannel = configuredRoutes[0]?.team_channel ?? envInternal;
const clientChannels =
  configuredRoutes.length > 0
    ? [...new Set(configuredRoutes.map((route) => route.client_channel))]
    : envClients;
const teamChannels =
  configuredRoutes.length > 0
    ? [...new Set(configuredRoutes.map((route) => route.team_channel))]
    : envInternal
      ? [envInternal]
      : [];
const claimEmoji = (process.env.CLAIM_EMOJI ?? "raised_hand").replace(/:/g, "").trim();
const dismissEmoji = (process.env.DISMISS_EMOJI ?? "x").replace(/:/g, "").trim();

let problems = 0;
let warnings = 0;

const ok = (message: string) => console.log(`  \x1b[32mok\x1b[0m    ${message}`);
const warn = (message: string) => {
  warnings++;
  console.log(`  \x1b[33mwarn\x1b[0m  ${message}`);
};
const fail = (message: string) => {
  problems++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${message}`);
};

console.log("\nRelay doctor\n" + "─".repeat(60));

console.log("\ntokens");
if (!botToken) fail("SLACK_BOT_TOKEN is not set.");
else if (!botToken.startsWith("xoxb-")) warn(`SLACK_BOT_TOKEN doesn't start with xoxb- — is it the right token?`);
else ok("SLACK_BOT_TOKEN present");

if (!appToken) fail("SLACK_APP_TOKEN is not set (socket mode needs it).");
else if (!appToken.startsWith("xapp-")) warn("SLACK_APP_TOKEN doesn't start with xapp-.");
else ok("SLACK_APP_TOKEN present");

if (!botToken) {
  console.log("\nCannot continue without a bot token.\n");
  process.exit(1);
}

const client = new WebClient(botToken);

console.log("\nidentity + granted scopes");
let botUserId = "";
try {
  // Raw fetch, because the granted scopes only come back as a response header
  // and the SDK doesn't surface it.
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}` },
  });
  const auth = (await response.json()) as { ok: boolean; user_id?: string; team?: string; error?: string };

  if (!auth.ok) {
    fail(`auth.test failed: ${auth.error}. The token is wrong, revoked, or the app was uninstalled.`);
  } else {
    botUserId = auth.user_id ?? "";
    ok(`authenticated as ${auth.user_id} in workspace "${auth.team}"`);

    const granted = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);

    const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
    if (missing.length === 0) {
      ok(`all ${REQUIRED_SCOPES.length} required scopes granted`);
    } else {
      fail(
        `missing scope(s): ${missing.join(", ")}\n` +
          `        Add them in OAuth & Permissions, then REINSTALL the app —\n` +
          `        adding a scope does nothing until the app is reinstalled.`,
      );
    }
    if (!granted.includes("reactions:read")) {
      fail("without reactions:read, claim/dismiss reactions are never delivered — this is the usual cause of 'reacting does nothing'.");
    }
  }
} catch (error) {
  fail(`could not reach Slack: ${(error as Error).message}`);
}

console.log("\nchannels");

interface ChannelReport {
  id: string;
  role: "internal" | "client";
}

const targets: ChannelReport[] = [
  ...teamChannels.map((id) => ({ id, role: "internal" as const })),
  ...clientChannels.map((id) => ({ id, role: "client" as const })),
];

if (configuredRoutes.length === 0) {
  fail("No channel pairings configured. Run `/relay setup` in Slack to add one.");
} else {
  console.log(`  \x1b[2mnote\x1b[0m  ${configuredRoutes.length} pairing(s) configured in the database:`);
  for (const route of configuredRoutes) {
    console.log(
      `        ${route.client_channel} → ${route.team_channel}` +
        `${route.label ? `  (${route.label})` : ""}` +
        `${route.ingest_mode === "mention" ? "  [mention-only]" : ""}`,
    );
  }
}

for (const target of targets) {
  const label = `${target.role} channel ${target.id}`;

  if (!/^[CGD][A-Z0-9]+$/i.test(target.id)) {
    fail(
      `${label} doesn't look like a channel ID.\n` +
        `        It must be the ID (starts with C, G, or D), not a #name.\n` +
        `        Run \`npm run channels\` to list IDs.`,
    );
    continue;
  }

  try {
    const info = await client.conversations.info({ channel: target.id });
    const channel = info.channel as
      | { name?: string; is_member?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean }
      | undefined;

    const name = channel?.name ? `#${channel.name}` : "(direct message)";
    const kind = channel?.is_im
      ? "DM"
      : channel?.is_mpim
        ? "group DM"
        : channel?.is_private
          ? "private channel"
          : "public channel";

    if (channel?.is_member === false) {
      fail(`${label} ${name}: bot is NOT a member. Run /invite @Relay there.`);
      continue;
    }

    ok(`${target.role.padEnd(8)} ${name} (${kind}) — bot is a member`);

    // This app only subscribes to message.channels and message.groups, so a DM
    // delivers no message or reaction events at all, however correct it looks.
    if (channel?.is_im || channel?.is_mpim) {
      fail(
        `${name} is a ${kind}. Relay subscribes to channel events only, so\n` +
          `        reactions and messages there are never delivered. Use a real\n` +
          `        channel (public or private) instead — this alone will make\n` +
          `        reactions appear to do nothing.`,
      );
    }
  } catch (error) {
    const reason = (error as { data?: { error?: string } })?.data?.error ?? String(error);
    if (reason === "channel_not_found") {
      fail(`${label}: channel_not_found. Wrong ID, or the bot was never invited.`);
    } else {
      fail(`${label}: ${reason}`);
    }
  }
}

console.log("\nreaction config");
const { emojiSet, overlaps } = await import("../src/emoji.js");
const claimSet = emojiSet(claimEmoji);
const dismissSet = emojiSet(dismissEmoji);

ok(`claim   accepts ${claimSet.accepts.map((name) => `:${name}:`).join(" ")}  (bot adds :${claimSet.primary}:)`);
ok(`dismiss accepts ${dismissSet.accepts.map((name) => `:${name}:`).join(" ")}  (bot adds :${dismissSet.primary}:)`);
if (overlaps(claimSet, dismissSet)) fail("CLAIM_EMOJI and DISMISS_EMOJI overlap — they must be distinct.");
console.log(
  `  \x1b[2mnote\x1b[0m  Slack reports the same glyph under different names depending on\n` +
    `        which client reacted, so known aliases are accepted automatically.\n` +
    `        A reaction outside these sets is ignored and logged — watch for\n` +
    `        "ignoring :name:" in the output of \`npm run dev\`.`,
);

console.log("\ngoogle sheets");
{
  const { activeSheetId, checkSheetAccess, serviceAccountEmail } = await import("../src/sheets.js");
  const settingsStore = await import("../src/settings.js");

  const sheetId = activeSheetId();
  const email = serviceAccountEmail();

  if (!sheetId && !email) {
    console.log("  \x1b[2mskip\x1b[0m  Not set up. Optional — see \"Live Google Sheet\" in README.md.");
  } else {
    if (email) ok(`service account: ${email}`);
    else fail("No credentials. Set GOOGLE_SERVICE_ACCOUNT_FILE to the JSON key path.");

    if (sheetId) ok(`spreadsheet: ${settingsStore.sheetUrl(sheetId)}`);
    else warn("No spreadsheet connected yet. Run `/relay sheet <url>` in Slack.");

    if (sheetId && email) {
      const access = await checkSheetAccess();
      if (access.ok) {
        ok(`can open "${access.title}" (tabs: ${access.tabs.join(", ") || "none yet"})`);
      } else {
        fail(
          `cannot open the spreadsheet: ${access.reason}` +
            (access.shareHint
              ? `\n        Share the sheet with ${email} as an Editor:\n` +
                `        open it → Share → paste that address → Editor → Send.`
              : ""),
        );
      }
    }
  }
}

console.log("\n" + "─".repeat(60));
if (problems === 0 && warnings === 0) {
  console.log("Everything checks out.\n");
} else {
  console.log(`${problems} problem(s), ${warnings} warning(s).\n`);
}
process.exit(problems > 0 ? 1 : 0);
