import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notes-"));
process.env.APP_URL = "https://flowplan.example.test";
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { splitFrontmatter, toFrontmatter } = await import("../lib/frontmatter");
const { exportMarkdown } = await import("../lib/markdown-export");
const { importMarkdownRecords, markdownEntries, guessType } = await import("../lib/markdown-records");
const { captureTargets } = await import("../lib/capture");
const { readExportZip } = await import("./helpers/read-export-zip");

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const anna = person("Anna"),
  ben = person("Ben");
const wid = createWorkspace(anna.id, "Familie");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "viewer");
const space = bootstrap(anna, wid).spaces[0].id;
const act = (user: Identity, b: Record<string, unknown>) => command(user, { workspaceId: wid, ...b }) as Record<string, unknown>;
const schema = (pageId: string) => {
  const db = one<{ fields: string; views: string; record_layout: string }>("SELECT fields,views,record_layout FROM databases WHERE page_id=?", pageId)!;
  return { fields: JSON.parse(db.fields) as Field[], views: JSON.parse(db.views) as View[], layout: JSON.parse(db.record_layout) };
};
const rowsOf = (pageId: string) =>
  (one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", pageId)!.n);
const newDatabase = (title: string, databaseKind?: string) =>
  String(act(anna, { action: "page.create", spaceId: space, title, kind: "database", ...(databaseKind ? { databaseKind } : {}) }).id);

test("a new database starts as tasks, documents or with only a title", () => {
  const tasks = schema(newDatabase("Aufgaben"));
  assert.deepEqual(tasks.fields.map((f) => f.id), ["title", "status", "priority", "date", "assignee", "tags"]);
  const documents = schema(newDatabase("Notizen", "documents"));
  assert.deepEqual(documents.fields.map((f) => f.type), ["text", "multiselect", "created_at", "updated_at"]);
  assert.equal(documents.views[0].type, "list");
  assert.equal(documents.layout.open, "full");
  const empty = schema(newDatabase("Leer", "empty"));
  assert.deepEqual(empty.fields.map((f) => f.id), ["title"]);
  assert.throws(() => newDatabase("Falsch", "kanban"));
});

test("frontmatter is read as Obsidian writes it and written back readable", () => {
  const { data, body } = splitFrontmatter(
    "---\npara: Resource\narea: House # the house\ntags: [heating, maintenance]\naliases:\n- Heizung\n- \"Heating: yearly\"\ncreated: 2026-03-14\ndone: false\ncount: 3\nflowplan:\n  id: abc\n---\n# Heating – maintenance\nText",
  );
  assert.deepEqual(data, {
    para: "Resource",
    area: "House",
    tags: ["heating", "maintenance"],
    aliases: ["Heizung", "Heating: yearly"],
    created: "2026-03-14",
    done: false,
    count: 3,
    flowplan: { id: "abc" },
  });
  assert.equal(body, "# Heating – maintenance\nText");
  const written = toFrontmatter({ title: "Plan: 2027", tags: ["a b", "true"], when: "2026-01-02", n: 4, ok: true, empty: [] });
  assert.equal(written, '---\ntitle: "Plan: 2027"\ntags:\n  - a b\n  - "true"\nwhen: 2026-01-02\nn: 4\nok: true\nempty: []\n---\n');
  assert.deepEqual(splitFrontmatter(written).data, { title: "Plan: 2027", tags: ["a b", "true"], when: "2026-01-02", n: 4, ok: true, empty: [] });
  assert.deepEqual(splitFrontmatter("No frontmatter\n---\n").data, {});
  assert.deepEqual(guessType([["a"], ["b", "c"]]), { type: "multiselect", options: ["a", "b", "c"] });
  assert.equal(guessType(["2026-03-14", "2026-01-01"]).type, "date");
  assert.equal(guessType([true, false]).type, "checkbox");
  assert.equal(guessType([1, 2.5]).type, "number");
});

const areas = newDatabase("Bereiche", "documents");
const house = String(act(anna, { action: "row.create", pageId: areas, cells: { title: "House" } }).id);
const notes = newDatabase("Notizen PARA", "documents");
const notesSchema = schema(notes);
notesSchema.fields.push({ id: "area", name: "Area", type: "relation", relationPage: areas }, { id: "para", name: "PARA", type: "select", options: ["Resource", "Project"] });
notesSchema.fields[1].options = ["heating"];
run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(notesSchema.fields), notes);

test("an Obsidian note becomes a record with its properties", async () => {
  const note = Buffer.from(
    "---\npara: Resource\narea: \"[[House]]\"\ntags: [heating, maintenance]\nreviewed: 2026-03-14\nsource: https://example.org/heating\n---\n# Heating – maintenance\n\nBleed the radiators in **autumn**.\n",
  );
  const entries = await markdownEntries("Heating.md", note);
  const plan = importMarkdownRecords(anna, notes, entries, { dryRun: true });
  assert.deepEqual(plan.matched.sort(), ["Area", "PARA", "Tags"]);
  assert.deepEqual(plan.missing, [
    { name: "reviewed", type: "date" },
    { name: "source", type: "url" },
  ]);
  assert.equal(rowsOf(notes), 0, "a preview creates nothing");
  const result = importMarkdownRecords(anna, notes, entries, { createMissing: true });
  assert.equal(result.created, 1);
  const row = one<{ id: string; cells: string; content: string }>("SELECT id,cells,content FROM rows WHERE page_id=?", notes)!;
  const fields = schema(notes).fields;
  const byName = (name: string) => fields.find((f) => f.name === name)!;
  const cells = JSON.parse(row.cells);
  assert.equal(cells.title, "Heating – maintenance");
  assert.equal(cells.para, "Resource");
  assert.deepEqual(cells.area, [house]);
  assert.deepEqual(cells.tags, ["heating", "maintenance"]);
  assert.ok(byName("Tags").options!.includes("maintenance"), "unknown tags become options");
  assert.equal(cells[byName("reviewed").id], "2026-03-14");
  assert.equal(cells[byName("source").id], "https://example.org/heating");
  // The heading was the title; the rest is the record document.
  assert.doesNotMatch(row.content, /Heating – maintenance/);
  assert.match(row.content, /<strong>autumn<\/strong>/);
  // Viewers cannot import.
  assert.throws(() => importMarkdownRecords(ben, notes, entries), /Berechtigung/);
});

test("records are exported with frontmatter and come back with their properties", async () => {
  const { bytes } = await exportMarkdown(anna, { pageId: notes, format: "zip", includeSubpages: false });
  const files = await readExportZip(bytes as Buffer);
  const record = [...files].find(([name]) => name.startsWith("records/"))!;
  const text = record[1].toString("utf8");
  const { data, body } = splitFrontmatter(text);
  assert.equal(data.title, "Heating – maintenance");
  assert.equal(data.PARA, "Resource");
  assert.deepEqual(data.Tags, ["heating", "maintenance"]);
  assert.deepEqual(data.Area, ["House"]);
  // Computed values only below "flowplan:", with the record id.
  assert.ok(!("Erstellt" in data) && !("Bearbeitet" in data));
  const flowplan = data.flowplan as Record<string, unknown>;
  assert.equal(typeof flowplan.id, "string");
  assert.ok("Erstellt" in flowplan);
  assert.match(body, /^\n?# Heating – maintenance\n/);
  assert.match(body, /\*\*autumn\*\*/);
  assert.doesNotMatch(text, /\| Eigenschaft \| Wert \|/);
  // Round trip into the same database: same properties, nothing new.
  const plan = importMarkdownRecords(anna, notes, files, { dryRun: true });
  assert.deepEqual(plan.missing, []);
  assert.ok(plan.skipped.length === 0 || plan.skipped.every((name) => ["Erstellt", "Bearbeitet"].includes(name)));
  importMarkdownRecords(anna, notes, files, {});
  const copies = (await import("../lib/db")).all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? ORDER BY position", notes);
  assert.equal(copies.length, 2);
  const [first, second] = copies.map((c) => JSON.parse(c.cells));
  for (const key of ["title", "para", "tags", "area"]) assert.deepEqual(second[key], first[key], key);
});

test("captured items become records in the chosen or default database", () => {
  const inbox = newDatabase("Eingang", "documents");
  const inboxFields = schema(inbox).fields;
  inboxFields.push({ id: "link", name: "Link", type: "url" });
  run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(inboxFields), inbox);
  // The default record template applies (e.g. a tag that puts it in the inbox view).
  run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
    id(),
    inbox,
    "Eingang",
    JSON.stringify({ tags: [] }),
    "<p>Zum Sortieren</p>",
    1,
    anna.id,
  );
  assert.equal(captureTargets(anna, wid).default, null);
  act(anna, { action: "capture.target", pageId: inbox });
  const targets = captureTargets(anna, wid);
  assert.equal(targets.default, inbox);
  assert.ok(targets.databases.some((d) => d.id === notes));
  // Viewers have nothing to capture into.
  assert.deepEqual(captureTargets(ben, wid).databases, []);
  assert.throws(() => act(ben, { action: "capture.target", pageId: inbox }));

  const rowId = id();
  const captured = act(anna, { action: "capture.record", pageId: inbox, rowId, title: "Idee", text: "Erst später sortieren\nhttps://example.org/a" });
  assert.equal(captured.rowId, rowId);
  // Sent twice (offline queue): still one record.
  act(anna, { action: "capture.record", pageId: inbox, rowId, title: "Idee" });
  assert.equal(rowsOf(inbox), 1);
  const row = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", rowId)!;
  assert.deepEqual(JSON.parse(row.cells), { tags: [], title: "Idee", link: "https://example.org/a" });
  assert.match(row.content, /^<p>Zum Sortieren<\/p><p>Erst später sortieren<\/p>$/);

  // Share and web clipper: "as a record".
  const shared = act(anna, { action: "page.fromShare", spaceId: space, as: "record", databaseId: areas, title: "Artikel", url: "https://example.org/b", article: "<p>Volltext</p>" });
  const sharedRow = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", String(shared.rowId))!;
  assert.equal(JSON.parse(sharedRow.cells).title, "Artikel");
  // No URL property there: the link goes into the text.
  assert.match(sharedRow.content, /href="https:\/\/example.org\/b"/);
  assert.match(sharedRow.content, /Volltext/);
  assert.throws(() => act(ben, { action: "capture.record", pageId: inbox, title: "x" }), /Berechtigung|erfasst/);
});
