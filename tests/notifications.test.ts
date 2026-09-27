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

function account(name: string) {
  const uid = id();
  run(
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
const me = account("notify-me"),
  other = account("notify-other");
createWorkspace(me.id, "Benachrichtigungen");
const notify = (user: Identity, body: string) => {
  const nid = id();
  run(
    "INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)",
    nid,
    user.id,
    body,
  );
  return nid;
};
const state = (user: Identity) =>
  Object.fromEntries(
    all<{ body: string; read_at: string | null }>(
      "SELECT body,read_at FROM notifications WHERE user_id=?",
      user.id,
    ).map((n) => [n.body, !!n.read_at]),
  );

test("single notifications are marked, unmarked and removed by their owner only", () => {
  const a = notify(me, "A"),
    b = notify(me, "B"),
    foreign = notify(other, "Fremd");
  command(me, { action: "notification.mark", notificationId: a, read: true });
  assert.deepEqual(state(me), { A: true, B: false });
  command(me, { action: "notification.mark", notificationId: a, read: false });
  assert.deepEqual(state(me), { A: false, B: false });
  assert.throws(
    () =>
      command(me, {
        action: "notification.mark",
        notificationId: foreign,
        read: true,
      }),
    /nicht gefunden/,
  );
  assert.throws(
    () =>
      command(me, { action: "notification.delete", notificationId: foreign }),
    /nicht gefunden/,
  );
  assert.deepEqual(state(other), { Fremd: false });
  command(me, { action: "notification.delete", notificationId: b });
  assert.deepEqual(state(me), { A: false });
  command(me, { action: "notification.read" });
  assert.deepEqual(state(me), { A: true });
  assert.deepEqual(state(other), { Fremd: false });
});

test("notification kinds can be switched off for the inbox or for push", () => {
  const person = account("notify-prefs");
  const token = id();
  run(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
    token,
    person.id,
    "[]",
    Date.now() + 600000,
  );
  run(
    "INSERT INTO push_subscriptions(id,user_id,session_token,endpoint,p256dh,auth) VALUES(?,?,?,?,?,?)",
    id(),
    person.id,
    token,
    `https://push.example.test/${id()}`,
    "key",
    "auth",
  );
  const add = (kind: string, body: string) =>
    run(
      "INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,?)",
      id(),
      person.id,
      body,
      kind,
    );
  const pushed = () =>
    all<{ body: string }>(
      "SELECT n.body FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=?",
      person.id,
    ).map((n) => n.body);
  command(person, {
    action: "notification.prefs",
    kind: "mention",
    inbox: false,
    push: true,
  });
  command(person, {
    action: "notification.prefs",
    kind: "comment",
    inbox: true,
    push: false,
  });
  add("mention", "Erwähnung");
  add("comment", "Kommentar");
  add("reminder", "Erinnerung");
  assert.deepEqual(Object.keys(state(person)).sort(), [
    "Erinnerung",
    "Kommentar",
  ]);
  assert.deepEqual(pushed(), ["Erinnerung"]);
  // Push without inbox is not possible; defaults stay on.
  const prefs = command(person, {
    action: "notification.prefs",
    kind: "reminder",
    inbox: false,
    push: true,
  }) as Record<string, { inbox: boolean; push: boolean }>;
  assert.deepEqual(prefs.reminder, { inbox: false, push: false, email: false });
  assert.deepEqual(prefs.guest, { inbox: true, push: true, email: true });
  assert.throws(() =>
    command(person, {
      action: "notification.prefs",
      kind: "spam",
      inbox: true,
      push: true,
    }),
  );
});
