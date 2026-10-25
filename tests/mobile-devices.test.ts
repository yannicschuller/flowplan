import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-mobile-"));
const { id, one, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { flushPushQueue, PushGoneError } = await import("../lib/push");
const { registerMobileDevice, unregisterMobileDevice, unregisterByDeviceToken, identityFromDeviceToken, mobileSummary } = await import(
  "../lib/mobile-devices"
);

function account(name: string) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
const pushToken = () => `ExponentPushToken[${randomUUID().replaceAll("-", "").slice(0, 22)}]`;
const bearer = (token: string) => `Bearer ${token}`;

test("an app registers for its session; its token only lives as long as the sign-in", () => {
  const { user, token } = account("phone-owner");
  const installationId = randomUUID();
  assert.throws(() => registerMobileDevice(user, "no-session", { installationId, platform: "ios" }), /Sitzung/);
  assert.throws(
    () => registerMobileDevice({ ...user, apiScope: "write" }, token, { installationId, platform: "ios" }),
    /API-Token/,
  );
  assert.throws(() => registerMobileDevice(user, token, { installationId, platform: "windows" }));
  assert.throws(() => registerMobileDevice(user, token, { installationId, platform: "ios", pushToken: "https://evil.test" }));

  const first = registerMobileDevice(user, token, { installationId, platform: "ios", name: "iPhone", pushToken: pushToken() });
  assert.match(first.deviceToken, /^fpd_/);
  assert.equal(first.push, true);
  assert.equal(identityFromDeviceToken(bearer(first.deviceToken))?.id, user.id);
  assert.equal(identityFromDeviceToken(bearer(first.deviceToken))?.isAdmin, false);
  // API tokens and garbage are no device tokens.
  assert.equal(identityFromDeviceToken("Bearer fp_abcdefghijklmnopqrstuvwxyz"), null);
  assert.equal(identityFromDeviceToken(null), null);

  // Registering again replaces the entry and its token; one entry per installation.
  const second = registerMobileDevice(user, token, { installationId, platform: "ios", pushToken: pushToken() });
  assert.equal(identityFromDeviceToken(bearer(first.deviceToken)), null);
  assert.equal(identityFromDeviceToken(bearer(second.deviceToken))?.id, user.id);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM mobile_devices WHERE user_id=?", user.id)!.n, 1);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?", user.id)!.n, 1);

  // Signing out ends the token and the push subscription.
  run("DELETE FROM sessions WHERE token=?", token);
  assert.equal(identityFromDeviceToken(bearer(second.deviceToken)), null);
  assert.equal(one("SELECT id FROM mobile_devices WHERE user_id=?", user.id), undefined);
  assert.equal(one("SELECT id FROM push_subscriptions WHERE user_id=?", user.id), undefined);
});

test("a phone that switches accounts takes its push token along; unregister forgets it", () => {
  const anna = account("switch-anna"),
    ben = account("switch-ben");
  const shared = pushToken(),
    installationId = randomUUID();
  registerMobileDevice(anna.user, anna.token, { installationId, platform: "android", pushToken: shared });
  registerMobileDevice(ben.user, ben.token, { installationId, platform: "android", pushToken: shared });
  assert.equal(one<{ user_id: string }>("SELECT user_id FROM push_subscriptions WHERE endpoint=?", `expo:${shared}`)!.user_id, ben.user.id);
  unregisterMobileDevice(ben.user, installationId);
  assert.equal(one("SELECT id FROM mobile_devices WHERE user_id=?", ben.user.id), undefined);
  assert.equal(one("SELECT id FROM push_subscriptions WHERE endpoint=?", `expo:${shared}`), undefined);
  // Leaving the instance with only the device token.
  const leaving = registerMobileDevice(ben.user, ben.token, { installationId, platform: "android", pushToken: shared });
  assert.equal(unregisterByDeviceToken("Bearer fp_notadevicetokenatall0000"), false);
  assert.equal(unregisterByDeviceToken(bearer(leaving.deviceToken)), true);
  assert.equal(one("SELECT id FROM push_subscriptions WHERE endpoint=?", `expo:${shared}`), undefined);
  assert.equal(identityFromDeviceToken(bearer(leaving.deviceToken)), null);
  assert.equal(unregisterByDeviceToken(bearer(leaving.deviceToken)), false);
  // Without a push token (permission denied) the widgets still work.
  const quiet = registerMobileDevice(anna.user, anna.token, { installationId: randomUUID(), platform: "ios", pushToken: null });
  assert.equal(quiet.push, false);
});

test("the summary shows unread notifications, due tasks and the running timer", () => {
  const { user, token } = account("summary-owner");
  const wid = createWorkspace(user.id, "Summary"),
    boot = bootstrap(user, wid);
  const docId = (command(user, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Plan", kind: "document" }) as { id: string }).id;
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", docId)!.generation);
  const task = (text: string, due: string) => `<li data-type="taskItem" data-checked="false" data-due="${due}"><p>${text}</p></li>`;
  command(user, {
    action: "document.sync",
    workspaceId: wid,
    pageId: docId,
    generation,
    update: Buffer.from(htmlState(`<ul data-type="taskList">${task("Late", "2026-01-02")}${task("Today", "2026-03-04")}${task("Later", "2026-05-06")}</ul>`)).toString("base64"),
  });
  const dbId = (command(user, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Work" }) as { id: string }).id;
  command(user, {
    action: "database.update",
    pageId: dbId,
    version: database(dbId).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "spent", name: "Time", type: "time" },
    ],
    views: database(dbId).views,
  });
  const rowId = (command(user, { action: "row.create", pageId: dbId, cells: { title: "Write offer" } }) as { id: string }).id;
  command(user, { action: "time.start", pageId: dbId, rowId, fieldId: "spent" });
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), user.id, "Hallo");

  const { deviceToken } = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios" });
  const device = identityFromDeviceToken(bearer(deviceToken))!;
  const summary = mobileSummary(device, "2026-03-04");
  assert.equal(summary.unread, 1);
  assert.equal(summary.tasks.due, 2);
  assert.equal(summary.tasks.overdue, 1);
  assert.deepEqual(
    summary.tasks.items.map((t) => t.text),
    ["Late", "Today", "Later"],
  );
  assert.equal(summary.tasks.items[0].url, `/#page=${docId}`);
  assert.equal(summary.timer?.title, "Write offer");
  assert.equal(summary.timer?.database, "Work");
  assert.equal(summary.timer?.url, `/#page=${dbId}&row=${rowId}`);
  assert.throws(() => mobileSummary(device, "tomorrow"));

  command(user, { action: "time.stop", pageId: dbId, rowId, fieldId: "spent" });
  assert.equal(mobileSummary(device).timer, null);
});

test("notifications reach the app through Expo, with the badge and without content", async () => {
  const owner = account("expo-author"),
    reader = account("expo-reader");
  const wid = createWorkspace(owner.user.id, "Expo workspace");
  run("INSERT INTO members VALUES(?,?,?)", wid, reader.user.id, "editor");
  const page = bootstrap(owner.user, wid).pages[0];
  const token = pushToken();
  registerMobileDevice(reader.user, reader.token, { installationId: randomUUID(), platform: "ios", pushToken: token });
  command(owner.user, { action: "comment.create", pageId: page.id, body: "Confidential document text" });
  const sent: { to: string; body: string; badge: number; data: { url: string } }[] = [];
  await flushPushQueue(
    async () => assert.fail("No Web Push for the app"),
    async (message) => {
      sent.push(message);
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, token);
  assert.equal(sent[0].badge, 1);
  assert.equal(sent[0].data.url, `/#page=${page.id}`);
  assert.doesNotMatch(JSON.stringify(sent[0]), /Confidential|expo-author|Expo workspace/);

  // With MOBILE_PUSH_CONTENT the notification text comes along.
  process.env.MOBILE_PUSH_CONTENT = "on";
  try {
    command(owner.user, { action: "comment.create", pageId: page.id, body: "Second" });
    await flushPushQueue(
      async () => {},
      async (message) => {
        sent.push(message);
      },
    );
    assert.match(sent[1].body, /expo-author/);
    assert.equal(sent[1].badge, 2);
  } finally {
    delete process.env.MOBILE_PUSH_CONTENT;
  }

  // An uninstalled app: Expo answers DeviceNotRegistered, the subscription goes.
  run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", randomUUID(), reader.user.id, "Ping");
  await flushPushQueue(
    async () => {},
    async () => {
      throw new PushGoneError("DeviceNotRegistered");
    },
  );
  assert.equal(one("SELECT id FROM push_subscriptions WHERE endpoint=?", `expo:${token}`), undefined);
  assert.equal(
    one<{ push_subscription_id: string | null }>("SELECT push_subscription_id FROM mobile_devices WHERE user_id=?", reader.user.id)!
      .push_subscription_id,
    null,
  );
});

test("MOBILE_PUSH=off keeps registrations without push", () => {
  const { user, token } = account("no-push");
  process.env.MOBILE_PUSH = "off";
  try {
    const result = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "android", pushToken: pushToken() });
    assert.equal(result.push, false);
    assert.equal(one("SELECT id FROM push_subscriptions WHERE user_id=?", user.id), undefined);
  } finally {
    delete process.env.MOBILE_PUSH;
  }
});
