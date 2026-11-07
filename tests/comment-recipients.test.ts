// Who a comment notifies (lib/comment-recipients.ts): followers, the page's
// owner, a record's creator and assigned people, earlier commenters and
// mentioned people – never every member of the workspace. And old
// notifications are pruned (lib/notification-retention.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import { daysAgoText } from "../lib/db-driver/dialect";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-comment-recipients-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { withCommentDocument } = await import("../lib/inline-comments");
const { commentAnchor } = await import("../lib/comment-positions");
const { pruneNotifications } = await import("../lib/notification-retention");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
// A workspace with 50 members.
const creator = await user("Creator"),
  wid = await createWorkspace(creator.id, "Fifty"),
  space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const members = await Array.from({ length: 49 }, async (_, i) => await user(`Member ${i}`));
for (const m of members) await run("INSERT INTO members VALUES(?,?,?)", wid, m.id, "editor");
const [follower, pageOwner, earlier, author, recordCreator, assignee, mentioned, outsider] = members;
const recipients = async (where: string, ...params: string[]) =>
  (await all<{ user_id: string }>(`SELECT user_id FROM notifications WHERE ${where} ORDER BY user_id`, ...params)).map((n) => n.user_id);
const sorted = (...people: Identity[]) => people.map((p) => p.id).sort();

test("a page comment in a workspace of 50 notifies only followers, the owner and earlier commenters", async () => {
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM members WHERE workspace_id=?", wid))!.n), 50);
  const pageId = ((await command(creator, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan" })) as { id: string }).id;
  await command(follower, { action: "page.follow", pageId, follow: true });
  await command(creator, { action: "page.owner", pageId, ownerId: pageOwner.id });
  await command(earlier, { action: "comment.create", pageId, body: "First thoughts" });
  // The earlier comment reached the creator (who follows their own page),
  // the follower and the owner.
  assert.deepEqual(await recipients("page_id=? AND kind='comment'", pageId), sorted(creator, follower, pageOwner));
  await run("DELETE FROM notifications");

  await command(author, { action: "comment.create", pageId, body: "Looks good" });
  assert.deepEqual(await recipients("page_id=?", pageId), sorted(creator, follower, pageOwner, earlier));
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications"))!.n), 4);
  assert.equal((await recipients("user_id=?", outsider.id)).length, 0);
  assert.equal((await recipients("user_id=?", author.id)).length, 0);
  await run("DELETE FROM notifications");

  // Someone who stopped following hears nothing more, a disabled account
  // neither.
  await command(follower, { action: "page.follow", pageId, follow: false });
  await run("UPDATE users SET disabled=1 WHERE id=?", pageOwner.id);
  await command(author, { action: "comment.create", pageId, body: "Once more" });
  assert.deepEqual(await recipients("page_id=?", pageId), sorted(creator, earlier));
  await run("UPDATE users SET disabled=0 WHERE id=?", pageOwner.id);
  await run("DELETE FROM notifications");
});

test("a record comment notifies the database's followers, the record's creator and assigned people", async () => {
  const db = ((await command(creator, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tasks", kind: "database" })) as { id: string }).id;
  const row = ((await command(recordCreator, { action: "row.create", pageId: db, cells: { title: "Fix it", assignee: assignee.id } })) as { id: string }).id;
  // A comment on another record does not make its author a participant here.
  const other = ((await command(creator, { action: "row.create", pageId: db, cells: { title: "Other" } })) as { id: string }).id;
  await command(earlier, { action: "comment.create", pageId: db, rowId: other, body: "Elsewhere" });
  await run("DELETE FROM notifications");

  await command(author, { action: "comment.create", pageId: db, rowId: row, body: "Done?" });
  assert.deepEqual(await recipients("page_id=?", db), sorted(creator, recordCreator, assignee));
  assert.ok((await all<{ row_id: string }>("SELECT row_id FROM notifications WHERE page_id=?", db)).every((n) => n.row_id === row));
  await run("DELETE FROM notifications");

  // A private record: only people who may see it.
  await run("UPDATE rows SET access='private' WHERE id=?", row);
  await command(recordCreator, { action: "comment.create", pageId: db, rowId: row, body: "Private now" });
  for (const uid of await recipients("page_id=?", db))
    assert.ok([creator.id, assignee.id, author.id].includes(uid));
  assert.equal((await recipients("user_id=? AND page_id=?", earlier.id, db)).length, 0);
  await run("DELETE FROM notifications");
});

test("a new text comment notifies the same people plus whom it mentions; not the workspace", async () => {
  const pageId = ((await command(creator, { action: "page.create", workspaceId: wid, spaceId: space, title: "Spec" })) as { id: string }).id;
  const html = "<p>Alpha Bravo Charlie</p>";
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  await command(earlier, { action: "comment.create", pageId, body: "Page comment" });
  await run("DELETE FROM notifications");
  const threadId = id();
  await command(author, {
    action: "thread.create",
    pageId,
    threadId,
    messageId: id(),
    anchor: await withCommentDocument(pageId, null, (b, g) => commentAnchor(b, 1, 6, g)),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { userId: mentioned.id, label: "M" } }] }],
    },
  });
  assert.deepEqual(await recipients("thread_id=?", threadId), sorted(creator, earlier, mentioned));
  assert.equal((await one<{ kind: string }>("SELECT kind FROM notifications WHERE user_id=? AND thread_id=?", mentioned.id, threadId))!.kind, "mention");
  await run("DELETE FROM notifications");
});

test("old notifications are pruned: read after 90 days, unread after a year, beyond 1,000 per person", async () => {
  await run("DELETE FROM notifications");
  const add = async (userId: string, age: number, read: boolean) =>
    await run(
      "INSERT INTO notifications(id,user_id,body,kind,created_at,read_at) VALUES(?,?,?,'comment',?,?)",
      id(),
      userId,
      "x",
      daysAgoText(age),
      read ? "2026-01-01 00:00:00" : null,
    );
  await add(follower.id, 100, true); // read, old: goes
  await add(follower.id, 100, false); // unread, 100 days: stays
  await add(follower.id, 400, false); // unread, over a year: goes
  await add(follower.id, 10, true); // recent: stays
  for (let i = 0; i < 1005; i++) await add(author.id, 1, false);
  assert.equal(await pruneNotifications(), 1 + 1 + 5);
  assert.equal((await recipients("user_id=?", follower.id)).length, 2);
  assert.equal((await recipients("user_id=?", author.id)).length, 1000);
  assert.equal(await pruneNotifications(), 0);
});
