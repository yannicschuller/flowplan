// Widget pushes (lib/widget-push.ts) and app profiles that stay registered
// without notifications (lib/mobile-devices.ts, `push: false`): the
// registration, the cheap marks of the triggers (schema 115), the debounce
// and the budget of one push per device and 5 minutes, the claim that keeps
// two instances from sending the same push, and the toggle endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-widget-push-"));
process.env.APP_URL = "https://app.example.test";
// Never contacted: the tests hand their own sender to the flush.
process.env.PUSH_RELAY_URL = "http://localhost:9";
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { flushPushQueue } = await import("../lib/push");
const devices = await import("../lib/mobile-devices");
const { flushWidgetPushes, expandWidgetMarks, WIDGET_PUSH_DEBOUNCE_MS, WIDGET_PUSH_INTERVAL_MS } = await import("../lib/widget-push");
const { mySessions } = await import("../lib/my-sessions");
const route = await import("../app/api/mobile/[action]/route");
import type { RelayMessage, RelayResult } from "../lib/push-relay";

const { registerMobileDevice, setWidgetPushToken, setDevicePush, mobileSummary } = devices;
const RELAY = "http://localhost:9";

async function account(name: string) {
  const uid = id(),
    token = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
const relayToken = () => randomBytes(32).toString("base64url");
const expoToken = () => `ExponentPushToken[${randomUUID().replaceAll("-", "").slice(0, 22)}]`;
const bearer = (t: string) => `Bearer ${t}`;
// A relay that records what it is sent.
function recorder(answer: (m: RelayMessage) => RelayResult = () => ({ status: "ok" })) {
  const sent: RelayMessage[] = [];
  const send = async (messages: RelayMessage[]) => {
    sent.push(...messages);
    return messages.map(answer);
  };
  return { sent, send };
}
const deviceOf = async (userId: string) => (await one<{ id: string }>("SELECT id FROM mobile_devices WHERE user_id=?", userId))!.id;
// Nothing waits from earlier tests.
const reset = async () => {
  await run("DELETE FROM widget_push_dirty");
  await run("UPDATE mobile_widget_push SET pending_since=NULL,sent_at=NULL");
};

test("widget push registration: at registration, by its own endpoint, kept on renewal, removed by DELETE", async () => {
  const { user, token } = await account("wp-register");
  const installationId = randomUUID();
  const widget = relayToken();
  const first = await registerMobileDevice(user, token, { installationId, platform: "ios", widgetPush: { relayToken: widget, relayUrl: RELAY } });
  assert.equal(first.widgetPush, true);
  assert.equal(first.pushEnabled, true);
  const stored = (await one<{ relay_token: string; device_id: string }>("SELECT relay_token,device_id FROM mobile_widget_push WHERE device_id=?", await deviceOf(user.id)))!;
  // Sealed, never in the clear.
  assert.notEqual(stored.relay_token, widget);
  assert.equal(devices.openWidgetToken(stored.device_id, stored.relay_token), widget);
  // A renewal without `widgetPush` keeps it (re-sealed for the new entry).
  const second = await registerMobileDevice(user, token, { installationId, platform: "ios" });
  assert.equal(second.widgetPush, true);
  const renewed = (await one<{ relay_token: string; device_id: string }>("SELECT relay_token,device_id FROM mobile_widget_push WHERE device_id=?", await deviceOf(user.id)))!;
  assert.equal(devices.openWidgetToken(renewed.device_id, renewed.relay_token), widget);
  // A token from another relay is not taken.
  const foreign = await setWidgetPushToken(bearer(second.deviceToken), { relayToken: relayToken(), relayUrl: "https://other-relay.example" });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.widgetPush, true);
  // The endpoint with the device token.
  const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
  const replaced = relayToken();
  const post = await route.POST(
    new Request("http://localhost/api/mobile/widget-push", { method: "POST", headers: { authorization: bearer(second.deviceToken) }, body: JSON.stringify({ relayToken: replaced, relayUrl: RELAY }) }),
    ctx("widget-push"),
  );
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { ok: true, widgetPush: true, pushRelay: { version: 1, url: RELAY, instance: "https://app.example.test" } });
  const now = (await one<{ relay_token: string; device_id: string }>("SELECT relay_token,device_id FROM mobile_widget_push WHERE device_id=?", await deviceOf(user.id)))!;
  assert.equal(devices.openWidgetToken(now.device_id, now.relay_token), replaced);
  // Without a device token: 401; malformed: 400.
  assert.equal((await route.POST(new Request("http://localhost/api/mobile/widget-push", { method: "POST", body: "{}" }), ctx("widget-push"))).status, 401);
  assert.equal(
    (await route.POST(new Request("http://localhost/api/mobile/widget-push", { method: "POST", headers: { authorization: bearer(second.deviceToken) }, body: JSON.stringify({ relayToken: "short" }) }), ctx("widget-push"))).status,
    400,
  );
  const removed = await route.DELETE(new Request("http://localhost/api/mobile/widget-push", { method: "DELETE", headers: { authorization: bearer(second.deviceToken) } }), ctx("widget-push"));
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as { widgetPush: boolean }).widgetPush, false);
  assert.equal(await one("SELECT 1 FROM mobile_widget_push WHERE device_id=?", await deviceOf(user.id)), undefined);
  // `widgetPush: null` at registration removes it too.
  await setWidgetPushToken(bearer(second.deviceToken), { relayToken: relayToken() });
  const third = await registerMobileDevice(user, token, { installationId, platform: "ios", widgetPush: null });
  assert.equal(third.widgetPush, false);
  // Older apps: nothing of this in their requests, nothing changes for them.
  const old = await registerMobileDevice(user, token, { installationId: randomUUID(), platform: "android", pushToken: expoToken() });
  assert.equal(old.push, true);
  assert.equal(old.pushEnabled, true);
  assert.equal(old.widgetPush, false);
});

test("changes mark cheaply; one debounced push per device, at most every 5 minutes, only when something changed", async () => {
  await reset();
  const anna = await account("wp-anna"),
    ben = await account("wp-ben"),
    other = await account("wp-other");
  const wid = await createWorkspace(anna.user.id, "Pushy");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.user.id, "editor");
  const page = (await bootstrap(anna.user, wid)).pages[0];
  const annaToken = relayToken(),
    benToken = relayToken(),
    otherToken = relayToken();
  await registerMobileDevice(anna.user, anna.token, { installationId: randomUUID(), platform: "ios", widgetPush: { relayToken: annaToken } });
  await registerMobileDevice(ben.user, ben.token, { installationId: randomUUID(), platform: "ios", widgetPush: { relayToken: benToken } });
  await registerMobileDevice(other.user, other.token, { installationId: randomUUID(), platform: "ios", widgetPush: { relayToken: otherToken } });

  // A change in the workspace: one mark, however many writes.
  const db = ((await command(anna.user, { action: "page.create", workspaceId: wid, spaceId: page.space_id, kind: "database", title: "Tasks" })) as { id: string }).id;
  for (let i = 0; i < 5; i++) await command(anna.user, { action: "row.create", pageId: db, cells: {} });
  const marks = await all<{ scope: string; key: string; at: number }>("SELECT scope,key,at FROM widget_push_dirty");
  assert.deepEqual(marks.map((m) => [m.scope, m.key]), [["w", wid]]);
  const t0 = Number(marks[0].at);

  // Within the debounce: nothing is sent yet.
  const relay = recorder();
  assert.equal(await flushWidgetPushes(relay.send, t0 + 1000), 0);
  assert.equal(relay.sent.length, 0);
  // After it: one push each to the members' phones, not to the outsider.
  const t1 = t0 + WIDGET_PUSH_DEBOUNCE_MS + 1;
  assert.equal(await flushWidgetPushes(relay.send, t1), 2);
  assert.deepEqual(relay.sent.map((m) => m.to).sort(), [annaToken, benToken].sort());
  assert.deepEqual(relay.sent[0], { to: relay.sent[0].to, type: "widgets", category: null, collapseId: null, badge: null, priority: "normal", ttl: 3600, liveActivity: null });
  assert.equal(relay.sent[0].payload, undefined);
  // Nothing changed: nothing more, ever.
  assert.equal(await flushWidgetPushes(relay.send, t1 + 10 * WIDGET_PUSH_INTERVAL_MS), 0);

  // A notification for Ben: his phone only – but his budget waits.
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), ben.user.id, "Ping");
  const mark = (await one<{ at: number }>("SELECT at FROM widget_push_dirty WHERE scope='u' AND key=?", ben.user.id))!;
  await run("UPDATE widget_push_dirty SET at=? WHERE scope='u' AND key=?", t1 + 1000, ben.user.id);
  assert.ok(mark);
  const t2 = t1 + 1000 + WIDGET_PUSH_DEBOUNCE_MS;
  assert.equal(await flushWidgetPushes(relay.send, t2), 0, "within 5 minutes of the last push");
  assert.ok(await one("SELECT 1 FROM mobile_widget_push WHERE device_id=? AND pending_since IS NOT NULL", await deviceOf(ben.user.id)));
  // More changes meanwhile still become one push.
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), ben.user.id, "Pong");
  await run("UPDATE widget_push_dirty SET at=? WHERE scope='u' AND key=?", t2, ben.user.id);
  const t3 = t1 + WIDGET_PUSH_INTERVAL_MS;
  const before = relay.sent.length;
  assert.equal(await flushWidgetPushes(relay.send, t3), 1);
  assert.deepEqual(relay.sent.slice(before).map((m) => m.to), [benToken]);
  assert.equal(await flushWidgetPushes(relay.send, t3 + WIDGET_PUSH_INTERVAL_MS), 0);

  // Answers: gone drops the registration, an error keeps it pending.
  await run("INSERT INTO widget_push_dirty(scope,key,at) VALUES('w',?,?)", wid, t3);
  const failing = recorder((m) => (m.to === annaToken ? { status: "gone" } : { status: "error" }));
  const t4 = t3 + 2 * WIDGET_PUSH_INTERVAL_MS;
  assert.equal(await flushWidgetPushes(failing.send, t4), 2);
  assert.equal(await one("SELECT 1 FROM mobile_widget_push WHERE device_id=?", await deviceOf(anna.user.id)), undefined);
  assert.ok(await one("SELECT 1 FROM mobile_widget_push WHERE device_id=? AND pending_since IS NOT NULL", await deviceOf(ben.user.id)));
});

test("two instances at once: each mark and each device is claimed once", async () => {
  await reset();
  const carl = await account("wp-carl");
  const token = relayToken();
  await registerMobileDevice(carl.user, carl.token, { installationId: randomUUID(), platform: "ios", widgetPush: { relayToken: token } });
  await run("INSERT INTO widget_push_dirty(scope,key,at) VALUES('u',?,?)", carl.user.id, 1000);
  const relay = recorder();
  const now = 1000 + WIDGET_PUSH_DEBOUNCE_MS + WIDGET_PUSH_INTERVAL_MS;
  const counts = await Promise.all([flushWidgetPushes(relay.send, now), flushWidgetPushes(relay.send, now), flushWidgetPushes(relay.send, now)]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
  assert.deepEqual(relay.sent.map((m) => m.to), [token]);
  assert.equal(await expandWidgetMarks(now), 0);
});

test("the push worker sends widget pushes with the relay's sender; nothing without a registration", async () => {
  await reset();
  const dora = await account("wp-dora");
  const token = relayToken();
  // No registration anywhere: the triggers mark nothing.
  await run("DELETE FROM mobile_widget_push");
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), dora.user.id, "Quiet");
  assert.equal(await one("SELECT 1 FROM widget_push_dirty"), undefined);
  await registerMobileDevice(dora.user, dora.token, { installationId: randomUUID(), platform: "ios", widgetPush: { relayToken: token } });
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), dora.user.id, "Hello");
  await run("UPDATE widget_push_dirty SET at=?", Date.now() - WIDGET_PUSH_DEBOUNCE_MS - 1000);
  const relay = recorder();
  await flushPushQueue(
    async () => assert.fail("no Web Push"),
    async () => assert.fail("no Expo"),
    relay.send,
  );
  assert.deepEqual(relay.sent.filter((m) => m.type === "widgets").map((m) => m.to), [token]);
});

test("push: false keeps summary and widgets, but no notifications; POST /api/mobile/device switches", async () => {
  await reset();
  const eva = await account("wp-eva");
  const expo = expoToken();
  const registered = await registerMobileDevice(eva.user, eva.token, { installationId: randomUUID(), platform: "android", pushToken: expo, push: false });
  assert.equal(registered.push, true);
  assert.equal(registered.pushEnabled, false);
  // The device token works for the summary and the widgets.
  const user = await devices.identityFromDeviceToken(bearer(registered.deviceToken));
  assert.equal(user?.id, eva.user.id);
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), eva.user.id, "Hidden");
  assert.equal((await mobileSummary(user!)).unread, 1);
  // No notification reaches it: the delivery is dropped, not retried.
  const expoSent: unknown[] = [];
  await flushPushQueue(
    async () => assert.fail("no Web Push"),
    async (m) => {
      expoSent.push(m);
    },
  );
  assert.equal(expoSent.length, 0);
  assert.equal(await one("SELECT 1 FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=?", eva.user.id), undefined);
  // Settings: "widgets only" for its session.
  assert.equal((await mySessions(eva.user, undefined)).find((s) => s.widgetsOnly)?.widgetsOnly, true);

  // The app switches back to this profile.
  const ctx = { params: Promise.resolve({ action: "device" }) };
  const on = await route.POST(new Request("http://localhost/api/mobile/device", { method: "POST", headers: { authorization: bearer(registered.deviceToken) }, body: JSON.stringify({ push: true }) }), ctx);
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { ok: true, pushEnabled: true, widgetPush: false });
  assert.equal((await mySessions(eva.user, undefined)).some((s) => s.widgetsOnly), false);
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), eva.user.id, "Visible");
  await flushPushQueue(
    async () => assert.fail("no Web Push"),
    async (m) => {
      expoSent.push(m);
    },
  );
  assert.equal(expoSent.length, 1);
  // And away again: waiting notifications are dropped at once.
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), eva.user.id, "Waiting");
  assert.deepEqual(await setDevicePush(bearer(registered.deviceToken), { push: false }), { ok: true, pushEnabled: false, widgetPush: false });
  assert.equal(await one("SELECT 1 FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=? AND d.delivered_at IS NULL", eva.user.id), undefined);
  // Bad input and no device token.
  assert.equal((await route.POST(new Request("http://localhost/api/mobile/device", { method: "POST", headers: { authorization: bearer(registered.deviceToken) }, body: JSON.stringify({ push: "yes" }) }), ctx)).status, 400);
  assert.equal((await route.POST(new Request("http://localhost/api/mobile/device", { method: "POST", body: JSON.stringify({ push: true }) }), ctx)).status, 401);
  // The test notification from the settings names it, without sending.
  const { sendTestPush } = await import("../lib/push-test");
  const report = await sendTestPush(eva.user, eva.token, { flush: async () => {}, timeoutMs: 50 });
  assert.equal(report.targets.find((t) => t.kind === "app")?.status, "widgets-only");
});

test("two profiles on one phone share its widget token: one push, one budget", async () => {
  await reset();
  const work = await account("wp-work"),
    home = await account("wp-home");
  const shared = relayToken();
  await registerMobileDevice(work.user, work.token, { installationId: randomUUID(), platform: "ios", widgetPush: { relayToken: shared } });
  await registerMobileDevice(home.user, home.token, { installationId: randomUUID(), platform: "ios", push: false, widgetPush: { relayToken: shared } });
  const both = [await deviceOf(work.user.id), await deviceOf(home.user.id)];
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM mobile_widget_push WHERE device_id IN (?,?)", ...both))!.n, 2);
  await run("INSERT INTO widget_push_dirty(scope,key,at) VALUES('u',?,?)", work.user.id, 1000);
  await run("INSERT INTO widget_push_dirty(scope,key,at) VALUES('u',?,?)", home.user.id, 1000);
  const relay = recorder();
  const now = 1000 + WIDGET_PUSH_DEBOUNCE_MS + WIDGET_PUSH_INTERVAL_MS;
  assert.equal(await flushWidgetPushes(relay.send, now), 1);
  assert.deepEqual(relay.sent.map((m) => m.to), [shared]);
  // Gone for the token: both registrations go.
  await run("INSERT INTO widget_push_dirty(scope,key,at) VALUES('u',?,?)", home.user.id, now);
  const gone = recorder(() => ({ status: "gone" }));
  assert.equal(await flushWidgetPushes(gone.send, now + 2 * WIDGET_PUSH_INTERVAL_MS), 1);
  assert.equal(await one("SELECT 1 FROM mobile_widget_push WHERE device_id IN (?,?)", ...both), undefined);
});
