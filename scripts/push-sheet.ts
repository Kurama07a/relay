/**
 * Pushes the ledger to the configured Google Sheet once, right now.
 *
 *   npm run sheet
 *
 * Useful for checking credentials work before relying on the background sync,
 * and for forcing a refresh without restarting the bot.
 */
import "dotenv/config";
import { backfillNames } from "../src/resolve-names.js";
import { pushToSheet, sheetsConfigured } from "../src/sheets.js";
import { config } from "../src/config.js";

if (!sheetsConfigured()) {
  console.error(`
Google Sheets isn't configured.

  SHEETS_ID                     the id from your sheet's URL:
                                docs.google.com/spreadsheets/d/<THIS>/edit
  GOOGLE_SERVICE_ACCOUNT_FILE   path to the service account JSON key

Then share the spreadsheet with the service account's client_email address,
giving it Editor access. See "Live Google Sheet" in README.md.
`);
  process.exit(1);
}

const botToken = process.env.SLACK_BOT_TOKEN?.trim();
if (botToken) {
  const resolved = await backfillNames(botToken);
  if (resolved > 0) console.log(`Resolved ${resolved} name(s) from Slack.`);
}

const force = process.argv.includes("--restyle");

try {
  const { rows, tabs } = await pushToSheet(force);
  console.log(`
Pushed ${rows} rows across ${tabs} tabs.

  https://docs.google.com/spreadsheets/d/${config.sheets.id}/edit
`);
} catch (error) {
  const detail =
    (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
      ?.message ?? (error as Error).message;
  console.error(`\nFailed: ${detail}\n`);
  if (/permission|forbidden|not found/i.test(detail)) {
    console.error(
      "Most likely the sheet isn't shared with the service account.\n" +
        "Open the spreadsheet → Share → paste the client_email from your JSON key → Editor.\n",
    );
  }
  process.exit(1);
}
