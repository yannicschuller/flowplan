import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notify-"));
const { run, id, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");

async function account(name: string) {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const me = await account("notify-me"),
  other = await account("notify-other");
await createWorkspace(me.id, "Benachrichtigungen");
const notify = async (user: Identity, body: string) => {
  const nid = id();
  await run(
    "INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)",
    nid,
    user.id,
    body,
  );
  return nid;
};
const state = async (user: Identity) =>
  Object.fromEntries(
    (await all<{ body: string; read_at: string | null }>(
      "SELECT body,read_at FROM notifications WHERE user_id=?",
      user.id,
    )).map((n) => [n.body, !!n.read_at]),
  );

test("single notifications are marked, unmarked and removed by their owner only", async () => {
  const a = await notify(me, "A"),
    b = await notify(me, "B"),
    foreign = await notify(other, "Fremd");
  await command(me, { action: "notification.mark", notificationId: a, read: true });
  assert.deepEqual(await state(me), { A: true, B: false });
  await command(me, { action: "notification.mark", notificationId: a, read: false });
  assert.deepEqual(await state(me), { A: false, B: false });
  await assert.rejects(
    async () =>
      await command(me, {
        action: "notification.mark",
        notificationId: foreign,
        read: true,
      }),
    /nicht gefunden/,
  );
  await assert.rejects(
    async () =>
      await command(me, { action: "notification.delete", notificationId: foreign }),
    /nicht gefunden/,
  );
  assert.deepEqual(await state(other), { Fremd: false });
  await command(me, { action: "notification.delete", notificationId: b });
  assert.deepEqual(await state(me), { A: false });
  await command(me, { action: "notification.read" });
  assert.deepEqual(await state(me), { A: true });
  assert.deepEqual(await state(other), { Fremd: false });
});

test("notification kinds can be switched off for the inbox or for push", async () => {
  const person = await account("notify-prefs");
  const token = id();
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
    token,
    person.id,
    "[]",
    Date.now() + 600000,
  );
  await run(
    "INSERT INTO push_subscriptions(id,user_id,session_token,endpoint,p256dh,auth) VALUES(?,?,?,?,?,?)",
    id(),
    person.id,
    token,
    `https://push.example.test/${id()}`,
    "key",
    "auth",
  );
  const add = async (kind: string, body: string) =>
    await run(
      "INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,?)",
      id(),
      person.id,
      body,
      kind,
    );
  const pushed = async () =>
    (await all<{ body: string }>(
      "SELECT n.body FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=?",
      person.id,
    )).map((n) => n.body);
  await command(person, {
    action: "notification.prefs",
    kind: "mention",
    inbox: false,
    push: true,
  });
  await command(person, {
    action: "notification.prefs",
    kind: "comment",
    inbox: true,
    push: false,
  });
  await add("mention", "Erwähnung");
  await add("comment", "Kommentar");
  await add("reminder", "Erinnerung");
  assert.deepEqual(Object.keys(await state(person)).sort(), [
    "Erinnerung",
    "Kommentar",
  ]);
  assert.deepEqual(await pushed(), ["Erinnerung"]);
  // Push without inbox is not possible; defaults stay on.
  const prefs = (await command(person, {
    action: "notification.prefs",
    kind: "reminder",
    inbox: false,
    push: true,
  })) as Record<string, { inbox: boolean; push: boolean }>;
  assert.deepEqual(prefs.reminder, { inbox: false, push: false, email: false, messenger: false });
  // Untouched kinds follow the defaults (guest comments: no e-mail, no chat apps).
  assert.deepEqual(prefs.guest, { inbox: true, push: true, email: false, messenger: false });
  await assert.rejects(async () =>
    await command(person, {
      action: "notification.prefs",
      kind: "spam",
      inbox: true,
      push: true,
    }),
  );
});
