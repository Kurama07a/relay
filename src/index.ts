import { config, validateConfig } from "./config.js";
import { log } from "./log.js";
import { app, client, resolveBotIdentity, teamId } from "./slack/app.js";
import { registerIngest } from "./slack/ingest.js";
import { registerReactions } from "./slack/reactions.js";
import { registerCommands } from "./slack/commands.js";
import { migrateFromEnv, registerAdmin } from "./slack/admin.js";
import { countRoutes, listRoutes, watchedChannels } from "./routes.js";
import * as settings from "./settings.js";
import { ADMIN_USERS } from "./permissions.js";
import { channelName } from "./slack/names.js";
import { refreshInternalMessage } from "./slack/actions.js";
import { countByStatus, getTask } from "./store.js";
import { startApi } from "./api.js";
import { reapStaleSessions } from "./sessions.js";
import { startSheetSync } from "./sheets.js";

/**
 * Warns about channels the bot cannot actually read. Missing membership is the
 * single most common reason a fresh install looks broken — everything connects,
 * but no events ever arrive.
 */
async function checkMembership(): Promise<void> {
  const channels = watchedChannels();
  if (channels.length === 0) {
    log.warn("no channel pairings configured — run /relay setup in Slack to add one");
    return;
  }
  for (const channel of channels) {
    try {
      const info = await client.conversations.info({ channel });
      if (info.channel?.is_member === false) {
        log.warn(`bot is not a member of ${channel} (#${info.channel?.name}) — run /invite @relay there`);
      } else {
        log.info(`watching ${await channelName(channel)}`);
      }
    } catch (error) {
      const reason = (error as { data?: { error?: string } })?.data?.error ?? error;
      log.warn(`cannot read channel ${channel}: ${reason}`);
    }
  }
}

/**
 * Closes sessions whose owner stopped checking in. Runs on a timer because the
 * alternative — trusting every editor to always fire a clean shutdown hook — is
 * how a closed laptop turns into an overnight session in a client-facing total.
 */
function startSessionReaper(): NodeJS.Timeout {
  const sweep = async () => {
    try {
      const reaped = reapStaleSessions();
      for (const session of reaped) {
        log.warn(
          `reaped stale session ${session.id} on task ${session.task_id} (last heartbeat ${session.last_heartbeat_at})`,
        );
        const task = getTask(session.task_id);
        if (task) await refreshInternalMessage(task);
      }
    } catch (error) {
      log.error("session reaper failed", error);
    }
  };

  void sweep(); // catch anything abandoned while the process was down
  const timer = setInterval(() => void sweep(), config.sessions.reapIntervalMinutes * 60_000);
  timer.unref();
  return timer;
}

/**
 * Notices when the tokens have been repointed at a different workspace.
 *
 * Nothing in the ledger is workspace-scoped, so a swapped token silently leaves
 * channel pairings, the control channel, and the admin list referring to ids
 * that don't exist here. The admin list is the dangerous one: if it names users
 * from the old workspace, nobody in the new one can run `/relay setup` unless
 * they happen to be a workspace owner.
 */
function checkWorkspace(): void {
  const known = settings.get("team_id");

  if (!known) {
    settings.set("team_id", teamId);
    return;
  }
  if (known === teamId) return;

  log.warn(
    `this database belongs to workspace ${known} but the token is for ${teamId}. ` +
      `Channel pairings, the control channel and the admin list all reference the ` +
      `old workspace and will not work here.`,
  );

  const stale = [
    listRoutes(true).length > 0 ? `${listRoutes(true).length} channel pairing(s)` : null,
    settings.get(ADMIN_USERS) ? "an admin list" : null,
    settings.get(settings.KEYS.controlChannel) ? "a control channel" : null,
  ].filter(Boolean);

  if (stale.length > 0) {
    log.warn(
      `carrying over ${stale.join(", ")} from the old workspace — start from an ` +
        `empty volume, or clear them before using this instance`,
    );
  }
}

async function main(): Promise<void> {
  validateConfig();

  // Registered before the handlers so it sees everything, including events no
  // handler claims.
  if (config.logEvents) {
    app.use(async ({ body, next }) => {
      const payload = body as { event?: { type?: string; reaction?: string; channel?: string }; type?: string; command?: string };
      const event = payload.event;
      const description = event?.type
        ? `${event.type}${event.reaction ? ` :${event.reaction}:` : ""}${event.channel ? ` in ${event.channel}` : ""}`
        : (payload.command ?? payload.type ?? "unknown");
      log.info(`← received: ${description}`);
      await next();
    });
    log.info("LOG_EVENTS=true — every inbound event will be logged");
  }

  // Pairings used to be env vars. Anything already configured that way is moved
  // into the database once, so upgrading changes nothing for an existing setup.
  migrateFromEnv();

  registerIngest();
  registerReactions();
  registerCommands();
  registerAdmin();

  app.error(async (error) => {
    log.error("unhandled bolt error", error);
  });

  await app.start();
  await resolveBotIdentity();

  log.info("relay is up (socket mode)");
  checkWorkspace();
  log.info(
    `ingest=${config.ingestMode} prefix=${config.commandPrefix} ` +
      `claim=${config.emoji.claim.accepts.map((name) => `:${name}:`).join("/")} ` +
      `dismiss=${config.emoji.dismiss.accepts.map((name) => `:${name}:`).join("/")}`,
  );
  log.info("ledger", countByStatus());

  startApi();
  startSessionReaper();
  startSheetSync();

  await checkMembership();
}

/**
 * A relay that dies takes the whole team's task tracking with it, and Slack
 * throws from more places than can be individually guarded — a rate limit
 * during a retry, a socket dropped mid-call. A stray rejection is worth loud
 * logging, not a process exit. An uncaught exception is different: the process
 * state is no longer trustworthy, so it goes down and lets the supervisor
 * restart it clean.
 */
process.on("unhandledRejection", (reason) => {
  log.error("unhandled promise rejection (continuing)", reason);
});

process.on("uncaughtException", (error) => {
  log.error("uncaught exception, shutting down", error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    void app.stop().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  log.error("failed to start", error);
  process.exit(1);
});
