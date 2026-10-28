// Who is here right now (Administration → Users): the open app reports once
// a minute that it is open and how long ago someone last typed, clicked,
// scrolled or touched it (components/activity-ping.tsx) – nothing about
// what they did or where. Two times per account:
//   last_open_at    the app was open (any tab, also in the background)
//   last_active_at  someone used it
// Accounts without pings (older apps, API tokens) fall back to their
// sessions' last request.
import { all, run } from "./db";
import { HttpError } from "./auth";
import type { Identity } from "./types";
import type { UserActivity } from "./user-activity-state";

export type { UserActivity };

// Idle times beyond this are reported as this (the app may sleep longer).
const MAX_IDLE_MS = 24 * 3_600_000;

export function recordActivity(
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
  run(
    "UPDATE users SET last_open_at=?,last_active_at=CASE WHEN ? IS NOT NULL AND (last_active_at IS NULL OR last_active_at<?) THEN ? ELSE last_active_at END WHERE id=?",
    now,
    activeAt,
    activeAt,
    activeAt,
    user.id,
  );
  return { ok: true };
}

export function userActivity(admin: Identity): UserActivity[] {
  if (!admin.isAdmin)
    throw new HttpError(403, "Administrator-Gruppe erforderlich.");
  return all<{
    id: string;
    open_at: number | null;
    active_at: number | null;
    seen: number | null;
  }>(
    "SELECT u.id,u.last_open_at open_at,u.last_active_at active_at,(SELECT max(s.last_seen) FROM sessions s WHERE s.user_id=u.id) seen FROM users u WHERE u.demo_until IS NULL",
  ).map((r) => ({
    id: r.id,
    openAt: r.open_at,
    activeAt: r.active_at ?? r.seen,
  }));
}
