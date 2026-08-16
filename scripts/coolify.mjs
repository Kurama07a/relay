#!/usr/bin/env node
/**
 * Drives a Coolify instance over its REST API.
 *
 *   npm run coolify probe            what's on your instance (read-only)
 *   npm run coolify create           create the Relay application
 *   npm run coolify env              push environment variables
 *   npm run coolify deploy           trigger a deployment
 *   npm run coolify status           latest deployment state
 *
 * Reads COOLIFY_URL and COOLIFY_TOKEN from .env (which is gitignored). Coolify
 * has no official CLI; this talks to the same API its own UI uses.
 *
 * `probe` is deliberately read-only and comes first: it confirms the token
 * works and shows the servers and projects an application has to be attached
 * to, rather than guessing at ids.
 */
import { readFileSync } from "node:fs";

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // No .env — fall back to the process environment.
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const URL_BASE = (env.COOLIFY_URL ?? "").replace(/\/$/, "");
const TOKEN = env.COOLIFY_TOKEN ?? "";

if (!URL_BASE || !TOKEN) {
  console.error(`
Coolify credentials are missing. Add to .env (it is gitignored):

  COOLIFY_URL=https://coolify.your-domain.com
  COOLIFY_TOKEN=<token>

Create the token in Coolify: Keys & Tokens -> API tokens -> Create.
Give it write permissions, not read-only, or create/deploy will 403.
`);
  process.exit(1);
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${URL_BASE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}

function fail(label, result) {
  console.error(`\n✗ ${label} — HTTP ${result.status}`);
  console.error(typeof result.data === "string" ? result.data.slice(0, 400) : JSON.stringify(result.data, null, 2).slice(0, 800));
  if (result.status === 401) console.error("\nThe token was rejected. Check COOLIFY_TOKEN.");
  if (result.status === 403) console.error("\nThe token lacks permission. It needs write access, not read-only.");
  if (result.status === 404) console.error("\nEndpoint not found — your Coolify may be a different major version.");
  process.exit(1);
}

const APP_NAME = env.COOLIFY_APP_NAME ?? "relay";
const REPO = env.COOLIFY_REPO ?? "https://github.com/Kurama07a/relay";
const BRANCH = env.COOLIFY_BRANCH ?? "main";

const commands = {
  /** Read-only. Confirms the token works and shows what things can attach to. */
  async probe() {
    const version = await api("/version");
    if (!version.ok) fail("Could not reach Coolify", version);
    console.log(`\nCoolify ${typeof version.data === "string" ? version.data : JSON.stringify(version.data)} at ${URL_BASE}`);

    const servers = await api("/servers");
    if (!servers.ok) fail("Could not list servers", servers);
    console.log(`\nServers (${servers.data?.length ?? 0}):`);
    for (const server of servers.data ?? []) {
      console.log(`  ${server.uuid}  ${server.name}${server.description ? ` — ${server.description}` : ""}`);
    }

    const projects = await api("/projects");
    if (!projects.ok) fail("Could not list projects", projects);
    console.log(`\nProjects (${projects.data?.length ?? 0}):`);
    for (const project of projects.data ?? []) {
      const envs = (project.environments ?? []).map((e) => e.name).join(", ");
      console.log(`  ${project.uuid}  ${project.name}${envs ? `  [${envs}]` : ""}`);
    }

    const apps = await api("/applications");
    if (apps.ok) {
      console.log(`\nApplications (${apps.data?.length ?? 0}):`);
      for (const app of apps.data ?? []) {
        const mine = app.name === APP_NAME ? "  <-- this one" : "";
        console.log(`  ${app.uuid}  ${app.name}  ${app.status ?? ""}${mine}`);
      }
    }

    console.log(`
Next: pick a server and project uuid from above and add them to .env

  COOLIFY_SERVER_UUID=...
  COOLIFY_PROJECT_UUID=...
  COOLIFY_ENVIRONMENT=production

then run:  npm run coolify create
`);
  },

  async create() {
    const server = env.COOLIFY_SERVER_UUID;
    const project = env.COOLIFY_PROJECT_UUID;
    const environment = env.COOLIFY_ENVIRONMENT ?? "production";

    if (!server || !project) {
      console.error("Set COOLIFY_SERVER_UUID and COOLIFY_PROJECT_UUID in .env — run `npm run coolify probe` to find them.");
      process.exit(1);
    }

    const existing = await api("/applications");
    const already = (existing.data ?? []).find((app) => app.name === APP_NAME);
    if (already) {
      console.log(`Application "${APP_NAME}" already exists: ${already.uuid}`);
      console.log(`Add to .env:\n\n  COOLIFY_APP_UUID=${already.uuid}\n`);
      return;
    }

    // Dockerfile build pack: the repo's Dockerfile handles the native SQLite
    // build, and Relay needs no exposed port because Socket Mode is outbound.
    const result = await api("/applications/public", {
      method: "POST",
      body: {
        project_uuid: project,
        server_uuid: server,
        environment_name: environment,
        git_repository: REPO,
        git_branch: BRANCH,
        build_pack: "dockerfile",
        dockerfile_location: "/Dockerfile",
        name: APP_NAME,
        description: "Slack bot routing client requests into engineering",
        ports_exposes: "3737",
        instant_deploy: false,
      },
    });
    if (!result.ok) fail("Could not create the application", result);

    const uuid = result.data?.uuid;
    console.log(`\nCreated "${APP_NAME}": ${uuid}`);
    console.log(`
Add to .env:

  COOLIFY_APP_UUID=${uuid}

Then, IN THE COOLIFY UI, add persistent storage before deploying:

  Storages -> Add -> mount path /data

That one is not optional. Without it the ledger is wiped on every redeploy,
and every existing Slack thread stops working permanently.

Then:  npm run coolify env  &&  npm run coolify deploy
`);
  },

  /** Pushes the runtime configuration Relay needs, without printing values. */
  async env() {
    const app = env.COOLIFY_APP_UUID;
    if (!app) {
      console.error("Set COOLIFY_APP_UUID in .env — run `npm run coolify create` first.");
      process.exit(1);
    }

    const wanted = {
      SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: env.SLACK_APP_TOKEN,
      DB_PATH: "/data/relay.db",
      LOG_LEVEL: env.LOG_LEVEL ?? "info",
    };

    // Sent as one line rather than a file path — nothing is copied to the server.
    if (env.GOOGLE_SERVICE_ACCOUNT_FILE) {
      try {
        wanted.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(
          JSON.parse(readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, "utf8")),
        );
      } catch (error) {
        console.error(`Could not read ${env.GOOGLE_SERVICE_ACCOUNT_FILE}: ${error.message}`);
      }
    } else if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      wanted.GOOGLE_SERVICE_ACCOUNT_JSON = env.GOOGLE_SERVICE_ACCOUNT_JSON;
    }

    for (const [key, value] of Object.entries(wanted)) {
      if (!value) {
        console.log(`  skip   ${key} (not set locally)`);
        continue;
      }
      const result = await api(`/applications/${app}/envs`, {
        method: "POST",
        body: { key, value, is_preview: false},
      });

      if (result.ok) {
        console.log(`  set    ${key}`);
        continue;
      }
      // Already present: update rather than duplicate.
      const update = await api(`/applications/${app}/envs`, {
        method: "PATCH",
        body: { key, value, is_preview: false},
      });
      if (update.ok) {
        console.log(`  update ${key}`);
        continue;
      }

      // Show what the server objected to. A validation error that only says
      // "422" is the least useful message a deploy tool can give you.
      console.log(`  FAILED ${key}  POST ${result.status} / PATCH ${update.status}`);
      for (const [label, response] of [["POST", result], ["PATCH", update]]) {
        const detail = response.data;
        if (!detail) continue;
        const message =
          typeof detail === "string"
            ? detail.slice(0, 300)
            : JSON.stringify(detail.errors ?? detail.message ?? detail).slice(0, 300);
        console.log(`         ${label}: ${message}`);
      }
    }

    console.log("\nValues are never printed here — check them in the Coolify UI if unsure.");
  },

  async deploy() {
    const app = env.COOLIFY_APP_UUID;
    if (!app) {
      console.error("Set COOLIFY_APP_UUID in .env first.");
      process.exit(1);
    }
    const result = await api(`/deploy?uuid=${encodeURIComponent(app)}&force=false`, {
      method: "POST",
    });
    if (!result.ok) fail("Could not trigger the deployment", result);
    console.log(`\nDeployment queued.\n${JSON.stringify(result.data, null, 2)}`);
    console.log(`\nWatch it:  npm run coolify status\n`);
  },

  async status() {
    const app = env.COOLIFY_APP_UUID;
    if (!app) {
      console.error("Set COOLIFY_APP_UUID in .env first.");
      process.exit(1);
    }
    const application = await api(`/applications/${app}`);
    if (application.ok) {
      console.log(`\n${application.data?.name}: ${application.data?.status ?? "unknown"}`);
    }
    const deployments = await api(`/deployments`);
    if (deployments.ok && Array.isArray(deployments.data)) {
      const mine = deployments.data.filter((d) => d.application_id === app || d.application_uuid === app);
      console.log(`\nRecent deployments:`);
      for (const deployment of mine.slice(0, 5)) {
        console.log(`  ${deployment.created_at ?? ""}  ${deployment.status}  ${deployment.deployment_uuid ?? ""}`);
      }
      if (mine.length === 0) console.log("  (none yet)");
    }
  },
};

const command = process.argv[2] ?? "probe";
const handler = commands[command];
if (!handler) {
  console.error(`Unknown command "${command}". Try: probe | create | env | deploy | status`);
  process.exit(1);
}

await handler();
