// Attachments, page mentions and link previews of page, record and text
// comments (#450, lib/comment-extras.ts): what is stored, who may fetch the
// files, how mentions read for people with and without access, that older
// comments read as before, that the files count as used and as storage,
// and that deleting or editing moves dropped files to the file trash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-comment-attachments-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, pageData } = await import("../lib/api");
const { storeUpload } = await import("../lib/page-upload");
const { readableFile } = await import("../lib/file-access");
const { usedFileIds } = await import("../lib/file-usage");
const { htmlState } = await import("../lib/document-server");
const { commentAnchor } = await import("../lib/comment-positions");
const { withCommentDocument, inlineThreads } = await import("../lib/inline-comments");
const { normalizeCommentContent, commentText } = await import("../lib/comment-content");
const { importedContent } = await import("../lib/comment-extras");
const { englishMessage } = await import("../lib/i18n-errors");
const { exportInlineComments } = await import("../lib/inline-comment-archive");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Olga Owner"),
  reader = await user("Rita Reader"),
  outsider = await user("Otto Outside");
const wid = await createWorkspace(owner.id, "Attachments");
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const privateSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", owner.id);
const create = async (as: Identity, input: Record<string, unknown>) => ((await command(as, input)) as { id: string }).id;
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const upload = async (as: Identity, pageId: string, name = "plan.pdf", mime = "application/pdf", bytes = 1234) => {
  const fid = id();
  await storeUpload(as, await page(pageId), { id: fid, name, mime, content: Buffer.alloc(bytes, 7) });
  return fid;
};
const doc = (text: string, attrs?: Record<string, unknown>, extra: unknown[] = []) => ({
  type: "doc",
  ...(attrs ? { attrs } : {}),
  content: [{ type: "paragraph", content: [...(text ? [{ type: "text", text }] : []), ...extra] }],
});
const files = (...ids: string[]) => ids.map((fid) => ({ src: `/api/files/${fid}`, name: "client name", mime: "text/html", size: 1 }));
const commentsOf = async (as: Identity, pageId: string) =>
  (await pageData(as, pageId)).comments as { id: string; body: string; row_id: string | null; content?: any }[];

const docPage = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan" });
const secret = await create(owner, { action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Secret budget" });
const target = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Roadmap" });

test("a page comment stores its attachments with the stored file's name, type and size; attachments alone are enough", async () => {
  const a = await upload(owner, docPage, "plan.pdf", "application/pdf", 2048),
    b = await upload(owner, docPage, "photo.png", "image/png", 100);
  const one1 = await create(owner, { action: "comment.create", pageId: docPage, body: "ignored", content: doc("See the files", { attachments: files(a, b) }) });
  const two = await create(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("", { attachments: files(b) }) });
  const shown = await commentsOf(reader, docPage);
  const first = shown.find((c) => c.id === one1)!,
    second = shown.find((c) => c.id === two)!;
  assert.equal(first.body, "See the files");
  assert.deepEqual(first.content.attrs.attachments, [
    { src: `/api/files/${a}`, name: "plan.pdf", mime: "application/pdf", size: 2048 },
    { src: `/api/files/${b}`, name: "photo.png", mime: "image/png", size: 100 },
  ]);
  assert.equal(second.body, "");
  assert.equal(second.content.attrs.attachments.length, 1);
  // Neither text nor files: refused.
  await assert.rejects(() => command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("") }));
  // At most 10.
  const many = await Promise.all(Array.from({ length: 11 }, () => upload(owner, docPage, "x.txt", "text/plain", 1)));
  await assert.rejects(() => command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("many", { attachments: files(...many) }) }), /Höchstens 10 Anhänge/);
});

test("only own uploads of the same page can be attached; trashed files cannot", async () => {
  const others = await upload(owner, docPage, "owner.txt", "text/plain", 5);
  // The reader may not attach the owner's file …
  await assert.rejects(() => command(reader, { action: "comment.create", pageId: docPage, body: "", content: doc("x", { attachments: files(others) }) }), /Anhang ist nicht verfügbar/);
  // … nor a file of another page, nor one in the trash.
  const elsewhere = await upload(owner, target, "there.txt", "text/plain", 5);
  await assert.rejects(() => command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("x", { attachments: files(elsewhere) }) }), /Anhang ist nicht verfügbar/);
  const trashed = await upload(owner, docPage, "gone.txt", "text/plain", 5);
  await run("UPDATE files SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", trashed);
  await assert.rejects(() => command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("x", { attachments: files(trashed) }) }), /Anhang ist nicht verfügbar/);
  // A reader (viewer) may attach their own upload.
  const own = await upload(reader, docPage, "mine.txt", "text/plain", 5);
  await command(reader, { action: "comment.create", pageId: docPage, body: "", content: doc("mine", { attachments: files(own) }) });
});

test("attachment files are fetched only by readers of the page, and of a private record", async () => {
  const fid = await upload(owner, docPage, "plan.txt", "text/plain", 10);
  await command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("x", { attachments: files(fid) }) });
  assert.equal((await readableFile(reader, fid)).id, fid);
  await assert.rejects(() => readableFile(outsider, fid), /Berechtigung|nicht gefunden|fehlt/);
  // A record comment's file of a private record stays with the record.
  const db = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tasks", kind: "database" });
  await run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, reader.id);
  const row = await create(owner, { action: "row.create", pageId: db, cells: { title: "Private one" } });
  const rowFile = await upload(owner, db, "contract.pdf", "application/pdf", 10);
  await command(owner, { action: "comment.create", pageId: db, rowId: row, body: "", content: doc("signed", { attachments: files(rowFile) }) });
  assert.equal((await readableFile(reader, rowFile)).id, rowFile);
  await command(owner, { action: "row.access", pageId: db, rowId: row, access: "private", grants: [] });
  await assert.rejects(() => readableFile(reader, rowFile), /fehlt/);
  assert.equal((await readableFile(owner, rowFile)).id, rowFile);
  assert.equal((await commentsOf(reader, db)).filter((c) => c.row_id === row).length, 0);
  await run("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?", wid, reader.id);
});

test("page mentions: the current title for readers, “no access” without a title for others; the author must be able to read the page", async () => {
  const mention = (pageId: string) => ({ type: "pageMention", attrs: { pageId, label: "client label" } });
  const cid = await create(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("See ", undefined, [mention(target), { type: "text", text: " and " }, mention(secret)]) });
  const stored = (await one<{ rich_body: string; body: string }>("SELECT rich_body,body FROM comments WHERE id=?", cid))!;
  assert.match(stored.body, /@Roadmap/);
  assert.equal(JSON.parse(stored.rich_body).content[0].content[1].attrs.label, "Roadmap");
  await command(owner, { action: "page.update", pageId: target, patch: { title: "Roadmap 2027" } });
  const forOwner = (await commentsOf(owner, docPage)).find((c) => c.id === cid)!;
  const forReader = (await commentsOf(reader, docPage)).find((c) => c.id === cid)!;
  assert.equal(forOwner.content.content[0].content[1].attrs.label, "Roadmap 2027");
  assert.equal(forOwner.content.content[0].content[3].attrs.label, "Secret budget");
  assert.deepEqual(forReader.content.content[0].content[3].attrs, { pageId: secret, label: "", noAccess: true });
  // Neither the formatted content nor the plain text tells the reader the title.
  assert.doesNotMatch(JSON.stringify(forReader), /Secret budget/);
  assert.match(forReader.body, /@Roadmap 2027/);
  // The reader cannot mention a page they may not read.
  await assert.rejects(() => command(reader, { action: "comment.create", pageId: docPage, body: "", content: doc("x ", undefined, [mention(secret)]) }), /erwähnte Seite ist nicht verfügbar/);
  // Mentioning a page notifies nobody besides the usual recipients.
  await run("DELETE FROM notifications");
  await command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("ping ", undefined, [mention(target)]) });
  assert.equal((await all("SELECT * FROM notifications WHERE kind='mention'")).length, 0);
});

test("older comments read unchanged; plain API comments still work", async () => {
  const legacy = id();
  await run("INSERT INTO comments(id,page_id,row_id,author_id,body) VALUES(?,?,?,?,?)", legacy, docPage, null, owner.id, "Old text with https://example.org");
  const plain = await create(owner, { action: "comment.create", pageId: docPage, body: "Plain via API" });
  const all2 = await commentsOf(reader, docPage);
  const old = all2.find((c) => c.id === legacy)!;
  assert.equal(old.body, "Old text with https://example.org");
  assert.equal(old.content, null);
  const api = all2.find((c) => c.id === plain)!;
  assert.equal(api.body, "Plain via API");
  assert.equal(api.content, null);
  // A formatted comment of an older version (no attrs, no page mentions) as before.
  const before = normalizeCommentContent(doc("Hello"));
  assert.deepEqual(before, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] });
  assert.equal(commentText(before), "Hello");
});

test("attachments count as used files and as the uploader's storage; the notification names only their number", async () => {
  const fid = await upload(reader, docPage, "big.bin", "application/octet-stream", 5000);
  assert.equal((await usedFileIds(wid, [fid])).size, 0);
  await run("DELETE FROM notifications");
  await command(reader, { action: "comment.create", pageId: docPage, body: "", content: doc("Two files", { attachments: files(fid, await upload(reader, docPage)) }) });
  assert.equal((await usedFileIds(wid, [fid])).size, 1);
  const used = await one<{ n: number }>("SELECT COALESCE(SUM(size),0) n FROM files WHERE created_by=?", reader.id);
  assert.ok(Number(used!.n) >= 5000);
  const note = (await all<{ body: string }>("SELECT body FROM notifications WHERE user_id=?", owner.id)).map((n) => n.body);
  assert.deepEqual(note, ["Rita Reader kommentiert „Plan“ · 📎 2 Anhänge"]);
  assert.equal(englishMessage(note[0]), "Rita Reader commented on “Plan” · 📎 2 attachments");
  assert.equal(englishMessage("A hat dich in einem Kommentar in „P“ erwähnt · 📎 1 Anhang"), "A mentioned you in a comment in “P” · 📎 1 attachment");
});

test("text comments and replies: attachments and page mentions; editing or deleting moves dropped files to the trash", async () => {
  const html = "<p>Alpha Bravo Charlie</p>";
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), docPage);
  const anchor = await withCommentDocument(docPage, null, (b, g) => commentAnchor(b, 1, 6, g));
  const a = await upload(owner, docPage, "a.png", "image/png", 10),
    b = await upload(owner, docPage, "b.txt", "text/plain", 10),
    shared = await upload(owner, docPage, "shared.txt", "text/plain", 10);
  // `shared` is also used by a page comment: it must stay.
  await command(owner, { action: "comment.create", pageId: docPage, body: "", content: doc("uses shared", { attachments: files(shared) }) });
  const threadId = id(),
    messageId = id();
  await command(owner, {
    action: "thread.create",
    pageId: docPage,
    threadId,
    messageId,
    anchor,
    body: "",
    content: doc("With files ", { attachments: files(a, b, shared), previews: [{ url: "https://example.org/x", title: "Example", site: "example.org", description: "d", image: "https://example.org/i.png" }, { url: "https://not-in-text.example", title: "t", site: "", description: "", image: "" }] }, [
      { type: "pageMention", attrs: { pageId: target } },
      { type: "text", text: " link", marks: [{ type: "link", attrs: { href: "https://example.org/x" } }] },
    ]),
  });
  const replyId = id();
  const replyFile = await upload(reader, docPage, "reply.jpg", "image/jpeg", 10);
  await command(reader, { action: "thread.reply", pageId: docPage, threadId, messageId: replyId, body: "", content: doc("", { attachments: files(replyFile) }) });
  let thread = (await inlineThreads(reader, docPage, undefined, false))[0];
  assert.equal(thread.messages[0].content!.attrs!.attachments!.length, 3);
  // Only previews of links the comment has are kept.
  assert.deepEqual(thread.messages[0].content!.attrs!.previews!.map((p) => p.url), ["https://example.org/x"]);
  assert.equal(thread.messages[0].content!.content![0].content![1].attrs!.label, "Roadmap 2027");
  assert.equal(thread.messages[1].content!.attrs!.attachments![0].name, "reply.jpg");
  // Summaries name the number of files.
  assert.equal((await inlineThreads(reader, docPage, undefined, true))[0].messages[0].attachmentCount, 3);
  // Archives keep the files with the message.
  assert.equal((await exportInlineComments(docPage))[0].messages[0].content!.attrs!.attachments!.length, 3);
  // Editing away `b` and `shared`: `b` goes to the trash, `shared` (used elsewhere) stays.
  await command(owner, { action: "thread.edit", pageId: docPage, threadId, messageId, version: 1, body: "", content: doc("Only a", { attachments: files(a) }) });
  const state = async (fid: string) => (await one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", fid))!.deleted_at;
  assert.ok(await state(b));
  assert.equal(await state(shared), null);
  assert.equal(await state(a), null);
  thread = (await inlineThreads(owner, docPage, undefined, false))[0];
  assert.deepEqual(thread.messages[0].content!.attrs!.attachments!.map((x) => x.name), ["a.png"]);
  // Deleting the reply trashes its file (uploaded by its author).
  await command(reader, { action: "thread.deleteMessage", pageId: docPage, threadId, messageId: replyId, version: 1 });
  assert.ok(await state(replyFile));
  // A file in the trash shows as missing where it is still attached.
  await run("UPDATE files SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", a);
  thread = (await inlineThreads(owner, docPage, undefined, false))[0];
  assert.equal(thread.messages[0].content!.attrs!.attachments![0].missing, true);
});

test("imported content: people become historic, unknown pages text, files the imported ones", async () => {
  const fid = id(),
    next = id(),
    pid = id();
  const content = normalizeCommentContent(
    doc("Hi ", { attachments: [{ src: `/api/files/${fid}`, name: "a", mime: "", size: 1 }, { src: `/api/files/${id()}`, name: "b", mime: "", size: 1 }] }, [
      { type: "mention", attrs: { userId: owner.id, label: "Olga" } },
      { type: "pageMention", attrs: { pageId: pid, label: "Elsewhere" } },
    ]),
  );
  const imported = await importedContent(content, (src) => (src.endsWith(fid) ? `/api/files/${next}` : null));
  assert.deepEqual(imported.attrs!.attachments!.map((a) => a.src), [`/api/files/${next}`]);
  assert.equal(imported.content![0].content![1].attrs!.userId, null);
  assert.deepEqual(imported.content![0].content![2], { type: "text", text: "@Elsewhere" });
  assert.equal(commentText(imported), commentText(content));
});
