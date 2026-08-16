import type { KnownBlock, View } from "@slack/types";
import { app, client } from "./app.js";
import { channelName } from "./names.js";
import { dot, ICON } from "./design.js";
import { log } from "../log.js";
import {
  addRoute,
  listRoutes,
  removeRoute,
  type IngestMode,
  type Route,
} from "../routes.js";
import * as settings from "../settings.js";
import {
  adminChannels,
  adminUsers,
  canAdmin,
  describeAdmins,
  forgetRoles,
  setAdminChannels,
  setAdminUsers,
} from "../permissions.js";
import { backfillNames } from "../resolve-names.js";
import {
  describeLastSync,
  pushToSheet,
  renameSpreadsheet,
  sheetsConfigured,
} from "../sheets.js";
import { config } from "../config.js";

/**
 * Configuration from inside Slack.
 *
 * Everything here used to be a `.env` edit and a restart. Channel pairings and
 * the spreadsheet link are properties of how the team works, not of the machine
 * the bot runs on, so they belong somewhere the team can actually reach.
 */

const ADD_ROUTE = "relay_add_route";
const SET_SHEET = "relay_set_sheet";
const SET_PERMS = "relay_set_perms";

/**
 * Guard for interactive admin surfaces. The buttons only ever appear in an
 * ephemeral message an admin was shown, but the check is repeated here because
 * an interaction payload is a request like any other, and "the UI didn't offer
 * it" is not an authorisation model.
 */
async function denyIfNotAdmin(
  userId: string,
  channelId: string | undefined,
  respond?: (message: { response_type: "ephemeral"; replace_original: boolean; text: string }) => Promise<unknown>,
): Promise<boolean> {
  const decision = await canAdmin(userId, channelId);
  if (decision.ok) return false;
  log.warn(`blocked admin action by ${userId}: ${decision.reason}`);
  if (respond) {
    await respond({
      response_type: "ephemeral",
      replace_original: false,
      text: `${ICON.warning} ${decision.reason}`,
    });
  }
  return true;
}

/**
 * The control panel. Non-admins still get to see which channel pairs with
 * which — that's useful and harmless — but not the spreadsheet link, and not
 * the buttons that change anything.
 */
export async function configBlocks(isAdmin = true): Promise<KnownBlock[]> {
  const routes = listRoutes();
  const sheetId = settings.get(settings.KEYS.sheetId);

  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "Relay setup", emoji: true } },
  ];

  if (routes.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*No channel pairings yet.*\nAdd one to start relaying client requests into a team channel.",
      },
    });
  } else {
    const lines = await Promise.all(
      routes.map(async (route) => {
        const client_ = await channelName(route.client_channel);
        const team = await channelName(route.team_channel);
        return `*${client_}*  →  *${team}*\n${dot(route.label ?? undefined, route.ingest_mode === "mention" ? "only when @-mentioned" : "all messages")}`;
      }),
    );
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Channel pairings*\n\n${lines.join("\n\n")}` },
    });
  }

  if (!isAdmin) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `${ICON.note} View only — ${await describeAdmins()}` },
      ],
    });
    return blocks;
  }

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: sheetId
        ? `*Google Sheet*\n<${settings.sheetUrl(sheetId)}|Open spreadsheet>\n` +
          (sheetsConfigured()
            ? `_Syncs automatically · last updated ${describeLastSync()}_`
            : `${ICON.warning} _Credentials missing — set GOOGLE_SERVICE_ACCOUNT_FILE to enable syncing._`)
        : "*Google Sheet*\n_Not connected._",
    },
  });

  const admins = adminUsers();
  const channels = adminChannels();
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*Who can configure Relay*\n` +
        (admins.length > 0
          ? admins.map((id) => `<@${id}>`).join(", ")
          : "_Anyone who is a Slack workspace admin._") +
        (channels.length > 0
          ? `\nOnly from ${channels.map((id) => `<#${id}>`).join(", ")}`
          : "\nFrom any channel"),
    },
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Add pairing", emoji: false },
        style: "primary",
        action_id: "relay_open_route_modal",
      },
      {
        type: "button",
        text: { type: "plain_text", text: sheetId ? "Change sheet" : "Connect sheet", emoji: false },
        action_id: "relay_open_sheet_modal",
      },
      ...(sheetId
        ? [
            {
              type: "button" as const,
              text: { type: "plain_text" as const, text: "Sync now", emoji: false },
              action_id: "relay_sync_sheet",
            },
          ]
        : []),
      {
        type: "button",
        text: { type: "plain_text", text: "Permissions", emoji: false },
        action_id: "relay_open_perms_modal",
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: dot(
          `\`/relay unpair #channel\``,
          `\`/relay sheet <url>\``,
          `\`/relay backfill\``,
          `\`/relay admins\``,
        ),
      },
    ],
  });

  return blocks;
}

function routeModal(): View {
  return {
    type: "modal",
    callback_id: ADD_ROUTE,
    title: { type: "plain_text", text: "Add a pairing" },
    submit: { type: "plain_text", text: "Pair channels" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "client",
        label: { type: "plain_text", text: "Client channel" },
        hint: { type: "plain_text", text: "Where requests come from. Shared channels work." },
        element: {
          type: "conversations_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a channel" },
          filter: { include: ["public", "private"], exclude_bot_users: true },
        },
      },
      {
        type: "input",
        block_id: "team",
        label: { type: "plain_text", text: "Team channel" },
        hint: { type: "plain_text", text: "Where your engineers triage them." },
        element: {
          type: "conversations_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Pick a channel" },
          filter: { include: ["public", "private"], exclude_bot_users: true },
        },
      },
      {
        type: "input",
        block_id: "label",
        optional: true,
        label: { type: "plain_text", text: "Label" },
        hint: { type: "plain_text", text: "Shown in the setup list, e.g. the client's name." },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Acme Corp" },
        },
      },
      {
        type: "input",
        block_id: "mode",
        label: { type: "plain_text", text: "What should be relayed?" },
        element: {
          type: "radio_buttons",
          action_id: "value",
          initial_option: {
            value: "all",
            text: { type: "plain_text", text: "Every new message" },
          },
          options: [
            { value: "all", text: { type: "plain_text", text: "Every new message" } },
            {
              value: "mention",
              text: { type: "plain_text", text: "Only messages that @-mention Relay" },
            },
          ],
        },
      },
    ],
  };
}

function permsModal(): View {
  const admins = adminUsers();
  const channels = adminChannels();

  return {
    type: "modal",
    callback_id: SET_PERMS,
    title: { type: "plain_text", text: "Permissions" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "admins",
        optional: true,
        label: { type: "plain_text", text: "Who can configure Relay" },
        hint: {
          type: "plain_text",
          text: "Leave empty to allow any Slack workspace admin. Workspace owners always qualify.",
        },
        element: {
          type: "multi_users_select",
          action_id: "value",
          ...(admins.length > 0 ? { initial_users: admins } : {}),
          placeholder: { type: "plain_text", text: "Pick people" },
        },
      },
      {
        type: "input",
        block_id: "channels",
        optional: true,
        label: { type: "plain_text", text: "Where setup commands work" },
        hint: {
          type: "plain_text",
          text: "Leave empty to allow any channel. Workspace owners are never restricted.",
        },
        element: {
          type: "multi_conversations_select",
          action_id: "value",
          ...(channels.length > 0 ? { initial_conversations: channels } : {}),
          placeholder: { type: "plain_text", text: "Pick channels" },
        },
      },
    ],
  };
}

function sheetModal(current: string | null): View {
  return {
    type: "modal",
    callback_id: SET_SHEET,
    title: { type: "plain_text", text: "Google Sheet" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "url",
        optional: true,
        label: { type: "plain_text", text: "Spreadsheet link" },
        hint: {
          type: "plain_text",
          text: "Paste the URL. Leave empty to disconnect. Share the sheet with your service account as an Editor.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: current ? settings.sheetUrl(current) : undefined,
          placeholder: {
            type: "plain_text",
            text: "https://docs.google.com/spreadsheets/d/…",
          },
        },
      },
    ],
  };
}

/**
 * Confirms Relay can post into a channel. Shared by pairing and by setting the
 * control channel — both write there, and both fail invisibly if it can't.
 */
export async function postingProblem(channel: string): Promise<string | null> {
  return membershipProblem(channel);
}

/** Confirms the bot can actually see a channel before pairing it. */
async function membershipProblem(channel: string): Promise<string | null> {
  try {
    const info = await client.conversations.info({ channel });
    if (info.channel?.is_im || info.channel?.is_mpim) {
      return "Direct messages can't be paired — Relay only receives events from channels.";
    }
    if (info.channel?.is_member === false) {
      return `Relay isn't in #${info.channel?.name ?? channel}. Invite it there first with /invite @Relay, then try again.`;
    }
    return null;
  } catch (error) {
    const reason = (error as { data?: { error?: string } })?.data?.error ?? "unknown error";
    return `Relay can't see that channel (${reason}). Invite it with /invite @Relay first.`;
  }
}

/** Pulls user, channel, and trigger out of a block_actions payload. */
function actionContext(body: unknown): {
  user: string;
  channel: string | undefined;
  triggerId: string | undefined;
} {
  const payload = body as {
    user?: { id?: string };
    channel?: { id?: string };
    trigger_id?: string;
  };
  return {
    user: payload.user?.id ?? "",
    channel: payload.channel?.id,
    triggerId: payload.trigger_id,
  };
}

export function registerAdmin(): void {
  app.action("relay_open_route_modal", async ({ ack, body, respond }) => {
    await ack();
    const { user, channel, triggerId } = actionContext(body);
    if (await denyIfNotAdmin(user, channel, respond)) return;
    if (triggerId) await client.views.open({ trigger_id: triggerId, view: routeModal() });
  });

  app.action("relay_open_sheet_modal", async ({ ack, body, respond }) => {
    await ack();
    const { user, channel, triggerId } = actionContext(body);
    if (await denyIfNotAdmin(user, channel, respond)) return;
    if (triggerId) {
      await client.views.open({
        trigger_id: triggerId,
        view: sheetModal(settings.get(settings.KEYS.sheetId)),
      });
    }
  });

  app.action("relay_open_perms_modal", async ({ ack, body, respond }) => {
    await ack();
    const { user, channel, triggerId } = actionContext(body);
    if (await denyIfNotAdmin(user, channel, respond)) return;
    if (triggerId) await client.views.open({ trigger_id: triggerId, view: permsModal() });
  });

  app.view(SET_PERMS, async ({ ack, body, view }) => {
    if (await denyIfNotAdmin(body.user.id, undefined)) {
      await ack({
        response_action: "errors",
        errors: { admins: "You're not allowed to change Relay's permissions." },
      });
      return;
    }

    const values = view.state.values;
    const admins = values.admins?.value?.selected_users ?? [];
    const channels = values.channels?.value?.selected_conversations ?? [];

    // Removing yourself while naming others is how people lock themselves out.
    if (admins.length > 0 && !admins.includes(body.user.id)) {
      const role = await canAdmin(body.user.id, undefined);
      if (role.ok) admins.push(body.user.id);
    }

    setAdminUsers(admins, body.user.id);
    setAdminChannels(channels, body.user.id);
    forgetRoles();
    await ack();

    await announce(
      `${ICON.note} <@${body.user.id}> updated who can configure Relay: ` +
        (admins.length > 0 ? admins.map((id) => `<@${id}>`).join(", ") : "any workspace admin") +
        (channels.length > 0
          ? `, from ${channels.map((id) => `<#${id}>`).join(", ")}`
          : ", from any channel"),
      body.user.id,
    );
  });

  app.action("relay_sync_sheet", async ({ ack, body, respond }) => {
    await ack();
    const { user, channel } = actionContext(body);
    if (await denyIfNotAdmin(user, channel, respond)) return;
    try {
      if (process.env.SLACK_BOT_TOKEN) await backfillNames(process.env.SLACK_BOT_TOKEN);
      const { rows, tabs } = await pushToSheet();
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `${ICON.done} Synced ${rows} rows across ${tabs} tabs.`,
      });
    } catch (error) {
      log.error(`manual sheet sync failed for ${user}`, error);
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `${ICON.warning} Sync failed: ${sheetError(error)}`,
      });
    }
  });

  app.view(ADD_ROUTE, async ({ ack, body, view }) => {
    if (await denyIfNotAdmin(body.user.id, undefined)) {
      await ack({
        response_action: "errors",
        errors: { client: "You're not allowed to change Relay's configuration." },
      });
      return;
    }

    const values = view.state.values;
    const clientChannel = values.client?.value?.selected_conversation ?? "";
    const teamChannel = values.team?.value?.selected_conversation ?? "";
    const label = values.label?.value?.value?.trim() || undefined;
    const mode = (values.mode?.value?.selected_option?.value ?? "all") as IngestMode;

    if (clientChannel === teamChannel) {
      await ack({
        response_action: "errors",
        errors: { team: "Pick a different channel — a channel can't relay into itself." },
      });
      return;
    }

    const clientProblem = await membershipProblem(clientChannel);
    if (clientProblem) {
      await ack({ response_action: "errors", errors: { client: clientProblem } });
      return;
    }
    const teamProblem = await membershipProblem(teamChannel);
    if (teamProblem) {
      await ack({ response_action: "errors", errors: { team: teamProblem } });
      return;
    }

    const result = addRoute({
      clientChannel,
      teamChannel,
      label,
      ingestMode: mode,
      createdBy: body.user.id,
    });

    if (!result.ok) {
      await ack({ response_action: "errors", errors: { client: result.error } });
      return;
    }
    await ack();

    await announce(
      `${ICON.done} <@${body.user.id}> paired *${await channelName(clientChannel)}* → *${await channelName(teamChannel)}*` +
        (result.replaced ? " _(replacing its previous pairing)_" : ""),
      body.user.id,
    );
  });

  app.view(SET_SHEET, async ({ ack, body, view }) => {
    if (await denyIfNotAdmin(body.user.id, undefined)) {
      await ack({
        response_action: "errors",
        errors: { url: "You're not allowed to change Relay's configuration." },
      });
      return;
    }

    const raw = view.state.values.url?.value?.value?.trim() ?? "";

    if (!raw) {
      settings.clear(settings.KEYS.sheetId);
      await ack();
      await announce(`${ICON.note} <@${body.user.id}> disconnected the Google Sheet.`, body.user.id);
      return;
    }

    const id = settings.parseSheetId(raw);
    if (!id) {
      await ack({
        response_action: "errors",
        errors: { url: "That doesn't look like a Google Sheets link or id." },
      });
      return;
    }

    settings.set(settings.KEYS.sheetId, id, body.user.id);
    await ack();

    let note = "";
    if (sheetsConfigured()) {
      try {
        const renamed = await renameSpreadsheet();
        if (renamed.changed) note += ` Renamed it from "${renamed.from}" to "${renamed.to}".`;
      } catch (error) {
        log.warn("could not rename the spreadsheet on connect", error);
      }
      try {
        const { rows } = await pushToSheet();
        note += ` First sync wrote ${rows} rows.`;
      } catch (error) {
        note += ` But the first sync failed: ${sheetError(error)}`;
      }
    } else {
      note = " Set GOOGLE_SERVICE_ACCOUNT_FILE to start syncing.";
    }

    await announce(
      `${ICON.done} <@${body.user.id}> connected the <${settings.sheetUrl(id)}|Google Sheet>.${note}`,
      body.user.id,
    );
  });
}

/**
 * Posts config changes to the control channel if one is set, so there's a shared
 * record of who changed what. Falls back to a DM so the actor always hears back.
 */
export async function announce(text: string, actor: string): Promise<void> {
  const channel = settings.get(settings.KEYS.controlChannel);
  try {
    await client.chat.postMessage({ channel: channel ?? actor, text, unfurl_links: false });
  } catch (error) {
    log.warn("could not announce a config change", error);
  }
}

export function sheetError(error: unknown): string {
  const detail =
    (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
      ?.message ?? (error as Error).message;
  return /permission|forbidden|not found/i.test(detail)
    ? `${detail} — is the sheet shared with the service account as an Editor?`
    : detail;
}

/** Seeds pairings from .env the first time, so upgrading changes nothing. */
export function migrateFromEnv(): void {
  if (listRoutes(true).length > 0) return;
  if (!config.internalChannel || config.clientChannels.length === 0) return;

  for (const clientChannel of config.clientChannels) {
    addRoute({
      clientChannel,
      teamChannel: config.internalChannel,
      ingestMode: config.ingestMode,
      createdBy: "migration",
      label: "from .env",
    });
  }
  log.info(
    `migrated ${config.clientChannels.length} channel pairing(s) out of .env into the database — ` +
      `you can remove CLIENT_CHANNELS and INTERNAL_CHANNEL now`,
  );
}
