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

function user(name: string, email = `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, email);
  return { id: uid, name, email, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = user("Olga Owner"),
  wid = createWorkspace(owner.id, "Mentions"),
  space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const anna = user("Anna"),
  annaBerg = user("Anna Berg"),
  bob = user("Bob"),
  guest = user("Gus Guest"),
  outsider = user("Otto Outside");
for (const m of [anna, annaBerg, bob]) run("INSERT INTO members VALUES(?,?,?)", wid, m.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "viewer");
run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const create = (as: Identity, input: Record<string, unknown>) => (command(as, input) as { id: string }).id;
const notes = (pageId: string) =>
  all<{ user_id: string; kind: string; body: string; row_id: string | null }>("SELECT user_id,kind,body,row_id FROM notifications WHERE page_id=? ORDER BY user_id,kind", pageId);
const of = (pageId: string, who: Identity) => notes(pageId).filter((n) => n.user_id === who.id);
const page = (pageId: string) => one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;

test("the parser finds full names and e-mail addresses after @, the longest name first", () => {
  const p = page(create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Parse" }));
  const found = (body: string) => commentTextMentions(owner, p, body).sort();
  assert.deepEqual(found("Hi @Anna Berg, see this"), [annaBerg.id].sort());
  assert.deepEqual(found("@anna and @BOB!"), [anna.id, bob.id].sort());
  assert.deepEqual(found("ask @bob@example.test"), [bob.id]);
  // An @ inside a word or an address in the text is no mention, nor a name
  // that only starts the word.
  assert.deepEqual(found("mail anna@example.test or @Bobby"), []);
  // Somebody outside the workspace is never found.
  assert.deepEqual(found("@Otto Outside"), []);
  // Guests see nobody of the workspace: their @ names nobody.
  assert.deepEqual(commentTextMentions(guest, p, "@Anna"), []);
});

test("a page comment notifies the mentioned person once, as a mention, never the author", () => {
  const pageId = create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Plan" });
  command(bob, { action: "page.follow", pageId, follow: true });
  run("DELETE FROM notifications");
  command(anna, { action: "comment.create", pageId, body: "@Bob and @Anna Berg, please look. (@Anna is me)" });
  // Bob follows the page and is mentioned: one notification, a mention.
  assert.deepEqual(of(pageId, bob).map((n) => n.kind), ["mention"]);
  assert.match(of(pageId, bob)[0].body, /Anna hat dich in einem Kommentar in „Plan“ erwähnt/);
  assert.deepEqual(of(pageId, annaBerg).map((n) => n.kind), ["mention"]);
  // The author mentioning herself hears nothing; the owner follows as creator.
  assert.equal(of(pageId, anna).length, 0);
  assert.deepEqual(of(pageId, owner).map((n) => n.kind), ["comment"]);
  assert.equal(of(pageId, outsider).length, 0);
});

test("a record comment notifies the mentioned person only while they may read the record", () => {
  const db = create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tasks", kind: "database" });
  const row = create(owner, { action: "row.create", pageId: db, cells: { title: "Fix it" } });
  run("DELETE FROM notifications");
  command(anna, { action: "comment.create", pageId: db, rowId: row, body: "@Bob can you?" });
  assert.deepEqual(of(db, bob).map((n) => [n.kind, n.row_id]), [["mention", row]]);
  run("DELETE FROM notifications");
  // A private record of the owner: Bob may not see it, the mention reaches nobody.
  run("UPDATE rows SET access='private',created_by=? WHERE id=?", owner.id, row);
  command(owner, { action: "comment.create", pageId: db, rowId: row, body: "@Bob secret" });
  assert.equal(of(db, bob).length, 0);
});

test("pages a person may not read and guests: no notification from a mention", () => {
  const privateSpace = create(owner, { action: "space.create", workspaceId: wid, name: "Private", private: true });
  const hidden = create(owner, { action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Hidden" });
  assert.throws(() => pageData(bob, hidden));
  run("DELETE FROM notifications");
  command(owner, { action: "comment.create", pageId: hidden, body: "@Bob look" });
  assert.equal(of(hidden, bob).length, 0);
  // A guest who may read the page is reached; a guest's own @ names nobody.
  const shared = create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Shared" });
  command(owner, { action: "grant.set", resourceId: shared, userId: guest.id, role: "viewer" });
  command(owner, { action: "comment.create", pageId: shared, body: "@Gus Guest welcome" });
  assert.deepEqual(of(shared, guest).map((n) => n.kind), ["mention"]);
  command(guest, { action: "comment.create", pageId: shared, body: "@Bob hello" });
  assert.equal(of(shared, bob).length, 0);
});

test("a mention in a journal behind a PIN shows only the locked notice", () => {
  const journal = create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Diary", kind: "journal" });
  command(owner, { action: "journal.lock", pageId: journal, pin: "135790" });
  run("DELETE FROM notifications");
  command(owner, { action: "comment.create", pageId: journal, body: "@Bob private words" });
  assert.deepEqual(of(journal, bob).map((n) => n.kind), ["mention"]);
  // Bob has not entered the PIN: inbox, push, mail and chat apps show only
  // the locked notice instead of the text (lib/journal-extras.ts).
  assert.equal(lockedNotification()({ user_id: bob.id, page_id: journal, kind: "mention" }), true);
  assert.ok(LOCKED_NOTICE);
});

test("text comments: mentions notify once, an edit only the newly added ones", () => {
  const pageId = create(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Doc" });
  const html = "<p>Quarterly numbers</p>";
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  const anchor = withCommentDocument(pageId, null, (binding, generation) => commentAnchor(binding, 1, 10, generation)!);
  const mention = (who: Identity) => ({ type: "mention", attrs: { userId: who.id, label: who.name } });
  const content = (...people: Identity[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "See " }, ...people.map(mention)] }] });
  run("DELETE FROM notifications");
  const threadId = crypto.randomUUID(),
    messageId = crypto.randomUUID();
  command(anna, { action: "thread.create", pageId, threadId, messageId, anchor, content: content(bob) });
  assert.deepEqual(of(pageId, bob).map((n) => n.kind), ["mention"]);
  run("DELETE FROM notifications");
  command(anna, { action: "thread.edit", pageId, threadId, messageId, version: 1, content: content(bob, annaBerg, anna) });
  assert.equal(of(pageId, bob).length, 0);
  assert.deepEqual(of(pageId, annaBerg).map((n) => n.kind), ["mention"]);
  assert.equal(of(pageId, anna).length, 0);
});
