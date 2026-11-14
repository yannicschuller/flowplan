// Who is here right now (Administration → Users): the open app reports once
// a minute that it is open and how long ago someone last typed, clicked,
// scrolled or touched it (components/activity-ping.tsx) – nothing about
// what they did or where. Two times per account:
//   last_open_at    the app was open (any tab, also in the background)
//   last_active_at  someone used it
// Accounts without pings (older apps, API tokens) fall back to their
// sessions' last request.
//
// The ping also names the open workspace: someone who used it lately is
// recorded per workspace (workspace_activity, at most hourly) – what the
// inactivity message "only this workspace" (#282, lib/dead-man-switch.ts)
// counts as a sign of life.
import { all, run } from "./db";
import { HttpError } from "./auth";
import type { Identity } from "./types";
import type { UserActivity } from "./user-activity-state";

export type { UserActivity };

// Idle times beyond this are reported as this (the app may sleep longer).
const MAX_IDLE_MS = 24 * 3_600_000;
// Use of a workspace counts when it was this recent; written once an hour.
const WORKSPACE_USE_MS = 5 * 60_000;
const WORKSPACE_EVERY_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const workspaceWrites = new Map<string, number>();

// The person used this workspace at `at` (full members only, no guests).
export async function recordWorkspaceActivity(userId: string, workspaceId: string, at: number) {
  const key = `${userId}:${workspaceId}`;
  if ((workspaceWrites.get(key) ?? -Infinity) > at - WORKSPACE_EVERY_MS) return false;
  workspaceWrites.set(key, at);
  if (workspaceWrites.size > 10_000) workspaceWrites.clear();
  const result = await run(
    `INSERT INTO workspace_activity(user_id,workspace_id,at) SELECT m.user_id,m.workspace_id,? FROM members m
     WHERE m.workspace_id=? AND m.user_id=? AND NOT EXISTS(SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id)
     ON CONFLICT(user_id,workspace_id) DO UPDATE SET at=excluded.at WHERE workspace_activity.at<excluded.at`,
    at,
    workspaceId,
    userId,
  );
  return result.changes > 0;
}

export async function recordActivity(
  user: Identity,
  body: unknown,
  now = Date.now(),
) {
  // Only the signed-in app, not scripts with an API token.
  if (user.apiScope) return { ok: false };
  const idle = Number((body as { idleMs?: unknown } | null)?.idleMs);
  const activeAt =
    Number.isFinite(idle) && idle >= 0
      ? now - Math.min(idle, MAX_IDLE_MS)
      : null;
  await run(
    "UPDATE users SET last_open_at=?,last_active_at=CASE WHEN ? IS NOT NULL AND (last_active_at IS NULL OR last_active_at<?) THEN ? ELSE last_active_at END WHERE id=?",
    now,
    activeAt,
    activeAt,
    activeAt,
    user.id,
  );
  const workspaceId = (body as { workspaceId?: unknown } | null)?.workspaceId;
  if (activeAt !== null && now - activeAt <= WORKSPACE_USE_MS && typeof workspaceId === "string" && UUID.test(workspaceId))
    await recordWorkspaceActivity(user.id, workspaceId, activeAt);
  return { ok: true };
}

export async function userActivity(admin: Identity): Promise<UserActivity[]> {
  if (!admin.isAdmin)
    throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  return (await all<{
    id: string;
    open_at: number | null;
    active_at: number | null;
    seen: number | null;
  }>(
    "SELECT u.id,u.last_open_at open_at,u.last_active_at active_at,(SELECT max(s.last_seen) FROM sessions s WHERE s.user_id=u.id) seen FROM users u WHERE u.demo_until IS NULL",
  )).map((r) => ({
    id: r.id,
    openAt: r.open_at,
    activeAt: r.active_at ?? r.seen,
  }));
}
