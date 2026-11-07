import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notification-defaults-"));
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_FROM = "flowplan@example.test";
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { recordPageEdit } = await import("../lib/page-activity");
const { queueNotificationDigests } = await import("../lib/mail");

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const ada = await person("Ada"),
  ben = await person("Ben");
const wid = await createWorkspace(ada.id, "Familie");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const as = (user: Identity) => async (b: Record<string, unknown>) => (await command(user, { workspaceId: wid, ...b })) as Record<string, unknown>;
const space = (await bootstrap(ada, wid)).spaces[0].id;
// Ada creates the page and so follows it.
const page = String(as(ada)({ action: "page.create", spaceId: space, title: "Einkauf", kind: "document" }).id);
const later = (minutes: number) => Date.now() + minutes * 60_000;

test("by default, changes on followed pages reach the inbox only", async () => {
  const prefs = (await bootstrap(ada, wid)).notificationPrefs;
  assert.deepEqual(prefs.change, { inbox: true, push: false, email: false, messenger: false });
  assert.deepEqual(prefs.mention, { inbox: true, push: true, email: true, messenger: true });
  await recordPageEdit(ben, page);
  assert.ok(await one("SELECT 1 FROM notifications WHERE user_id=? AND kind='change'", ada.id), "in the inbox");
  await queueNotificationDigests(later(30));
  assert.equal((await all("SELECT 1 FROM mail_queue WHERE recipient=?", ada.email)).length, 0, "no e-mail for a small edit");
  // Someone who wants them turns them on.
  as(ada)({ action: "notification.prefs", kind: "change", inbox: true, push: true, email: true });
  await run("UPDATE notifications SET emailed_at=NULL WHERE user_id=?", ada.id);
  await queueNotificationDigests(later(30));
  assert.equal((await all("SELECT 1 FROM mail_queue WHERE recipient=?", ada.email)).length, 1);
  // Back to the defaults.
  const reset = as(ada)({ action: "notification.reset" }) as Record<string, { email: boolean }>;
  assert.equal(reset.change.email, false);
  assert.equal(await one("SELECT 1 FROM notification_prefs WHERE user_id=?", ada.id), undefined);
});

test("a kind turned off in the inbox does not arrive at all", async () => {
  as(ben)({ action: "notification.prefs", kind: "change", inbox: false, push: false, email: false });
  await recordPageEdit(ada, page);
  assert.equal(await one("SELECT 1 FROM notifications WHERE user_id=? AND kind='change'", ben.id), undefined);
});

test("the introduction's e-mail switch keeps edits out of the e-mail", () => {
  const prefs = as(ben)({ action: "notification.email", email: true }) as Record<string, { email: boolean }>;
  assert.equal(prefs.mention.email, true);
  assert.equal(prefs.change.email, false);
  assert.equal(prefs.automation.email, false);
});
