import type { KnownBlock } from "@slack/types";
import { app, teamId } from "./app.js";
import { announce, configBlocks, postingProblem, sheetError } from "./admin.js";
import {
  adminChannels,
  adminUsers,
  canAdmin,
  forgetRoles,
  setAdminChannels,
  setAdminUsers,
} from "../permissions.js";
import { channelName } from "./names.js";
import {
  beginAuth,
  disconnect as disconnectGoogle,
  getAccount as getGoogleAccount,
  googleSetupProblem,
  spreadsheetUrl,
} from "../google.js";
import { addRoute, removeRoute } from "../routes.js";
import * as settings from "../settings.js";
import { backfillNames } from "../resolve-names.js";
import {
  describeLastSync,
  desiredTitle,
  pushToSheet,
  renameSpreadsheet,
  sheetsConfigured,
} from "../sheets.js";
import { config } from "../config.js";
import { ICON } from "./design.js";
import { KIND, statusLabel } from "./design.js";
import { mention, userName } from "./names.js";
import { log } from "../log.js";
import {
  countByStatus,
  getTask,
  listTasks,
  parseRef,
  ref,
  type Task,
  type TaskStatus,
} from "../store.js";

const ACTIVE: TaskStatus[] = ["triage", "open", "in_progress", "blocked"];

export function registerCommands(): void {
  // A link button still delivers an interaction payload; Slack shows the user a
  // warning triangle if nothing acknowledges it, even though there's no work.
  app.action("open_client_message", async ({ ack }) => {
    await ack();
  });

  app.command("/relay", async ({ command, ack, respond }) => {
    await ack();
    try {
      const result = await run(command.text.trim(), command.user_id, command.channel_id);
      await respond(
        typeof result === "string"
          ? { response_type: "ephemeral", text: result }
          : { response_type: "ephemeral", text: "Relay setup", ...result },
      );
    } catch (error) {
      log.error("/relay failed", error);
      await respond({ response_type: "ephemeral", text: "Something went wrong. Check the Relay logs." });
    }
  });
}

async function run(
  input: string,
  userId: string,
  channelId: string,
): Promise<string | { blocks: KnownBlock[] }> {
  const [subcommand = "", ...restParts] = input.split(/\s+/);
  const rest = restParts.join(" ");
  const verb = subcommand.toLowerCase();

  // Task commands are open to everyone; anything that changes configuration is
  // gated. Checked here, once, rather than inside each branch — a new admin
  // subcommand added to this list is protected by default.
  const ADMIN_VERBS = new Set([
    "pair", "unpair", "sheet", "backfill", "control", "admin", "admins",
  ]);
  if (ADMIN_VERBS.has(verb)) {
    const decision = await canAdmin(userId, channelId);
    if (!decision.ok) return `${ICON.warning} ${decision.reason}`;
  }

  switch (verb) {
    case "":
    case "open":
      return render("Open tasks", listTasks({ status: ACTIVE, limit: 20 }));

    case "mine":
      return render(
        "Your tasks",
        listTasks({ status: ACTIVE, assignee: userId, limit: 20 }),
        "Nothing assigned to you right now.",
      );

    case "all":
      return render("All tasks", listTasks({ limit: 20 }));

    case "done":
      return render("Recently completed", listTasks({ status: ["done"], limit: 20 }));

    case "stats": {
      const counts = countByStatus();
      const rows = Object.entries(counts)
        .map(([status, count]) => `• ${statusLabel(status as TaskStatus)} — *${count}*`)
        .join("\n");
      return rows ? `*Ledger*\n${rows}` : "The ledger is empty.";
    }

    // Viewing the setup is open — knowing which channel your requests land in
    // is useful to everyone. The card itself hides the sheet link and the
    // buttons from anyone who can't use them.
    case "setup":
    case "config":
    case "routes":
      return { blocks: await configBlocks((await canAdmin(userId, channelId)).ok) };

    case "admins":
    case "admin": {
      const [action = "", ...targets] = rest.split(/\s+/);
      const users = [...rest.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gi)].map((m) => m[1]!);
      const channels = [...rest.matchAll(/<#([A-Z0-9]+)(?:\|[^>]*)?>/gi)].map((m) => m[1]!);

      switch (action.toLowerCase()) {
        case "add": {
          if (users.length === 0) return "Usage: `/relay admin add @someone`";
          // Whoever is granting must stay an admin, or the next change is impossible.
          setAdminUsers([...adminUsers(), ...users, userId], userId);
          forgetRoles();
          await announce(
            `${ICON.note} <@${userId}> made ${users.map((id) => `<@${id}>`).join(", ")} a Relay admin.`,
            userId,
          );
          return `${ICON.done} Added ${users.map((id) => `<@${id}>`).join(", ")}.`;
        }
        case "remove": {
          if (users.length === 0) return "Usage: `/relay admin remove @someone`";
          const remaining = adminUsers().filter((id) => !users.includes(id));
          if (remaining.length === 0) {
            return `${ICON.warning} That would leave nobody. Add another admin first, or use \`/relay admin reset\` to fall back to workspace admins.`;
          }
          setAdminUsers(remaining, userId);
          forgetRoles();
          return `${ICON.done} Removed ${users.map((id) => `<@${id}>`).join(", ")}.`;
        }
        case "reset": {
          setAdminUsers([], userId);
          setAdminChannels([], userId);
          forgetRoles();
          return `${ICON.done} Reset — any Slack workspace admin can configure Relay, from anywhere.`;
        }
        case "here": {
          setAdminChannels([...adminChannels(), channelId], userId);
          return `${ICON.done} Setup commands now work in ${await channelName(channelId)}.`;
        }
        case "only": {
          const target = channels.length > 0 ? channels : [channelId];
          setAdminChannels(target, userId);
          return `${ICON.done} Setup commands are now restricted to ${target.map((id) => `<#${id}>`).join(", ")}.`;
        }
        case "anywhere": {
          setAdminChannels([], userId);
          return `${ICON.done} Setup commands work in any channel again.`;
        }
        default: {
          const admins = adminUsers();
          const allowed = adminChannels();
          return [
            "*Who can configure Relay*",
            admins.length > 0
              ? admins.map((id) => `<@${id}>`).join(", ")
              : "_Any Slack workspace admin (no explicit list set)._",
            "Workspace owners always qualify, so nobody can be locked out.",
            "",
            "*Where*",
            allowed.length > 0 ? allowed.map((id) => `<#${id}>`).join(", ") : "_Any channel._",
            "",
            "`/relay admin add @user` · `remove @user` · `only #channel` · `anywhere` · `reset`",
          ].join("\n");
        }
      }
    }

    case "pair": {
      const channels = [...rest.matchAll(/<#([A-Z0-9]+)(?:\|[^>]*)?>/gi)].map((m) => m[1]!);
      if (channels.length !== 2) {
        return "Usage: `/relay pair #client-channel #team-channel` — or just `/relay setup` for a form.";
      }
      const result = addRoute({
        clientChannel: channels[0]!,
        teamChannel: channels[1]!,
        createdBy: userId,
      });
      if (!result.ok) return `${ICON.warning} ${result.error}`;
      await announce(
        `${ICON.done} <@${userId}> paired *${await channelName(channels[0]!)}* → *${await channelName(channels[1]!)}*`,
        userId,
      );
      return `${ICON.done} Paired ${await channelName(channels[0]!)} → ${await channelName(channels[1]!)}.\nMake sure Relay is in both channels.`;
    }

    case "unpair": {
      const channel = /<#([A-Z0-9]+)(?:\|[^>]*)?>/i.exec(rest)?.[1];
      if (!channel) return "Usage: `/relay unpair #client-channel`";
      const removed = removeRoute(channel);
      if (!removed) return "That channel isn't paired with anything.";
      await announce(`${ICON.note} <@${userId}> unpaired *${await channelName(channel)}*`, userId);
      return `Unpaired ${await channelName(channel)}. Existing tasks keep working.`;
    }

    case "sheet": {
      if (rest === "connect" || rest === "link") {
        const problem = googleSetupProblem();
        if (problem) {
          return `${ICON.warning} Relay's Google integration isn't set up by the operator yet.\n_${problem}_`;
        }
        const url = beginAuth(teamId, userId, channelId);
        return {
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Connect Google Sheets*\nRelay will create a spreadsheet in your Google Drive and keep it up to date. It can only see the file it creates — nothing else in your Drive.",
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Authorise with Google" },
                  style: "primary",
                  url,
                  action_id: "relay_google_auth",
                },
              ],
            },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: "This link is single-use and expires in 15 minutes." }],
            },
          ],
        };
      }

      if (rest === "disconnect" || rest === "off") {
        disconnectGoogle(teamId);
        settings.clear(settings.KEYS.sheetId);
        return "Disconnected. Relay will stop syncing, and your spreadsheet stays in your Drive.";
      }

      if (!rest || rest === "show" || rest === "status") {
        const account = getGoogleAccount(teamId);
        const id = account?.spreadsheet_id ?? settings.get(settings.KEYS.sheetId);
        if (!id) return "No sheet connected. `/relay sheet <url>` or use `/relay setup`.";

        return [
          `*${desiredTitle()}*`,
          `<${settings.sheetUrl(id)}|Open spreadsheet>${account?.email ? ` · connected as ${account.email}` : ""}`,
          "",
          `Syncs automatically every ${config.sheets.syncSeconds}s when something changes.`,
          `Last updated *${describeLastSync()}*.`,
          "",
          "`/relay sheet sync` to force one · `restyle` to reapply the formatting",
        ].join("\n");
      }
      if (rest === "off" || rest === "disconnect") {
        settings.clear(settings.KEYS.sheetId);
        return "Sheet disconnected.";
      }
      if (rest === "sync" || rest === "restyle") {
        if (!sheetsConfigured()) return "No sheet connected, or credentials are missing.";
        try {
          if (process.env.SLACK_BOT_TOKEN) await backfillNames(process.env.SLACK_BOT_TOKEN);
          const { rows, tabs } = await pushToSheet(rest === "restyle");
          return rest === "restyle"
            ? `${ICON.done} Restyled and synced ${rows} rows across ${tabs} tabs.`
            : `${ICON.done} Synced ${rows} rows across ${tabs} tabs.`;
        } catch (error) {
          return `${ICON.warning} ${sheetError(error)}`;
        }
      }
      if (rest.startsWith("title")) {
        const title = rest.slice("title".length).trim();
        if (!title) {
          return `Current title: *${desiredTitle()}*\nChange it with \`/relay sheet title <name>\`, or \`title reset\` for the default.`;
        }
        if (title === "reset") {
          settings.clear(settings.KEYS.sheetTitle);
        } else {
          settings.set(settings.KEYS.sheetTitle, title, userId);
        }
        if (!sheetsConfigured()) return `${ICON.done} Saved. It'll apply when a sheet is connected.`;
        try {
          const renamed = await renameSpreadsheet();
          return renamed.changed
            ? `${ICON.done} Renamed from *${renamed.from}* to *${renamed.to}*.`
            : `${ICON.done} Already called *${renamed.to}*.`;
        } catch (error) {
          return `${ICON.warning} ${sheetError(error)}`;
        }
      }

      const id = settings.parseSheetId(rest);
      if (!id) return "That doesn't look like a Google Sheets link.";
      settings.set(settings.KEYS.sheetId, id, userId);

      // Rename on connect so the file is identifiable in Drive, and say what it
      // used to be called — silently renaming somebody's file is unkind.
      let renameNote = "";
      try {
        const renamed = await renameSpreadsheet();
        if (renamed.changed) {
          renameNote = `\nRenamed it from *${renamed.from}* to *${renamed.to}* — \`/relay sheet title <name>\` to change that.`;
        }
      } catch (error) {
        log.warn("could not rename the spreadsheet on connect", error);
      }

      await announce(
        `${ICON.done} <@${userId}> connected the <${settings.sheetUrl(id)}|Google Sheet>.`,
        userId,
      );
      return `${ICON.done} Connected. Syncing every ${config.sheets.syncSeconds}s.${renameNote}`;
    }

    case "backfill": {
      if (!process.env.SLACK_BOT_TOKEN) return "No bot token available.";
      const resolved = await backfillNames(process.env.SLACK_BOT_TOKEN);
      return `Resolved ${resolved} name(s). ${sheetsConfigured() ? "Run `/relay sheet sync` to push them." : ""}`;
    }

    case "control": {
      if (rest === "off" || rest === "none") {
        settings.clear(settings.KEYS.controlChannel);
        return "Config changes will be sent to you directly instead of a channel.";
      }
      const channel = /<#([A-Z0-9]+)(?:\|[^>]*)?>/i.exec(rest)?.[1] ?? channelId;

      // Announcements post into this channel, so a bot that isn't a member
      // would fail silently every time — check now, while someone is watching.
      const problem = await postingProblem(channel);
      if (problem) return `${ICON.warning} ${problem}`;

      settings.set(settings.KEYS.controlChannel, channel, userId);
      await announce(
        `${ICON.done} <@${userId}> made this the Relay control channel. Configuration changes will be announced here.`,
        userId,
      );
      return `${ICON.done} Config changes will be announced in ${await channelName(channel)}.`;
    }

    case "help":
      return [
        "*Tasks*",
        "`/relay` — open tasks · `mine` · `all` · `done` · `stats` · `REL-12`",
        "",
        "*Setup*",
        "`/relay setup` — channel pairings and the spreadsheet, with buttons",
        "`/relay pair #client #team` — pair two channels",
        "`/relay unpair #client` — stop relaying a channel",
        "`/relay sheet <url>` — connect a Google Sheet · `sync` · `off`",
        "`/relay backfill` — resolve any user or channel IDs into names",
        "`/relay control #channel` — where config changes get announced",
      ].join("\n");

    default: {
      const id = parseRef(subcommand + (rest ? ` ${rest}` : ""));
      if (id === null) return `Don't know \`${subcommand}\`. Try \`/relay help\`.`;
      const task = getTask(id);
      if (!task) return `No task with id ${id}.`;
      return detail(task);
    }
  }
}

async function render(heading: string, tasks: Task[], empty = "Nothing here."): Promise<string> {
  if (tasks.length === 0) return `*${heading}*\n_${empty}_`;

  const lines = await Promise.all(
    tasks.map(async (task) => {
      const kind = KIND[task.kind];
      const who = task.assignee ? await userName(task.assignee) : "unassigned";
      return `${kind.icon} *${ref(task)}* ${task.title}\n    ${statusLabel(task.status)} · ${who}`;
    }),
  );
  return `*${heading}*\n${lines.join("\n")}`;
}

async function detail(task: Task): Promise<string> {
  const kind = KIND[task.kind];
  const lines = [
    `${kind.icon} *${ref(task)} · ${kind.label}*`,
    task.title,
    "",
    `*Status:* ${statusLabel(task.status)}`,
    `*Assignee:* ${mention(task.assignee)}`,
    `*Requested by:* ${await userName(task.client_user)}`,
    `*Opened:* ${task.created_at}`,
  ];
  if (task.started_at) lines.push(`*Started:* ${task.started_at}`);
  if (task.completed_at) lines.push(`*Completed:* ${task.completed_at}`);
  if (task.client_permalink) lines.push("", `<${task.client_permalink}|Original client message>`);
  return lines.join("\n");
}
