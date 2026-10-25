// Focus filters of the iPhone and iPad app (iOS "Focus" → Flowplan filter):
// while a Focus with a Flowplan filter is on, the app may tell the instance
// to hold back the push notifications of the other workspaces on this
// device – or all of them, when the Focus belongs to another profile. The
// notifications stay in the inbox; only the push to this phone is left out
// (lib/push.ts asks focusSilences before sending). A Focus that is never
// switched off ends by itself after `hours` (default a day): the filter
// fails open. Only small, separate tables, so lib/push.ts can import this
// file without the rest of the mobile API.
import { createHash } from "node:crypto";
import { z } from "zod";
import { db, one, run } from "./db";
import { HttpError } from "./auth";
import { ct } from "./content-locale";
import type { Identity } from "./types";

const prepared = new WeakSet<object>();
function ensureTables() {
  const d = db();
  if (prepared.has(d)) return;
  d.exec(`CREATE TABLE IF NOT EXISTS mobile_focus(
      device_id TEXT PRIMARY KEY REFERENCES mobile_devices(id) ON DELETE CASCADE,
      workspace_id TEXT, until INTEGER NOT NULL)`);
  prepared.add(d);
}

export const focusInput = z.object({
  // null: every workspace stays quiet (the Focus belongs to another profile).
  workspaceId: z.uuid().nullable().default(null),
  hide: z.boolean().default(false),
  hours: z.number().int().min(1).max(48).default(24),
});

// The device behind "Authorization: Bearer fpd_…" (the token itself is
// checked by identityFromDeviceToken before).
function deviceOf(authorization: string | null) {
  const token = authorization?.match(/^Bearer\s+(fpd_[A-Za-z0-9_-]{20,80})$/)?.[1];
  if (!token) return null;
  return one<{ id: string; user_id: string }>(
    "SELECT id,user_id FROM mobile_devices WHERE token_hash=?",
    createHash("sha256").update(token).digest("hex"),
  );
}

export function setDeviceFocus(user: Identity, authorization: string | null, input: unknown, now = Date.now()) {
  ensureTables();
  const b = focusInput.parse(input);
  const device = deviceOf(authorization);
  if (!device || device.user_id !== user.id) throw new HttpError(401, "Bitte melde dich an.");
  if (b.workspaceId && !one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", b.workspaceId, user.id))
    throw new HttpError(404, ct("Arbeitsbereich nicht gefunden.", "Workspace not found."));
  if (!b.hide) {
    run("DELETE FROM mobile_focus WHERE device_id=?", device.id);
    return { ok: true, focus: null };
  }
  const until = now + b.hours * 3_600_000;
  run(
    "INSERT INTO mobile_focus(device_id,workspace_id,until) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET workspace_id=excluded.workspace_id,until=excluded.until",
    device.id,
    b.workspaceId,
    until,
  );
  return { ok: true, focus: { workspaceId: b.workspaceId, until } };
}

// Whether a push to this subscription is held back by the device's Focus:
// everything when the Focus is for another profile, otherwise what belongs
// to another workspace. Notifications without a page always come through.
export function focusSilences(subscriptionId: string, workspaceId: string | null | undefined, now = Date.now()) {
  ensureTables();
  const focus = one<{ workspace_id: string | null }>(
    "SELECT f.workspace_id FROM mobile_focus f JOIN mobile_devices d ON d.id=f.device_id WHERE d.push_subscription_id=? AND f.until>?",
    subscriptionId,
    now,
  );
  if (!focus) return false;
  if (!focus.workspace_id) return true;
  return !!workspaceId && workspaceId !== focus.workspace_id;
}

// Whether a Focus with a Flowplan filter is on for this app installation
// right now (for the test notification in the settings, lib/push-test.ts).
export function focusActive(deviceId: string, now = Date.now()) {
  ensureTables();
  return !!one("SELECT 1 FROM mobile_focus WHERE device_id=? AND until>?", deviceId, now);
}
