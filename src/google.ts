import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { db } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Google authorisation, per Slack workspace.
 *
 * The operator registers Relay with Google **once** and sets a client id and
 * secret. Every workspace then connects its own Google account by clicking
 * Allow — no Google Cloud project, no service account, no JSON key on their
 * side. This is the same shape as the Slack app itself: registered once by
 * whoever ships it, installed by everyone else.
 *
 * Scope is deliberately `drive.file`, which grants access only to files Relay
 * itself created. That is enough because Relay creates the spreadsheet, and it
 * keeps the app out of Google's "sensitive scope" tier — which would otherwise
 * mean a verification review, a 100-user cap, and refresh tokens that expire
 * every seven days.
 */

const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const STATE_TTL_MINUTES = 15;

export interface GoogleAccount {
  team_id: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: string | null;
  email: string | null;
  spreadsheet_id: string | null;
  connected_by: string | null;
  connected_at: string;
}

export function googleConfigured(): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret && config.publicUrl);
}

/** Explains exactly which piece is missing, rather than just "not configured". */
export function googleSetupProblem(): string | null {
  if (!config.google.clientId) return "GOOGLE_CLIENT_ID is not set.";
  if (!config.google.clientSecret) return "GOOGLE_CLIENT_SECRET is not set.";
  if (!config.publicUrl) {
    return "PUBLIC_URL is not set — Google needs a public address to send people back to.";
  }
  return null;
}

export function redirectUri(): string {
  return `${config.publicUrl.replace(/\/$/, "")}/oauth/google/callback`;
}

function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: redirectUri(),
  });
}

/** Builds the consent URL and remembers who it was issued to. */
export function beginAuth(teamId: string, userId: string, channelId?: string): string {
  const state = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO oauth_states (state, team_id, user_id, channel_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(state, teamId, userId, channelId ?? null, new Date().toISOString());

  return oauthClient().generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    // Without this, a user who has already approved gets no refresh token back,
    // and reconnecting silently produces an account that cannot be refreshed.
    prompt: "consent",
    include_granted_scopes: true,
  });
}

export interface ConsumedState {
  team_id: string;
  user_id: string;
  channel_id: string | null;
}

/** One-shot: a state token is valid once, and only briefly. */
export function consumeState(state: string): ConsumedState | null {
  const row = db.prepare(`SELECT * FROM oauth_states WHERE state = ?`).get(state) as
    | (ConsumedState & { created_at: string })
    | undefined;
  if (!row) return null;

  db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
  db.prepare(`DELETE FROM oauth_states WHERE created_at < ?`).run(
    new Date(Date.now() - STATE_TTL_MINUTES * 60_000).toISOString(),
  );

  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > STATE_TTL_MINUTES * 60_000) return null;

  return { team_id: row.team_id, user_id: row.user_id, channel_id: row.channel_id };
}

/** Exchanges the callback code for tokens and stores them against the team. */
export async function completeAuth(code: string, resolved: ConsumedState): Promise<GoogleAccount> {
  const auth = oauthClient();
  const { tokens } = await auth.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Revoke Relay's access at myaccount.google.com/permissions and connect again.",
    );
  }

  let email: string | null = null;
  try {
    auth.setCredentials(tokens);
    const info = await auth.request<{ email?: string }>({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    email = info.data.email ?? null;
  } catch {
    // Non-fatal — it's only shown for reassurance about which account is linked.
  }

  db.prepare(
    `INSERT INTO google_accounts
       (team_id, refresh_token, access_token, expires_at, email, connected_by, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token  = excluded.access_token,
       expires_at    = excluded.expires_at,
       email         = excluded.email,
       connected_by  = excluded.connected_by,
       connected_at  = excluded.connected_at`,
  ).run(
    resolved.team_id,
    tokens.refresh_token,
    tokens.access_token ?? null,
    tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    email,
    resolved.user_id,
    new Date().toISOString(),
  );

  log.info(`google account connected for team ${resolved.team_id}${email ? ` (${email})` : ""}`);
  return getAccount(resolved.team_id)!;
}

export function getAccount(teamId: string): GoogleAccount | undefined {
  return db.prepare(`SELECT * FROM google_accounts WHERE team_id = ?`).get(teamId) as
    | GoogleAccount
    | undefined;
}

export function disconnect(teamId: string): void {
  db.prepare(`DELETE FROM google_accounts WHERE team_id = ?`).run(teamId);
}

/** An authorised client for a workspace, refreshing the access token as needed. */
export function clientFor(teamId: string): OAuth2Client | null {
  const account = getAccount(teamId);
  if (!account) return null;

  const auth = oauthClient();
  auth.setCredentials({
    refresh_token: account.refresh_token,
    access_token: account.access_token ?? undefined,
    expiry_date: account.expires_at ? new Date(account.expires_at).getTime() : undefined,
  });

  // Persist rotated tokens so a restart doesn't force a re-authorisation.
  auth.on("tokens", (tokens) => {
    db.prepare(
      `UPDATE google_accounts SET access_token = COALESCE(?, access_token),
                                  expires_at   = COALESCE(?, expires_at),
                                  refresh_token = COALESCE(?, refresh_token)
       WHERE team_id = ?`,
    ).run(
      tokens.access_token ?? null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      tokens.refresh_token ?? null,
      teamId,
    );
  });

  return auth;
}

export const TAB_NAMES = ["Summary", "Tasks", "Sessions", "Activity"] as const;

/**
 * Creates the workspace's spreadsheet. Relay owning the creation is what keeps
 * `drive.file` sufficient — the app can touch this file and nothing else in the
 * user's Drive, which is both the privacy-respecting choice and the one that
 * avoids Google's review process.
 */
export async function createSpreadsheet(teamId: string, title: string): Promise<string> {
  const auth = clientFor(teamId);
  if (!auth) throw new Error("This workspace has not connected a Google account.");

  const response = await auth.request<{ spreadsheetId?: string }>({
    url: SHEETS_API,
    method: "POST",
    data: {
      properties: { title },
      sheets: TAB_NAMES.map((name) => ({ properties: { title: name } })),
    },
  });

  const id = response.data.spreadsheetId;
  if (!id) throw new Error("Google created no spreadsheet id.");

  db.prepare(`UPDATE google_accounts SET spreadsheet_id = ? WHERE team_id = ?`).run(id, teamId);
  log.info(`created spreadsheet ${id} for team ${teamId}`);
  return id;
}

export function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
