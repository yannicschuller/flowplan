// Comment pins on whiteboards (#455, lib/whiteboard-comments.ts and
// lib/whiteboard-comments-server.ts): formatted content read back safely,
// page mentions stored without titles and resolved per reader, "@Name"
// notifies once and only who may read the board, attachments of deleted
// comments go to the file trash, and the pin's colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-whiteboard-comments-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, pageData } = await import("../lib/api");
const { storeUpload } = await import("../lib/page-upload");
const { englishMessage } = await import("../lib/i18n-errors");
const {
  boardCommentBadge,
  boardCommentColor,
  boardMentionKeys,
  boardMessageContent,
  boardMessageFiles,
  boardMessageText,
  editedBoardMessage,
  mayChangeBoardMessage,
  storedBoardCommentColor,
  storedBoardMessage,
  withMentionTitles,
  withoutBoardMessage,
} = await import("../lib/whiteboard-comments");
const { BOARD_MENTION_KEEP_DAYS, NOTIFY_WINDOW_MS, boardMentionTitles, notifyBoardMentions, trashBoardCommentFiles } = await import(
  "../lib/whiteboard-comments-server"
);
const { boardExtras } = await import("../lib/whiteboard-embeds");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Olga Owner"),
  editor = await user("Ed Editor"),
  outsider = await user("Otto Outside");
const wid = await createWorkspace(owner.id, "Boards");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const privateSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", owner.id);
const create = async (input: Record<string, unknown>) => ((await command(owner, input)) as { id: string }).id;
const board = await create({ action: "page.create", workspaceId: wid, spaceId: space, title: "Workshop", kind: "whiteboard" });
const roadmap = await create({ action: "page.create", workspaceId: wid, spaceId: space, title: "Roadmap" });
const secret = await create({ action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Secret budget" });
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

// A browser on the board: its Yjs document and the sync.
async function browser(who: Identity) {
  const data = (await pageData(who, board)) as { whiteboard: { state: string; generation: string } };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
  let vector = Y.encodeStateVector(doc);
  return {
    doc,
    items: doc.getMap<Y.Map<unknown>>("items"),
    async sync() {
      const update = Y.encodeStateAsUpdate(doc, vector);
      vector = Y.encodeStateVector(doc);
      const result = (await command(who, { action: "whiteboard.sync", pageId: board, generation: data.whiteboard.generation, update: b64(update) })) as { state: string };
      Y.applyUpdate(doc, Buffer.from(result.state, "base64"), "remote");
    },
  };
}
const doc = (...inline: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content: inline }] });

test("a formatted message is read back rebuilt; anything invalid shows as its plain text", () => {
  const content = doc({ type: "text", text: "Bitte ", marks: [{ type: "bold" }] }, { type: "text", text: "prüfen", marks: [{ type: "link", attrs: { href: "https://example.org" } }] });
  assert.deepEqual(boardMessageContent({ content }), content);
  assert.equal(boardMessageContent({ content: { type: "doc", content: [{ type: "script", text: "x" }] } }), null);
  assert.equal(boardMessageContent({ content: doc({ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }) }), null);
  assert.equal(boardMessageContent({}), null);
  assert.equal(boardMessageText({ text: "plain", content: { evil: true } }), "plain");
});

test("page mentions are stored without their title and shown per reader", () => {
  const written = doc({ type: "text", text: "Siehe " }, { type: "pageMention", attrs: { pageId: secret, label: "Secret budget" } });
  const stored = storedBoardMessage(written as never);
  assert.ok(!JSON.stringify(stored.content).includes("Secret budget"));
  assert.equal(stored.text, "Siehe @…");
  assert.deepEqual(boardMentionKeys([stored.content]), [secret]);
  const allowed = withMentionTitles(stored.content, { [secret]: "Secret budget" });
  assert.match(JSON.stringify(allowed), /Secret budget/);
  const refused = withMentionTitles(stored.content, { [secret]: null });
  assert.match(JSON.stringify(refused), /"noAccess":true/);
  assert.ok(!JSON.stringify(refused).includes("Secret budget"));
});

test("readers get the titles of mentioned pages they may read, and no others", async () => {
  const titles = await boardMentionTitles(editor, board, [roadmap, secret, "nonsense", `${roadmap}:${id()}`]);
  assert.equal(titles[roadmap], "Roadmap");
  assert.equal(titles[secret], null);
  assert.ok(!("nonsense" in titles));
  assert.equal(titles[`${roadmap}:${roadmap}`], undefined);
  assert.equal((await boardMentionTitles(owner, board, [secret]))[secret], "Secret budget");
  await assert.rejects(() => boardMentionTitles(outsider, board, [roadmap]));
  await assert.rejects(() => boardMentionTitles(owner, roadmap, [roadmap]), (e: Error) => englishMessage(e.message) === "Not a whiteboard.");
});

test("a mentioned person hears of a new message once, if they may read the board", async () => {
  const b = await browser(editor);
  const pin = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ type: "comment", x: 0, y: 0, w: 32, h: 32 })) pin.set(k, v);
  const messages = new Y.Array<unknown>();
  pin.set("messages", messages);
  b.items.set("pin-1", pin);
  const content = doc({ type: "mention", attrs: { userId: owner.id, label: "Olga Owner" } }, { type: "mention", attrs: { userId: outsider.id, label: "Otto" } }, { type: "text", text: " schau mal" });
  const stored = storedBoardMessage(content as never);
  messages.push([{ id: "m-1", author: editor.id, name: editor.name, text: stored.text, at: Date.now(), content: stored.content }]);
  // Someone else's message never notifies on their behalf.
  messages.push([{ id: "m-2", author: owner.id, name: owner.name, text: "x", at: Date.now(), content: stored.content }]);
  await b.sync();
  const count = async (userId: string) =>
    (await all<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='mention' AND page_id=?", userId, board)).length;
  assert.equal(await notifyBoardMentions(editor, board, "pin-1", "m-1"), 1);
  assert.equal(await count(owner.id), 1);
  // The outsider may not read the board: not notified.
  assert.equal(await count(outsider.id), 0);
  // Again: nobody twice.
  assert.equal(await notifyBoardMentions(editor, board, "pin-1", "m-1"), 0);
  assert.equal(await count(owner.id), 1);
  assert.equal(await notifyBoardMentions(editor, board, "pin-1", "m-2"), 0);
  assert.equal(await notifyBoardMentions(editor, board, "pin-1", "missing"), 0);
  const body = (await one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND page_id=? AND kind='mention'", owner.id, board))!.body;
  assert.equal(body, "Ed Editor hat dich in einem Kommentar in „Workshop“ erwähnt");
  assert.equal(englishMessage(body), "Ed Editor mentioned you in a comment in “Workshop”");
  // Who was told is stored (schema 127), not kept in the process's memory.
  const rows = await all<{ user_id: string; notified_at: number }>("SELECT user_id,notified_at FROM whiteboard_mention_notices WHERE page_id=? AND message_id=?", board, "m-1");
  assert.deepEqual(rows.map((r) => r.user_id), [owner.id]);
  assert.ok(Math.abs(rows[0].notified_at - Date.now()) < 60_000);
});

test("an edited message tells only the people it newly mentions, once", async () => {
  const third = await user("Tina Third");
  await run("INSERT INTO members VALUES(?,?,?)", wid, third.id, "viewer");
  const b = await browser(editor);
  const pin = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ type: "comment", x: 0, y: 0, w: 32, h: 32 })) pin.set(k, v);
  const messages = new Y.Array<unknown>();
  pin.set("messages", messages);
  b.items.set("pin-edit", pin);
  const mention = (u: Identity) => ({ type: "mention", attrs: { userId: u.id, label: u.name } });
  const first = storedBoardMessage(doc(mention(owner), { type: "text", text: " bitte prüfen" }) as never);
  const at = Date.now() - NOTIFY_WINDOW_MS - 1000;
  const message = { id: "e-1", author: editor.id, name: editor.name, text: first.text, at: Date.now(), content: first.content };
  messages.push([message]);
  await b.sync();
  const count = async (userId: string) => (await all("SELECT id FROM notifications WHERE user_id=? AND kind='mention' AND page_id=?", userId, board)).length;
  const ownerBefore = await count(owner.id);
  assert.equal(await notifyBoardMentions(editor, board, "pin-edit", "e-1"), 1);
  // The author edits it and mentions a third person too: only she hears.
  const second = storedBoardMessage(doc(mention(owner), mention(third), { type: "text", text: " bitte prüfen" }) as never);
  const edited = editedBoardMessage(message, second.text, second.content);
  assert.ok(edited.edited && edited.id === "e-1");
  messages.delete(0, 1);
  messages.insert(0, [edited]);
  await b.sync();
  assert.equal(await notifyBoardMentions(editor, board, "pin-edit", "e-1"), 1);
  assert.equal(await count(owner.id), ownerBefore + 1);
  assert.equal(await count(third.id), 1);
  assert.equal(await notifyBoardMentions(editor, board, "pin-edit", "e-1"), 0);
  // An old message (written and edited long ago) tells nobody.
  messages.delete(0, 1);
  const late = storedBoardMessage(doc(mention(outsider), mention(await user("Late Lou"))) as never);
  messages.insert(0, [{ ...edited, at, edited: at, content: late.content, text: late.text }]);
  await b.sync();
  assert.equal(await notifyBoardMentions(editor, board, "pin-edit", "e-1"), 0);
  // A deleted placeholder tells nobody.
  messages.delete(0, 1);
  messages.insert(0, [{ id: "e-1", author: editor.id, name: editor.name, text: "", at: Date.now(), deleted: true }]);
  await b.sync();
  assert.equal(await notifyBoardMentions(editor, board, "pin-edit", "e-1"), 0);
  // Rows go with the board's page, and after the retention.
  assert.equal(BOARD_MENTION_KEEP_DAYS, 400);
  const other = await create({ action: "page.create", workspaceId: wid, spaceId: space, title: "Weg", kind: "whiteboard" });
  await run("INSERT INTO whiteboard_mention_notices(page_id,message_id,user_id,notified_at) VALUES(?,?,?,?)", other, "x", owner.id, Date.now());
  await run("DELETE FROM pages WHERE id=?", other);
  assert.equal((await all("SELECT 1 FROM whiteboard_mention_notices WHERE page_id=?", other)).length, 0);
});

test("authors edit and delete their own messages; deleting keeps a placeholder for replies", () => {
  const m = (id: string, author = editor.id) => ({ id, author, name: "N", text: id, at: 1 });
  assert.equal(mayChangeBoardMessage(m("a"), editor.id), true);
  assert.equal(mayChangeBoardMessage(m("a"), owner.id), false);
  assert.equal(mayChangeBoardMessage(m("a"), ""), false);
  // Guests of edit links share one identity per link: never.
  assert.equal(mayChangeBoardMessage(m("a", "guest:abc"), "guest:abc"), false);
  assert.equal(mayChangeBoardMessage({ ...m("a"), deleted: true }, editor.id), false);
  const edited = editedBoardMessage({ ...m("a"), content: { type: "doc" } }, "  neu  ", null, 5);
  assert.deepEqual(edited, { id: "a", author: editor.id, name: "N", text: "neu", at: 1, edited: 5 });
  // The first of a thread with replies: a placeholder without text.
  const thread = [m("a"), m("b", owner.id), m("c")];
  const one = withoutBoardMessage(thread, "a")!;
  assert.deepEqual(one[0], { id: "a", author: editor.id, name: "N", text: "", at: 1, deleted: true });
  assert.deepEqual(one.slice(1), thread.slice(1));
  // A reply goes.
  assert.deepEqual(withoutBoardMessage(thread, "c")!.map((x) => x.id), ["a", "b"]);
  // The only message (or the last one besides a placeholder): the pin goes.
  assert.equal(withoutBoardMessage([m("a")], "a"), null);
  assert.equal(withoutBoardMessage([{ ...m("a"), deleted: true }, m("b")], "b"), null);
  assert.equal(withoutBoardMessage(thread, "missing"), thread);
});

test("attachments of deleted comments go to the file trash once the board no longer has them", async () => {
  const upload = async (as: Identity) => {
    const fid = id();
    await storeUpload(as, await page(board), { id: fid, name: "plan.pdf", mime: "application/pdf", content: Buffer.alloc(100, 7) });
    return fid;
  };
  const mine = await upload(editor),
    theirs = await upload(owner);
  const b = await browser(editor);
  const pin = new Y.Map<unknown>();
  for (const [k, v] of Object.entries({ type: "comment", x: 0, y: 0, w: 32, h: 32 })) pin.set(k, v);
  const files = [mine, theirs].map((f) => ({ src: `/api/files/${f}`, name: "plan.pdf", mime: "application/pdf", size: 100 }));
  const content = { type: "doc", attrs: { attachments: files }, content: [{ type: "paragraph", content: [] }] };
  const messages = new Y.Array<unknown>();
  pin.set("messages", messages);
  messages.push([{ id: "m-f", author: editor.id, name: editor.name, text: "📎 plan.pdf", at: Date.now(), content }]);
  b.items.set("pin-files", pin);
  await b.sync();
  assert.deepEqual(boardMessageFiles([{ content }]).sort(), [mine, theirs].sort());
  // Still on the board: nothing goes.
  assert.deepEqual(await trashBoardCommentFiles(editor, board, [mine]), []);
  b.items.delete("pin-files");
  await b.sync();
  // Only own uploads go; someone else's stays.
  assert.deepEqual(await trashBoardCommentFiles(editor, board, [mine, theirs]), [mine]);
  assert.ok((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", mine))!.deleted_at);
  assert.equal((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM files WHERE id=?", theirs))!.deleted_at, null);
  await assert.rejects(() => trashBoardCommentFiles(outsider, board, [theirs]));
});

test("a pin's colour is a palette name; orange, the colour pins always had, is not stored", () => {
  assert.equal(boardCommentColor(undefined), "orange");
  assert.equal(boardCommentColor("blue"), "blue");
  assert.equal(boardCommentColor("#ff0000"), "orange");
  assert.equal(storedBoardCommentColor("orange"), undefined);
  assert.equal(storedBoardCommentColor("green"), "green");
  assert.equal(boardCommentBadge({}).fill, "#f08c00");
  assert.equal(boardCommentBadge({ commentColor: "yellow" }).text, "#3d2e00");
  assert.deepEqual(boardExtras({ commentColor: "red" }), { commentColor: "red" });
  assert.deepEqual(boardExtras({ commentColor: "url(x)" }), {});
});
