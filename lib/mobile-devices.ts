// The apps for iPhone, iPad and Android (flowplan-app). After signing in, the
// app registers its installation from inside its web view (same origin, the
// session cookie). The entry is bound to that session: signing out, ending
// the session in the settings or a deleted account removes it; the device
// token works while the session lives, and using it keeps a remembered
// session alive. Signing in again on the device moves the entry over to the
// new session (carryOverSession in lib/auth.ts).
//
// - Push: the app's Expo push token becomes a push subscription with an
//   "expo:" endpoint, so notifications reach it through the same queue,
//   preferences and session checks as Web Push (lib/push.ts).
// - Widgets and the Live Activity: a device token (fpd_…, only a hash is
//   stored) lets the app read a short summary in the background – unread
//   notifications, open tasks, the running timer. It opens nothing else.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { adminGroup, HttpError, touchSession } from "./auth";
import { cellText } from "./cell-text";
import { openTasksEverywhere } from "./doc-tasks";
import { pageLocationHash } from "./page-location";
import { pageRole } from "./permissions";
import { EXPO_ENDPOINT } from "./push";
import { hiddenRowIds } from "./row-access";
import type { Field, Identity, Page, User } from "./types";

const MAX_DEVICES = 20;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Push to the apps goes through Expo's push service (exp.host), which hands
// it to Apple and Google. MOBILE_PUSH=off switches it off for an instance.
export const mobilePushEnabled = () => !/^(0|off|false|no)$/i.test(process.env.MOBILE_PUSH || "");
const expoToken = z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/);

const registration = z.object({
  installationId: z.uuid(),
  platform: z.enum(["ios", "android"]),
  name: z.string().trim().max(80).default(""),
  appVersion: z.string().trim().max(40).default(""),
  pushToken: expoToken.nullable().optional(),
});

function requireSession(user: Identity, sessionToken: string) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  if (!one("SELECT token FROM sessions WHERE token=? AND user_id=? AND expires>?", sessionToken, user.id, Date.now()))
    throw new HttpError(401, "Sitzung abgelaufen.");
}

// Registers (or renews) this installation for the signed-in session and
// returns a fresh device token; the previous one stops working.
export function registerMobileDevice(user: Identity, sessionToken: string, input: unknown) {
  requireSession(user, sessionToken);
  const b = registration.parse(input);
  const existing = one<{ id: string; push_subscription_id: string | null }>(
    "SELECT id,push_subscription_id FROM mobile_devices WHERE user_id=? AND installation_id=?",
    user.id,
    b.installationId,
  );
  if (
    !existing &&
    Number(one<{ n: number }>("SELECT COUNT(*) n FROM mobile_devices WHERE user_id=?", user.id)?.n || 0) >= MAX_DEVICES
  )
    throw new HttpError(429, "Höchstens 20 Apps pro Konto.");
  if (existing) {
    if (existing.push_subscription_id) run("DELETE FROM push_subscriptions WHERE id=?", existing.push_subscription_id);
    run("DELETE FROM mobile_devices WHERE id=?", existing.id);
  }
  let subscription: string | null = null;
  if (b.pushToken && mobilePushEnabled()) {
    const endpoint = `${EXPO_ENDPOINT}${b.pushToken}`;
    // A phone signed in with another account before: its pushes now go here.
    run("DELETE FROM push_subscriptions WHERE endpoint=?", endpoint);
    subscription = id();
    run(
      "INSERT INTO push_subscriptions(id,user_id,session_token,endpoint,p256dh,auth) VALUES(?,?,?,?,?,?)",
      subscription,
      user.id,
      sessionToken,
      endpoint,
      "",
      "",
    );
  }
  const token = `fpd_${randomBytes(30).toString("base64url")}`;
  const now = Date.now();
  run(
    "INSERT INTO mobile_devices(id,user_id,installation_id,session_token,platform,name,app_version,token_hash,push_subscription_id,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id(),
    user.id,
    b.installationId,
    sessionToken,
    b.platform,
    b.name,
    b.appVersion,
    hashToken(token),
    subscription,
    now,
    now,
  );
  return { deviceToken: token, push: !!subscription };
}

export function unregisterMobileDevice(user: Identity, installationId: unknown) {
  const device = one<{ id: string; push_subscription_id: string | null }>(
    "SELECT id,push_subscription_id FROM mobile_devices WHERE user_id=? AND installation_id=?",
    user.id,
    z.uuid().parse(installationId),
  );
  if (device) {
    if (device.push_subscription_id) run("DELETE FROM push_subscriptions WHERE id=?", device.push_subscription_id);
    run("DELETE FROM mobile_devices WHERE id=?", device.id);
  }
  return { ok: true };
}

// The app leaves the instance (another server, "forget"): its device token
// alone removes the entry, without the web view's cookie.
export function unregisterByDeviceToken(header: string | null) {
  const match = header?.match(/^Bearer\s+(fpd_[A-Za-z0-9_-]{20,80})$/);
  if (!match) return false;
  const device = one<{ id: string; push_subscription_id: string | null }>(
    "SELECT id,push_subscription_id FROM mobile_devices WHERE token_hash=?",
    hashToken(match[1]),
  );
  if (!device) return false;
  if (device.push_subscription_id) run("DELETE FROM push_subscriptions WHERE id=?", device.push_subscription_id);
  run("DELETE FROM mobile_devices WHERE id=?", device.id);
  return true;
}

// The person behind "Authorization: Bearer fpd_…", while their session lasts.
export function identityFromDeviceToken(header: string | null): Identity | null {
  const match = header?.match(/^Bearer\s+(fpd_[A-Za-z0-9_-]{20,80})$/);
  if (!match) return null;
  const now = Date.now();
  const row = one<User & { device_id: string; last_seen_at: number; groups_json: string; session_token: string; expires: number; session_created: number | null; remember: number; sso: number; last_seen: number | null }>(
    `SELECT u.*,d.id device_id,d.last_seen_at,d.session_token,s.groups_json,s.expires,s.created_at session_created,s.remember,s.sso,s.last_seen FROM mobile_devices d
       JOIN users u ON u.id=d.user_id JOIN sessions s ON s.token=d.session_token
     WHERE d.token_hash=? AND s.expires>? AND u.disabled=0`,
    hashToken(match[1]),
    now,
  );
  if (!row) return null;
  if (now - row.last_seen_at > 60_000) run("UPDATE mobile_devices SET last_seen_at=? WHERE id=?", now, row.device_id);
  // The widgets are the app in the background: they keep its session alive
  // like the app's web view does (a remembered session slides, never beyond
  // its maximum).
  touchSession(
    { token: row.session_token, expires: row.expires, created_at: row.session_created, remember: row.remember, sso: row.sso, last_seen: row.last_seen, demo_until: row.demo_until },
    now,
  );
  let groups: string[] = [];
  try {
    groups = JSON.parse(row.groups_json);
  } catch {}
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    disabled: row.disabled,
    created_at: row.created_at,
    avatar: row.avatar,
    demo_until: row.demo_until ?? null,
    demo: !!row.demo_until,
    groups,
    // Rights stay those of the person; administration never comes along.
    isAdmin: false,
    apiScope: "read",
  };
}

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

// What the widgets and the Live Activity show. `today` is the phone's date,
// so "due today" means the person's day, not the server's.
export function mobileSummary(user: Identity, todayInput?: unknown) {
  const now = new Date();
  const today =
    day.parse(todayInput) ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const unread = Number(
    one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", user.id)?.n || 0,
  );
  const tasks = openTasksEverywhere(user).filter((t) => t.assigned || t.journal || t.due);
  const due = tasks.filter((t) => t.due && t.due <= today);
  return {
    name: user.name,
    unread,
    tasks: {
      due: due.length,
      overdue: due.filter((t) => t.due! < today).length,
      open: tasks.length,
      items: tasks.slice(0, 8).map((t) => ({
        text: t.text.slice(0, 200),
        page: (t.title || "").slice(0, 120),
        due: t.due,
        url: `/${pageLocationHash({ pageId: t.pageId, ...(t.rowId ? { rowId: t.rowId } : {}) })}`,
      })),
    },
    timer: runningTimer(user),
    today,
    at: Date.now(),
    // The person administers the instance: the app also shows the
    // administrators' widgets (GET /api/mobile/admin-summary).
    admin: !user.demo && user.groups.includes(adminGroup()),
  };
}

// The person's running timer (time tracking), if they may still see it.
function runningTimer(user: Identity) {
  const entry = one<{ page_id: string; row_id: string; start: number }>(
    "SELECT page_id,row_id,start FROM time_entries WHERE user_id=? AND end IS NULL ORDER BY start DESC LIMIT 1",
    user.id,
  );
  if (!entry) return null;
  const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", entry.page_id);
  if (!page || !pageRole(user, page) || hiddenRowIds(user, page).has(entry.row_id)) return null;
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", entry.row_id, page.id);
  if (!row) return null;
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]") as Field[];
  const cells = JSON.parse(row.cells) as Record<string, unknown>;
  return {
    start: entry.start,
    title: (fields[0] && cellText(cells[fields[0].id]).slice(0, 120)) || "",
    database: (page.title || "").slice(0, 120),
    url: `/${pageLocationHash({ pageId: page.id, rowId: entry.row_id })}`,
  };
}

// The installations of a person, for the profile settings.
export function listMobileDevices(user: Identity) {
  return all<{ installation_id: string; platform: string; name: string; app_version: string; created_at: number; last_seen_at: number; push: number }>(
    "SELECT installation_id,platform,name,app_version,created_at,last_seen_at,(push_subscription_id IS NOT NULL) push FROM mobile_devices WHERE user_id=? ORDER BY last_seen_at DESC",
    user.id,
  );
}
