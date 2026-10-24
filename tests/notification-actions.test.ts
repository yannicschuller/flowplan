import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notification-actions-"));
const { all, id, one, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { processDueTasks } = await import("../lib/doc-tasks");
const { processDateReminders } = await import("../lib/date-reminders");
const { flushPushQueue } = await import("../lib/push");
const { registerMobileDevice, identityFromDeviceToken } = await import("../lib/mobile-devices");
const { notificationAction, nextDay } = await import("../lib/notification-actions");
const { NOTIFICATION_CATEGORIES, notificationCategory } = await import("../lib/notification-targets");

function account(name: string) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
const anna = account("Anna"),
  ben = account("Ben"),
  stranger = account("Stranger");
const wid = createWorkspace(anna.user.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.user.id, "editor");
const space = bootstrap(anna.user, wid).spaces[0].id;
const pushToken = `ExponentPushToken[${randomUUID().replaceAll("-", "").slice(0, 22)}]`;
const { deviceToken } = registerMobileDevice(ben.user, ben.token, { installationId: randomUUID(), platform: "ios", pushToken });
// What the endpoint works with: the person behind the device token.
const phone = identityFromDeviceToken(`Bearer ${deviceToken}`)!;
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

async function pushes() {
  const sent: { data: { url: string; notificationId?: string }; categoryId?: string; body: string }[] = [];
  await flushPushQueue(
    async () => assert.fail("No Web Push"),
    async (message) => {
      sent.push(message);
    },
  );
  return sent;
}
const withContent = async <T>(fn: () => Promise<T>) => {
  process.env.MOBILE_PUSH_CONTENT = "on";
  try {
    return await fn();
  } finally {
    delete process.env.MOBILE_PUSH_CONTENT;
  }
};
const latest = (user: Identity, kind: string) =>
  one<{ id: string; read_at: string | null }>("SELECT id,read_at FROM notifications WHERE user_id=? AND kind=? ORDER BY rowid DESC LIMIT 1", user.id, kind)!;

// A document with a task for Ben, due today.
const docId = (command(anna.user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Sprint", kind: "document" }) as { id: string }).id;
function writeDoc(html: string) {
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", docId)!.generation);
  run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", docId);
  command(anna.user, { action: "document.sync", workspaceId: wid, pageId: docId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
}
const task = (text: string, due: string) =>
  `<li data-type="taskItem" data-checked="false" data-due="${due}"><p>${text} <span data-mention="${ben.user.id}" class="mention">@Ben</span></p></li>`;

test("a due task's push carries its notification and the task buttons – only with content", async () => {
  writeDoc(`<ul data-type="taskList">${task("Angebot schreiben", today)}${task("Rechnung prüfen", today)}</ul>`);
  await pushes(); // the assignments
  assert.equal(processDueTasks(today), 2);
  const sent = await withContent(pushes);
  assert.equal(sent.length, 2);
  for (const message of sent) {
    assert.equal(message.categoryId, NOTIFICATION_CATEGORIES.task);
    assert.ok(message.data.notificationId);
    assert.match(message.body, /Heute fällig/);
  }
  // Without the text on the lock screen only "Mark as read".
  const reminder = one<{ id: string; kind: string; page_id: string; row_id: string | null; thread_id: string | null }>(
    "SELECT id,kind,page_id,row_id,thread_id FROM notifications WHERE id=?",
    sent[0].data.notificationId!,
  )!;
  assert.equal(notificationCategory(reminder, false), NOTIFICATION_CATEGORIES.read);
  assert.equal(notificationCategory(reminder, true), NOTIFICATION_CATEGORIES.task);
});

test("“Tomorrow” and “Done” act on the task the reminder is about", async () => {
  const reminders = all<{ id: string; body: string }>("SELECT id,body FROM notifications WHERE user_id=? AND kind='reminder' ORDER BY body", ben.user.id);
  const offer = reminders.find((r) => r.body.includes("Angebot"))!;
  const invoice = reminders.find((r) => r.body.includes("Rechnung"))!;
  // The task moved meanwhile: it is found again by its text.
  writeDoc(`<p>Neu oben</p><ul data-type="taskList">${task("Rechnung prüfen", today)}${task("Angebot schreiben", today)}</ul>`);
  const later = await notificationAction(phone, { action: "tomorrow", notificationId: offer.id, today });
  assert.equal(later.due, nextDay(today));
  const tasks = () => all<{ text: string; due: string | null; checked: number }>("SELECT text,due,checked FROM doc_tasks WHERE page_id=? ORDER BY idx", docId);
  assert.equal(tasks().find((t) => t.text.startsWith("Angebot"))!.due, nextDay(today));
  assert.equal(tasks().find((t) => t.text.startsWith("Rechnung"))!.due, today);
  assert.ok(one<{ read_at: string | null }>("SELECT read_at FROM notifications WHERE id=?", offer.id)!.read_at);

  const done = await notificationAction(phone, { action: "done", notificationId: invoice.id });
  assert.equal(done.ok, true);
  assert.equal(typeof done.unread, "number");
  assert.equal(tasks().find((t) => t.text.startsWith("Rechnung"))!.checked, 1);
  // Again: nothing changes, no error.
  await notificationAction(phone, { action: "done", notificationId: invoice.id });

  // A task that is gone gives 409 instead of ticking off another one.
  writeDoc(`<ul data-type="taskList">${task("Ganz anders", today)}</ul>`);
  await assert.rejects(notificationAction(phone, { action: "done", notificationId: offer.id }), (e: { status?: number }) => e.status === 409);
});

test("a record's date reminder: done sets the done state, tomorrow keeps the time", async () => {
  const dbId = (command(anna.user, { action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Aufgaben" }) as { id: string }).id;
  command(anna.user, {
    action: "database.update",
    pageId: dbId,
    version: database(dbId).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    ],
    views: database(dbId).views,
  });
  const soon = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const rowId = (command(anna.user, { action: "row.create", pageId: dbId, cells: { title: "Bericht", due: soon, status: "Offen" } }) as { id: string }).id;
  command(ben.user, { action: "reminder.set", pageId: dbId, rowId, fieldId: "due", offset: 0, timeZone: "UTC" });
  assert.equal(processDateReminders(Date.now() + 120_000), 1);
  const sent = await withContent(pushes);
  const message = sent.find((m) => m.body.includes("Bericht"))!;
  assert.equal(message.categoryId, NOTIFICATION_CATEGORIES.task);
  const notificationId = message.data.notificationId!;

  const cells = () => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId)!.cells) as Record<string, string>;
  const moved = await notificationAction(phone, { action: "tomorrow", notificationId, today: soon.slice(0, 10) });
  assert.equal(cells().due, `${nextDay(soon.slice(0, 10))}${soon.slice(10)}`);
  assert.equal(moved.due, cells().due);
  // Never back: a date further ahead moves one day on.
  await notificationAction(phone, { action: "tomorrow", notificationId, today: "2020-01-01" });
  assert.equal(cells().due.slice(0, 10), nextDay(nextDay(soon.slice(0, 10))));
  await notificationAction(phone, { action: "done", notificationId });
  assert.equal(cells().status, "Erledigt");

  // A database without "done": the reminder only offers "Mark as read".
  const plain = (command(anna.user, { action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Termine" }) as { id: string }).id;
  command(anna.user, {
    action: "database.update",
    pageId: plain,
    version: database(plain).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "when", name: "Wann", type: "date" },
    ],
    views: database(plain).views,
  });
  const meeting = (command(anna.user, { action: "row.create", pageId: plain, cells: { title: "Treffen", when: soon } }) as { id: string }).id;
  command(ben.user, { action: "reminder.set", pageId: plain, rowId: meeting, fieldId: "when", offset: 0, timeZone: "UTC" });
  processDateReminders(Date.now() + 120_000);
  const [only] = (await withContent(pushes)).filter((m) => m.body.includes("Treffen"));
  assert.equal(only.categoryId, NOTIFICATION_CATEGORIES.read);
});

test("“Reply” answers the comment thread or comments on the page", async () => {
  command(anna.user, { action: "comment.create", pageId: docId, body: "Kannst du das prüfen?" });
  const [comment] = (await withContent(pushes)).filter((m) => m.categoryId === NOTIFICATION_CATEGORIES.comment);
  assert.ok(comment, "comments get the reply buttons");
  const before = Number(one<{ n: number }>("SELECT COUNT(*) n FROM comments WHERE page_id=?", docId)!.n);
  await notificationAction(phone, { action: "reply", notificationId: comment.data.notificationId!, text: "Mache ich morgen." });
  const reply = one<{ author_id: string; body: string }>("SELECT author_id,body FROM comments WHERE page_id=? ORDER BY rowid DESC LIMIT 1", docId)!;
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM comments WHERE page_id=?", docId)!.n), before + 1);
  assert.equal(reply.author_id, ben.user.id);
  assert.equal(reply.body, "Mache ich morgen.");
  // Anna hears about the answer as about any comment.
  assert.ok(latest(anna.user, "comment"));

  // A thread: the answer goes into it.
  const threadId = randomUUID();
  run("INSERT INTO inline_threads(id,page_id,row_id,author_id,anchor) VALUES(?,?,?,?,?)", threadId, docId, null, anna.user.id, "{}");
  run("INSERT INTO inline_messages(id,thread_id,author_id,author_name,body) VALUES(?,?,?,?,?)", randomUUID(), threadId, anna.user.id, "Anna", "Passt das?");
  const threadNote = id();
  run("INSERT INTO notifications(id,user_id,body,page_id,thread_id,kind) VALUES(?,?,?,?,?,'mention')", threadNote, ben.user.id, "Anna hat dich erwähnt", docId, threadId);
  const [mention] = (await withContent(pushes)).filter((m) => m.data.notificationId === threadNote);
  assert.equal(mention.categoryId, NOTIFICATION_CATEGORIES.comment);
  const result = await notificationAction(phone, { action: "reply", notificationId: threadNote, text: "Ja." });
  assert.equal(result.action, "reply");
  const messages = all<{ body: string; author_id: string }>("SELECT body,author_id FROM inline_messages WHERE thread_id=? ORDER BY created_at,rowid", threadId);
  assert.deepEqual(messages.map((m) => m.body), ["Passt das?", "Ja."]);
  assert.equal(messages[1].author_id, ben.user.id);
  assert.ok(one<{ read_at: string | null }>("SELECT read_at FROM notifications WHERE id=?", threadNote)!.read_at);
});

test("“Mark as read”, and what the buttons refuse", async () => {
  const note = id();
  run("INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'share')", note, ben.user.id, "Geteilt", docId);
  const [shared] = (await withContent(pushes)).filter((m) => m.data.notificationId === note);
  assert.equal(shared.categoryId, NOTIFICATION_CATEGORIES.read);
  const unreadBefore = Number(one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", ben.user.id)!.n);
  const read = await notificationAction(phone, { action: "read", notificationId: note });
  assert.equal(read.unread, unreadBefore - 1);
  // Not a task, not a comment.
  await assert.rejects(notificationAction(phone, { action: "done", notificationId: note }), (e: { status?: number }) => e.status === 400);
  await assert.rejects(notificationAction(phone, { action: "reply", notificationId: note, text: "Hallo" }), (e: { status?: number }) => e.status === 400);
  // Someone else's notification does not exist for this phone.
  await assert.rejects(notificationAction(stranger.user, { action: "read", notificationId: note }), (e: { status?: number }) => e.status === 404);
  // Empty replies and unknown buttons are invalid.
  await assert.rejects(notificationAction(phone, { action: "reply", notificationId: note, text: "  " }));
  await assert.rejects(notificationAction(phone, { action: "delete", notificationId: note }));
});
