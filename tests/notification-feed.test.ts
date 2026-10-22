// GET /api/notifications (lib/notification-feed.ts): what the desktop app
// polls instead of Web Push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-feed-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { notificationFeed } = await import("../lib/notification-feed");
const { withContentLocale } = await import("../lib/content-locale");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const notify = (user: Identity, body: string, at: string, extra: { page?: string; row?: string; kind?: string } = {}) => {
  const nid = id();
  run(
    "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind,created_at) VALUES(?,?,?,?,?,?,?)",
    nid,
    user.id,
    body,
    extra.page ?? null,
    extra.row ?? null,
    extra.kind ?? null,
    at,
  );
  return nid;
};

test("the feed lists the newest notifications in the reader's language, with the push setting per kind", () => {
  const me = account("feed-me"),
    other = account("feed-other");
  const wid = createWorkspace(me.id, "Feed"),
    boot = bootstrap(me, wid);
  const doc = (command(me, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Plan", kind: "document" }) as { id: string }).id;
  const db = (command(me, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Work", kind: "database" }) as { id: string }).id;
  assert.ok(database(db));
  const row = (command(me, { action: "row.create", pageId: db, cells: { title: "Write offer" } }) as { id: string }).id;

  const mention = notify(me, "Anna hat dich in „Plan“ erwähnt", "2026-10-22 08:00:00", { page: doc, kind: "mention" });
  const change = notify(me, "Anna kommentiert „Work“", "2026-10-22 08:00:05", { page: db, row, kind: "change" });
  const gone = notify(me, "Anna hat dich in „Weg“ erwähnt", "2026-10-22 08:00:10", { page: id(), kind: "mention" });
  notify(other, "Not mine", "2026-10-22 08:00:20");

  const feed = withContentLocale("en", () => notificationFeed(me, null));
  assert.equal(feed.unread, 3);
  assert.ok(!Number.isNaN(Date.parse(feed.now)));
  assert.deepEqual(feed.notifications.map((n) => n.id), [gone, change, mention], "newest first, only mine");
  const [goneItem, changeItem, mentionItem] = feed.notifications;
  assert.equal(mentionItem.text, "Anna mentioned you in “Plan”");
  assert.equal(mentionItem.url, `/#page=${doc}`);
  assert.equal(mentionItem.createdAt, "2026-10-22T08:00:00Z");
  assert.equal(mentionItem.push, true, "mentions push by default");
  assert.equal(mentionItem.read, false);
  assert.equal(changeItem.detail, "Write offer", "the record's title");
  assert.equal(changeItem.url, `/#page=${db}&row=${row}`);
  assert.equal(changeItem.push, false, "changes on followed pages stay in the inbox by default");
  assert.equal(goneItem.push, false, "nothing for a page that is gone");
  assert.equal(goneItem.url, "/#inbox");
  // German by default.
  assert.equal(notificationFeed(me, null).notifications[2].text, "Anna hat dich in „Plan“ erwähnt");

  // The person's own settings decide, like for push.
  command(me, { action: "notification.prefs", kind: "change", inbox: true, push: true });
  command(me, { action: "notification.prefs", kind: "mention", inbox: true, push: false });
  const prefs = notificationFeed(me, null).notifications;
  assert.equal(prefs.find((n) => n.id === change)!.push, true);
  assert.equal(prefs.find((n) => n.id === mention)!.push, false);

  // Since a server time: from that second on; read ones say so.
  command(me, { action: "notification.mark", notificationId: change, read: true });
  const since = notificationFeed(me, Date.parse("2026-10-22T08:00:05Z"));
  assert.deepEqual(since.notifications.map((n) => n.id), [gone, change]);
  assert.equal(since.notifications[1].read, true);
  assert.equal(since.unread, 2);
  assert.deepEqual(notificationFeed(me, Date.parse("2026-10-22T09:00:00Z")).notifications, []);
});

test("a page the reader may no longer see gives no title and no push", () => {
  const owner = account("feed-owner"),
    guest = account("feed-guest");
  const wid = createWorkspace(owner.id, "Private"),
    boot = bootstrap(owner, wid);
  const doc = (command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Secret", kind: "document" }) as { id: string }).id;
  const nid = notify(guest, "Owner hat dich in „Secret“ erwähnt", "2026-10-22 10:00:00", { page: doc, kind: "mention" });
  const [item] = notificationFeed(guest, null).notifications;
  assert.equal(item.id, nid);
  assert.equal(item.push, false);
  assert.equal(item.url, "/#inbox");
  assert.equal(item.detail, "");
});
