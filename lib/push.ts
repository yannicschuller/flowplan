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
export function testPush(user: Identity, sessionToken: string) {
  if (
    !one(
      "SELECT id FROM push_subscriptions WHERE user_id=? AND session_token=?",
      user.id,
      sessionToken,
    )
  )
    throw new HttpError(400, "Push zuerst aktivieren.");
  if (
    one(
      "SELECT id FROM notifications WHERE user_id=? AND body=? AND created_at>datetime('now','-1 minute')",
      user.id,
      "Push-Testbenachrichtigung",
    )
  )
    throw new HttpError(429, "Bitte vor dem nächsten Test eine Minute warten.");
  run(
    "INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)",
    id(),
    user.id,
    "Push-Testbenachrichtigung",
  );
  return { ok: true };
}
type Sender = (
  sub: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;
export async function flushPushQueue(send: Sender = webpush.sendNotification) {
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
  }>(
    "SELECT d.id,d.subscription_id,d.notification_id,d.attempts,s.user_id,s.endpoint,s.p256dh,s.auth,n.page_id,n.row_id,n.thread_id,n.read_at FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id JOIN notifications n ON n.id=d.notification_id WHERE d.delivered_at IS NULL AND d.attempts<5 AND d.available_at<=? ORDER BY d.id LIMIT 20",
    now,
  );
  if (!jobs.length) return;
  const keys = pushKeys();
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
      try {
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
            body:
              userLocale(job.user_id) === "de"
                ? "Du hast eine neue Benachrichtigung im Posteingang."
                : "You have a new notification in your inbox.",
            url: notificationUrl(job),
            tag: `flowplan-${job.notification_id}`,
          }),
          {
            vapidDetails: {
              ...keys,
              subject:
                process.env.WEB_PUSH_SUBJECT ||
                process.env.APP_URL ||
                "https://flowplan.example.com",
            },
            TTL: 86400,
            timeout: 5000,
            contentEncoding: "aes128gcm",
            urgency: "normal",
          },
        );
        run(
          "UPDATE push_deliveries SET delivered_at=?,last_error=NULL WHERE id=?",
          Date.now(),
          job.id,
        );
      } catch (error) {
        const status = Number(
          (error as { statusCode?: number }).statusCode || 0,
        );
        if (status === 404 || status === 410)
          run("DELETE FROM push_subscriptions WHERE id=?", job.subscription_id);
        else
          run(
            "UPDATE push_deliveries SET available_at=?,last_error=? WHERE id=?",
            Date.now() + Math.min(600000, 30000 * 2 ** job.attempts),
            status ? `HTTP ${status}` : "Senden fehlgeschlagen",
            job.id,
          );
      }
    }),
  );
}
export function dispatchPush() {
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
