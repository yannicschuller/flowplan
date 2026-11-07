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

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Olga"),
  editor = account("Emil"),
  viewer = account("Vera"),
  guest = account("Gustav");
const wid = createWorkspace(owner.id, "Agentur");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const team = bootstrap(owner, wid).spaces[0].id;
type Result = { id: string } & Record<string, unknown>;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Result;
const tagId = (name: string) => one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND name=?", wid, name)?.id;
const tagNames = () => bootstrap(owner, wid).taxonomy!.tags.map((t) => t.name);

const db = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Projekte", kind: "database" }).id;
const fields = (): Field[] => database(db).fields;
const schema = (next: Field[], as = owner) => act({ action: "database.update", pageId: db, version: database(db).version, fields: next, views: database(db).views }, as);
const cells = (rowId: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId)!.cells) as Record<string, unknown>;
const record = (title: string, values: Record<string, unknown> = {}, as = owner, pageId = db) =>
  act({ action: "row.create", pageId, cells: { [database(pageId).fields[0].id]: title, ...values } }, as).id;
const update = (rowId: string, values: Record<string, unknown>, as = owner, pageId = db) =>
  act({ action: "row.update", pageId, rowId, version: one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId)!.version, cells: values }, as);
const hits = (query: string, as = owner) => searchWorkspace(as, wid, query).map((h) => (h.rowId ? `row:${h.title}` : h.title));

// An existing page tag, and a multi-select with its own options.
const kunde = act({ action: "tag.save", workspaceId: wid, name: "Kunde" }).id;
const angebotPage = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Angebot Seite", kind: "document" }).id;
act({ action: "page.properties", pageId: angebotPage, tags: [kunde] });
schema([...fields(), { id: "themen", name: "Themen", type: "multiselect", options: ["kunde", "Intern"] }]);
const alpha = record("Alpha", { themen: ["kunde", "Intern"] });
const beta = record("Beta", { themen: ["Intern"] });

test("switching a multi-select to the workspace's tags maps options and values", () => {
  schema(fields().map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f)));
  const field = fields().find((f) => f.id === "themen")!;
  assert.equal(field.tagOptions, true);
  // "kunde" is the existing tag "Kunde"; "Intern" was created.
  assert.ok(tagId("Intern"));
  assert.deepEqual(field.options, tagNames());
  assert.deepEqual(cells(alpha).themen, ["Kunde", "Intern"]);
  assert.deepEqual(cells(beta).themen, ["Intern"]);
});

test("values that are no tag yet create one for editors, not for viewers or guests", () => {
  update(beta, { themen: ["Intern", "Neu"] }, editor);
  assert.ok(tagId("Neu"));
  assert.deepEqual(cells(beta).themen, ["Intern", "Neu"]);
  assert.ok(fields().find((f) => f.id === "themen")!.options!.includes("Neu"));
  // Existing tags in any case get their exact name.
  update(beta, { themen: ["intern", "NEU"] }, editor);
  assert.deepEqual(cells(beta).themen, ["Intern", "Neu"]);
  assert.throws(() => update(beta, { themen: ["Anders"] }, viewer), /Berechtigung|schreibgeschützt|Rechte/);
  // A guest with edit rights uses only the tags of the records it sees.
  run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", db, guest.id, "editor");
  assert.throws(() => update(beta, { themen: ["Intern", "Gast-Tag"] }, guest), /Neue Tags/);
  assert.equal(tagId("Gast-Tag"), undefined);
  update(beta, { themen: ["Intern"] }, guest);
  assert.deepEqual(cells(beta).themen, ["Intern"]);
  assert.throws(() => record("Gamma", { themen: ["Gast-Tag"] }, guest), /Neue Tags/);
  // A read token never creates.
  assert.throws(() => update(beta, { themen: ["Token"] }, { ...editor, apiScope: "read" }), /nur lesen/);
  update(beta, { themen: ["Intern", "Neu"] });
});

test("renaming, merging and deleting a tag rewrites the cells", () => {
  const view = database(db).views[0];
  act({ action: "database.update", pageId: db, version: database(db).version, fields: fields(), views: [{ ...view, filters: [{ field: "themen", op: "any_of", value: "", values: ["Intern"] }] }] });
  const before = one<{ version: number }>("SELECT version FROM rows WHERE id=?", alpha)!.version;
  act({ action: "tag.save", workspaceId: wid, tagId: tagId("Intern")!, name: "Intern (Team)" });
  assert.deepEqual(cells(alpha).themen, ["Kunde", "Intern (Team)"]);
  assert.deepEqual(cells(beta).themen, ["Intern (Team)", "Neu"]);
  assert.ok(one<{ version: number }>("SELECT version FROM rows WHERE id=?", alpha)!.version > before);
  assert.deepEqual(database(db).views[0].filters[0].values, ["Intern (Team)"]);
  assert.ok(fields().find((f) => f.id === "themen")!.options!.includes("Intern (Team)"));
  // A version of the database keeps the state before.
  assert.ok(one("SELECT 1 FROM snapshots WHERE page_id=?", db));
  // Merge: the source's values become the target, once.
  act({ action: "tag.merge", workspaceId: wid, tagId: tagId("Neu")!, into: tagId("Intern (Team)")! });
  assert.deepEqual(cells(beta).themen, ["Intern (Team)"]);
  // Delete: the value goes.
  act({ action: "tag.delete", workspaceId: wid, tagId: tagId("Intern (Team)")! });
  assert.deepEqual(cells(alpha).themen, ["Kunde"]);
  assert.deepEqual(cells(beta).themen, []);
  // The filter on the deleted tag went with it.
  assert.deepEqual(database(db).views[0].filters, []);
  assert.deepEqual(fields().find((f) => f.id === "themen")!.options, tagNames());
});

test("records with tags appear in the tag view and the search, with access rules", () => {
  update(beta, { themen: ["Kunde"] });
  const listing = tagListing(owner, wid, kunde) as unknown as { tags: { id: string; pages: number; records: number }[]; records: { row_id: string }[] };
  assert.equal(listing.tags.find((t) => t.id === kunde)!.records, 2);
  assert.deepEqual(listing.records.map((r) => r.row_id).sort(), [alpha, beta].sort());
  assert.deepEqual(hits("#Kunde").sort(), ["Angebot Seite", "row:Alpha", "row:Beta"].sort());
  assert.ok(hits("Alpha #Kunde").includes("row:Alpha"));
  assert.ok(!hits("Alpha -#Kunde").includes("row:Alpha"));
  // A private record of the owner stays hidden from the editor.
  run("UPDATE rows SET access='private' WHERE id=?", beta);
  assert.deepEqual(
    (tagListing(editor, wid, kunde) as unknown as { records: { row_id: string }[] }).records.map((r) => r.row_id),
    [alpha],
  );
  assert.ok(!hits("#Kunde", editor).includes("row:Beta"));
  run("UPDATE rows SET access='inherit' WHERE id=?", beta);
  // A property hidden from the editor does not lead to the record.
  schema(fields().map((f) => (f.id === "themen" ? { ...f, access: { read: "owners" as const, write: "owners" as const } } : f)));
  assert.equal(taggedRecords(editor, wid).length, 0);
  assert.ok(!hits("#Kunde", editor).includes("row:Alpha"));
  schema(fields().map((f) => (f.id === "themen" ? { ...f, access: undefined } : f)));
  // Behind a journal PIN or in the trash: gone.
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Tagebuch", kind: "journal" }).id;
  run("UPDATE pages SET parent_id=? WHERE id=?", journal, db);
  run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
  assert.equal(taggedRecords(owner, wid).length, 0);
  assert.ok(!hits("#Kunde").includes("row:Alpha"));
  run("DELETE FROM journal_settings WHERE page_id=?", journal);
  run("UPDATE pages SET parent_id=NULL WHERE id=?", db);
  run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), db);
  assert.equal(taggedRecords(owner, wid).length, 0);
  run("UPDATE pages SET deleted_at=NULL WHERE id=?", db);
  assert.equal(taggedRecords(owner, wid).length, 2);
});

test("guests learn only the tags of records shared with them", () => {
  const secret = act({ action: "tag.save", workspaceId: wid, name: "Geheim" }).id;
  const other = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Intern", kind: "document" }).id;
  act({ action: "page.properties", pageId: other, tags: [secret] });
  // The guest sees the database (grant above): its records' tags only.
  const taxonomy = bootstrap(guest, wid).taxonomy!;
  assert.deepEqual(taxonomy.tags.map((t) => t.name), ["Kunde"]);
  const data = pageData(guest, db) as unknown as { database: { fields: Field[] } };
  assert.deepEqual(data.database.fields.find((f) => f.id === "themen")!.options, ["Kunde"]);
  const asOwner = pageData(owner, db) as unknown as { database: { fields: Field[] } };
  assert.ok(asOwner.database.fields.find((f) => f.id === "themen")!.options!.includes("Geheim"));
  // A private record's tags stay unknown too.
  update(alpha, { themen: ["Kunde", "Geheim"] });
  run("UPDATE rows SET access='private' WHERE id=?", alpha);
  assert.deepEqual(bootstrap(guest, wid).taxonomy!.tags.map((t) => t.name), ["Kunde"]);
  assert.throws(() => update(beta, { themen: ["Kunde", "Geheim"] }, guest), /Neue Tags/);
  run("UPDATE rows SET access='inherit' WHERE id=?", alpha);
  update(alpha, { themen: ["Kunde"] });
});

test("share links offer only the record's own tags and create none", () => {
  const token = act({ action: "share.create", pageId: db, role: "editor", includeChildren: false, name: "Gäste" }).token as string;
  const shared = sharedContent(token, db, alpha);
  assert.deepEqual(shared.fields.find((f) => f.id === "themen")!.options, ["Kunde"]);
  assert.ok(!JSON.stringify(shared).includes("Geheim"));
  assert.throws(
    () => mutateSharedContent(token, { action: "cells", pageId: db, rowId: alpha, version: shared.version, cells: { themen: ["Kunde", "Geheim"] } }),
    /Ungültige Auswahl/,
  );
});

test("turn into page carries the record's tags; turn into record the page's", () => {
  const gamma = record("Gamma", { themen: ["Kunde", "Projekt"] });
  const moved = act({ action: "record.toPage", pageId: db, rowId: gamma, spaceId: team, keepProperties: false });
  const page = moved.id;
  const tags = (pageData(owner, page) as { properties?: { tags: string[] } }).properties!.tags;
  assert.deepEqual(tags, [kunde, tagId("Projekt")]);
  // And back: into the database's first tag-backed property.
  const back = act({ action: "page.toRecord", pageId: angebotPage, databaseId: db }) as unknown as { rowId: string };
  assert.deepEqual(cells(back.rowId).themen, ["Kunde"]);
});

test("switching back to an own list keeps the values; encrypted spaces refuse the option", () => {
  schema(fields().map((f) => (f.id === "themen" ? { ...f, tagOptions: false } : f)));
  const field = fields().find((f) => f.id === "themen")!;
  assert.ok(!field.tagOptions);
  // The tags in use come first.
  assert.equal(field.options![0], "Kunde");
  assert.ok(field.options!.length <= 100);
  assert.deepEqual(cells(alpha).themen, ["Kunde"]);
  // Own lists keep at most 100 options.
  assert.throws(() => schema(fields().map((f) => (f.id === "themen" ? { ...f, options: Array.from({ length: 101 }, (_, i) => `o${i}`) } : f))), /100 Optionen/);
  // End-to-end encrypted: refused server-side.
  const page = one<Page>("SELECT * FROM pages WHERE id=?", db)!;
  run("UPDATE spaces SET encrypted=1 WHERE id=?", page.space_id);
  try {
    assert.throws(
      () => prepareTagFields(owner, page, fields().map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f)), fields()),
      /verschlüsselter/,
    );
    assert.throws(() => schema(fields().map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f))), (e: { status?: number }) => e.status === 409);
  } finally {
    run("UPDATE spaces SET encrypted=0 WHERE id=?", page.space_id);
  }
});

test("rows.import creates missing tags under the same rule", () => {
  schema(fields().map((f) => (f.id === "themen" ? { ...f, tagOptions: true } : f)));
  const title = fields()[0].id;
  act({ action: "rows.import", pageId: db, rows: [{ [title]: "Import", themen: ["kunde", "Importiert"] }] }, editor);
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND cells LIKE '%Importiert%'", db)!;
  assert.deepEqual(JSON.parse(row.cells).themen, ["Kunde", "Importiert"]);
  assert.ok(tagId("Importiert"));
  // A guest's import keeps known tags and leaves out the rest.
  act({ action: "rows.import", pageId: db, rows: [{ [title]: "Gast-Import", themen: ["Kunde", "Gast-Neu"] }] }, guest);
  const guestRow = one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND cells LIKE '%Gast-Import%'", db)!;
  assert.deepEqual(JSON.parse(guestRow.cells).themen, ["Kunde"]);
  assert.equal(tagId("Gast-Neu"), undefined);
});
