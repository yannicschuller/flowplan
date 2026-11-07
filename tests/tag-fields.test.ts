// Multi-select properties with the workspace's tags as options (#79):
// switching, creating tags from records, rename/merge/delete rewriting
// cells, the tag view and search with access rules, guests, conversions and
// end-to-end encrypted spaces.
import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tag-fields-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData, database } = await import("../lib/api");
const { searchWorkspace } = await import("../lib/search-index");
const { tagListing } = await import("../lib/page-properties-server");
const { prepareTagFields, taggedRecords } = await import("../lib/tag-fields");
const { sharedContent, mutateSharedContent } = await import("../lib/shared-content");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  editor = await account("Emil"),
  viewer = await account("Vera"),
  guest = await account("Gustav");
const wid = await createWorkspace(owner.id, "Agentur");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const team = (await bootstrap(owner, wid)).spaces[0].id;
type Result = { id: string } & Record<string, unknown>;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Result;
const tagId = async (name: string) => (await one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND name=?", wid, name))?.id;
const tagNames = async () => (await bootstrap(owner, wid)).taxonomy!.tags.map((t) => t.name);

const db = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Projekte", kind: "database" })).id;
const fields = async (): Promise<Field[]> => (await database(db)).fields;
const schema = async (next: Field[], as = owner) => await act({ action: "database.update", pageId: db, version: (await database(db)).version, fields: next, views: (await database(db)).views }, as);
const cells = async (rowId: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId))!.cells) as Record<string, unknown>;
const record = async (title: string, values: Record<string, unknown> = {}, as = owner, pageId = db) =>
  (await act({ action: "row.create", pageId, cells: { [(await database(pageId)).fields[0].id]: title, ...values } }, as)).id;
const update = async (rowId: string, values: Record<string, unknown>, as = owner, pageId = db) =>
  await act({ action: "row.update", pageId, rowId, version: (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version, cells: values }, as);
const hits = async (query: string, as = owner) => (await searchWorkspace(as, wid, query)).map((h) => (h.rowId ? `row:${h.title}` : h.title));

// An existing page tag, and a multi-select with its own options.
const kunde = (await act({ action: "tag.save", workspaceId: wid, name: "Kunde" })).id;
const angebotPage = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Angebot Seite", kind: "document" })).id;
await act({ action: "page.properties", pageId: angebotPage, tags: [kunde] });
await schema([...await fields(), { id: "themen", name: "Themen", type: "multiselect", options: ["kunde", "Intern"] }]);
const alpha = await record("Alpha", { themen: ["kunde", "Intern"] });
const beta = await record("Beta", { themen: ["Intern"] });

test("switching a multi-select to the workspace's tags maps options and values", async () => {
  await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f)));
  const field = (await fields()).find((f) => f.id === "themen")!;
  assert.equal(field.tagOptions, true);
  // "kunde" is the existing tag "Kunde"; "Intern" was created.
  assert.ok(await tagId("Intern"));
  assert.deepEqual(field.options, await tagNames());
  assert.deepEqual((await cells(alpha)).themen, ["Kunde", "Intern"]);
  assert.deepEqual((await cells(beta)).themen, ["Intern"]);
});

test("values that are no tag yet create one for editors, not for viewers or guests", async () => {
  await update(beta, { themen: ["Intern", "Neu"] }, editor);
  assert.ok(await tagId("Neu"));
  assert.deepEqual((await cells(beta)).themen, ["Intern", "Neu"]);
  assert.ok((await fields()).find((f) => f.id === "themen")!.options!.includes("Neu"));
  // Existing tags in any case get their exact name.
  await update(beta, { themen: ["intern", "NEU"] }, editor);
  assert.deepEqual((await cells(beta)).themen, ["Intern", "Neu"]);
  await assert.rejects(async () => await update(beta, { themen: ["Anders"] }, viewer), /Berechtigung|schreibgeschützt|Rechte/);
  // A guest with edit rights uses only the tags of the records it sees.
  await run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", db, guest.id, "editor");
  await assert.rejects(async () => await update(beta, { themen: ["Intern", "Gast-Tag"] }, guest), /Neue Tags/);
  assert.equal(await tagId("Gast-Tag"), undefined);
  await update(beta, { themen: ["Intern"] }, guest);
  assert.deepEqual((await cells(beta)).themen, ["Intern"]);
  await assert.rejects(async () => await record("Gamma", { themen: ["Gast-Tag"] }, guest), /Neue Tags/);
  // A read token never creates.
  await assert.rejects(async () => await update(beta, { themen: ["Token"] }, { ...editor, apiScope: "read" }), /nur lesen/);
  await update(beta, { themen: ["Intern", "Neu"] });
});

test("renaming, merging and deleting a tag rewrites the cells", async () => {
  const view = (await database(db)).views[0];
  await act({ action: "database.update", pageId: db, version: (await database(db)).version, fields: await fields(), views: [{ ...view, filters: [{ field: "themen", op: "any_of", value: "", values: ["Intern"] }] }] });
  const before = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", alpha))!.version;
  await act({ action: "tag.save", workspaceId: wid, tagId: (await tagId("Intern"))!, name: "Intern (Team)" });
  assert.deepEqual((await cells(alpha)).themen, ["Kunde", "Intern (Team)"]);
  assert.deepEqual((await cells(beta)).themen, ["Intern (Team)", "Neu"]);
  assert.ok((await one<{ version: number }>("SELECT version FROM rows WHERE id=?", alpha))!.version > before);
  assert.deepEqual((await database(db)).views[0].filters[0].values, ["Intern (Team)"]);
  assert.ok((await fields()).find((f) => f.id === "themen")!.options!.includes("Intern (Team)"));
  // A version of the database keeps the state before.
  assert.ok(await one("SELECT 1 FROM snapshots WHERE page_id=?", db));
  // Merge: the source's values become the target, once.
  await act({ action: "tag.merge", workspaceId: wid, tagId: (await tagId("Neu"))!, into: (await tagId("Intern (Team)"))! });
  assert.deepEqual((await cells(beta)).themen, ["Intern (Team)"]);
  // Delete: the value goes.
  await act({ action: "tag.delete", workspaceId: wid, tagId: (await tagId("Intern (Team)"))! });
  assert.deepEqual((await cells(alpha)).themen, ["Kunde"]);
  assert.deepEqual((await cells(beta)).themen, []);
  // The filter on the deleted tag went with it.
  assert.deepEqual((await database(db)).views[0].filters, []);
  assert.deepEqual((await fields()).find((f) => f.id === "themen")!.options, await tagNames());
});

test("records with tags appear in the tag view and the search, with access rules", async () => {
  await update(beta, { themen: ["Kunde"] });
  const listing = (await tagListing(owner, wid, kunde)) as unknown as { tags: { id: string; pages: number; records: number }[]; records: { row_id: string }[] };
  assert.equal(listing.tags.find((t) => t.id === kunde)!.records, 2);
  assert.deepEqual(listing.records.map((r) => r.row_id).sort(), [alpha, beta].sort());
  assert.deepEqual((await hits("#Kunde")).sort(), ["Angebot Seite", "row:Alpha", "row:Beta"].sort());
  assert.ok((await hits("Alpha #Kunde")).includes("row:Alpha"));
  assert.ok(!(await hits("Alpha -#Kunde")).includes("row:Alpha"));
  // A private record of the owner stays hidden from the editor.
  await run("UPDATE rows SET access='private' WHERE id=?", beta);
  assert.deepEqual(
    ((await tagListing(editor, wid, kunde)) as unknown as { records: { row_id: string }[] }).records.map((r) => r.row_id),
    [alpha],
  );
  assert.ok(!(await hits("#Kunde", editor)).includes("row:Beta"));
  await run("UPDATE rows SET access='inherit' WHERE id=?", beta);
  // A property hidden from the editor does not lead to the record.
  await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, access: { read: "owners" as const, write: "owners" as const } } : f)));
  assert.equal((await taggedRecords(editor, wid)).length, 0);
  assert.ok(!(await hits("#Kunde", editor)).includes("row:Alpha"));
  await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, access: undefined } : f)));
  // Behind a journal PIN or in the trash: gone.
  const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Tagebuch", kind: "journal" })).id;
  await run("UPDATE pages SET parent_id=? WHERE id=?", journal, db);
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
  assert.equal((await taggedRecords(owner, wid)).length, 0);
  assert.ok(!(await hits("#Kunde")).includes("row:Alpha"));
  await run("DELETE FROM journal_settings WHERE page_id=?", journal);
  await run("UPDATE pages SET parent_id=NULL WHERE id=?", db);
  await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), db);
  assert.equal((await taggedRecords(owner, wid)).length, 0);
  await run("UPDATE pages SET deleted_at=NULL WHERE id=?", db);
  assert.equal((await taggedRecords(owner, wid)).length, 2);
});

test("guests learn only the tags of records shared with them", async () => {
  const secret = (await act({ action: "tag.save", workspaceId: wid, name: "Geheim" })).id;
  const other = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Intern", kind: "document" })).id;
  await act({ action: "page.properties", pageId: other, tags: [secret] });
  // The guest sees the database (grant above): its records' tags only.
  const taxonomy = (await bootstrap(guest, wid)).taxonomy!;
  assert.deepEqual(taxonomy.tags.map((t) => t.name), ["Kunde"]);
  const data = (await pageData(guest, db)) as unknown as { database: { fields: Field[] } };
  assert.deepEqual(data.database.fields.find((f) => f.id === "themen")!.options, ["Kunde"]);
  const asOwner = (await pageData(owner, db)) as unknown as { database: { fields: Field[] } };
  assert.ok(asOwner.database.fields.find((f) => f.id === "themen")!.options!.includes("Geheim"));
  // A private record's tags stay unknown too.
  await update(alpha, { themen: ["Kunde", "Geheim"] });
  await run("UPDATE rows SET access='private' WHERE id=?", alpha);
  assert.deepEqual((await bootstrap(guest, wid)).taxonomy!.tags.map((t) => t.name), ["Kunde"]);
  await assert.rejects(async () => await update(beta, { themen: ["Kunde", "Geheim"] }, guest), /Neue Tags/);
  await run("UPDATE rows SET access='inherit' WHERE id=?", alpha);
  await update(alpha, { themen: ["Kunde"] });
});

test("share links offer only the record's own tags and create none", async () => {
  const token = (await act({ action: "share.create", pageId: db, role: "editor", includeChildren: false, name: "Gäste" })).token as string;
  const shared = await sharedContent(token, db, alpha);
  assert.deepEqual(shared.fields.find((f) => f.id === "themen")!.options, ["Kunde"]);
  assert.ok(!JSON.stringify(shared).includes("Geheim"));
  await assert.rejects(
    async () => await mutateSharedContent(token, { action: "cells", pageId: db, rowId: alpha, version: shared.version, cells: { themen: ["Kunde", "Geheim"] } }),
    /Ungültige Auswahl/,
  );
});

test("turn into page carries the record's tags; turn into record the page's", async () => {
  const gamma = await record("Gamma", { themen: ["Kunde", "Projekt"] });
  const moved = await act({ action: "record.toPage", pageId: db, rowId: gamma, spaceId: team, keepProperties: false });
  const page = moved.id;
  const tags = ((await pageData(owner, page)) as { properties?: { tags: string[] } }).properties!.tags;
  assert.deepEqual(tags, [kunde, await tagId("Projekt")]);
  // And back: into the database's first tag-backed property.
  const back = (await act({ action: "page.toRecord", pageId: angebotPage, databaseId: db })) as unknown as { rowId: string };
  assert.deepEqual((await cells(back.rowId)).themen, ["Kunde"]);
});

test("switching back to an own list keeps the values; encrypted spaces refuse the option", async () => {
  await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, tagOptions: false } : f)));
  const field = (await fields()).find((f) => f.id === "themen")!;
  assert.ok(!field.tagOptions);
  // The tags in use come first.
  assert.equal(field.options![0], "Kunde");
  assert.ok(field.options!.length <= 100);
  assert.deepEqual((await cells(alpha)).themen, ["Kunde"]);
  // Own lists keep at most 100 options.
  await assert.rejects(async () => await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, options: Array.from({ length: 101 }, (_, i) => `o${i}`) } : f))), /100 Optionen/);
  // End-to-end encrypted: refused server-side.
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", db))!;
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", page.space_id);
  try {
    await assert.rejects(
      async () => await prepareTagFields(owner, page, (await fields()).map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f)), await fields()),
      /verschlüsselter/,
    );
    await assert.rejects(async () => await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f))), (e: { status?: number }) => e.status === 409);
  } finally {
    await run("UPDATE spaces SET encrypted=0 WHERE id=?", page.space_id);
  }
});

test("rows.import creates missing tags under the same rule", async () => {
  await schema((await fields()).map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f)));
  const title = (await fields())[0].id;
  await act({ action: "rows.import", pageId: db, rows: [{ [title]: "Import", themen: ["kunde", "Importiert"] }] }, editor);
  const row = (await one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND cells LIKE '%Importiert%'", db))!;
  assert.deepEqual(JSON.parse(row.cells).themen, ["Kunde", "Importiert"]);
  assert.ok(await tagId("Importiert"));
  // A guest's import keeps known tags and leaves out the rest.
  await act({ action: "rows.import", pageId: db, rows: [{ [title]: "Gast-Import", themen: ["Kunde", "Gast-Neu"] }] }, guest);
  const guestRow = (await one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND cells LIKE '%Gast-Import%'", db))!;
  assert.deepEqual(JSON.parse(guestRow.cells).themen, ["Kunde"]);
  assert.equal(await tagId("Gast-Neu"), undefined);
});
