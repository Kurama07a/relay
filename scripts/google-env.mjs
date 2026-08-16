#!/usr/bin/env node
/**
 * Flattens the service account key into a single line, ready to paste into
 * Coolify (or any env-var box) as GOOGLE_SERVICE_ACCOUNT_JSON.
 *
 *   npm run google:env
 *   npm run google:env -- ./some-other-key.json
 *
 * Copying a credential file onto a server is worse than pasting it into the
 * platform's secret store, which is why this exists.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "./gcp-service-account.json",
);

let parsed;
try {
  parsed = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`
Could not read ${path}

  ${error.message}

Run \`npm run setup:google\` first, or pass the path:
  npm run google:env -- ./path/to/key.json
`);
  process.exit(1);
}

if (!parsed.client_email || !parsed.private_key) {
  console.error(`${path} doesn't look like a service account key — no client_email/private_key.`);
  process.exit(1);
}

console.error(`
Service account: ${parsed.client_email}
Share your spreadsheet with that address as an Editor.

Paste everything below as GOOGLE_SERVICE_ACCOUNT_JSON:
${"─".repeat(64)}`);

// The value goes to stdout alone, so `npm run google:env > value.txt` or a pipe
// to the clipboard gives exactly the string and nothing else.
console.log(JSON.stringify(parsed));
