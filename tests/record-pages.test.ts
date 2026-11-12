// Sub-pages under records (#231, part 3, lib/record-pages.ts): pages below
// a record keep its database as parent and name the record; they inherit
// the record's access, go to the trash and come back with it, move with it
// to another database, are copied with their database, carried by archives,
// exports and the Notion import, and are shared with a record only with
// "Unterseiten einbeziehen" – never sub-pages of other records, and nothing
// after revoking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-record-pages-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { requirePage, pageRole } = await import("../lib/permissions");
const { publicPage, publicTree, publicFile } = await import("../lib/publication");
const { sharedContent } = await import("../lib/shared-content");
const { recordSharePages, recordScope } = await import("../lib/record-share");
const { shareAccess } = await import("../lib/share-presence");
const { writeZip, exportArchive, importArchive, readZip } = await import("../lib/archive");
const { importZip } = await import("../lib/zip-import");
const { exportMarkdown } = await import("../lib/markdown-export");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  editor = await user("editor"),
  wid = await createWorkspace(owner.id, "Records"),
  boot = await bootstrap(owner, wid),
  space = boot.spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
async function page(extra: Record<string, unknown> = {}, by = owner) {
  return ((await command(by, { action: "page.create", workspaceId: wid, spaceId: space, title: "Seite", ...extra })) as { id: string }).id;
}
const stored = async (pid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
async function fails(fn: () => unknown, status: number) {
  await assert.rejects(async () => fn(), (e: { status?: number }) => e.status === status);
}
async function database(title = "Requirements") {
  const db = await page({ kind: "database", title });
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([{ id: "title", name: "Name", type: "text" }]), db);
  return db;
}
async function record(db: string, title: string, access = "inherit") {
  const rid = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by,access) VALUES(?,?,?,?,?)", rid, db, JSON.stringify({ title }), owner.id, access);
  return rid;
}
const pagesOf = async (u: Identity) => (await bootstrap(u, wid)).pages.map((p) => p.id);

test("a page is created below a record and listed with it; the record's edit rights are needed", async () => {
  const db = await database();
  const rid = await record(db, "U3a Interface X");
  const notes = await page({ parentId: db, parentRowId: rid, title: "Call notes" });
  const p = await stored(notes);
  assert.equal(p.parent_id, db);
  assert.equal(p.parent_row_id, rid);
  // Below the record of the parent database only.
  const other = await database("Other");
  await fails(() => page({ parentId: other, parentRowId: rid }), 404);
  await fails(() => page({ parentRowId: rid }), 400);
  // Readers of the record cannot add pages below it.
  await fails(() => page({ parentId: db, parentRowId: rid }, viewer), 403);
  // The bootstrap names the record for the sidebar and the breadcrumb.
  const b = await bootstrap(viewer, wid);
  assert.deepEqual(b.recordParents?.find((r) => r.rowId === rid), { pageId: db, rowId: rid, title: "U3a Interface X", icon: "" });
  assert.ok(b.pages.some((p) => p.id === notes));
});

test("sub-pages inherit the record's access: private and read-only records, record grants", async () => {
  const db = await database();
  const secret = await record(db, "Secret", "private");
  const fixed = await record(db, "Fixed", "readonly");
  const hidden = await page({ parentId: db, parentRowId: secret, title: "Hidden notes" });
  const deeper = await page({ parentId: hidden, title: "Deeper" });
  const readonly = await page({ parentId: db, parentRowId: fixed, title: "Read-only notes" });
  // Members who do not see the private record see nothing below it –
  // not in the tree, not by id, not its record in the bootstrap.
  for (const pid of [hidden, deeper]) {
    assert.equal(await pageRole(editor, await stored(pid)), null);
    await fails(() => requirePage(editor, pid), 403);
    assert.ok(!(await pagesOf(editor)).includes(pid));
  }
  assert.ok(!(await bootstrap(editor, wid)).recordParents?.some((r) => r.rowId === secret));
  // The owner (manager of the record) does.
  assert.equal(await pageRole(owner, await stored(deeper)), "owner");
  // A read-only record: its pages are read-only for editors.
  assert.equal(await pageRole(editor, await stored(readonly)), "viewer");
  await fails(() => command(editor, { action: "page.update", pageId: readonly, patch: { title: "x" } }), 403);
  // A grant on the record opens it and its pages.
  await command(owner, { action: "row.access", pageId: db, rowId: secret, access: "private", grants: [{ userId: editor.id, role: "editor" }] });
  assert.equal(await pageRole(editor, await stored(deeper)), "editor");
  assert.ok((await bootstrap(editor, wid)).recordParents?.some((r) => r.rowId === secret));
});

test("pages move below a record (Move to …, drag and drop) and out again; a stand-in page is dissolved", async () => {
  const db = await database();
  const rid = await record(db, "Interface");
  // The workaround of the Notion migration: a same-named page with the
  // record's sub-pages below it.
  const standIn = await page({ title: "Interface" });
  const a = await page({ parentId: standIn, title: "Call notes" });
  const b = await page({ parentId: standIn, title: "Flowcharts" });
  const c = await page({ parentId: b, title: "Detail" });
  await command(owner, { action: "page.move", pageId: a, parentId: db, parentRowId: rid });
  assert.deepEqual([(await stored(a)).parent_id, (await stored(a)).parent_row_id], [db, rid]);
  // Next to a page below the record (as dropping in the tree): below it too.
  await command(owner, { action: "page.move", pageId: b, targetId: a, placement: "after" });
  assert.deepEqual([(await stored(b)).parent_id, (await stored(b)).parent_row_id], [db, rid]);
  // Its own sub-pages travel with it and stay below it.
  assert.equal((await stored(c)).parent_id, b);
  assert.deepEqual((await all<{ id: string }>("SELECT id FROM pages WHERE parent_row_id=? ORDER BY position", rid)).map((p) => p.id), [a, b]);
  // The stand-in is empty now and can go.
  assert.equal((await all("SELECT id FROM pages WHERE parent_id=? AND deleted_at IS NULL", standIn)).length, 0);
  // Several at once (pages.bulk, "Verschieben nach …" of a selection).
  const d = await page({ title: "Spec" }),
    e = await page({ title: "Summary" });
  await command(owner, { action: "pages.bulk", workspaceId: wid, operation: "move", pageIds: [d, e], parentId: db, parentRowId: rid });
  for (const pid of [d, e]) assert.equal((await stored(pid)).parent_row_id, rid);
  // Readers of the record cannot move pages there.
  const mine = await page({ title: "Mine" }, editor);
  await run("UPDATE rows SET access='readonly' WHERE id=?", rid);
  await fails(() => command(editor, { action: "page.move", pageId: mine, parentId: db, parentRowId: rid }), 403);
  await run("UPDATE rows SET access='inherit' WHERE id=?", rid);
  // Into another page: no longer below the record.
  await command(owner, { action: "page.move", pageId: e, targetId: standIn, placement: "inside" });
  assert.deepEqual([(await stored(e)).parent_id, (await stored(e)).parent_row_id ?? null], [standIn, null]);
  // Not below its own sub-page's record: the database into its own tree.
  const r2 = await record(db, "Other");
  await fails(() => command(owner, { action: "page.move", pageId: db, targetId: a, placement: "inside", parentRowId: r2 }), 400);
});

test("deleting a record takes its sub-pages to the trash; restoring brings them back; purging deletes them", async () => {
  const db = await database();
  const rid = await record(db, "Doomed");
  const a = await page({ parentId: db, parentRowId: rid, title: "A" });
  const a1 = await page({ parentId: a, title: "A1" });
  const before = await page({ parentId: db, parentRowId: rid, title: "Trashed before" });
  await command(owner, { action: "page.delete", pageId: before });
  const earlier = (await stored(before)).deleted_at;
  await new Promise((r) => setTimeout(r, 1100));
  await command(owner, { action: "row.delete", pageId: db, rowId: rid });
  for (const pid of [a, a1]) assert.ok((await stored(pid)).deleted_at, pid);
  assert.equal((await stored(a)).deleted_at, (await stored(a1)).deleted_at);
  // While the record is in the trash, its access still counts.
  assert.equal(await pageRole(viewer, await stored(a)), "viewer");
  await command(owner, { action: "row.trash.restore", trashId: rid });
  for (const pid of [a, a1]) assert.equal((await stored(pid)).deleted_at, null, pid);
  // One trashed on its own earlier stays in the trash.
  assert.equal((await stored(before)).deleted_at, earlier);
  // A sub-page restored on its own while its record is in the trash goes to
  // the top of the space; the record's restore leaves it there.
  await command(owner, { action: "row.delete", pageId: db, rowId: rid });
  await command(owner, { action: "page.restore", pageId: a1 });
  const alone = await stored(a1);
  assert.deepEqual([alone.deleted_at, alone.parent_id, alone.parent_row_id ?? null], [null, null, null]);
  await command(owner, { action: "page.restore", pageId: a });
  assert.deepEqual([(await stored(a)).parent_id, (await stored(a)).parent_row_id ?? null], [null, null]);
  // Purging the record deletes the sub-pages still waiting with it.
  const rid2 = await record(db, "Gone");
  const b = await page({ parentId: db, parentRowId: rid2, title: "B" });
  await command(owner, { action: "row.delete", pageId: db, rowId: rid2 });
  await command(owner, { action: "row.trash.purge", trashId: rid2 });
  assert.equal(await one("SELECT 1 FROM pages WHERE id=?", b), undefined);
  // Deleting the database takes everything below it, record pages too.
  const rid3 = await record(db, "Stays");
  const c = await page({ parentId: db, parentRowId: rid3, title: "C" });
  await command(owner, { action: "page.delete", pageId: db });
  assert.ok((await stored(c)).deleted_at);
  await command(owner, { action: "page.restore", pageId: db });
  assert.equal((await stored(c)).deleted_at, null);
  assert.equal((await stored(c)).parent_row_id, rid3);
});

test("moving a record to another database takes its sub-pages; converting it to a page adopts them", async () => {
  const source = await database("Source"),
    target = await database("Target");
  const rid = await record(source, "Traveller");
  const a = await page({ parentId: source, parentRowId: rid, title: "A" });
  const a1 = await page({ parentId: a, title: "A1" });
  // Into another space as well.
  const other = (await command(owner, { action: "space.create", workspaceId: wid, name: "Elsewhere" })) as { id: string } | undefined;
  const otherSpace = other?.id || (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND id!=? AND deleted_at IS NULL", wid, space))!.id;
  await command(owner, { action: "page.move", pageId: target, spaceId: otherSpace, parentId: null });
  await command(owner, { action: "rows.transfer", pageId: source, rowIds: [rid], targetPageId: target, mode: "move" });
  const moved = await stored(a);
  assert.deepEqual([moved.parent_id, moved.parent_row_id, moved.space_id], [target, rid, otherSpace]);
  assert.equal((await stored(a1)).space_id, otherSpace);
  // Copying a record copies the record alone.
  await command(owner, { action: "rows.transfer", pageId: target, rowIds: [rid], targetPageId: source, mode: "copy" });
  assert.equal((await all("SELECT id FROM pages WHERE parent_id=? AND deleted_at IS NULL", source)).length, 0);
});

test("duplicating a database copies its record pages below the copied records (not those of hidden records)", async () => {
  const db = await database("Copied");
  const rid = await record(db, "Shown");
  const secret = await record(db, "Secret", "private");
  await page({ parentId: db, parentRowId: rid, title: "Shown notes" });
  await page({ parentId: db, parentRowId: secret, title: "Secret notes" });
  await run("UPDATE rows SET created_by=? WHERE id=?", owner.id, secret);
  // An editor who does not see the private record copies without it and its pages.
  const { id: copy } = (await command(editor, { action: "page.duplicate", pageId: db })) as { id: string };
  const copiedRows = await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", copy);
  assert.equal(copiedRows.length, 1);
  const pagesBelow = await all<Page>("SELECT * FROM pages WHERE parent_id=?", copy);
  assert.deepEqual(pagesBelow.map((p) => p.title), ["Shown notes"]);
  assert.equal(pagesBelow[0].parent_row_id, copiedRows[0].id);
});

test("archives carry the record a page sits under; the Markdown export lists it with the record", async () => {
  const db = await database("Archived");
  const rid = await record(db, "With pages");
  await page({ parentId: db, parentRowId: rid, title: "Archived notes" });
  const target = await createWorkspace(owner.id, "Target");
  const archive = await exportArchive(owner, wid);
  await importArchive(owner, target, archive);
  const imported = await one<Page>("SELECT * FROM pages WHERE workspace_id=? AND title='Archived notes'", target);
  assert.ok(imported?.parent_row_id);
  const row = await one<{ page_id: string }>("SELECT page_id FROM rows WHERE id=?", imported!.parent_row_id);
  assert.equal(row?.page_id, imported!.parent_id);
  // Markdown: the record's file names its sub-pages; the database does not.
  const { bytes } = await exportMarkdown(owner, { pageId: db, format: "zip", includeSubpages: true });
  const files = await readZip(Buffer.from(bytes), { foreign: true });
  const recordFile = [...files.keys()].find((k) => k.startsWith("records/"))!;
  assert.match(files.get(recordFile)!.toString(), /## (Unterseiten|Sub-pages)\n\n- \[Archived notes\]/);
  assert.doesNotMatch(files.get("index.md")!.toString(), /Archived notes/);
});

test("the Notion import puts a record's sub-pages below the record (Markdown and HTML)", async () => {
  const hex = (n: number) => String(n).repeat(32).slice(0, 32);
  for (const ext of ["md", "html"] as const) {
    const body = (title: string) =>
      ext === "md" ? `# ${title}\n\nText of ${title}\n` : `<html><head><title>${title}</title></head><body><article class="page"><header><h1 class="page-title">${title}</h1></header><div class="page-body"><p>Text of ${title}</p></div></article></body></html>`;
    const bytes = await writeZip(
      new Map(
        Object.entries({
          [`Requirements ${hex(1)}.csv`]: "Name,Status\nU3a_Interface X,Open\nOther,Done\n",
          [`Requirements ${hex(1)}/U3a_Interface X ${hex(2)}.${ext}`]: body("U3a_Interface X"),
          [`Requirements ${hex(1)}/U3a_Interface X ${hex(2)}/Call notes ${hex(3)}.${ext}`]: body("Call notes"),
          [`Requirements ${hex(1)}/U3a_Interface X ${hex(2)}/Call notes ${hex(3)}/Detail ${hex(4)}.${ext}`]: body("Detail"),
          [`Requirements ${hex(1)}/U3a_Interface X ${hex(2)}/Flowcharts ${hex(5)}.${ext}`]: body("Flowcharts"),
        }).map(([k, v]) => [k, Buffer.from(v)]),
      ),
    );
    const result = await importZip(owner, wid, space, Buffer.from(bytes));
    const db = (await all<Page>(`SELECT * FROM pages WHERE id IN (${result.rootIds.map(() => "?").join(",")})`, ...result.rootIds)).find((p) => p.kind === "database")!;
    // Only the database is a top-level page: no loose sub-pages.
    assert.deepEqual(result.rootIds, [db.id], ext);
    const row = (await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", db.id)).find((r) => JSON.parse(r.cells).title === "U3a_Interface X")!;
    const below = await all<Page>("SELECT * FROM pages WHERE parent_id=? ORDER BY title", db.id);
    assert.deepEqual(below.map((p) => [p.title, p.parent_row_id]), [["Call notes", row.id], ["Flowcharts", row.id]], ext);
    const detail = await one<Page>("SELECT * FROM pages WHERE parent_id=? AND title='Detail'", below[0].id);
    assert.ok(detail, ext);
    assert.equal(detail!.parent_row_id ?? null, null);
  }
});

test("a shared record includes its sub-pages only with 'Include sub-pages'; nothing else, nothing after revoking", async () => {
  const db = await database("Shared");
  const rid = await record(db, "Requirement");
  const otherRecord = await record(db, "Sibling");
  const sub = await page({ parentId: db, parentRowId: rid, title: "Call notes" });
  const subSub = await page({ parentId: sub, title: "Details" });
  const foreign = await page({ parentId: db, parentRowId: otherRecord, title: "Sibling notes" });
  const loose = await page({ parentId: db, title: "Database sub-page" });
  const workflow = await page({ parentId: db, parentRowId: rid, title: "Automation", kind: "workflow" }).catch(() => null);
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, sub, "plan.png", "image/png", 1, owner.id);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p>See <img src="/api/files/${fid}"></p>`, sub);
  const foreignFile = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", foreignFile, foreign, "x.png", "image/png", 1, owner.id);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><img src="/api/files/${foreignFile}"></p>`, foreign);
  // Without sub-pages: none of them.
  const plain = ((await command(owner, { action: "record.share.create", pageId: db, rowId: rid, name: "Plain", role: "viewer" })) as { token: string }).token;
  for (const pid of [sub, subSub, foreign, loose, db]) await fails(() => publicPage(plain, pid), 404);
  await fails(() => publicFile(plain, fid), 404);
  assert.deepEqual(await recordSharePages((await recordScope(plain))!), []);
  // With sub-pages: the record's own, below it too – never the sibling's,
  // the database's other sub-pages, the database or a workflow page.
  const shares = (await command(owner, { action: "record.share.create", pageId: db, rowId: rid, name: "With pages", role: "editor", includeChildren: true })) as { token: string; links: { token: string; includeChildren: boolean }[]; subPages: number };
  const token = shares.token;
  assert.equal(shares.links.find((l) => l.token === token)?.includeChildren, true);
  assert.equal(shares.subPages, workflow ? 2 : 1);
  assert.deepEqual((await recordSharePages((await recordScope(token))!)).map((p) => p.id).sort(), [sub, subSub].sort());
  const opened = await publicPage(token, sub);
  assert.equal(opened.page.id, sub);
  assert.equal(opened.root.title, "Requirement");
  assert.equal(opened.role, "editor");
  assert.equal((await publicPage(token, subSub)).page.id, subSub);
  for (const pid of [foreign, loose, db, ...(workflow ? [workflow] : [])]) await fails(() => publicPage(token, pid), 404);
  await fails(() => publicPage(token, undefined), 404);
  await fails(() => publicTree(token), 404);
  assert.equal((await publicFile(token, fid)).id, fid);
  await fails(() => publicFile(token, foreignFile), 404);
  // The share's page paths: content and live editing of the sub-page.
  assert.match((await sharedContent(token, sub)).html, /\/api\/share\/[^/]+\/files\//);
  assert.equal((await shareAccess(token, sub)).id, sub);
  await fails(() => sharedContent(token, foreign), 404);
  // A read-only record: guests comment only.
  await run("UPDATE rows SET access='readonly' WHERE id=?", rid);
  assert.equal((await publicPage(token, sub)).role, "commenter");
  await run("UPDATE rows SET access='inherit' WHERE id=?", rid);
  // A sub-page moved out leaves the share.
  await command(owner, { action: "page.move", pageId: subSub, parentId: null, spaceId: space });
  await fails(() => publicPage(token, subSub), 404);
  // The publication: switched on with sub-pages, and off again.
  const published = (await command(owner, { action: "record.publish", pageId: db, rowId: rid, enabled: true, includeChildren: true })) as { publication: { token: string; includeChildren: boolean } };
  assert.equal(published.publication.includeChildren, true);
  assert.equal((await publicPage(published.publication.token, sub)).role, "viewer");
  await command(owner, { action: "record.publish", pageId: db, rowId: rid, enabled: true, includeChildren: false });
  await fails(() => publicPage(published.publication.token, sub), 404);
  // Revoked: nothing.
  await command(owner, { action: "record.share.revoke", pageId: db, rowId: rid, token });
  await fails(() => publicPage(token, sub), 404);
  await fails(() => publicFile(token, fid), 404);
  // A token of the other record never reaches this record's pages.
  const siblingToken = ((await command(owner, { action: "record.share.create", pageId: db, rowId: otherRecord, name: "Sibling", role: "viewer", includeChildren: true })) as { token: string }).token;
  assert.equal((await publicPage(siblingToken, foreign)).page.id, foreign);
  await fails(() => publicPage(siblingToken, sub), 404);
  // Made private: the record and its pages leave every share.
  await run("UPDATE rows SET access='private' WHERE id=?", otherRecord);
  await fails(() => publicPage(siblingToken, foreign), 404);
});

test("a shared or published database leaves out the pages of its private records", async () => {
  const db = await database("Published");
  const open = await record(db, "Open");
  const secret = await record(db, "Secret", "private");
  const openPage = await page({ parentId: db, parentRowId: open, title: "Open notes" });
  const secretPage = await page({ parentId: db, parentRowId: secret, title: "Secret notes" });
  const secretChild = await page({ parentId: secretPage, title: "Below secret" });
  await command(owner, { action: "page.publish", pageId: db, enabled: true, includeChildren: true });
  const token = (await stored(db)).public_token!;
  assert.equal((await publicPage(token, openPage)).page.id, openPage);
  for (const pid of [secretPage, secretChild]) await fails(() => publicPage(token, pid), 404);
  // A record made private later takes its pages out at once.
  await run("UPDATE rows SET access='private' WHERE id=?", open);
  await fails(() => publicPage(token, openPage), 404);
  await run("UPDATE rows SET access='inherit' WHERE id=?", open);
  // A link with sub-pages of the database: the same.
  const { token: link } = (await command(owner, { action: "share.create", pageId: db, name: "Team", role: "viewer", includeChildren: true })) as { token: string };
  assert.equal((await publicPage(link, openPage)).page.id, openPage);
  await fails(() => publicPage(link, secretPage), 404);
});
