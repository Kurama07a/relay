/**
 * Writes the ledger out as CSV files you can open in Excel, Numbers, or import
 * into Google Sheets.
 *
 *   npm run export                  # -> ./export/*.csv
 *   npm run export -- --out ./tmp   # somewhere else
 *
 * Reads the database directly, so it needs no Slack connection and no tokens.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allSheets, toCsv, UTF8_BOM } from "../src/report.js";
import { backfillNames } from "../src/resolve-names.js";

const args = process.argv.slice(2);

// Turn any raw U…/C… ids into real names first, so the spreadsheet is readable.
// Skipped silently without a token — ids are a worse export, not a broken one.
const botToken = process.env.SLACK_BOT_TOKEN?.trim();
if (botToken && !args.includes("--no-resolve")) {
  const resolved = await backfillNames(botToken);
  if (resolved > 0) console.log(`\nResolved ${resolved} name(s) from Slack.\n`);
}
const outIndex = args.indexOf("--out");
const outDir = resolve(outIndex === -1 ? "./export" : (args[outIndex + 1] ?? "./export"));

mkdirSync(outDir, { recursive: true });

const sheets = allSheets();
let total = 0;

for (const sheet of sheets) {
  const file = join(outDir, `${sheet.name.toLowerCase()}.csv`);
  writeFileSync(file, UTF8_BOM + toCsv(sheet), "utf8");
  console.log(`  ${String(sheet.rows.length).padStart(5)} rows  →  ${file}`);
  total += sheet.rows.length;
}

console.log(`
Wrote ${sheets.length} files (${total} rows) to ${outDir}

To get these into Google Sheets: File → Import → Upload → tasks.csv.
For a sheet that keeps itself up to date instead, see "Live Google Sheet"
in README.md.
`);
