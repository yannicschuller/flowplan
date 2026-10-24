// The apps for iPhone, iPad and Android (flowplan-app). After signing in, the
// app registers its installation from inside its web view (same origin, the
// session cookie). The entry is bound to that session: signing out, ending
// the session in the settings or a deleted account removes it; the device
// token works while the session lives, and using it keeps a remembered
// session alive. Signing in again on the device moves the entry over to the
// new session (carryOverSession in lib/auth.ts).
//
// - Push: the app's push registration becomes a push subscription, so
//   notifications reach it through the same queue, preferences and session
//   checks as Web Push (lib/push.ts). Apps since the push relay send a relay
//   token and their X25519 public key (lib/push-relay.ts): notifications go
//   end-to-end encrypted through the relay. Older apps send an Expo push
//   token only ("expo:" endpoint) and keep getting push through Expo; an app
//   that sends both gets the relay, and Expo again if the relay refuses it.
// - Widgets and the Live Activity: a device token (fpd_…, only a hash is
//   stored) lets the app read a short summary in the background – unread
//   notifications, open tasks, the running timer. It opens nothing else.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { adminGroup, HttpError, touchSession } from "./auth";
import { cellText } from "./cell-text";
import { openTasksEverywhere } from "./doc-tasks";
import { sortTasks } from "./task-order";
import { pageLocationHash } from "./page-location";
import { pageRole } from "./permissions";
import { EXPO_ENDPOINT, RELAY_ENDPOINT } from "./push";
import { openSecret, sealSecret } from "./secret-box";
import { liveTokenAad, relayConfig, relayTokenAad, relayTokenSchema, strictOrigin, validDeviceKey } from "./push-relay";
import { hiddenRowIds } from "./row-access";
import type { Field, Identity, Page, User } from "./types";

const MAX_DEVICES = 20;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Push to the apps goes through Expo's push service (exp.host), which hands
// it to Apple and Google. MOBILE_PUSH=off switches it off for an instance.
export const mobilePushEnabled = () => !/^(0|off|false|no)$/i.test(process.env.MOBILE_PUSH || "");
const expoToken = z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/);

// The Live Activities whose state the instance changes itself and pushes
// (lib/live-activity-push.ts).
export const LIVE_ACTIVITY_KINDS = ["focus", "timer"] as const;
export type LiveActivityKind = (typeof LIVE_ACTIVITY_KINDS)[number];
const liveTokens = z
  .object({ focus: relayTokenSchema.nullable().optional(), timer: relayTokenSchema.nullable().optional() })
  .strict();

// Version 1 (older apps): installationId, platform, name, appVersion,
// pushToken. Version 2 adds relayToken + publicKey (both or neither),
// relayUrl and liveActivityRelayTokens; everything else is ignored as before.
const registration = z
  .object({
    installationId: z.uuid(),
    platform: z.enum(["ios", "android"]),
    name: z.string().trim().max(80).default(""),
    appVersion: z.string().trim().max(40).default(""),
    pushToken: expoToken.nullable().optional(),
    relayToken: relayTokenSchema.nullable().optional(),
    // The relay the token is from; must be this instance's relay (else the
    // relay part is left out and the answer names the right one).
    relayUrl: z.string().max(300).nullable().optional(),
    // base64url of the 32-byte X25519 public key, without padding.
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable().optional(),
    liveActivityRelayTokens: liveTokens.nullable().optional(),
  })
  .refine((b) => !b.relayToken === !b.publicKey, { message: "relayToken and publicKey belong together" });

const relayAad = relayTokenAad,
  liveAad = liveTokenAad;
export const openRelayToken = (deviceId: string, sealed: string) => openSecret(sealed, relayAad(deviceId));
export const openLiveToken = (deviceId: string, kind: LiveActivityKind, sealed: string) => openSecret(sealed, liveAad(deviceId, kind));

// What the app needs to register with the relay: which relay, and the
// instance origin it signs as (the "instance" of the relay registration).
export function pushRelayInfo() {
  const config = relayConfig();
  if (!mobilePushEnabled() || !config.enabled) return null;
  return { version: 1 as const, url: config.relay, instance: config.instance };
}

function storeLiveToken(deviceId: string, kind: LiveActivityKind, token: string | null) {
  run("DELETE FROM mobile_live_activities WHERE device_id=? AND kind=?", deviceId, kind);
  if (!token) return;
  const tokenHash = hashToken(token);
  // An activity token belongs to one installation (another account on the phone before).
  run("DELETE FROM mobile_live_activities WHERE token_hash=?", tokenHash);
  run(
    "INSERT INTO mobile_live_activities(device_id,kind,relay_token,token_hash,created_at) VALUES(?,?,?,?,?)",
    deviceId,
    kind,
    sealSecret(token, liveAad(deviceId, kind)),
    tokenHash,
    Date.now(),
  );
}
const liveKinds = (deviceId: string) =>
  all<{ kind: LiveActivityKind }>("SELECT kind FROM mobile_live_activities WHERE device_id=? ORDER BY kind", deviceId).map((r) => r.kind);

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
  if (b.publicKey && !validDeviceKey(b.publicKey)) throw new HttpError(400, "Ungültiger Push-Schlüssel.");
  const relay = pushRelayInfo();
  // The relay part counts only for this instance's relay.
  const relayMatches = !!relay && (!b.relayUrl || strictOrigin(b.relayUrl) === relay.url);
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
  const deviceId = id();
  const withRelay = relayMatches && !!b.relayToken && !!b.publicKey;
  let subscription: string | null = null;
  if ((b.pushToken || withRelay) && mobilePushEnabled()) {
    // Expo stays the fallback when the relay refuses the device (lib/push.ts).
    const endpoint = b.pushToken ? `${EXPO_ENDPOINT}${b.pushToken}` : `${RELAY_ENDPOINT}${deviceId}`;
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
    deviceId,
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
  if (withRelay && subscription) {
    const relayHash = hashToken(b.relayToken!);
    // A phone signed in with another account before: its pushes now go here.
    run("DELETE FROM mobile_push_relay WHERE token_hash=?", relayHash);
    run(
      "INSERT INTO mobile_push_relay(device_id,relay_token,token_hash,public_key,created_at) VALUES(?,?,?,?,?)",
      deviceId,
      sealSecret(b.relayToken!, relayAad(deviceId)),
      relayHash,
      b.publicKey!,
      now,
    );
  }
  // Live Activities need no notification permission, only the relay.
  if (relayMatches && b.liveActivityRelayTokens)
    for (const kind of LIVE_ACTIVITY_KINDS) {
      const value = b.liveActivityRelayTokens[kind];
      if (value) storeLiveToken(deviceId, kind, value);
    }
  return {
    deviceToken: token,
    push: !!subscription,
    // Whether notifications go through the relay, end-to-end encrypted.
    relay: withRelay && !!subscription,
    liveActivities: liveKinds(deviceId),
  };
}

// A Live Activity started (or ended) on the phone after the registration:
// its relay token (platform "ios-liveactivity" at the relay), or null.
const liveInput = z.object({ kind: z.enum(LIVE_ACTIVITY_KINDS), relayToken: relayTokenSchema.nullable(), relayUrl: z.string().max(300).nullable().optional() }).strict();
export function setLiveActivityToken(authorization: string | null, input: unknown) {
  const match = authorization?.match(/^Bearer\s+(fpd_[A-Za-z0-9_-]{20,80})$/);
  const device = match
    ? one<{ id: string }>(
        "SELECT d.id FROM mobile_devices d JOIN sessions s ON s.token=d.session_token JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND s.expires>? AND u.disabled=0",
        hashToken(match[1]),
        Date.now(),
      )
    : undefined;
  if (!device) throw new HttpError(401, "Bitte melde dich an.");
  const b = liveInput.parse(input);
  const relay = pushRelayInfo();
  if (b.relayToken && (!relay || (b.relayUrl && strictOrigin(b.relayUrl) !== relay.url))) return { ok: false, liveActivities: liveKinds(device.id), pushRelay: relay };
  storeLiveToken(device.id, b.kind, b.relayToken);
  return { ok: true, liveActivities: liveKinds(device.id), pushRelay: relay };
}

// The person behind a device, with the rights of its session, for work in
// the background (Live Activity pushes); null once the session ended.
export function deviceIdentity(deviceId: string): Identity | null {
  const row = one<User & { groups_json: string }>(
    `SELECT u.*,s.groups_json FROM mobile_devices d JOIN users u ON u.id=d.user_id JOIN sessions s ON s.token=d.session_token
     WHERE d.id=? AND s.expires>? AND u.disabled=0`,
    deviceId,
    Date.now(),
  );
  if (!row) return null;
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
    isAdmin: false,
    apiScope: "read",
  };
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
  // Overdue, today, upcoming, undated – as in the "Tasks" widget.
  const tasks = sortTasks(
    openTasksEverywhere(user)
      .filter((t) => t.assigned || t.journal || t.due)
      .map((t) => ({ ...t, page: t.title })),
    today,
  );
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
  return all<{ installation_id: string; platform: string; name: string; app_version: string; created_at: number; last_seen_at: number; push: number; relay: number }>(
    "SELECT installation_id,platform,name,app_version,created_at,last_seen_at,(push_subscription_id IS NOT NULL) push,EXISTS(SELECT 1 FROM mobile_push_relay r WHERE r.device_id=mobile_devices.id) relay FROM mobile_devices WHERE user_id=? ORDER BY last_seen_at DESC",
    user.id,
  );
}
