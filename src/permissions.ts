import * as settings from "./settings.js";
import { log } from "./log.js";

/**
 * Who may change Relay's configuration, and where.
 *
 * Two independent gates: a person must be an admin, and — if the workspace has
 * restricted them — must be standing in an approved channel. Task commands
 * (`/relay`, `/relay mine`) are ungated; only configuration is protected.
 *
 * The design problem here is lockout. A permission system that can be
 * configured wrong badly enough to lock everyone out is worse than none, so
 * Slack workspace *owners* always pass both gates. They can reinstall the app
 * regardless, so this grants nothing they didn't already have.
 */

export const ADMIN_USERS = "admin_users";
export const ADMIN_CHANNELS = "admin_channels";

function readList(key: string): string[] {
  const raw = settings.get(key);
  return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export function adminUsers(): string[] {
  return readList(ADMIN_USERS);
}

export function adminChannels(): string[] {
  return readList(ADMIN_CHANNELS);
}

export function setAdminUsers(users: string[], by?: string): void {
  settings.set(ADMIN_USERS, [...new Set(users)].join(","), by);
}

export function setAdminChannels(channels: string[], by?: string): void {
  settings.set(ADMIN_CHANNELS, [...new Set(channels)].join(","), by);
}

interface WorkspaceRole {
  isOwner: boolean;
  isAdmin: boolean;
}

const roleCache = new Map<string, WorkspaceRole>();

/**
 * Slack's own admin/owner flags. Cached — this is checked on every admin
 * action, and workspace roles change about once a year.
 */
async function workspaceRole(userId: string): Promise<WorkspaceRole> {
  const cached = roleCache.get(userId);
  if (cached) return cached;

  try {
    const { client } = await import("./slack/app.js");
    const result = await client.users.info({ user: userId });
    const role: WorkspaceRole = {
      isOwner: Boolean(result.user?.is_owner || result.user?.is_primary_owner),
      isAdmin: Boolean(result.user?.is_admin),
    };
    roleCache.set(userId, role);
    return role;
  } catch (error) {
    log.warn(`could not read the workspace role for ${userId}`, error);
    // Fail closed: an unknown role grants nothing.
    return { isOwner: false, isAdmin: false };
  }
}

export function forgetRoles(): void {
  roleCache.clear();
}

export type Decision = { ok: true } | { ok: false; reason: string };

/**
 * Whether someone may change configuration from where they are.
 *
 * Bootstrapping: with no admin list set, any Slack workspace admin or owner
 * qualifies. That way a fresh install is configurable by the people who
 * installed it, without a chicken-and-egg step, and stops being open to
 * everyone the moment the first explicit admin is named.
 */
export async function canAdmin(userId: string, channelId?: string): Promise<Decision> {
  const role = await workspaceRole(userId);

  // Owners bypass everything — the anti-lockout rule.
  if (role.isOwner) return { ok: true };

  const users = adminUsers();
  const allowed = users.length === 0 ? role.isAdmin : users.includes(userId);

  if (!allowed) {
    return {
      ok: false,
      reason:
        users.length === 0
          ? "Only Slack workspace admins can configure Relay until an admin list is set."
          : `You're not a Relay admin. ${await describeAdmins()}`,
    };
  }

  const channels = adminChannels();
  if (channels.length > 0 && channelId && !channels.includes(channelId)) {
    return {
      ok: false,
      reason: `Relay configuration is restricted to ${channels.map((id) => `<#${id}>`).join(", ")}. Run this there instead.`,
    };
  }

  return { ok: true };
}

/** Human-readable list of who to ask, used in refusals. */
export async function describeAdmins(): Promise<string> {
  const users = adminUsers();
  if (users.length === 0) return "Ask a Slack workspace admin.";
  return `Ask one of: ${users.map((id) => `<@${id}>`).join(", ")}.`;
}
