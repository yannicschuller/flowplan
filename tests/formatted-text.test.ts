// Formatted text properties (#126) on the server: the one-time migration
// (schema 90) keeps existing values showing as before, search, filters,
// sorting, groups and formulas read plain text, plain sources (CSV, forms,
// old archives) are escaped, AFFiNE keeps its formatting, the API writes
// and reads inline Markdown, and a type change keeps the text.
import { sqliteOnly } from "./helpers/backend";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, Row, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-formatted-"));
const { all, one, run, id, db } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap, command, database, rows } = await import("../lib/api");
const { queryRows, computedCells } = await import("../lib/database");
const { databaseGroups } = await import("../lib/database-groups");
const { searchWorkspace } = await import("../lib/search-index");
const { importZip } = await import("../lib/zip-import");
const { writeZip } = await import("../lib/archive");
const { saveFormSubmission } = await import("../lib/forms");
const { clipboardTable } = await import("../lib/database-clipboard");
const { escapeFormattedCells, FORMATTED_TEXT_MIGRATION } = await import("../lib/formatted-text");
const { parseImport } = await import("../lib/importers");
const { affineFileV2, note, page, para, text } = await import("./helpers/affine-fixture");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga");
const wid = await createWorkspace(owner.id, "Formatiert");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>) => (await command(owner, input)) as Record<string, unknown>;

const FIELDS: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "notes", name: "Notiz", type: "text" },
  { id: "kind", name: "Art", type: "select", options: ["a_b", "*x*"] },
  { id: "n", name: "Zahl", type: "number" },
  { id: "f", name: "Formel", type: "formula", formula: 'prop("Notiz") + "!"' },
];
async function newDatabase(title: string, fields: Field[] = FIELDS) {
  const pageId = ((await act({ action: "page.create", workspaceId: wid, spaceId: space, title, kind: "database", databaseKind: "empty" })) as { id: string }).id;
  const views: View[] = [{ id: "v", name: "Tabelle", type: "table", filters: [], sorts: [] } as unknown as View];
  await run("UPDATE databases SET fields=?,views=? WHERE page_id=?", JSON.stringify(fields), JSON.stringify(views), pageId);
  return pageId;
}
const cellsOf = async (pageId: string) => (await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? ORDER BY position", pageId)).map((r) => JSON.parse(r.cells));

test("schema 90: existing text values are escaped once, titles and other types stay", { skip: sqliteOnly }, async () => {
  const pageId = await newDatabase("Alt");
  // Values as they were stored before #126 (plain strings).
  const insert = async (cells: Record<string, unknown>, position: number) => {
    const rid = id();
    await run("INSERT INTO rows(id,page_id,cells,position) VALUES(?,?,?,?)", rid, pageId, JSON.stringify(cells), position);
    return rid;
  };
  const a = await insert({ title: "*Titel* bleibt", notes: "*stars* and snake_case [x](https://x.test) \\ back", kind: "a_b", n: 3 }, 1);
  await insert({ title: "B", notes: "nothing special" }, 2);
  await run("INSERT INTO row_templates(id,page_id,name,cells,html) VALUES(?,?,?,?,?)", id(), pageId, "T", JSON.stringify({ notes: "**fett?**" }), "");
  await run(
    "INSERT INTO snapshots(id,page_id,html,title) VALUES(?,?,?,?)",
    id(),
    pageId,
    JSON.stringify({ database: { fields: FIELDS, views: [] }, rows: [{ id: a, cells: { title: "*t*", notes: "_v_" } }], rowTemplates: [] }),
    "Alt",
  );
  await run(
    "INSERT INTO row_trash(id,page_id,workspace_id,title,payload) VALUES(?,?,?,?,?)",
    id(),
    pageId,
    wid,
    "Weg",
    JSON.stringify({ row: { id: id(), cells: JSON.stringify({ title: "*weg*", notes: "~~nicht~~" }) }, document: null, comments: [] }),
  );
  // The migration runs again as on a server that has not had it yet.
  await run("DELETE FROM data_migrations WHERE name=?", FORMATTED_TEXT_MIGRATION);
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  db();
  assert.ok(((globalThis as { flowplanSchema?: number }).flowplanSchema ?? 0) >= 90);
  const [first, second] = await cellsOf(pageId);
  assert.equal(first.title, "*Titel* bleibt", "titles stay plain text");
  assert.equal(first.notes, "\\*stars\\* and snake\\_case \\[x\\](https://x.test) \\\\ back");
  assert.equal(first.kind, "a_b");
  assert.equal(first.n, 3);
  assert.equal(second.notes, "nothing special");
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM row_templates WHERE page_id=?", pageId))!.cells).notes, "\\*\\*fett?\\*\\*");
  const snapshot = JSON.parse((await one<{ html: string }>("SELECT html FROM snapshots WHERE page_id=? ORDER BY seq DESC", pageId))!.html);
  assert.deepEqual(snapshot.rows[0].cells, { title: "*t*", notes: "\\_v\\_" });
  const trashed = JSON.parse((await one<{ payload: string }>("SELECT payload FROM row_trash WHERE page_id=?", pageId))!.payload);
  assert.deepEqual(JSON.parse(trashed.row.cells), { title: "*weg*", notes: "\\~\\~nicht\\~\\~" });
  // Shown as before: the plain text is the old value.
  const row = (await rows(pageId))[0];
  assert.equal(computedCells(row, FIELDS).f, "*stars* and snake_case [x](https://x.test) \\ back!", "formulas read plain text");
  // Only once: a second start changes nothing.
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  db();
  assert.equal((await cellsOf(pageId))[0].notes, first.notes);
});

test("search, filters, sorting, groups, copying and formulas read plain text", async () => {
  const pageId = await newDatabase("Lesen");
  await act({ action: "row.create", pageId, cells: { title: "Eins", notes: "**Wichtig**: bitte _heute_ lesen", n: 1 } });
  await act({ action: "row.create", pageId, cells: { title: "Zwei", notes: "[Anleitung](https://docs.test/a) zum ~~Lesen~~", n: 2 } });
  await act({ action: "row.create", pageId, cells: { title: "Drei", notes: "\\*sternchen\\*", n: 3 } });
  const all = await rows(pageId);
  const view = (patch: Partial<View>) => ({ id: "v", name: "T", type: "table", filters: [], sorts: [], ...patch }) as unknown as View;
  const names = (list: Row[]) => list.map((r) => r.cells.title);
  // "Wichtig: bitte" spans the formatting.
  assert.deepEqual(names(queryRows(all, FIELDS, view({}), "wichtig: bitte heute")), ["Eins"]);
  assert.deepEqual(names(queryRows(all, FIELDS, view({ filters: [{ field: "notes", op: "contains", value: "Anleitung zum" }] } as Partial<View>))), ["Zwei"]);
  assert.deepEqual(names(queryRows(all, FIELDS, view({ filters: [{ field: "notes", op: "starts_with", value: "*stern" }] } as Partial<View>))), ["Drei"]);
  assert.deepEqual(names(queryRows(all, FIELDS, view({ filters: [{ field: "notes", op: "eq", value: "*sternchen*" }] } as Partial<View>))), ["Drei"]);
  // Sorted by what people read: "*sternchen*" < "Anleitung" < "Wichtig".
  assert.deepEqual(names(queryRows(all, FIELDS, view({ sorts: [{ field: "notes", direction: "asc" }] }))), ["Drei", "Zwei", "Eins"]);
  const groups = databaseGroups(all, FIELDS[1], {});
  assert.ok(groups.some((g) => g.label === "*sternchen*"));
  assert.ok(groups.some((g) => g.label === "Wichtig: bitte heute lesen"));
  const copied = clipboardTable(FIELDS.slice(0, 2), all, { yes: "Ja", no: "Nein", untitled: "-", unavailable: "-" });
  assert.deepEqual(copied.rows.map((r) => r[1]), ["Wichtig: bitte heute lesen", "Anleitung zum Lesen", "*sternchen*"]);
  assert.equal(computedCells(all[1], FIELDS).f, "Anleitung zum Lesen!");
  // The workspace search finds the words, not the Markdown.
  const hits = await searchWorkspace(owner, wid, "Anleitung zum Lesen");
  assert.ok(hits.some((h) => (h as { rowId?: string }).rowId === all[1].id || JSON.stringify(h).includes(all[1].id)));
});

test("the API writes and reads inline Markdown as given", async () => {
  const pageId = await newDatabase("API");
  const created = (await act({ action: "row.create", pageId, cells: { title: "**Titel**", notes: "Zeile 1\n**fett** [x](https://x.test)" } })) as { id: string };
  const row = (await rows(pageId)).find((r) => r.id === created.id)!;
  assert.equal(row.cells.notes, "Zeile 1\n**fett** [x](https://x.test)");
  assert.equal(row.cells.title, "**Titel**");
  await act({ action: "row.update", pageId, rowId: created.id, version: row.version, cells: { notes: "_neu_" } });
  assert.equal((await rows(pageId)).find((r) => r.id === created.id)!.cells.notes, "_neu_");
});

test("a type change keeps the text: escaped into, plain out of formatted text", async () => {
  const pageId = await newDatabase("Typen");
  await act({ action: "row.create", pageId, cells: { title: "A", notes: "**fett** und \\*", kind: "*x*" } });
  const before = await database(pageId);
  const next = before.fields.map((f) =>
    f.id === "notes" ? { ...f, type: "select" as const, options: ["fett und *"] } : f.id === "kind" ? { ...f, type: "text" as const, options: undefined } : f,
  );
  await act({ action: "database.update", pageId, version: before.version, fields: next, views: before.views });
  const [cells] = await cellsOf(pageId);
  assert.equal(cells.notes, "fett und *", "a select takes the plain text");
  assert.equal(cells.kind, "\\*x\\*", "formatted text keeps the stars of the option");
});

test("CSV (Notion) imports are plain text: stars stay stars", async () => {
  const bytes = await writeZip(new Map([["Notizen.csv", Buffer.from("Name,Notiz\n*Eins*,*stars* and _x_\nZwei,plain\n")]]));
  await importZip(owner, wid, space, bytes);
  const pageId = (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Notizen' AND kind='database'", wid))!.id;
  const cells = await cellsOf(pageId);
  assert.equal(cells[0].title, "*Eins*");
  assert.equal(cells[0].f1, "\\*stars\\* and \\_x\\_");
  assert.equal(cells[1].f1, "plain");
});

test("form answers are plain text: escaped when stored", async () => {
  const pageId = await newDatabase("Formular");
  await saveFormSubmission(pageId, owner, { title: "*Frage*", notes: "a_b *c*" }, true, { confirm: false });
  const [cells] = await cellsOf(pageId);
  assert.equal(cells.title, "*Frage*");
  assert.equal(cells.notes, "a\\_b \\*c\\*");
});

test("escapeFormattedCells leaves titles, other types and safe strings alone", () => {
  const out = escapeFormattedCells({ title: "*t*", notes: "a*b", kind: "*x*", n: 1, other: "plain" }, FIELDS);
  assert.deepEqual(out.cells, { title: "*t*", notes: "a\\*b", kind: "*x*", n: 1, other: "plain" });
  assert.equal(out.changed, true);
  assert.equal(escapeFormattedCells({ notes: "plain" }, FIELDS).changed, false);
});

test("AFFiNE rich text cells keep bold, italic, strike, code and links", async () => {
  const database = {
    id: "fmtDb",
    flavour: "affine:database",
    props: {
      title: text("Formatiert"),
      views: [{ id: "fv", name: "Alle", mode: "table", columns: [] }],
      columns: [
        { id: "cT", type: "title", name: "Name", data: {} },
        { id: "cR", type: "rich-text", name: "Notiz", data: {} },
      ],
      cells: {
        fRow: {
          cR: {
            columnId: "cR",
            value: text([
              { insert: "Lies " },
              { insert: "das", attributes: { bold: true } },
              { insert: " und ", attributes: {} },
              { insert: "hier", attributes: { italic: true, link: "https://affine.test/x" } },
              { insert: " *nicht* ", attributes: {} },
              { insert: "alt", attributes: { strike: true } },
              { insert: " ", attributes: {} },
              { insert: "npm i", attributes: { code: true } },
              { insert: " böse", attributes: { link: "javascript:alert(1)" } },
            ]),
          },
        },
      },
    },
    children: [{ id: "fRow", flavour: "affine:paragraph", props: { type: "text", text: text("Zeile") } }],
  };
  const ws = { id: "fmtWs", name: "Formatiert", docs: [{ id: "fmtDoc", title: "Seite", doc: page("fmtDoc", "Seite", [note([para("Tabelle:"), database])]) }] };
  const tree = await parseImport("Formatiert.affine", affineFileV2(ws as never));
  const db = tree.pages.find((p) => p.kind === "database")!.database!;
  const notes = db.fields.find((f) => f.name === "Notiz")!;
  assert.equal(db.rows[0].cells[notes.id], "Lies **das** und [_hier_](https://affine.test/x) \\*nicht\\* ~~alt~~ `npm i` böse");
});
