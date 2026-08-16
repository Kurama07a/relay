import { readFileSync } from "node:fs";
import type { JWT, OAuth2Client } from "google-auth-library";
import { JWT as JwtClient } from "google-auth-library";
import { clientFor, getAccount } from "./google.js";
import { teamId, teamName } from "./slack/app.js";
import { db } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { allSheets, type Sheet } from "./report.js";
import * as settings from "./settings.js";
import {
  bannerFor,
  ruleRequests,
  STYLE_VERSION,
  styleRequests,
  type TabMeta,
} from "./sheet-style.js";

/**
 * Mirrors the ledger into a Google Sheet.
 *
 * One way, always. SQLite stays the source of truth and the sheet is a view of
 * it: edits made in the sheet are overwritten on the next sync. That is a
 * deliberate limit rather than a missing feature — the task rows carry the
 * Slack message mapping the whole bot depends on, and letting a spreadsheet
 * become authoritative over those would mean a stray paste could permanently
 * detach a card from its client thread.
 */

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Sheets rejects anything over 50k characters in one cell. */
const MAX_CELL = 40_000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function loadCredentials(): ServiceAccount | null {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();

  try {
    const raw = inline ? inline : file ? readFileSync(file, "utf8") : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) {
      log.error("service account JSON is missing client_email or private_key");
      return null;
    }
    return parsed;
  } catch (error) {
    log.error("could not read the Google service account credentials", error);
    return null;
  }
}

/**
 * The spreadsheet currently connected, in precedence order:
 *
 *   1. one Relay created via the workspace's own Google connection
 *   2. a link set from Slack against operator-provided credentials
 *   3. SHEETS_ID from .env
 *
 * The first is the path that scales to many workspaces; the others are the
 * single-tenant setup, kept working so nobody's existing install breaks.
 */
export function activeSheetId(): string {
  const account = teamId ? getAccount(teamId) : undefined;
  if (account?.spreadsheet_id) return account.spreadsheet_id;
  return settings.get(settings.KEYS.sheetId) ?? config.sheets.id;
}

/** An authorised requester, whichever way this workspace connected. */
function requester(): Requester | null {
  const oauth = teamId ? clientFor(teamId) : null;
  if (oauth) return oauth;

  const credentials = loadCredentials();
  return credentials ? client(credentials) : null;
}

export function sheetsConfigured(): boolean {
  return Boolean(activeSheetId() && requester());
}

/**
 * What the spreadsheet should be called. Named for what it holds rather than
 * for the app, so it's recognisable in a Drive listing months later.
 */
export function desiredTitle(): string {
  const custom = settings.get(settings.KEYS.sheetTitle);
  if (custom) return custom;
  return teamName ? `Relay Time Sheet — ${teamName}` : "Relay Time Sheet";
}

export interface RenameResult {
  from: string;
  to: string;
  changed: boolean;
}

/**
 * Renames the spreadsheet, and reports what it used to be called.
 *
 * Only ever called when a sheet is linked or the title is set explicitly —
 * never on a routine sync, so renaming it yourself afterwards sticks.
 */
export async function renameSpreadsheet(title = desiredTitle()): Promise<RenameResult> {
  const auth = requester();
  const spreadsheetId = activeSheetId();
  if (!auth || !spreadsheetId) throw new Error("No spreadsheet is connected.");

  const meta = await auth.request<{ properties?: { title?: string } }>({
    url: `${API}/${spreadsheetId}?fields=properties.title`,
  });
  const from = meta.data.properties?.title ?? "";
  if (from === title) return { from, to: title, changed: false };

  await auth.request({
    url: `${API}/${spreadsheetId}:batchUpdate`,
    method: "POST",
    data: {
      requests: [
        {
          updateSpreadsheetProperties: {
            properties: { title },
            fields: "title",
          },
        },
      ],
    },
  });

  log.info(`renamed spreadsheet ${spreadsheetId}: "${from}" -> "${title}"`);
  return { from, to: title, changed: true };
}

/** The address a spreadsheet must be shared with. Nobody can guess this. */
export function serviceAccountEmail(): string | null {
  return loadCredentials()?.client_email ?? null;
}

export type AccessCheck =
  | { ok: true; title: string; tabs: string[] }
  | { ok: false; reason: string; shareHint: boolean };

/**
 * Read-only probe that answers the only question that matters before the first
 * sync: can this service account actually open that spreadsheet?
 */
export async function checkSheetAccess(): Promise<AccessCheck> {
  const credentials = loadCredentials();
  if (!credentials) {
    return { ok: false, reason: "No service account credentials loaded.", shareHint: false };
  }
  const spreadsheetId = activeSheetId();
  if (!spreadsheetId) {
    return { ok: false, reason: "No spreadsheet connected.", shareHint: false };
  }

  try {
    const meta = await client(credentials).request<{
      properties?: { title?: string };
      sheets?: Array<{ properties?: { title?: string } }>;
    }>({ url: `${API}/${spreadsheetId}?fields=properties.title,sheets.properties.title` });

    return {
      ok: true,
      title: meta.data.properties?.title ?? "(untitled)",
      tabs: (meta.data.sheets ?? [])
        .map((sheet) => sheet.properties?.title)
        .filter(Boolean) as string[],
    };
  } catch (error) {
    const detail =
      (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message ?? (error as Error).message;
    return {
      ok: false,
      reason: detail,
      shareHint: /permission|forbidden|not found|denied/i.test(detail),
    };
  }
}

function client(credentials: ServiceAccount): JWT {
  return new JwtClient({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });
}

/** A cheap fingerprint of everything the sheet displays. */
function watermark(): string {
  const tasks = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS t FROM tasks`)
    .get() as { n: number; t: string };
  const events = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(COALESCE(ended_at, last_heartbeat_at)), '') AS t
       FROM work_sessions`,
    )
    .get() as { n: number; t: string };

  return `${tasks.n}:${tasks.t}|${events.n}|${sessions.n}:${sessions.t}`;
}

function clamp(sheet: Sheet): string[][] {
  return [sheet.header, ...sheet.rows].map((row) =>
    row.map((cell) => (cell.length > MAX_CELL ? `${cell.slice(0, MAX_CELL)}…` : cell)),
  );
}

/** Either auth style exposes the same `request`, which is all this file needs. */
type Requester = JWT | OAuth2Client;

interface SpreadsheetMeta {
  sheets?: Array<{
    properties?: { sheetId?: number; title?: string };
    bandedRanges?: Array<{ bandedRangeId?: number }>;
    conditionalFormats?: unknown[];
  }>;
}

async function readMeta(auth: Requester, spreadsheetId: string): Promise<SpreadsheetMeta> {
  const meta = await auth.request<SpreadsheetMeta>({
    url:
      `${API}/${spreadsheetId}` +
      `?fields=sheets.properties.sheetId,sheets.properties.title,` +
      `sheets.bandedRanges.bandedRangeId,sheets.conditionalFormats`,
  });
  return meta.data;
}

/** Creates any tab that doesn't exist yet, so a blank spreadsheet just works. */
async function ensureTabs(
  auth: Requester,
  spreadsheetId: string,
  sheets: Sheet[],
  meta: SpreadsheetMeta,
): Promise<boolean> {
  const existing = new Set(
    (meta.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[],
  );
  const missing = sheets.filter((sheet) => !existing.has(sheet.name));
  if (missing.length === 0) return false;

  await auth.request({
    url: `${API}/${spreadsheetId}:batchUpdate`,
    method: "POST",
    data: {
      requests: missing.map((sheet) => ({ addSheet: { properties: { title: sheet.name } } })),
    },
  });
  log.info(`created sheet tab(s): ${missing.map((s) => s.name).join(", ")}`);
  return true;
}

function tabMeta(meta: SpreadsheetMeta, title: string): TabMeta | null {
  const found = (meta.sheets ?? []).find((s) => s.properties?.title === title);
  const sheetId = found?.properties?.sheetId;
  // The first tab in a spreadsheet has id 0, so this must test for undefined.
  if (sheetId === undefined) return null;

  return {
    sheetId,
    title,
    bandedRangeIds: (found?.bandedRanges ?? [])
      .map((band) => band.bandedRangeId)
      .filter((id): id is number => typeof id === "number"),
    conditionalFormatCount: (found?.conditionalFormats ?? []).length,
  };
}

/** Writes every tab. Two API calls total, regardless of how many tabs. */
export async function pushToSheet(force = false): Promise<{ rows: number; tabs: number }> {
  const auth = requester();
  const spreadsheetId = activeSheetId();
  if (!auth || !spreadsheetId) {
    throw new Error(
      "No Google account is connected. Run `/relay sheet connect` in Slack.",
    );
  }
  const sheets = allSheets();

  // Reading the spreadsheet's structure is only needed to create missing tabs
  // or to style them. Once both are settled, a routine sync is two API calls —
  // which is what makes a short poll interval affordable.
  const styleKey = `sheet_style:${spreadsheetId}`;
  const needsMeta =
    force || !verifiedSheets.has(spreadsheetId) || settings.get(styleKey) !== STYLE_VERSION;

  let meta: SpreadsheetMeta | null = null;
  if (needsMeta) {
    meta = await readMeta(auth, spreadsheetId);
    const created = await ensureTabs(auth, spreadsheetId, sheets, meta);
    if (created) meta = await readMeta(auth, spreadsheetId);
  }

  // Clear first: without it, a shorter dataset leaves stale rows behind.
  await auth.request({
    url: `${API}/${spreadsheetId}/values:batchClear`,
    method: "POST",
    data: { ranges: sheets.map((sheet) => sheet.name) },
  });

  const updatedAt = new Date();
  await auth.request({
    url: `${API}/${spreadsheetId}/values:batchUpdate`,
    method: "POST",
    data: {
      valueInputOption: "RAW",
      data: sheets.map((sheet) => ({
        range: `${sheet.name}!A1`,
        // The banner belongs to the spreadsheet only; CSV exports stay plain.
        values: [
          [bannerFor(sheet, updatedAt), ...Array(sheet.header.length - 1).fill("")],
          ...clamp(sheet),
        ],
      })),
    },
  });

  if (meta) await applyStyling(auth, spreadsheetId, sheets, meta, force);

  verifiedSheets.add(spreadsheetId);
  settings.set(KEY_SYNCED_AT, new Date().toISOString());

  return {
    rows: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0),
    tabs: sheets.length,
  };
}

/** Spreadsheets whose tabs we've confirmed exist, so we can skip re-reading. */
const verifiedSheets = new Set<string>();

export const KEY_SYNCED_AT = "sheet_synced_at";

/** When the sheet last received data, so "is this working?" has an answer. */
export function lastSyncedAt(): string | null {
  return settings.get(KEY_SYNCED_AT);
}

/** e.g. "12 seconds ago" — for a status line, not a timestamp. */
export function describeLastSync(): string {
  const at = lastSyncedAt();
  if (!at) return "never";

  const seconds = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * Formatting is applied once per spreadsheet per style version, not on every
 * sync — it costs a dozen API calls and never changes in between. The recorded
 * version is what makes a redesign roll out without needing a fresh sheet.
 */
async function applyStyling(
  auth: Requester,
  spreadsheetId: string,
  sheets: Sheet[],
  meta: SpreadsheetMeta,
  force: boolean,
): Promise<void> {
  const key = `sheet_style:${spreadsheetId}`;
  if (!force && settings.get(key) === STYLE_VERSION) return;

  const requests: unknown[] = [];
  for (const sheet of sheets) {
    const tab = tabMeta(meta, sheet.name);
    if (!tab) continue;
    requests.push(...styleRequests(sheet, tab), ...ruleRequests(sheet, tab, sheet.rows.length));
  }
  if (requests.length === 0) return;

  try {
    await auth.request({
      url: `${API}/${spreadsheetId}:batchUpdate`,
      method: "POST",
      data: { requests },
    });
    settings.set(key, STYLE_VERSION);
    log.info(`applied sheet styling v${STYLE_VERSION} to ${spreadsheetId}`);
  } catch (error) {
    // A styling failure must never cost you the data that was just written.
    const detail =
      (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message ?? (error as Error).message;
    log.warn(`could not style the spreadsheet: ${detail}`);
  }
}

/**
 * Polls for changes rather than hooking every mutation. Decoupled on purpose:
 * a new way to change a task can't forget to notify the sheet, because nothing
 * has to remember to.
 */
export function startSheetSync(): NodeJS.Timeout | null {
  let lastPushed = "";
  let lastSheet = "";
  let running = false;

  const sync = async () => {
    if (running) return;

    // Re-read each tick: a workspace that connects Google from Slack must start
    // syncing without anyone restarting the bot.
    if (!sheetsConfigured()) return;
    const sheetId = activeSheetId();
    if (sheetId !== lastSheet) {
      lastPushed = ""; // a new spreadsheet starts out empty, so force a full write
      lastSheet = sheetId;
    }

    const current = watermark();
    if (current === lastPushed) return;

    running = true;
    try {
      const { rows, tabs } = await pushToSheet();
      lastPushed = current;
      log.info(`synced ${rows} rows across ${tabs} tabs to Google Sheets`);
    } catch (error) {
      const detail =
        (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? (error as Error).message;
      log.error(`Google Sheets sync failed: ${detail}`);
    } finally {
      running = false;
    }
  };

  void sync();
  const timer = setInterval(() => void sync(), config.sheets.syncSeconds * 1000);
  timer.unref();

  log.info(
    sheetsConfigured()
      ? `google sheets sync every ${config.sheets.syncSeconds}s → ${activeSheetId()}`
      : "google sheets idle — a workspace can connect one with /relay sheet connect",
  );
  return timer;
}
