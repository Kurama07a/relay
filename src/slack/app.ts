import bolt from "@slack/bolt";
import { config } from "../config.js";

const { App, LogLevel } = bolt;

export const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
  logLevel: config.logLevel === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
});

export const client = app.client;

/** Bot's own user id, filled in at startup so we can ignore our own messages. */
export let botUserId = "";

/**
 * The workspace Relay is serving. Everything per-workspace is keyed on this, so
 * that moving to a multi-tenant install means resolving it per event rather
 * than reshaping the data.
 */
export let teamId = "";

/** Workspace name, used to title things people will see outside Slack. */
export let teamName = "";

export async function resolveBotIdentity(): Promise<void> {
  const auth = await client.auth.test();
  botUserId = (auth.user_id as string) ?? "";
  teamId = (auth.team_id as string) ?? "";
  teamName = (auth.team as string) ?? "";
}
