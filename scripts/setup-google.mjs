#!/usr/bin/env node
/**
 * Creates everything Relay needs on Google Cloud, without opening a browser.
 *
 *   npm run setup:google
 *   npm run setup:google -- --project my-existing-project
 *   npm run setup:google -- --key ./somewhere-else.json
 *
 * Written in Node rather than shell so it behaves the same on Windows,
 * macOS, and the Linux box you deploy to — `sh` is not a given on Windows.
 *
 * Requires the gcloud CLI, logged in:  gcloud auth login
 */
import { spawnSync } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";

const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

if (args.includes("-h") || args.includes("--help")) {
  console.log(`
Creates a Google Cloud project, service account, and key for Relay.

  npm run setup:google
  npm run setup:google -- --project my-existing-project
  npm run setup:google -- --key ./path/to/key.json

Requires gcloud, logged in:  gcloud auth login
`);
  process.exit(0);
}

/**
 * gcloud ships as gcloud.cmd on Windows, so everything goes through a shell
 * rather than being exec'd directly.
 */
function gcloud(argv, { capture = true } = {}) {
  const result = spawnSync("gcloud", argv, {
    shell: true,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

const INSTALL_HINT = {
  win32: "winget install --id Google.CloudSDK -e",
  darwin: "brew install --cask google-cloud-sdk",
}[platform()] ?? "curl https://sdk.cloud.google.com | bash";

console.log("");

// ---- gcloud present and authenticated? --------------------------------------
if (!gcloud(["--version"]).ok) {
  console.error(`gcloud is not installed.

  ${INSTALL_HINT}

Then:  gcloud auth login

Docs: https://cloud.google.com/sdk/docs/install
`);
  process.exit(1);
}

const account = gcloud([
  "auth", "list", "--filter=status:ACTIVE", "--format=value(account)",
]);

if (!account.ok || !account.stdout) {
  console.error(`Not logged in to gcloud. Run:

  gcloud auth login
`);
  process.exit(1);
}
console.log(`==> Authenticated as ${account.stdout.split("\n")[0]}`);

// ---- project ----------------------------------------------------------------
let project = flag("project");

if (project) {
  // Passed straight to a shelled-out command, so constrain it.
  if (!/^[a-z][a-z0-9-]{5,29}$/.test(project)) {
    console.error(`"${project}" is not a valid project id (6-30 chars, lowercase letters, digits, hyphens).`);
    process.exit(1);
  }
  console.log(`==> Using existing project ${project}`);
} else {
  project = `relay-${Date.now().toString().slice(-9)}`;
  console.log(`==> Creating project ${project}`);
  const created = gcloud(["projects", "create", project, "--name=Relay"]);
  if (!created.ok) {
    console.error(`\nCould not create the project:\n${created.stderr}\n`);
    if (/quota|limit/i.test(created.stderr)) {
      console.error("You may be at your project limit. Reuse one with --project <id>.\n");
    }
    process.exit(1);
  }
}

// ---- APIs -------------------------------------------------------------------
console.log("==> Enabling the Sheets and Drive APIs (takes ~30s)");
const enabled = gcloud([
  "services", "enable", "sheets.googleapis.com", "drive.googleapis.com",
  `--project=${project}`,
]);
if (!enabled.ok) {
  console.error(`\nCould not enable the APIs:\n${enabled.stderr}\n`);
  if (/billing/i.test(enabled.stderr)) {
    console.error("This project may need a billing account linked. The Sheets and Drive APIs themselves are free.\n");
  }
  process.exit(1);
}

// ---- service account --------------------------------------------------------
const saName = "relay-sync";
const saEmail = `${saName}@${project}.iam.gserviceaccount.com`;

if (gcloud(["iam", "service-accounts", "describe", saEmail, `--project=${project}`]).ok) {
  console.log("==> Service account already exists");
} else {
  console.log(`==> Creating service account ${saName}`);
  const made = gcloud([
    "iam", "service-accounts", "create", saName,
    '--display-name="Relay"',
    '--description="Writes the Relay task ledger to Google Sheets"',
    `--project=${project}`,
  ]);
  if (!made.ok) {
    console.error(`\nCould not create the service account:\n${made.stderr}\n`);
    process.exit(1);
  }
}

// No IAM role is granted, deliberately: the account needs no project
// permissions. Its only access comes from the spreadsheet being shared with it.

// ---- key --------------------------------------------------------------------
const keyPath = resolve(flag("key", "./gcp-service-account.json"));

if (existsSync(keyPath)) {
  console.log(`==> Key already exists at ${keyPath} — leaving it alone`);
  console.log("    Delete it first if you want to rotate the key.");
} else {
  console.log(`==> Creating a key at ${keyPath}`);
  const key = gcloud([
    "iam", "service-accounts", "keys", "create", `"${keyPath}"`,
    `--iam-account=${saEmail}`,
    `--project=${project}`,
  ]);
  if (!key.ok) {
    console.error(`\nCould not create the key:\n${key.stderr}\n`);
    process.exit(1);
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file is gitignored either way.
  }
}

console.log(`
${"─".repeat(64)}
Done.

Add to your .env:

  GOOGLE_SERVICE_ACCOUNT_FILE=${flag("key", "./gcp-service-account.json")}

One manual step left — Google offers no API for it:

  1. Create a Google Sheet
  2. Share -> paste this address -> Editor -> Send

     ${saEmail}

  3. In Slack:  /relay sheet <the sheet's URL>

Check it with:  npm run doctor
${"─".repeat(64)}

Deploying to Coolify? Don't copy the key file to the server. Flatten it
into one line and paste it as GOOGLE_SERVICE_ACCOUNT_JSON:

  npm run google:env
`);
