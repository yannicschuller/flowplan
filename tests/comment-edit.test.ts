// Editing and deleting page and record comments (#450, lib/api.ts
// comment.edit / comment.delete), as text comments (lib/inline-comments.ts
// thread.edit / thread.deleteMessage): only the author, with the version
// they saw; `body` follows the formatted content; files the comment no
// longer has go to the file trash; newly mentioned people are notified,
// nobody else; the search follows; a private record's comments stay with
// the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-comment-edit-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, pageData } = await import("../lib/api");
const { storeUpload } = await import("../lib/page-upload");
const { searchWorkspace } = await import("../lib/search-index");
const { commandOverlay } = await import("../lib/optimistic-commands");
const { englishMessage } = await import("../lib/i18n-errors");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Olga Owner"),
  editor = await user("Erik Editor"),
  reader = await user("Rita Reader"),
  outsider = await user("Otto Outside");
const wid = await createWorkspace(owner.id, "Comment edits");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const create = async (as: Identity, input: Record<string, unknown>) => ((await command(as, input)) as { id: string }).id;
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const upload = async (as: Identity, pageId: string, name = "plan.pdf") => {
  const fid = id();
  await storeUpload(as, await page(pageId), { id: fid, name, mime: "application/pdf", content: Buffer.alloc(100, 7) });
  return fid;
};
const doc = (text: string, attrs?: Record<string, unknown>, extra: unknown[] = []) => ({
  type: "doc",
  ...(attrs ? { attrs } : {}),
  content: [{ type: "paragraph", content: [...(text ? [{ type: "text", text }] : []), ...extra] }],
});
const files = (...ids: string[]) => ids.map((fid) => ({ src: `/api/files/${fid}` }));
const mention = (who: Identity) => ({ type: "mention", attrs: { userId: who.id, label: who.name } });
type Shown = { id: string; body: string; row_id: string | null; version?: number; edited_at?: string | null; content?: any };
const commentsOf = async (as: Identity, pageId: string) => (await pageData(as, pageId)).comments as Shown[];
const stored = async (cid: string) =>
  await one<{ body: string; rich_body: string | null; version: number; edited_at: string | null }>("SELECT body,rich_body,version,edited_at FROM comments WHERE id=?", cid);
const trashed = async (fid: string) => !!(await one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", fid))?.deleted_at;

const docPage = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan" });

test("only the author may edit or delete; editors, owners and readers of someone else's comment may not", async () => {
  const cid = await create(reader, { action: "comment.create", pageId: docPage, body: "Reader's note" });
  for (const as of [owner, editor, outsider])
    for (const action of ["comment.edit", "comment.delete"])
      await assert.rejects(
        () => command(as, { action, pageId: docPage, commentId: cid, version: 1, body: "taken over" }),
        as === outsider ? /Berechtigung|nicht gefunden|Zugriff/ : /Nur eigene Kommentare können geändert werden/,
      );
  assert.equal(englishMessage("Nur eigene Kommentare können geändert werden."), "Only your own comments can be changed.");
  assert.equal((await stored(cid))!.body, "Reader's note");
  // A viewer may edit their own comment (commenting needs read access only).
  const result = (await command(reader, { action: "comment.edit", pageId: docPage, commentId: cid, version: 1, body: "Reader's better note" })) as { version: number };
  assert.equal(result.version, 2);
  // Guests' comments (shared_comments) are not page comments: not found.
  const guest = id();
  await run("INSERT INTO shared_comments(id,page_id,name,body) VALUES(?,?,?,?)", guest, docPage, "Gast", "hi");
  await assert.rejects(() => command(owner, { action: "comment.delete", pageId: docPage, commentId: guest, version: 1 }), /Kommentar nicht gefunden/);
});

test("an edit replaces text and content, keeps body in sync, marks the comment edited and needs the current version", async () => {
  const cid = await create(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("First draft") });
  const before = (await commentsOf(reader, docPage)).find((c) => c.id === cid)!;
  assert.equal(before.version, 1);
  assert.equal(before.edited_at, null);
  await command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 1, body: "x", content: doc("Second **draft**") });
  const row = (await stored(cid))!;
  assert.equal(row.body, "Second **draft**");
  assert.equal(JSON.parse(row.rich_body!).content[0].content[0].text, "Second **draft**");
  assert.equal(row.version, 2);
  assert.ok(row.edited_at);
  const after = (await commentsOf(reader, docPage)).find((c) => c.id === cid)!;
  assert.equal(after.body, "Second **draft**");
  assert.equal(after.version, 2);
  assert.ok(after.edited_at);
  // The version seen before the edit is refused – the draft stays with the client.
  await assert.rejects(
    () => command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 1, body: "stale" }),
    /Dieser Kommentar wurde inzwischen geändert/,
  );
  await assert.rejects(() => command(owner, { action: "comment.delete", pageId: docPage, commentId: cid, version: 1 }), /inzwischen geändert/);
  // A plain edit (no content) of a formatted comment: plain from then on.
  await command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 2, body: "  Plain again  " });
  assert.deepEqual({ ...(await stored(cid))!, edited_at: null }, { body: "Plain again", rich_body: null, version: 3, edited_at: null });
  // Empty is refused, as on create.
  await assert.rejects(() => command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 3, body: "", content: doc("") }));
});

test("files removed in an edit or by deleting go to the file trash unless used elsewhere; kept ones stay", async () => {
  const a = await upload(owner, docPage, "a.pdf"),
    b = await upload(owner, docPage, "b.pdf"),
    shared = await upload(owner, docPage, "shared.pdf");
  const cid = await create(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("files", { attachments: files(a, b, shared) }) });
  // `shared` is in another comment as well.
  await create(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("also", { attachments: files(shared) }) });
  // The edit keeps a (allowed: the comment already had it), drops b and shared.
  await command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 1, body: "", content: doc("fewer files", { attachments: files(a) }) });
  assert.equal(await trashed(b), true);
  assert.equal(await trashed(shared), false);
  assert.equal(await trashed(a), false);
  assert.deepEqual(JSON.parse((await stored(cid))!.rich_body!).attrs.attachments.map((f: { src: string }) => f.src), [`/api/files/${a}`]);
  // Deleting the comment: its last file goes as well, with the reactions.
  await command(reader, { action: "comment.react", pageId: docPage, commentId: cid, emoji: "👍", active: true });
  await command(owner, { action: "comment.delete", pageId: docPage, commentId: cid, version: 2 });
  assert.equal(await stored(cid), undefined);
  assert.equal(await trashed(a), true);
  assert.equal((await all("SELECT * FROM comment_reactions WHERE comment_id=?", cid)).length, 0);
  assert.equal((await commentsOf(owner, docPage)).some((c) => c.id === cid), false);
  // Gone: a second deletion finds nothing.
  await assert.rejects(() => command(owner, { action: "comment.delete", pageId: docPage, commentId: cid, version: 2 }), /Kommentar nicht gefunden/);
});

test("an edit notifies only people mentioned anew, never the author or the earlier mentions; a delete notifies nobody", async () => {
  const cid = await create(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("Hi ", undefined, [mention(editor)]) });
  await run("DELETE FROM notifications");
  await command(owner, {
    action: "comment.edit",
    pageId: docPage,
    commentId: cid,
    version: 1,
    body: "",
    content: doc("Hi ", undefined, [mention(editor), { type: "text", text: " and " }, mention(reader), { type: "text", text: " " }, mention(owner)]),
  });
  const sent = await all<{ user_id: string; kind: string; body: string }>("SELECT user_id,kind,body FROM notifications");
  assert.deepEqual(sent.map((n) => [n.user_id, n.kind]), [[reader.id, "mention"]]);
  assert.match(sent[0].body, /hat dich in einem Kommentar in „Plan“ erwähnt/);
  // The same mentions again: nobody.
  await command(owner, {
    action: "comment.edit",
    pageId: docPage,
    commentId: cid,
    version: 2,
    body: "",
    content: doc("Hello ", undefined, [mention(reader)]),
  });
  assert.equal((await all("SELECT 1 FROM notifications")).length, 1);
  // Plain text: "@Name" counts the same way.
  const plain = await create(owner, { action: "comment.create", pageId: docPage, body: "ping @Erik Editor" });
  await run("DELETE FROM notifications");
  await command(owner, { action: "comment.edit", pageId: docPage, commentId: plain, version: 1, body: "ping @Erik Editor and @Rita Reader" });
  assert.deepEqual((await all<{ user_id: string }>("SELECT user_id FROM notifications")).map((n) => n.user_id), [reader.id]);
  // Someone without access to the page cannot be mentioned.
  await assert.rejects(
    () => command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 3, body: "", content: doc("x ", undefined, [mention(outsider)]) }),
    /erwähnte Person hat keinen Zugriff/,
  );
  await run("DELETE FROM notifications");
  await command(owner, { action: "comment.delete", pageId: docPage, commentId: cid, version: 3 });
  assert.equal((await all("SELECT 1 FROM notifications")).length, 0);
});

test("the search finds the edited text, not the old one, and nothing after deleting", async () => {
  const cid = await create(owner, { action: "comment.create", pageId: docPage, body: "zebrafinch remark" });
  assert.ok((await searchWorkspace(owner, wid, "zebrafinch", { kind: "comment" })).length > 0);
  await command(owner, { action: "comment.edit", pageId: docPage, commentId: cid, version: 1, body: "", content: doc("hummingbird remark") });
  assert.equal((await searchWorkspace(owner, wid, "zebrafinch", { kind: "comment" })).length, 0);
  assert.ok((await searchWorkspace(owner, wid, "hummingbird", { kind: "comment" })).length > 0);
  await command(owner, { action: "comment.delete", pageId: docPage, commentId: cid, version: 2 });
  assert.equal((await searchWorkspace(owner, wid, "hummingbird", { kind: "comment" })).length, 0);
});

test("a private record's comments: only with access to the record; the search and mentions respect it", async () => {
  const db = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tasks", kind: "database" });
  const row = await create(owner, { action: "row.create", pageId: db, cells: { title: "Private one" } });
  const cid = await create(editor, { action: "comment.create", pageId: db, rowId: row, body: "okapi estimate" });
  // Private to the owner: the editor wrote the comment but no longer sees the record.
  await command(owner, { action: "row.access", pageId: db, rowId: row, access: "private", grants: [] });
  await assert.rejects(() => command(editor, { action: "comment.edit", pageId: db, commentId: cid, version: 1, body: "changed" }), /nicht gefunden|Berechtigung|Zugriff/);
  await assert.rejects(() => command(editor, { action: "comment.delete", pageId: db, commentId: cid, version: 1 }));
  assert.equal((await stored(cid))!.body, "okapi estimate");
  // Back for the editor: edits work, the reader still sees nothing of it.
  await command(owner, { action: "row.access", pageId: db, rowId: row, access: "private", grants: [{ userId: editor.id, role: "editor" }] });
  await command(editor, { action: "comment.edit", pageId: db, commentId: cid, version: 1, body: "", content: doc("okapi final ", undefined, [mention(reader)]) });
  assert.equal((await commentsOf(reader, db)).some((c) => c.id === cid), false);
  assert.equal((await searchWorkspace(reader, wid, "okapi", { kind: "comment" })).length, 0);
  assert.ok((await searchWorkspace(editor, wid, "okapi", { kind: "comment" })).length > 0);
  // The reader may read the database but not the record: not notified.
  assert.equal((await all("SELECT 1 FROM notifications WHERE user_id=? AND row_id=?", reader.id, row)).length, 0);
});

test("optimistic layers: an edit shows at once marked edited, a deletion removes the comment", () => {
  const comment = { id: "c1", page_id: "p1", row_id: null, author_id: "u1", name: "U", body: "old", resolved: 0, created_at: "2026-01-01 00:00:00", version: 1, edited_at: null };
  const data = { page: { id: "p1" } as Page, comments: [comment] };
  const ctx = { userId: "u1", userName: "U", now: new Date("2026-11-23T10:00:00Z") };
  const edited = commandOverlay({ action: "comment.edit", pageId: "p1", commentId: "c1", version: 1, body: "new", content: doc("new") }, ctx)!.page!(data);
  assert.equal(edited.comments![0].body, "new");
  assert.equal(edited.comments![0].edited_at, "2026-11-23 10:00:00");
  assert.equal(edited.comments![0].version, 2);
  assert.equal(commandOverlay({ action: "comment.delete", pageId: "p1", commentId: "c1", version: 1 }, ctx)!.page!(data).comments!.length, 0);
  // Other pages stay as they are.
  assert.equal(commandOverlay({ action: "comment.delete", pageId: "p2", commentId: "c1", version: 1 }, ctx)!.page!(data).comments!.length, 1);
});
