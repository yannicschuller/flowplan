// "Send test notification" in the settings (Settings → Notifications →
// Push): a test to every push target of the signed-in person – Web Push
// subscriptions of their browsers and their app installations, through the
// push relay (end-to-end encrypted) or Expo – with the outcome per target.
//
// The test takes the real way: one row per target in push_tests, sent by
// the push worker (flushPushQueue in lib/push.ts) with the same senders,
// keys and consequences as every notification, flushed at once; the request
// waits up to ten seconds for the results. No inbox entry is created. A
// test ignores the person's notification settings and quiet hours (it is
// asked for), not the device's own permission or Focus.
//
// Only for oneself (the session's person; never with an API token), five
// tests per person in ten minutes. The answer carries codes, names the
// person gave their devices and the browser kind – never a token, key or
// push address. Administrators also get a line of diagnostics.
import { randomUUID } from "node:crypto";
import { all, one, run } from "./db";
import { adminGroup, HttpError } from "./auth";
import { allow } from "./action-limits";
import { ct } from "./content-locale";
import { deviceName } from "./my-sessions";
import { focusActive } from "./mobile-focus";
import { mobilePushEnabled } from "./mobile-devices";
import { relayConfig } from "./push-relay";
import { relaySetup } from "./push-status";
import { dispatchPush, EXPO_ENDPOINT, RELAY_ENDPOINT } from "./push";
import type { Identity } from "./types";

export const PUSH_TEST_LIMIT = { max: 5, windowMs: 10 * 60_000 };
export const PUSH_TEST_TIMEOUT_MS = 10_000;

export type PushTestStatus =
  | "delivered"
  | "pending"
  | "push-disabled"
  | "app-push-off"
  | "relay-off"
  | "relay-unreachable"
  | "relay-signature"
  | "relay-blocked"
  | "relay-rejected"
  | "relay-unexpected"
  | "relay-upstream"
  | "relay-rate-limited"
  | "relay-registration"
  | "expo-gone"
  | "expo-error"
  | "web-gone"
  | "web-error"
  | "web-unreachable";
export type PushTestTarget = {
  // A key for the list only (the test row's random id), nothing to sign in with.
  key: string;
  kind: "browser" | "app";
  // The browser and system, or the name of the app installation.
  name: string;
  platform: string | null;
  // The push service of a browser: apple, google, mozilla, microsoft.
  service: string | null;
  // This browser (the session that asked).
  current: boolean;
  channel: "relay" | "expo" | "web" | null;
  status: PushTestStatus;
  // HTTP status, Expo's error name, a relay reason, seconds to wait.
  detail: string | null;
  // The app went through Expo because the relay is off or refused it.
  note: "relay-off" | "relay-registration" | null;
  // A Focus with a Flowplan filter is on for this device.
  focus: boolean;
};
export type PushTestReport = {
  targets: PushTestTarget[];
  // instance: this instance's public origin as the relay knows it.
  relay: { enabled: boolean; reason: "off" | "relay-url" | "instance-url" | null; instance: string | null };
  diagnostics?: { relayUrl: string | null; wellKnown: boolean; instance: string | null; mobilePush: boolean };
};

const serviceOf = (endpoint: string) => {
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {}
  return host === "web.push.apple.com" ? "apple" : host === "fcm.googleapis.com" ? "google" : host.endsWith(".mozilla.com") ? "mozilla" : host.endsWith(".notify.windows.com") ? "microsoft" : null;
};
const browserLabel = (agent: string) => {
  const d = deviceName(agent || "");
  return [d.app || d.browser, d.system].filter(Boolean).join(" · ");
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PushTestOptions = {
  // Sends what is queued (default: the push worker, lib/push.ts).
  flush?: () => Promise<unknown>;
  timeoutMs?: number;
};

export async function sendTestPush(user: Identity, sessionToken: string, options: PushTestOptions = {}): Promise<PushTestReport> {
  if (user.apiScope) throw new HttpError(403, ct("Mit einem API-Token nicht erlaubt.", "Not allowed with an API token."));
  if (!one("SELECT 1 FROM sessions WHERE token=? AND user_id=? AND expires>?", sessionToken, user.id, Date.now()))
    throw new HttpError(401, ct("Sitzung abgelaufen.", "Session expired."));
  if (!allow(`push-test:${user.id}`, PUSH_TEST_LIMIT.max, PUSH_TEST_LIMIT.windowMs))
    throw new HttpError(429, ct("Höchstens 5 Testbenachrichtigungen in 10 Minuten. Bitte warte kurz.", "At most 5 test notifications in 10 minutes. Please wait a moment."));
  const now = Date.now();
  const runId = randomUUID();
  const relay = relayConfig();
  const mobilePush = mobilePushEnabled();
  type Pending = Omit<PushTestTarget, "status" | "channel" | "detail" | "note"> & { subscription: string | null; status?: PushTestStatus };
  const targets: Pending[] = [];

  // Browsers (Web Push) of live sessions.
  for (const s of all<{ id: string; endpoint: string; session_token: string; agent: string | null }>(
    `SELECT s.id,s.endpoint,s.session_token,se.agent FROM push_subscriptions s JOIN sessions se ON se.token=s.session_token
     WHERE s.user_id=? AND se.expires>? AND s.endpoint NOT LIKE '${EXPO_ENDPOINT}%' AND s.endpoint NOT LIKE '${RELAY_ENDPOINT}%' ORDER BY s.created_at`,
    user.id,
    now,
  ))
    targets.push({
      key: randomUUID(),
      kind: "browser",
      name: browserLabel(s.agent || ""),
      platform: null,
      service: serviceOf(s.endpoint),
      current: s.session_token === sessionToken,
      focus: false,
      subscription: s.id,
    });
  // App installations, also those without push (permission not given).
  for (const d of all<{ id: string; name: string; platform: string; push_subscription_id: string | null }>(
    `SELECT md.id,md.name,md.platform,s.id push_subscription_id FROM mobile_devices md JOIN sessions se ON se.token=md.session_token
     LEFT JOIN push_subscriptions s ON s.id=md.push_subscription_id WHERE md.user_id=? AND se.expires>? ORDER BY md.created_at`,
    user.id,
    now,
  ))
    targets.push({
      key: randomUUID(),
      kind: "app",
      name: d.name.slice(0, 80),
      platform: d.platform,
      service: null,
      current: false,
      focus: focusActive(d.id, now),
      subscription: d.push_subscription_id,
      ...(d.push_subscription_id ? {} : { status: mobilePush ? ("push-disabled" as const) : ("app-push-off" as const) }),
    });

  for (const target of targets)
    if (target.subscription)
      run(
        "INSERT INTO push_tests(id,run_id,user_id,subscription_id,created_at) VALUES(?,?,?,?,?)",
        target.key,
        runId,
        user.id,
        target.subscription,
        now,
      );

  const waiting = () =>
    !!one(
      "SELECT 1 FROM push_tests t WHERE t.run_id=? AND (t.status='sending' OR (t.status IS NULL AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.id=t.subscription_id)))",
      runId,
    );
  if (targets.some((t) => t.subscription)) {
    const flush = options.flush ?? dispatchPush;
    const deadline = now + (options.timeoutMs ?? PUSH_TEST_TIMEOUT_MS);
    // The worker may be busy with an earlier run: flush until this test's
    // rows are answered or the time is up.
    while (waiting() && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([flush().catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))))]);
      clearTimeout(timer);
      if (waiting() && Date.now() < deadline) await sleep(100);
    }
  }
  const rows = new Map(
    all<{ id: string; status: string | null; channel: string | null; detail: string | null; note: string | null }>(
      "SELECT id,status,channel,detail,note FROM push_tests WHERE run_id=?",
      runId,
    ).map((r) => [r.id, r]),
  );
  run("DELETE FROM push_tests WHERE run_id=?", runId);

  const report: PushTestReport = {
    targets: targets.map(({ subscription, status, ...target }) => {
      const row = rows.get(target.key);
      const answered = row?.status && row.status !== "sending" ? (row.status as PushTestStatus) : null;
      // Not answered and the subscription gone meanwhile (session ended).
      const vanished = !!row && !row.status && !one("SELECT 1 FROM push_subscriptions WHERE id=?", subscription);
      return {
        ...target,
        channel: (row?.channel as PushTestTarget["channel"]) ?? (target.kind === "browser" ? "web" : null),
        status: status ?? answered ?? (vanished ? (target.kind === "browser" ? "web-gone" : "relay-registration") : "pending"),
        detail: row?.detail ?? null,
        note: (row?.note as PushTestTarget["note"]) ?? null,
      };
    }),
    relay: { enabled: relay.enabled, reason: relay.enabled ? null : relay.reason, instance: relay.enabled ? relay.instance : null },
  };
  if (!user.demo && user.groups.includes(adminGroup())) {
    // The same facts as Administration → Push (lib/push-status.ts).
    const setup = relaySetup();
    report.diagnostics = { relayUrl: setup.url, wellKnown: setup.wellKnown, instance: setup.instance, mobilePush };
  }
  return report;
}
