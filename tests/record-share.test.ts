// Sharing and publishing a single record (#231, lib/record-share.ts): the
// link opens that record and nothing else – not its database, its sibling
// records, relation targets, other records' files, the page tree, live
// editing of other documents – and access ends with revoking, unpublishing,
// deleting, moving or making the record private.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-record-share-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { sharedContent, mutateSharedContent } = await import("../lib/shared-content");
const { publicPage, publicTree, publicFile, publishedHtml } = await import("../lib/publication");
const { recordScope, recordReferenceNames, recordShownFields } = await import("../lib/record-share");
const { shareAccess, sharePresence } = await import("../lib/share-presence");
const { guestUpload } = await import("../lib/shared-uploads");
const { shareState, unlockShare, withShareCookie } = await import("../lib/share-access");
const { publicPlugin } = await import("../lib/plugins");
const { publicationMetadata } = await import("../lib/publication-meta");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  editor = await user("editor"),
  wid = await createWorkspace(owner.id, "Records"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
async function page(extra = {}) {
  return ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Requirements", ...extra })) as { id: string }).id;
}
async function file(pageId: string, name: string) {
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, "image/png", 1, owner.id);
  return fid;
}
async function fails(fn: () => unknown, status: number) {
  await assert.rejects(async () => fn(), (e: any) => e.status === status);
}

// A database with a record to share, its sibling, a relation target in
// another database and files of all of them.
async function fixture() {
  const db = await page({ kind: "database" }),
    people = await page({ kind: "database", title: "People" }),
    other = await page({ title: "Other page" });
  await run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify([
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
      { id: "note", name: "Note", type: "text" },
      { id: "secret", name: "Internal", type: "text", access: { read: "editors" } },
      { id: "who", name: "Contact", type: "relation", relationPage: people },
      { id: "owner", name: "Owner", type: "person" },
      { id: "docs", name: "Files", type: "files" },
      { id: "empty", name: "Empty", type: "text" },
    ]),
    db,
  );
  const ada = id(),
    hidden = id(),
    record = id(),
    sibling = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)", ada, people, JSON.stringify({ title: "Ada" }), owner.id);
  await run("INSERT INTO rows(id,page_id,cells,created_by,access) VALUES(?,?,?,?,'private')", hidden, people, JSON.stringify({ title: "Private person" }), owner.id);
  const recordImage = await file(db, "record.png"),
    recordCell = await file(db, "attachment.png"),
    siblingImage = await file(db, "sibling.png"),
    pageImage = await file(db, "database-page.png"),
    otherImage = await file(other, "other.png"),
    unused = await file(db, "unused.png");
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by,content) VALUES(?,?,?,?,?)",
    record,
    db,
    JSON.stringify({
      title: "U3a Interface X",
      status: "Open",
      note: "Visible note",
      secret: "Budget 50k",
      who: [ada, hidden],
      owner: owner.id,
      docs: [`/api/files/${recordCell}`],
    }),
    owner.id,
    `<p>Spec</p><img src="/api/files/${recordImage}"><p><a href="#page=${db}&amp;row=${sibling}">Sibling</a> <a href="#page=${db}">Database</a> <a href="#page=${other}">Other</a> <a href="/api/files/${otherImage}">Other file</a></p>`,
  );
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by,content) VALUES(?,?,?,?,?)",
    sibling,
    db,
    JSON.stringify({ title: "Sibling requirement", note: "Do not leak", docs: [`/api/files/${siblingImage}`] }),
    owner.id,
    `<p>Sibling secret</p><img src="/api/files/${siblingImage}">`,
  );
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${pageImage}"></p>`, db);
  return { db, people, other, ada, hidden, record, sibling, files: { recordImage, recordCell, siblingImage, pageImage, otherImage, unused } };
}
async function share(pageId: string, rowId: string, role = "viewer", extra = {}, who: Identity = owner) {
  return ((await command(who, { action: "record.share.create", pageId, rowId, role, name: role, ...extra })) as { token: string }).token;
}

test("a record link opens that record and nothing else of the database", async () => {
  const f = await fixture();
  const token = await share(f.db, f.record);
  const data = await sharedContent(token, f.db, f.record);
  assert.equal(data.rowId, f.record);
  assert.equal(data.role, "viewer");
  assert.ok(!JSON.stringify(data).includes("Sibling requirement"));
  assert.ok(!JSON.stringify(data).includes("Budget 50k"));
  // The database itself, its other records and other pages are not found.
  await fails(() => sharedContent(token, f.db), 404);
  await fails(() => sharedContent(token, f.db, f.sibling), 404);
  await fails(() => sharedContent(token, f.other), 404);
  await fails(() => sharedContent(token, f.people, f.ada), 404);
  // The page tree of the share knows nothing of the token.
  await fails(() => publicTree(token), 404);
  await fails(() => publicPage(token, f.db), 404);
  await fails(() => publicPage(token), 404);
  // Writes through other ids fail the same way.
  await fails(() => mutateSharedContent(token, { action: "comment", pageId: f.db, rowId: f.sibling, name: "x", body: "y" }), 404);
  await fails(() => mutateSharedContent(token, { action: "comment", pageId: f.db, name: "x", body: "y" }), 404);
});

test("visitors see the chosen properties: by default no relations, people or read-restricted ones", async () => {
  const f = await fixture();
  const token = await share(f.db, f.record);
  const scope = (await recordScope(token))!;
  assert.deepEqual(scope.shown.map((x) => x.id), ["status", "note", "docs", "empty"]);
  // Read rules can never be chosen; relations and people can.
  await command(owner, { action: "record.share.fields", pageId: f.db, rowId: f.record, fields: ["note", "who", "owner", "secret"] });
  const chosen = (await recordScope(token))!;
  assert.deepEqual(chosen.shown.map((x) => x.id), ["note", "who", "owner"]);
  const names = await recordReferenceNames(chosen);
  // Titles of linked records only, never private ones.
  assert.deepEqual(names.relations.who, ["Ada"]);
  assert.deepEqual(names.people.owner, ["owner"]);
  // Not shown any more: the status (and the files property with its file).
  const data = await sharedContent(token, f.db, f.record);
  assert.ok(!JSON.stringify(data).includes("Open"));
  await fails(() => publicFile(token, f.files.recordCell), 404);
  // Back to the default.
  await command(owner, { action: "record.share.fields", pageId: f.db, rowId: f.record, fields: null });
  assert.deepEqual(recordShownFields(scope.fields, null).map((x) => x.id), ["status", "note", "docs", "empty"]);
});

test("files: only the record's own, never those of sibling records, the database page or other pages", async () => {
  const f = await fixture();
  const token = await share(f.db, f.record);
  assert.equal((await publicFile(token, f.files.recordImage)).id, f.files.recordImage);
  assert.equal((await publicFile(token, f.files.recordCell)).id, f.files.recordCell);
  await fails(() => publicFile(token, f.files.siblingImage), 404);
  await fails(() => publicFile(token, f.files.pageImage), 404);
  await fails(() => publicFile(token, f.files.otherImage), 404);
  await fails(() => publicFile(token, f.files.unused), 404);
  // Links in the document to other records and pages are removed.
  const html = await publishedHtml((await one<{ content: string }>("SELECT content FROM rows WHERE id=?", f.record))!.content, token, []);
  assert.ok(html.includes(`/api/share/${token}/files/${f.files.recordImage}`));
  assert.ok(!html.includes(f.sibling));
  assert.ok(!html.includes(`#page=${f.db}`));
  assert.ok(!html.includes(f.other));
  assert.ok(!html.includes(f.files.otherImage));
});

test("roles: viewers read, commenters comment on this record only, editors change shown properties and the document", async () => {
  const f = await fixture();
  const reader = await share(f.db, f.record, "viewer"),
    commenter = await share(f.db, f.record, "commenter"),
    writer = await share(f.db, f.record, "editor");
  await fails(() => mutateSharedContent(reader, { action: "comment", pageId: f.db, rowId: f.record, name: "Guest", body: "Hi" }), 403);
  await mutateSharedContent(commenter, { action: "comment", pageId: f.db, rowId: f.record, name: "Guest", body: "Looks good" });
  const stored = await all<{ row_id: string }>("SELECT row_id FROM shared_comments WHERE page_id=?", f.db);
  assert.deepEqual(stored.map((c) => c.row_id), [f.record]);
  assert.equal((await sharedContent(reader, f.db, f.record)).comments.length, 1);
  await fails(() => mutateSharedContent(commenter, { action: "cells", pageId: f.db, rowId: f.record, version: "x", cells: { note: "x" } }), 403);
  const version = async () => (await sharedContent(writer, f.db, f.record)).version;
  await mutateSharedContent(writer, { action: "cells", pageId: f.db, rowId: f.record, version: await version(), cells: { note: "Changed by guest" } });
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", f.record))!.cells).note, "Changed by guest");
  // Hidden, read-restricted, relation and not shown properties stay closed.
  for (const cells of [{ secret: "x" }, { who: [f.ada] }, { owner: editor.id }, { nothing: "x" }])
    await fails(async () => mutateSharedContent(writer, { action: "cells", pageId: f.db, rowId: f.record, version: await version(), cells }), 403);
  // No new records in the database.
  await fails(() => mutateSharedContent(writer, { action: "create", pageId: f.db, rowId: f.record, cells: { title: "New" } }), 400);
  await fails(() => mutateSharedContent(writer, { action: "create", pageId: f.db, cells: { title: "New" } }), 404);
  // Guest edits keep the links they cannot see (placeholders) and cannot add links to the database.
  const data = await sharedContent(writer, f.db, f.record);
  await mutateSharedContent(writer, { action: "save", pageId: f.db, rowId: f.record, version: data.version, title: data.title, html: data.html + "<p>Added</p>" });
  const after = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", f.record))!.html;
  assert.ok(after.includes(`#page=${f.db}&amp;row=${f.sibling}`) || after.includes(`#page=${f.db}&row=${f.sibling}`));
  const again = await sharedContent(writer, f.db, f.record);
  await fails(() => mutateSharedContent(writer, { action: "save", pageId: f.db, rowId: f.record, version: again.version, title: again.title, html: `<p><a href="/share/${writer}/${f.db}">db</a></p>` }), 403);
  await fails(() => mutateSharedContent(writer, { action: "save", pageId: f.db, rowId: f.record, version: again.version, title: again.title, html: `<p><a href="#page=${f.db}&row=${f.sibling}">x</a></p>` }), 403);
  // The sibling is untouched.
  assert.ok(!(await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", f.sibling))!.cells.includes("Changed"));
});

test("live editing and presence: only the shared record, only for editors", async () => {
  const f = await fixture();
  const reader = await share(f.db, f.record, "viewer"),
    writer = await share(f.db, f.record, "editor");
  assert.equal((await shareAccess(writer, f.db, f.record)).id, f.db);
  await fails(() => shareAccess(reader, f.db, f.record), 403);
  await fails(() => shareAccess(writer, f.db, f.sibling), 404);
  await fails(() => shareAccess(writer, f.db, null), 404);
  await fails(() => shareAccess(writer, f.other, null), 404);
  await fails(() => sharePresence(writer, { action: "presence", pageId: f.db, rowId: f.sibling, clientId: id(), text: null }), 404);
  await fails(() => mutateSharedContent(writer, { action: "live", pageId: f.db, rowId: f.sibling }), 404);
  const live = (await mutateSharedContent(writer, { action: "live", pageId: f.db, rowId: f.record })) as { update: string };
  assert.ok(live.update.length > 0);
  // Uploads go to the record's database only, for editors.
  const png = new File([Buffer.from("89504e470d0a1a0a0000", "hex")], "a.png", { type: "image/png" });
  await fails(() => guestUpload(writer, f.other, png), 404);
  await fails(() => guestUpload(reader, f.db, png), 403);
  const uploaded = await guestUpload(writer, f.db, png);
  const fid = uploaded.url.split("/").pop()!;
  assert.equal((await publicFile(writer, fid)).id, fid);
  // Another link of the same record does not see the fresh upload.
  await fails(() => publicFile(reader, fid), 404);
});

test("publishing a record: read only, no guest comments, ends with unpublishing", async () => {
  const f = await fixture();
  const commenter = await share(f.db, f.record, "commenter");
  await mutateSharedContent(commenter, { action: "comment", pageId: f.db, rowId: f.record, name: "Guest", body: "Internal remark" });
  const shares = (await command(owner, { action: "record.publish", pageId: f.db, rowId: f.record, enabled: true })) as { publication: { token: string } };
  const token = shares.publication.token;
  const data = await sharedContent(token, f.db, f.record);
  assert.equal(data.role, "viewer");
  assert.deepEqual(data.comments, []);
  await fails(() => mutateSharedContent(token, { action: "comment", pageId: f.db, rowId: f.record, name: "x", body: "y" }), 403);
  // Publishing again keeps the address.
  const again = (await command(owner, { action: "record.publish", pageId: f.db, rowId: f.record, enabled: true })) as { publication: { token: string } };
  assert.equal(again.publication.token, token);
  // Search engines stay out, like for shared pages.
  const meta = await publicationMetadata(token);
  assert.deepEqual(meta.robots, { index: false, follow: false });
  assert.equal(meta.title, "U3a Interface X");
  await command(owner, { action: "record.publish", pageId: f.db, rowId: f.record, enabled: false });
  assert.equal(await recordScope(token), null);
  await fails(() => sharedContent(token, f.db, f.record), 404);
  assert.equal(await shareState(token, undefined), "missing");
});

test("password and end date hold for everything served through the record link", async () => {
  const f = await fixture();
  const token = await share(f.db, f.record, "viewer", { password: "secret-1" });
  assert.equal(await shareState(token, undefined), "password");
  await fails(() => sharedContent(token, f.db, f.record), 401);
  await fails(() => publicFile(token, f.files.recordImage), 401);
  const { value } = await unlockShare(token, "secret-1", "test-address");
  assert.equal(await shareState(token, value), "open");
  assert.equal((await withShareCookie(value, () => sharedContent(token, f.db, f.record))).rowId, f.record);
  // The unlock of one record link opens no other.
  const other = await share(f.db, f.record, "viewer", { password: "secret-2" });
  await fails(() => withShareCookie(value, () => sharedContent(other, f.db, f.record)), 401);
  // Expired.
  await run("UPDATE record_shares SET expires_at=? WHERE token=?", Date.now() - 1000, token);
  await fails(() => withShareCookie(value, () => sharedContent(token, f.db, f.record)), 410);
  // Metadata names no title behind a password.
  const meta = await publicationMetadata(other);
  assert.equal(meta.title, undefined);
});

test("revoking, deleting, moving and making the record private end access", async () => {
  const f = await fixture();
  const revoked = await share(f.db, f.record);
  await command(owner, { action: "record.share.revoke", pageId: f.db, rowId: f.record, token: revoked });
  assert.equal(await recordScope(revoked), null);
  await fails(() => sharedContent(revoked, f.db, f.record), 404);

  const privateLink = await share(f.db, f.record);
  await command(owner, { action: "row.access", pageId: f.db, rowId: f.record, access: "private", grants: [] });
  await fails(() => sharedContent(privateLink, f.db, f.record), 404);
  await fails(() => publicFile(privateLink, f.files.recordImage), 404);
  // Private records are not shared at all.
  await fails(() => share(f.db, f.record), 409);
  await command(owner, { action: "row.access", pageId: f.db, rowId: f.record, access: "inherit", grants: [] });

  const moved = await share(f.db, f.record);
  const target = await page({ kind: "database", title: "Archive" });
  await command(owner, { action: "rows.transfer", pageId: f.db, rowIds: [f.record], targetPageId: target, mode: "move" });
  assert.equal(await recordScope(moved), null);

  const g = await fixture();
  const deleted = await share(g.db, g.record);
  await command(owner, { action: "row.delete", pageId: g.db, rowId: g.record });
  assert.equal(await recordScope(deleted), null);

  const h = await fixture();
  const gone = await share(h.db, h.record);
  await command(owner, { action: "page.delete", pageId: h.db });
  assert.equal(await recordScope(gone), null);
});

test("who may share: editors of the record, not viewers, not other workspaces' records", async () => {
  const f = await fixture();
  await fails(() => share(f.db, f.record, "viewer", {}, viewer), 403);
  assert.ok(await share(f.db, f.record, "viewer", {}, editor));
  // A read-only record: only those who may still edit it.
  await command(owner, { action: "row.access", pageId: f.db, rowId: f.record, access: "readonly", grants: [] });
  await fails(() => share(f.db, f.record, "viewer", {}, editor), 403);
  const writer = await share(f.db, f.record, "editor");
  // Guests of a read-only record comment at most.
  assert.equal((await sharedContent(writer, f.db, f.record)).role, "commenter");
  await fails(() => shareAccess(writer, f.db, f.record), 404);
  await command(owner, { action: "row.access", pageId: f.db, rowId: f.record, access: "inherit", grants: [] });
  // Mismatched ids: the record must live in the named database.
  await fails(() => share(f.people, f.record), 404);
  await fails(() => share(f.other, f.record), 400);
  // Links of other records are not revoked from here.
  const mine = await share(f.db, f.record);
  await command(owner, { action: "record.share.revoke", pageId: f.db, rowId: f.sibling, token: mine });
  assert.ok(await recordScope(mine));
  // The listing is for those who may share.
  await fails(() => command(viewer, { action: "record.shares", pageId: f.db, rowId: f.record }), 403);
  const listed = (await command(owner, { action: "record.shares", pageId: f.db, rowId: f.record })) as { links: { token: string }[]; fields: { id: string }[] };
  assert.ok(listed.links.some((l) => l.token === mine));
  assert.ok(!listed.fields.some((x) => x.id === "secret"));
});

test("record tokens open no member API, plugins of other workspaces, or other shares", async () => {
  const f = await fixture();
  const token = await share(f.db, f.record, "editor");
  // Not a page link, not a publication.
  assert.equal(await one("SELECT 1 FROM share_links WHERE token=?", token), undefined);
  assert.equal(await one("SELECT 1 FROM pages WHERE public_token=?", token), undefined);
  // Not a session or API token.
  const { identityFromToken, identityFromRequest } = await import("../lib/auth");
  assert.equal(await identityFromToken(token), null);
  assert.equal(await identityFromRequest(new Request("http://localhost/api/bootstrap", { headers: { authorization: `Bearer ${token}` } })).catch(() => null), null);
  await fails(() => publicPlugin(token, id()), 404);
  // A page link of the database does not reach the record share's uploads either.
  const dbLink = ((await command(owner, { action: "share.create", pageId: f.db, role: "viewer", name: "db" })) as { token: string }).token;
  const png = new File([Buffer.from("89504e470d0a1a0a0000", "hex")], "a.png", { type: "image/png" });
  const fid = (await guestUpload(token, f.db, png)).url.split("/").pop()!;
  await fails(() => publicFile(dbLink, fid), 404);
});

test("own and administrators' overviews list record links and revoke them", async () => {
  const f = await fixture();
  const token = await share(f.db, f.record, "editor");
  const { mySecurity } = await import("../lib/my-security");
  const mine = await mySecurity(owner, undefined);
  const listed = mine.links.find((l) => l.token === token)!;
  assert.equal(listed.rowId, f.record);
  assert.equal(listed.role, "editor");
  const { securityAction, securityOverview } = await import("../lib/security-admin");
  const overview = (await securityOverview()) as unknown as { links: { shares: { id: string }[] } };
  assert.ok(overview.links.shares.some((s) => s.id === token.slice(0, 12)));
  const admin = { ...owner, isAdmin: true };
  await securityAction(admin, { action: "share.revoke", id: token.slice(0, 12) }, new Headers());
  assert.equal(await recordScope(token), null);
});

test("relations on a record link show only titles the link's creator may read", async () => {
  // Alice keeps salaries in her private space; a team record links to one
  // of them (set by someone who sees both). Bob edits the team record but
  // has no access to Alice's space.
  const alice = await user("alice"),
    bob = await user("bob");
  await run("INSERT INTO members VALUES(?,?,?)", wid, alice.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
  const privateSpace = ((await command(alice, { action: "space.create", workspaceId: wid, name: "Alice", private: true })) as { id: string }).id;
  const salaries = ((await command(alice, { action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Salaries", kind: "database" })) as { id: string }).id;
  const team = await page({ kind: "database", title: "Team" });
  const visible = await page({ kind: "database", title: "Contacts" });
  await run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify([
      { id: "title", name: "Name", type: "text" },
      { id: "pay", name: "Pay", type: "relation", relationPage: salaries },
      { id: "contact", name: "Contact", type: "relation", relationPage: visible },
    ]),
    team,
  );
  const salary = id(),
    contact = id(),
    hiddenContact = id(),
    record = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)", salary, salaries, JSON.stringify({ title: "CEO salary 400k" }), alice.id);
  await run("INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)", contact, visible, JSON.stringify({ title: "Grace" }), owner.id);
  // A read-only record is still named.
  await run("INSERT INTO rows(id,page_id,cells,created_by,access) VALUES(?,?,?,?,'readonly')", hiddenContact, visible, JSON.stringify({ title: "Readable" }), owner.id);
  await run(
    "INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)",
    record,
    team,
    JSON.stringify({ title: "Hiring", pay: [salary], contact: [contact, hiddenContact] }),
    owner.id,
  );
  const token = await share(team, record, "viewer", {}, bob);
  // Bob cannot choose the relation into Alice's space; the other one he can.
  await command(bob, { action: "record.share.fields", pageId: team, rowId: record, fields: ["pay", "contact"] });
  const stored = JSON.parse((await one<{ fields: string }>("SELECT fields FROM record_share_fields WHERE row_id=?", record))!.fields);
  assert.deepEqual(stored, ["contact"]);
  // Chosen by someone who may read it, it still stays hidden on Bob's link.
  await command(alice, { action: "record.share.fields", pageId: team, rowId: record, fields: ["pay", "contact"] });
  const scope = (await recordScope(token))!;
  assert.deepEqual(scope.shown.map((f) => f.id), ["contact"]);
  const names = await recordReferenceNames(scope);
  assert.equal(names.relations.pay, undefined);
  assert.deepEqual(names.relations.contact, ["Grace", "Readable"]);
  assert.ok(!JSON.stringify(await sharedContent(token, team, record)).includes("400k"));
  // Even with the relation shown, no title of a database the creator cannot open.
  assert.deepEqual((await recordReferenceNames({ ...scope, shown: scope.fields.slice(1) })).relations.pay, []);
  // On Alice's own link the salary is named.
  const own = await share(team, record, "viewer", {}, alice);
  assert.deepEqual((await recordReferenceNames((await recordScope(own))!)).relations.pay, ["CEO salary 400k"]);
  // A link whose creator is gone shows no relation titles.
  await run("UPDATE record_shares SET created_by=NULL WHERE token=?", own);
  const orphan = (await recordScope(own))!;
  assert.deepEqual(orphan.shown.map((f) => f.id), []);
  assert.deepEqual((await recordReferenceNames({ ...orphan, shown: orphan.fields.slice(1) })).relations, { pay: [], contact: [] });
});

test("a relation cell takes only records the writer may read", async () => {
  const carol = await user("carol");
  await run("INSERT INTO members VALUES(?,?,?)", wid, carol.id, "editor");
  const privateSpace = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Owner only", private: true })) as { id: string }).id;
  const closed = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Closed", kind: "database" })) as { id: string }).id;
  const people = await page({ kind: "database", title: "People" });
  const team = await page({ kind: "database", title: "Team" });
  await run(
    "UPDATE databases SET fields=? WHERE page_id=?",
    JSON.stringify([
      { id: "title", name: "Name", type: "text" },
      { id: "who", name: "Who", type: "relation", relationPage: people },
      { id: "closed", name: "Closed", type: "relation", relationPage: closed },
    ]),
    team,
  );
  const open = id(),
    secret = id(),
    hidden = id(),
    record = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)", open, people, JSON.stringify({ title: "Open" }), owner.id);
  await run("INSERT INTO rows(id,page_id,cells,created_by,access) VALUES(?,?,?,?,'private')", secret, people, JSON.stringify({ title: "Secret" }), owner.id);
  await run("INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)", hidden, closed, JSON.stringify({ title: "Hidden" }), owner.id);
  await run("INSERT INTO rows(id,page_id,cells,created_by) VALUES(?,?,?,?)", record, team, JSON.stringify({ title: "Task" }), owner.id);
  const update = async (who: Identity, cells: Record<string, unknown>) =>
    await command(who, {
      action: "row.update",
      pageId: team,
      rowId: record,
      version: Number((await one<{ version: number }>("SELECT version FROM rows WHERE id=?", record))!.version),
      cells,
    });
  const cells = async () => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", record))!.cells);
  // A private record of someone else, a database Carol cannot open.
  await fails(() => update(carol, { who: [open, secret] }), 400);
  await fails(() => update(carol, { closed: [hidden] }), 403);
  await update(carol, { who: [open] });
  assert.deepEqual((await cells()).who, [open]);
  // A link set by someone who may read it stays when Carol edits the cell.
  await update(owner, { who: [open, secret] });
  await update(carol, { who: [secret] });
  assert.deepEqual((await cells()).who, [secret]);
});
