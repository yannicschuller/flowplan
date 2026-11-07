// "@Name" in page and record comments notifies the person named
// (lib/comment-recipients.ts commentTextMentions) – once, as a mention, and
// only who may read the page and the record. Text comments notify their
// mention nodes; editing one notifies only mentions added by the edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-comment-mentions-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, pageData } = await import("../lib/api");
const { commentTextMentions } = await import("../lib/comment-recipients");
const { htmlState } = await import("../lib/document-server");
const { commentAnchor } = await import("../lib/comment-positions");
const { withCommentDocument } = await import("../lib/inline-comments");
const { LOCKED_NOTICE, lockedNotification } = await import("../lib/journal-extras");

async function user(name: string, email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, email);
  return { id: uid, name, email, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Olga Owner"),
  wid = await createWorkspace(owner.id, "Mentions"),
  space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const anna = await user("Anna"),
  annaBerg = await user("Anna Berg"),
  bob = await user("Bob"),
  guest = await user("Gus Guest"),
  outsider = await user("Otto Outside");
for (const m of [anna, annaBerg, bob]) await run("INSERT INTO members VALUES(?,?,?)", wid, m.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const create = async (as: Identity, input: Record<string, unknown>) => ((await command(as, input)) as { id: string }).id;
const notes = async (pageId: string) =>
  await all<{ user_id: string; kind: string; body: string; row_id: string | null }>("SELECT user_id,kind,body,row_id FROM notifications WHERE page_id=? ORDER BY user_id,kind", pageId);
const of = async (pageId: string, who: Identity) => (await notes(pageId)).filter((n) => n.user_id === who.id);
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;

test("the parser finds full names and e-mail addresses after @, the longest name first", async () => {
  const p = await page(await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Parse" }));
  const found = async (body: string) => (await commentTextMentions(owner, p, body)).sort();
  assert.deepEqual(await found("Hi @Anna Berg, see this"), [annaBerg.id].sort());
  assert.deepEqual(await found("@anna and @BOB!"), [anna.id, bob.id].sort());
  assert.deepEqual(await found("ask @bob@example.test"), [bob.id]);
  // An @ inside a word or an address in the text is no mention, nor a name
  // that only starts the word.
  assert.deepEqual(await found("mail anna@example.test or @Bobby"), []);
  // Somebody outside the workspace is never found.
  assert.deepEqual(await found("@Otto Outside"), []);
  // Guests see nobody of the workspace: their @ names nobody.
  assert.deepEqual(await commentTextMentions(guest, p, "@Anna"), []);
});

test("a page comment notifies the mentioned person once, as a mention, never the author", async () => {
  const pageId = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan" });
  await command(bob, { action: "page.follow", pageId, follow: true });
  await run("DELETE FROM notifications");
  await command(anna, { action: "comment.create", pageId, body: "@Bob and @Anna Berg, please look. (@Anna is me)" });
  // Bob follows the page and is mentioned: one notification, a mention.
  assert.deepEqual((await of(pageId, bob)).map((n) => n.kind), ["mention"]);
  assert.match((await of(pageId, bob))[0].body, /Anna hat dich in einem Kommentar in „Plan“ erwähnt/);
  assert.deepEqual((await of(pageId, annaBerg)).map((n) => n.kind), ["mention"]);
  // The author mentioning herself hears nothing; the owner follows as creator.
  assert.equal((await of(pageId, anna)).length, 0);
  assert.deepEqual((await of(pageId, owner)).map((n) => n.kind), ["comment"]);
  assert.equal((await of(pageId, outsider)).length, 0);
});

test("a record comment notifies the mentioned person only while they may read the record", async () => {
  const db = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tasks", kind: "database" });
  const row = await create(owner, { action: "row.create", pageId: db, cells: { title: "Fix it" } });
  await run("DELETE FROM notifications");
  await command(anna, { action: "comment.create", pageId: db, rowId: row, body: "@Bob can you?" });
  assert.deepEqual((await of(db, bob)).map((n) => [n.kind, n.row_id]), [["mention", row]]);
  await run("DELETE FROM notifications");
  // A private record of the owner: Bob may not see it, the mention reaches nobody.
  await run("UPDATE rows SET access='private',created_by=? WHERE id=?", owner.id, row);
  await command(owner, { action: "comment.create", pageId: db, rowId: row, body: "@Bob secret" });
  assert.equal((await of(db, bob)).length, 0);
});

test("pages a person may not read and guests: no notification from a mention", async () => {
  const privateSpace = await create(owner, { action: "space.create", workspaceId: wid, name: "Private", private: true });
  const hidden = await create(owner, { action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Hidden" });
  await assert.rejects(async () => await pageData(bob, hidden));
  await run("DELETE FROM notifications");
  await command(owner, { action: "comment.create", pageId: hidden, body: "@Bob look" });
  assert.equal((await of(hidden, bob)).length, 0);
  // A guest who may read the page is reached; a guest's own @ names nobody.
  const shared = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Shared" });
  await command(owner, { action: "grant.set", resourceId: shared, userId: guest.id, role: "viewer" });
  await command(owner, { action: "comment.create", pageId: shared, body: "@Gus Guest welcome" });
  assert.deepEqual((await of(shared, guest)).map((n) => n.kind), ["mention"]);
  await command(guest, { action: "comment.create", pageId: shared, body: "@Bob hello" });
  assert.equal((await of(shared, bob)).length, 0);
});

test("a mention in a journal behind a PIN shows only the locked notice", async () => {
  const journal = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Diary", kind: "journal" });
  await command(owner, { action: "journal.lock", pageId: journal, pin: "135790" });
  await run("DELETE FROM notifications");
  await command(owner, { action: "comment.create", pageId: journal, body: "@Bob private words" });
  assert.deepEqual((await of(journal, bob)).map((n) => n.kind), ["mention"]);
  // Bob has not entered the PIN: inbox, push, mail and chat apps show only
  // the locked notice instead of the text (lib/journal-extras.ts).
  assert.equal(await (await lockedNotification())({ user_id: bob.id, page_id: journal, kind: "mention" }), true);
  assert.ok(LOCKED_NOTICE);
});

test("text comments: mentions notify once, an edit only the newly added ones", async () => {
  const pageId = await create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Doc" });
  const html = "<p>Quarterly numbers</p>";
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  const anchor = await withCommentDocument(pageId, null, (binding, generation) => commentAnchor(binding, 1, 10, generation)!);
  const mention = (who: Identity) => ({ type: "mention", attrs: { userId: who.id, label: who.name } });
  const content = (...people: Identity[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See " }, ...people.map(mention)] }] });
  await run("DELETE FROM notifications");
  const threadId = crypto.randomUUID(),
    messageId = crypto.randomUUID();
  await command(anna, { action: "thread.create", pageId, threadId, messageId, anchor, content: content(bob) });
  assert.deepEqual((await of(pageId, bob)).map((n) => n.kind), ["mention"]);
  await run("DELETE FROM notifications");
  await command(anna, { action: "thread.edit", pageId, threadId, messageId, version: 1, content: content(bob, annaBerg, anna) });
  assert.equal((await of(pageId, bob)).length, 0);
  assert.deepEqual((await of(pageId, annaBerg)).map((n) => n.kind), ["mention"]);
  assert.equal((await of(pageId, anna)).length, 0);
});
