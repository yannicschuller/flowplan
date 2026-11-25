// The inbox's structured notifications: the columns of schema 136,
// what the places that notify write into them, the line built from them in
// the reader's language (with the body for older rows), the groups, the
// command for several at once and the pages after the bootstrap's first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bootstrap, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notification-inbox-"));
const { one, all, run, id, db } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { translate } = await import("../lib/i18n");
const { notificationLine, notificationActionLabel, similarKey } = await import("../lib/notification-display");
const { notificationCategory } = await import("../lib/notification-kinds");
const { notificationFields, notificationExcerpt } = await import("../lib/notification-fields");
const { inboxNotifications, unreadNotifications } = await import("../lib/notification-inbox");
const { commandOverlay } = await import("../lib/optimistic-commands");

type Note = Bootstrap["notifications"][number];
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Mara Lindqvist"),
  jonas = await user("Jonas Weber"),
  stranger = await user("Fremd");
const wid = await createWorkspace(owner.id, "Inbox");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
await run("INSERT INTO members VALUES(?,?,?)", wid, jonas.id, "editor");
const rowsOf = async (uid: string) =>
  await all<Note & { kind: string | null }>("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC,seq DESC", uid);
const de = (d: string, _e: string) => d;
const en = translate("en");
await (await import("../lib/i18n-catalogs-server")).ensureCatalog("fr");
const fr = translate("fr");

test("schema 136 adds the structured columns to notifications", async () => {
  const columns = (db().prepare("PRAGMA table_info(notifications)").all() as { name: string }[]).map((c) => c.name);
  for (const column of ["actor_id", "subtype", "severity", "params", "excerpt"]) assert.ok(columns.includes(column), column);
});

test("a comment notifies with its author, type, page and first words", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Q1-Roadmap" })) as { id: string }).id;
  const long = `Budget  für März\nbitte ${"sehr ".repeat(60)}gründlich prüfen`;
  await command(jonas, { action: "comment.create", pageId, body: long });
  const [n] = await rowsOf(owner.id);
  assert.equal(n.kind, "comment");
  assert.equal(n.subtype, "comment");
  assert.equal(n.actor_id, jonas.id);
  assert.deepEqual(JSON.parse(n.params!), { actor: "Jonas Weber", page: "Q1-Roadmap" });
  assert.ok(n.excerpt!.startsWith("Budget für März bitte sehr"));
  assert.ok(n.excerpt!.length <= 160 && n.excerpt!.endsWith("…"));
  // The body stays the German text for push, e-mail and older apps.
  assert.equal(n.body, "Jonas Weber kommentiert „Q1-Roadmap“");
  // The line in the reader's language, with the person's current name.
  const line = notificationLine(n, en, [{ id: jonas.id, name: "Jonas W." }]);
  assert.deepEqual(
    { actor: line.actor, title: line.title, place: line.place, category: line.category, plain: line.plain },
    { actor: { id: jonas.id, name: "Jonas W." }, title: "commented", place: "Q1-Roadmap", category: "comment", plain: false },
  );
  assert.equal(notificationLine(n, fr).title, "a commenté");
  assert.equal(notificationLine(n, de).title, "hat kommentiert");
  assert.equal(notificationActionLabel(line, en), "Reply");
  await run("DELETE FROM notifications");
});

test("an incident carries its rule and severity; old rows show their body", async () => {
  const [incident] = [
    { id: "i1", body: "Kritischer Sicherheitsvorfall: …", kind: "incident", subtype: "incident", severity: "critical", params: JSON.stringify({ rule: "login_after_failures", detail: "23 Fehlversuche" }) },
  ] as unknown as Note[];
  const line = notificationLine(incident, en);
  assert.deepEqual(
    { title: line.title, detail: line.detail, severity: line.severity, category: line.category },
    { title: "Sign-in after many failures", detail: "23 Fehlversuche", severity: "critical", category: "security" },
  );
  assert.equal(notificationActionLabel(line, de), "Zum Vorfall");
  // Two incidents of one rule are "the same"; other notifications stand alone.
  const other = { ...incident, id: "i2" } as Note;
  assert.equal(similarKey(incident, line), similarKey(other, notificationLine(other, en)));
  // An older row (no subtype) and an unknown rule: the body as it is.
  const old = { id: "o", body: "Lea Hoffmann kommentiert „Plan“", kind: "comment" } as Note;
  assert.deepEqual([notificationLine(old, en).title, notificationLine(old, en).plain], ["Lea Hoffmann kommentiert „Plan“", true]);
  const unknown = { ...incident, params: JSON.stringify({ rule: "nope" }) } as Note;
  assert.equal(notificationLine(unknown, en).title, incident.body);
  // A person's action without a known person: the body.
  const nobody = { id: "x", body: "Text", kind: "share", subtype: "share", params: "{}" } as Note;
  assert.equal(notificationLine(nobody, en).title, "Text");
});

test("kinds and subtypes fall into the inbox's groups", () => {
  assert.equal(notificationCategory("mention"), "mention");
  assert.equal(notificationCategory("mention", "assignment"), "task");
  assert.equal(notificationCategory("reminder"), "task");
  assert.equal(notificationCategory("workflow_ops", "approval"), "share");
  assert.equal(notificationCategory("guest"), "comment");
  assert.equal(notificationCategory("incident"), "security");
  assert.equal(notificationCategory("ai_quota"), "system");
  assert.equal(notificationCategory(null), "system");
});

test("the fields helper keeps values short and leaves out empty ones", () => {
  const [actor, subtype, severity, params, excerpt] = notificationFields({ subtype: "share", params: { page: "x".repeat(400), none: null, empty: "" }, excerpt: " a\n b " });
  assert.equal(actor, null);
  assert.equal(subtype, "share");
  assert.equal(severity, null);
  assert.equal(JSON.parse(params!).page.length, 300);
  assert.deepEqual(Object.keys(JSON.parse(params!)), ["page"]);
  assert.equal(excerpt, "a b");
  assert.equal(notificationExcerpt("   "), null);
});

test("several notifications are read, unread and removed at once – only your own", async () => {
  await run("DELETE FROM notifications");
  const mine: string[] = [];
  for (const body of ["A", "B", "C"]) {
    const nid = id();
    mine.push(nid);
    await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", nid, owner.id, body);
  }
  const foreign = id();
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", foreign, stranger.id, "F");
  assert.deepEqual(await command(owner, { action: "notification.bulk", notificationIds: [mine[0], mine[1], foreign], op: "read" }), { changed: 2 });
  assert.equal(await unreadNotifications(owner.id), 1);
  assert.equal(await unreadNotifications(stranger.id), 1);
  const readAt = (await one<{ read_at: string }>("SELECT read_at FROM notifications WHERE id=?", mine[0]))!.read_at;
  // Reading again keeps the first time.
  await command(owner, { action: "notification.bulk", notificationIds: [mine[0]], op: "read" });
  assert.equal((await one<{ read_at: string }>("SELECT read_at FROM notifications WHERE id=?", mine[0]))!.read_at, readAt);
  await command(owner, { action: "notification.bulk", notificationIds: [mine[0]], op: "unread" });
  assert.equal(await unreadNotifications(owner.id), 2);
  await command(owner, { action: "notification.bulk", notificationIds: [mine[1], mine[2]], op: "delete" });
  assert.deepEqual((await rowsOf(owner.id)).map((n) => n.body), ["A"]);
  await assert.rejects(async () => await command(owner, { action: "notification.bulk", notificationIds: [foreign], op: "delete" }), /nicht gefunden/);
  await assert.rejects(async () => await command(owner, { action: "notification.bulk", notificationIds: [], op: "read" }));
  assert.equal((await rowsOf(stranger.id)).length, 1);
  await run("DELETE FROM notifications");
});

test("the bootstrap has the newest 100 and the unread count; older ones come page by page", async () => {
  await run("DELETE FROM notifications");
  const base = Date.parse("2026-11-01T10:00:00Z");
  for (let i = 0; i < 130; i++)
    await run(
      "INSERT INTO notifications(id,user_id,body,created_at,read_at) VALUES(?,?,?,?,?)",
      `n${String(i).padStart(3, "0")}`,
      owner.id,
      `Nr. ${i}`,
      new Date(base + i * 60_000).toISOString().replace("T", " ").slice(0, 19),
      i % 2 ? "2026-11-02 00:00:00" : null,
    );
  const boot = await bootstrap(owner, wid);
  assert.equal(boot.notifications.length, 100);
  assert.equal(boot.notifications[0].body, "Nr. 129");
  assert.equal(boot.notificationsMore, true);
  assert.equal(boot.notificationsUnread, 65);
  const page = await inboxNotifications(owner, { before: boot.notifications[99].id, limit: 50 });
  assert.deepEqual(
    page.notifications.map((n) => n.body),
    Array.from({ length: 30 }, (_, i) => `Nr. ${29 - i}`),
  );
  assert.equal(page.more, false);
  // Someone else's id as the cursor gives nothing of theirs.
  await run("INSERT INTO notifications(id,user_id,body) VALUES('theirs',?,'T')", stranger.id);
  const fromForeign = await inboxNotifications(owner, { before: "theirs", limit: 5 });
  assert.ok(fromForeign.notifications.every((n) => n.body.startsWith("Nr.")));
  await run("DELETE FROM notifications");
});

test("the optimistic overlay of notification.bulk moves the unread count", () => {
  const boot = {
    notifications: [
      { id: "a", read_at: null },
      { id: "b", read_at: null },
      { id: "c", read_at: "2026-11-01 00:00:00" },
    ],
    notificationsUnread: 120,
  } as unknown as Bootstrap;
  const ctx = { userId: "u", userName: "Ada", now: new Date("2026-11-25T10:00:00Z") };
  const read = commandOverlay({ action: "notification.bulk", notificationIds: ["a", "c"], op: "read" }, ctx)!.boot!(boot);
  assert.deepEqual([read.notifications.map((n) => !!n.read_at), read.notificationsUnread], [[true, false, true], 119]);
  const unread = commandOverlay({ action: "notification.bulk", notificationIds: ["a", "c"], op: "unread" }, ctx)!.boot!(read);
  assert.equal(unread.notificationsUnread, 121);
  const gone = commandOverlay({ action: "notification.bulk", notificationIds: ["b", "c"], op: "delete" }, ctx)!.boot!(boot);
  assert.deepEqual([gone.notifications.map((n) => n.id), gone.notificationsUnread], [["a"], 119]);
  assert.equal(commandOverlay({ action: "notification.read" }, ctx)!.boot!(boot).notificationsUnread, 0);
});
