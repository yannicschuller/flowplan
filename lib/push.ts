import { notificationUrl } from "./page-location";
import webpush from "web-push";
import { createECDH } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { all, one, run, id } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import type { Identity, Page } from "./types";
import { userLocale } from "./user-locale";
import { localizedMessage } from "./i18n-errors";
import { translate } from "./i18n";
import { focusSilences } from "./mobile-focus";
import { openSecret } from "./secret-box";
import { notePushResult, type PushResult } from "./metrics";
import { NOTIFICATION_CATEGORIES, notificationCategory, type NotificationCategory } from "./notification-targets";
import { encryptForDevice, plaintextJson, pushContent, relayConfig, relayTokenAad, sendBatched, sendToRelay, type RelayCategory, type RelayMessage, type RelayResult, type RelaySender } from "./push-relay";
const runtime = globalThis as unknown as {
  flowplanPushTimer?: ReturnType<typeof setInterval>;
  flowplanPushRun?: Promise<void>;
};
export function pushKeys() {
  if (process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY)
    return {
      publicKey: process.env.WEB_PUSH_PUBLIC_KEY,
      privateKey: process.env.WEB_PUSH_PRIVATE_KEY,
    };
  const dir = resolve(
      /* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data",
    ),
    path = resolve(dir, "web-push-keys.json");
  mkdirSync(dir, { recursive: true });
  try {
    return JSON.parse(readFileSync(path, "utf8")) as {
      publicKey: string;
      privateKey: string;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const keys = webpush.generateVAPIDKeys();
    try {
      writeFileSync(path, JSON.stringify(keys), { flag: "wx", mode: 0o600 });
      return keys;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return JSON.parse(readFileSync(path, "utf8")) as typeof keys;
    }
  }
}
export function validatePushSubscription(input: unknown) {
  const subscription = z
    .object({
      endpoint: z.string().url().max(2048),
      keys: z.object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}={0,2}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}={0,2}$/),
      }),
    })
    .parse(input);
  const url = new URL(subscription.endpoint);
  const allowed = [
    "web.push.apple.com",
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !(
      allowed.includes(url.hostname) ||
      url.hostname.endsWith(".notify.windows.com")
    )
  )
    throw new HttpError(400, "Unbekannter Push-Dienst.");
  try {
    const curve = createECDH("prime256v1");
    curve.generateKeys();
    curve.computeSecret(Buffer.from(subscription.keys.p256dh, "base64url"));
  } catch {
    throw new HttpError(400, "Ungültiger Push-Schlüssel.");
  }
  return subscription;
}
export function subscribePush(
  user: Identity,
  sessionToken: string,
  input: unknown,
) {
  if (
    !one(
      "SELECT token FROM sessions WHERE token=? AND user_id=? AND expires>?",
      sessionToken,
      user.id,
      Date.now(),
    )
  )
    throw new HttpError(401, "Sitzung abgelaufen.");
  const sub = validatePushSubscription(input);
  const existing = one<{ id: string; p256dh: string; auth: string }>(
    "SELECT * FROM push_subscriptions WHERE endpoint=?",
    sub.endpoint,
  );
  if (
    existing &&
    (existing.p256dh !== sub.keys.p256dh || existing.auth !== sub.keys.auth)
  )
    throw new HttpError(409, "Push-Abonnement stimmt nicht überein.");
  if (
    !existing &&
    Number(
      one<{ count: number }>(
        "SELECT count(*) count FROM push_subscriptions WHERE user_id=?",
        user.id,
      )!.count,
    ) >= 20
  )
    throw new HttpError(429, "Höchstens 20 Push-Geräte pro Konto.");
  // Rebinding a browser after login discards deliveries addressed to its previous session.
  if (existing) run("DELETE FROM push_subscriptions WHERE id=?", existing.id);
  run(
    "INSERT INTO push_subscriptions(id,user_id,session_token,endpoint,p256dh,auth) VALUES(?,?,?,?,?,?)",
    id(),
    user.id,
    sessionToken,
    sub.endpoint,
    sub.keys.p256dh,
    sub.keys.auth,
  );
  return { ok: true };
}
export function unsubscribePush(user: Identity, endpoint: unknown) {
  run(
    "DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?",
    user.id,
    z.string().max(2048).parse(endpoint),
  );
  return { ok: true };
}
type Sender = (
  sub: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;
// Push subscriptions of the apps (lib/mobile-devices.ts) carry the Expo push
// token behind this prefix instead of a Web Push endpoint.
export const EXPO_ENDPOINT = "expo:";
// Apps that registered only with the push relay (no Expo token): the
// endpoint names the device; the relay token itself is stored sealed in
// mobile_push_relay (lib/mobile-devices.ts).
export const RELAY_ENDPOINT = "relay:";
const isMobile = (endpoint: string) => endpoint.startsWith(EXPO_ENDPOINT) || endpoint.startsWith(RELAY_ENDPOINT);
const RELAY_CATEGORY: Record<NotificationCategory, RelayCategory> = {
  [NOTIFICATION_CATEGORIES.task]: "task",
  [NOTIFICATION_CATEGORIES.comment]: "comment",
  [NOTIFICATION_CATEGORIES.read]: "default",
};
// The general text of a push notification, in the person's language.
function inboxNotice(userId: string) {
  const say = translate(userLocale(userId));
  return say("Du hast eine neue Benachrichtigung im Posteingang.", "You have a new notification in your inbox.");
}
// One message to the apps through Expo's push service (lib/mobile-devices.ts).
export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  // notificationId: for the buttons (lib/notification-actions.ts).
  data: { url: string; notificationId?: string };
  // The buttons the notification shows (lib/notification-targets.ts).
  categoryId?: NotificationCategory;
  sound: "default";
  badge: number;
  channelId: string;
  ttl: number;
  priority: "high";
};
type ExpoSender = (message: ExpoMessage) => Promise<unknown>;
export class PushGoneError extends Error {
  statusCode = 410;
}
export async function sendExpoPush(message: ExpoMessage) {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(5000),
  });
  const result = (await response.json().catch(() => ({}))) as {
    data?: { status?: string; details?: { error?: string } };
  };
  if (result.data?.details?.error === "DeviceNotRegistered") throw new PushGoneError("DeviceNotRegistered");
  if (!response.ok || result.data?.status !== "ok")
    throw Object.assign(new Error(result.data?.details?.error || "Expo push failed"), { statusCode: response.status || 502 });
}
function webPushOptions(keys: { publicKey: string; privateKey: string }): webpush.RequestOptions {
  return {
    vapidDetails: {
      ...keys,
      subject: process.env.WEB_PUSH_SUBJECT || process.env.APP_URL || "https://flowplan.example.com",
    },
    TTL: 86400,
    timeout: 5000,
    contentEncoding: "aes128gcm",
    urgency: "normal",
  };
}
const unreadCount = (userId: string) =>
  Number(one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", userId)?.n || 0);
const backoff = (attempts: number) => Math.min(600000, 30000 * 2 ** attempts);
// Counts a Web Push or Expo answer for the push status (lib/metrics.ts):
// ok, or the failure by HTTP status (404/410 gone, 403 forbidden, 429
// rate limited) with the status or Expo's error name as its code.
function countPush(channel: "web" | "expo", error?: unknown) {
  try {
    if (error === undefined) return notePushResult(channel, "ok");
    const status = Number((error as { statusCode?: number })?.statusCode || 0);
    const result: PushResult =
      error instanceof PushGoneError || status === 404 || status === 410 ? "gone" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : "error";
    const name = channel === "expo" ? expoErrorName(error) : null;
    notePushResult(channel, result, name || (status ? `HTTP ${status}` : "unreachable"));
  } catch {}
}

export async function flushPushQueue(
  send: Sender = webpush.sendNotification,
  sendExpo: ExpoSender = sendExpoPush,
  sendRelay: RelaySender = sendToRelay,
) {
  const now = Date.now();
  run(
    "DELETE FROM push_subscriptions WHERE session_token IN (SELECT token FROM sessions WHERE expires<=?) OR user_id IN (SELECT id FROM users WHERE disabled=1)",
    now,
  );
  run(
    "DELETE FROM push_deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE created_at<datetime('now','-7 days'))",
  );
  const jobs = all<{
    id: number;
    subscription_id: string;
    notification_id: string;
    attempts: number;
    user_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    page_id: string | null;
    row_id: string | null;
    thread_id: string | null;
    read_at: string | null;
    body: string | null;
    kind: string | null;
    link: string | null;
    device_id: string | null;
    relay_token: string | null;
    public_key: string | null;
  }>(
    "SELECT d.id,d.subscription_id,d.notification_id,d.attempts,s.user_id,s.endpoint,s.p256dh,s.auth,n.page_id,n.row_id,n.thread_id,n.read_at,n.body,n.kind,n.link,md.id device_id,r.relay_token,r.public_key FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id JOIN notifications n ON n.id=d.notification_id LEFT JOIN mobile_devices md ON md.push_subscription_id=s.id LEFT JOIN mobile_push_relay r ON r.device_id=md.id WHERE d.delivered_at IS NULL AND d.attempts<5 AND d.available_at<=? ORDER BY d.id LIMIT 20",
    now,
  );
  const relay = relayConfig();
  // Test notifications from the settings (lib/push-test.ts) go first.
  await flushPushTests(send, sendExpo, sendRelay, relay);
  // Live Activities (lib/live-activity-push.ts) – loaded only when some exist.
  const live = relay.enabled && !!one("SELECT 1 FROM push_live_queue WHERE available_at<=? LIMIT 1", now);
  if (!jobs.length) {
    if (live) await (await import("./live-activity-push")).flushLiveActivities(sendRelay, now);
    return;
  }
  const keys = pushKeys();
  // Notifications for the relay, sent together after the loop (≤ 100 per request).
  const viaRelay: { job: (typeof jobs)[number]; message: RelayMessage }[] = [];
  await Promise.all(
    jobs.map(async (job) => {
      if (
        !run(
          "UPDATE push_deliveries SET available_at=?,attempts=attempts+1 WHERE id=? AND available_at<=? AND delivered_at IS NULL",
          now + 60000,
          job.id,
          now,
        ).changes
      )
        return;
      const page = job.page_id
        ? one<Page>("SELECT * FROM pages WHERE id=?", job.page_id)
        : undefined;
      if (
        job.read_at ||
        (job.row_id &&
          !one(
            "SELECT id FROM rows WHERE id=? AND page_id=?",
            job.row_id,
            job.page_id,
          )) ||
        (job.thread_id &&
          !one(
            "SELECT id FROM inline_threads WHERE id=? AND page_id=? AND row_id IS ?",
            job.thread_id,
            job.page_id,
            job.row_id,
          )) ||
        (job.page_id &&
          (!page ||
            page.deleted_at ||
            !pageRole({ id: job.user_id } as Identity, page)))
      ) {
        run("DELETE FROM push_deliveries WHERE id=?", job.id);
        return;
      }
      // A Focus filter of the app holds other workspaces back (lib/mobile-focus.ts).
      if (isMobile(job.endpoint) && focusSilences(job.subscription_id, page?.workspace_id, now)) {
        run("DELETE FROM push_deliveries WHERE id=?", job.id);
        return;
      }
      // The app registered with the relay: end-to-end encrypted through it.
      if (relay.enabled && job.device_id && job.relay_token && job.public_key) {
        try {
          viaRelay.push({ job, message: relayAlert(job, relay.instance) });
        } catch {
          // The sealed token or the key does not open any more: the relay part goes.
          dropRelay(job);
        }
        return;
      }
      // Registered with the relay only, which is off now (PUSH_RELAY=off) or
      // refused the device: nothing can reach it.
      if (job.endpoint.startsWith(RELAY_ENDPOINT)) {
        if (!job.relay_token) run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
        else run("DELETE FROM push_deliveries WHERE id=?", job.id);
        return;
      }
      try {
        if (job.endpoint.startsWith(EXPO_ENDPOINT)) {
          // Older apps through Expo: the badge shows the unread notifications.
          // The text stays as general as Web Push unless the instance opts in
          // (MOBILE_PUSH_CONTENT=on), because it passes Expo, Apple and Google
          // in plain text.
          const content = pushContent("expo"),
            locale = userLocale(job.user_id),
            unread = unreadCount(job.user_id);
          await sendExpo({
            to: job.endpoint.slice(EXPO_ENDPOINT.length),
            title: "Flowplan",
            body: content && job.body ? localizedMessage(job.body, locale).slice(0, 300) : inboxNotice(job.user_id),
            data: { url: notificationUrl(job), notificationId: job.notification_id },
            categoryId: notificationCategory({ ...job, id: job.notification_id }, content),
            sound: "default",
            badge: unread,
            channelId: "inbox",
            ttl: 86400,
            priority: "high",
          });
          countPush("expo");
          run(
            "UPDATE push_deliveries SET delivered_at=?,last_error=NULL WHERE id=?",
            Date.now(),
            job.id,
          );
          return;
        }
        validatePushSubscription({
          endpoint: job.endpoint,
          keys: { p256dh: job.p256dh, auth: job.auth },
        });
        await send(
          {
            endpoint: job.endpoint,
            keys: { p256dh: job.p256dh, auth: job.auth },
          },
          JSON.stringify({
            title: "Flowplan",
            body: inboxNotice(job.user_id),
            url: notificationUrl(job),
            tag: `flowplan-${job.notification_id}`,
          }),
          webPushOptions(keys),
        );
        countPush("web");
        run(
          "UPDATE push_deliveries SET delivered_at=?,last_error=NULL WHERE id=?",
          Date.now(),
          job.id,
        );
      } catch (error) {
        countPush(job.endpoint.startsWith(EXPO_ENDPOINT) ? "expo" : "web", error);
        const status = Number(
          (error as { statusCode?: number }).statusCode || 0,
        );
        if (status === 404 || status === 410)
          run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
        else
          run(
            "UPDATE push_deliveries SET available_at=?,last_error=? WHERE id=?",
            Date.now() + backoff(job.attempts),
            status ? `HTTP ${status}` : "Senden fehlgeschlagen",
            job.id,
          );
      }
    }),
  );
  if (viaRelay.length) {
    const results = await sendBatched(
      viaRelay.map((r) => r.message),
      sendRelay,
    );
    viaRelay.forEach(({ job }, i) => relayOutcome(job, results[i]));
  }
  if (live) await (await import("./live-activity-push")).flushLiveActivities(sendRelay, Date.now());
}

type RelayJob = {
  id: number;
  subscription_id: string;
  notification_id: string;
  attempts: number;
  user_id: string;
  endpoint: string;
  page_id: string | null;
  row_id: string | null;
  thread_id: string | null;
  body: string | null;
  kind: string | null;
  link: string | null;
  device_id: string | null;
  relay_token: string | null;
  public_key: string | null;
};

// One notification as an encrypted alert (PROTOCOL.md §3, §4). The text
// comes along unless MOBILE_PUSH_CONTENT=off: only the app can read it.
function relayAlert(job: RelayJob, instance: string): RelayMessage {
  const content = pushContent("relay"),
    locale = userLocale(job.user_id),
    category = notificationCategory({ ...job, id: job.notification_id }, content);
  const token = openSecret(job.relay_token!, relayTokenAad(job.device_id!));
  const plaintext = plaintextJson({
    title: "Flowplan",
    body: content && job.body ? localizedMessage(job.body, locale).slice(0, 300) : inboxNotice(job.user_id),
    url: new URL(notificationUrl(job), `${instance}/`).toString(),
    id: job.notification_id,
    category,
    data: job.kind ? { kind: job.kind } : null,
    sentAt: Math.floor(Date.now() / 1000),
  });
  return {
    to: token,
    type: "alert",
    payload: encryptForDevice(job.public_key!, instance, plaintext),
    category: RELAY_CATEGORY[category],
    collapseId: null,
    badge: Math.min(9999, unreadCount(job.user_id)),
    priority: "high",
    ttl: 86400,
    liveActivity: null,
  };
}

// The relay refused the device (forbidden, invalid) or its token cannot be
// opened: its relay part goes; with an Expo token the delivery is tried
// again through Expo right away, otherwise the subscription goes.
function dropRelay(job: RelayJob, status = "unreadable") {
  if (dropRelayPart(job, status))
    run("UPDATE push_deliveries SET available_at=?,attempts=MAX(0,attempts-1) WHERE id=?", Date.now(), job.id);
}
// The relay part of an installation goes; true when an Expo token remains.
function dropRelayPart(job: { device_id: string | null; endpoint: string; subscription_id: string }, status: string) {
  console.warn(`push relay: removed the relay registration of an app installation (${status})`);
  run("DELETE FROM mobile_push_relay WHERE device_id=?", job.device_id);
  if (job.endpoint.startsWith(EXPO_ENDPOINT)) return true;
  run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
  return false;
}

function relayOutcome(job: RelayJob, result: RelayResult) {
  switch (result.status) {
    case "ok":
      run("UPDATE push_deliveries SET delivered_at=?,last_error=NULL WHERE id=?", Date.now(), job.id);
      return;
    case "gone":
      // The app is no longer reachable (uninstalled, token revoked): the
      // installation goes with its push subscription.
      run("DELETE FROM mobile_devices WHERE id=?", job.device_id);
      run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
      return;
    case "rate_limited":
      // Not a failed attempt: again once the relay allows it.
      run(
        "UPDATE push_deliveries SET available_at=?,attempts=MAX(0,attempts-1),last_error=? WHERE id=?",
        Date.now() + (result.retryAfter ?? 60) * 1000,
        "Relay: rate_limited",
        job.id,
      );
      return;
    case "forbidden":
    case "invalid":
      dropRelay(job, result.status);
      return;
    default:
      run("UPDATE push_deliveries SET available_at=?,last_error=? WHERE id=?", Date.now() + backoff(job.attempts), "Relay: error", job.id);
  }
}
// ---- Test notifications (lib/push-test.ts) ----
// Where a tapped test notification leads: the push part of the settings.
export const PUSH_TEST_URL = "/#settings/notifications/push";
export function pushTestText(userId: string) {
  const say = translate(userLocale(userId));
  return say("Testbenachrichtigung – alles funktioniert.", "Test notification – everything works.");
}
type TestJob = {
  id: string;
  user_id: string;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string | null;
  relay_token: string | null;
  public_key: string | null;
};
// The outcome of one target, as lib/push-test.ts reads it: never a token,
// key or address – only codes, an HTTP status or Expo's error name.
function testResult(job: TestJob, status: string, channel: string | null, detail: string | null = null, note: string | null = null) {
  run("UPDATE push_tests SET status=?,channel=?,detail=?,note=COALESCE(?,note) WHERE id=?", status, channel, detail, note, job.id);
}
const expoErrorName = (error: unknown) => {
  const message = (error as Error)?.message || "";
  return /^[A-Za-z]{1,40}$/.test(message) ? message : null;
};
async function testViaExpo(job: TestJob, sendExpo: ExpoSender, note: string | null) {
  try {
    await sendExpo({
      to: job.endpoint.slice(EXPO_ENDPOINT.length),
      title: "Flowplan",
      body: pushTestText(job.user_id),
      data: { url: PUSH_TEST_URL },
      sound: "default",
      badge: unreadCount(job.user_id),
      channelId: "inbox",
      ttl: 600,
      priority: "high",
    });
    countPush("expo");
    testResult(job, "delivered", "expo", null, note);
  } catch (error) {
    countPush("expo", error);
    if (error instanceof PushGoneError || Number((error as { statusCode?: number }).statusCode) === 410) {
      // As for every notification: the app is not reachable through Expo any more.
      run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
      testResult(job, "expo-gone", "expo", null, note);
    } else testResult(job, "expo-error", "expo", expoErrorName(error), note);
  }
}
// Sends the pending test notifications right away, through the same
// channels and with the same consequences as flushPushQueue (a gone
// subscription goes, a refused relay registration falls back to Expo), but
// once: the outcome is reported, not retried. Notification settings, quiet
// hours and Focus filters of the instance do not hold a test back; the
// device's own permission and Focus still do.
async function flushPushTests(send: Sender, sendExpo: ExpoSender, sendRelay: RelaySender, relay: ReturnType<typeof relayConfig>) {
  run("DELETE FROM push_tests WHERE created_at<?", Date.now() - 3_600_000);
  const tests = all<TestJob>(
    "SELECT t.id,t.user_id,t.subscription_id,s.endpoint,s.p256dh,s.auth,md.id device_id,r.relay_token,r.public_key FROM push_tests t JOIN push_subscriptions s ON s.id=t.subscription_id AND s.user_id=t.user_id LEFT JOIN mobile_devices md ON md.push_subscription_id=s.id LEFT JOIN mobile_push_relay r ON r.device_id=md.id WHERE t.status IS NULL ORDER BY t.created_at LIMIT 50",
  );
  if (!tests.length) return;
  const viaRelay: { job: TestJob; message: RelayMessage }[] = [];
  let keys: ReturnType<typeof pushKeys> | undefined;
  await Promise.all(
    tests.map(async (job) => {
      if (!run("UPDATE push_tests SET status='sending' WHERE id=? AND status IS NULL", job.id).changes) return;
      if (relay.enabled && job.device_id && job.relay_token && job.public_key) {
        try {
          const token = openSecret(job.relay_token, relayTokenAad(job.device_id));
          const plaintext = plaintextJson({
            title: "Flowplan",
            body: pushTestText(job.user_id),
            url: new URL(PUSH_TEST_URL, `${relay.instance}/`).toString(),
            id: `test-${job.id}`,
            category: null,
            data: { kind: "test" },
            sentAt: Math.floor(Date.now() / 1000),
          });
          viaRelay.push({
            job,
            message: {
              to: token,
              type: "alert",
              payload: encryptForDevice(job.public_key, relay.instance, plaintext),
              category: "default",
              collapseId: null,
              badge: Math.min(9999, unreadCount(job.user_id)),
              priority: "high",
              ttl: 600,
              liveActivity: null,
            },
          });
        } catch {
          if (dropRelayPart(job, "unreadable")) await testViaExpo(job, sendExpo, "relay-registration");
          else testResult(job, "relay-registration", "relay", "unreadable");
        }
        return;
      }
      if (job.endpoint.startsWith(RELAY_ENDPOINT)) {
        // Registered with the relay only, which is off (or never got a token).
        testResult(job, relay.enabled ? "relay-registration" : "relay-off", "relay", relay.enabled ? "missing" : relay.reason);
        return;
      }
      if (job.endpoint.startsWith(EXPO_ENDPOINT)) {
        await testViaExpo(job, sendExpo, job.relay_token && !relay.enabled ? "relay-off" : null);
        return;
      }
      try {
        validatePushSubscription({ endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } });
        keys ??= pushKeys();
        await send(
          { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
          JSON.stringify({ title: "Flowplan", body: pushTestText(job.user_id), url: PUSH_TEST_URL, tag: "flowplan-test" }),
          { ...webPushOptions(keys), TTL: 600 },
        );
        countPush("web");
        testResult(job, "delivered", "web");
      } catch (error) {
        countPush("web", error);
        const status = Number((error as { statusCode?: number }).statusCode || 0);
        if (status === 404 || status === 410) {
          run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
          testResult(job, "web-gone", "web", `HTTP ${status}`);
        } else if (status) testResult(job, "web-error", "web", `HTTP ${status}`);
        else testResult(job, "web-unreachable", "web");
      }
    }),
  );
  if (!viaRelay.length) return;
  const results = await sendBatched(
    viaRelay.map((r) => r.message),
    sendRelay,
  );
  await Promise.all(
    viaRelay.map(async ({ job }, i) => {
      const result = results[i];
      switch (result.status) {
        case "ok":
          testResult(job, "delivered", "relay");
          return;
        case "gone":
          // As for every notification: the installation goes.
          run("DELETE FROM mobile_devices WHERE id=?", job.device_id);
          run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
          testResult(job, "relay-registration", "relay", "gone");
          return;
        case "forbidden":
        case "invalid":
          if (dropRelayPart(job, result.status)) await testViaExpo(job, sendExpo, "relay-registration");
          else testResult(job, "relay-registration", "relay", result.status);
          return;
        case "rate_limited":
          testResult(job, "relay-rate-limited", "relay", result.retryAfter ? String(result.retryAfter) : null);
          return;
        default: {
          const reason = result.reason ?? "unreachable";
          const status =
            reason === "signature" ? "relay-signature" : reason === "blocked" ? "relay-blocked" : reason === "upstream" ? "relay-upstream" : reason === "rejected" ? "relay-rejected" : reason === "response" ? "relay-unexpected" : reason === "off" ? "relay-off" : "relay-unreachable";
          testResult(job, status, "relay", result.httpStatus ? `HTTP ${result.httpStatus}` : null);
        }
      }
    }),
  );
}
export function dispatchPush() {
  // Chat apps (lib/messengers.ts) are queued by the same notifications:
  // sent right away too, not only by their worker's next round.
  void import("./messengers").then((m) => m.dispatchMessengers()).catch(() => {});
  if (!runtime.flowplanPushRun)
    runtime.flowplanPushRun = flushPushQueue()
      .catch(() => {})
      .finally(() => {
        runtime.flowplanPushRun = undefined;
      });
  return runtime.flowplanPushRun;
}
export function startPushWorker() {
  if (runtime.flowplanPushTimer) return;
  runtime.flowplanPushTimer = setInterval(() => {
    void dispatchPush();
  }, 30000);
  runtime.flowplanPushTimer.unref();
  void dispatchPush();
}
