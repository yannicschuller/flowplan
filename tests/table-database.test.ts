// "In Datenbank umwandeln" (#118): column types, header names, reading an
// editor table and the server command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentSchema } from "../lib/document-schema";
import {
  TABLE_DATABASE_LIMITS,
  cellUrl,
  detectColumnType,
  headerNames,
  parseCheckbox,
  parseDate,
  parseNumber,
  tableToDatabase,
  type TableCell,
} from "../lib/table-database";
import { readTable, tableTitle } from "../lib/table-read";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-table-database-"));
const { run, one, all, id } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { MAX_IMPORT_ROWS } = await import("../lib/zip-import");

const cells = (...values: string[]): TableCell[] => values.map((text) => ({ text }));

test("numbers in German and English writing", () => {
  assert.equal(parseNumber("12"), 12);
  assert.equal(parseNumber("-3"), -3);
  assert.equal(parseNumber("1,5"), 1.5);
  assert.equal(parseNumber("1.5"), 1.5);
  assert.equal(parseNumber(",5"), 0.5);
  assert.equal(parseNumber("1.234,56"), 1234.56);
  assert.equal(parseNumber("1,234.56"), 1234.56);
  assert.equal(parseNumber("1.234.567"), 1234567);
  assert.equal(parseNumber("1,234,567"), 1234567);
  assert.equal(parseNumber("1 234,5"), 1234.5);
  assert.equal(parseNumber("−7"), -7);
  for (const text of ["", "abc", "1.2.3", "1,23,4", "1.234,5.6", "12 €", "+49 30 1234", "04.11.2026", "2026-11-04", "1e5"])
    assert.equal(parseNumber(text), null, text);
});

test("dates: ISO and dd.mm.yyyy, only real days", () => {
  assert.equal(parseDate("2026-11-04"), "2026-11-04");
  assert.equal(parseDate("2026-11-04T09:30"), "2026-11-04");
  assert.equal(parseDate("2026-11-04 09:30:00Z"), "2026-11-04");
  assert.equal(parseDate("04.11.2026"), "2026-11-04");
  assert.equal(parseDate("4.1.2026"), "2026-01-04");
  assert.equal(parseDate("04.11.26"), "2026-11-04");
  for (const text of ["2026-02-30", "31.04.2026", "13.13.2026", "11/04/2026", "2026", "morgen"])
    assert.equal(parseDate(text), null, text);
});

test("checkboxes and URLs", () => {
  for (const yes of ["✓", "✔", "x", "X", "yes", "Ja", "TRUE"]) assert.equal(parseCheckbox(yes), true, yes);
  for (const no of ["✗", "no", "Nein", "false"]) assert.equal(parseCheckbox(no), false, no);
  assert.equal(parseCheckbox("vielleicht"), null);
  assert.equal(cellUrl({ text: "https://example.test/a" }), "https://example.test/a");
  assert.equal(cellUrl({ text: "www.example.test" }), "https://www.example.test");
  assert.equal(cellUrl({ text: "Dokumentation", href: "https://docs.example.test" }), "https://docs.example.test");
  assert.equal(cellUrl({ text: "Dokumentation", href: "/#page=x" }), null);
  assert.equal(cellUrl({ text: "example" }), null);
});

test("a column's type comes from all its filled cells", () => {
  assert.equal(detectColumnType(cells("1", "", "2,5", "1.000.000")), "number");
  assert.equal(detectColumnType(cells("2026-01-02", "", "03.04.2026")), "date");
  assert.equal(detectColumnType(cells("ja", "", "nein", "✓")), "checkbox");
  assert.equal(detectColumnType(cells("x", "", "x")), "checkbox");
  assert.equal(detectColumnType([{ text: "https://a.test" }, { text: "" }, { text: "B", href: "https://b.test" }]), "url");
  // One value that does not fit makes the column text.
  assert.equal(detectColumnType(cells("1", "2", "drei")), "text");
  assert.equal(detectColumnType(cells("2026-01-02", "12")), "text");
  assert.equal(detectColumnType(cells("", " ")), "text");
  assert.equal(detectColumnType([]), "text");
});

test("header names: trimmed, numbered when empty, repeated ones counted on", () => {
  assert.deepEqual(headerNames(cells("Name", " Preis \n netto ", "", "name", "Name"), 6), ["Name", "Preis netto", "Spalte 3", "name 2", "Name 3", "Spalte 6"]);
  assert.deepEqual(headerNames([], 2, (n) => `Column ${n}`), ["Column 1", "Column 2"]);
  assert.deepEqual(headerNames(cells("Spalte 2", ""), 2), ["Spalte 2", "Spalte 2 2"]);
  const long = "L".repeat(300);
  const names = headerNames(cells(long, long), 2);
  assert.equal(names[0].length, TABLE_DATABASE_LIMITS.name);
  assert.ok(names[1].endsWith(" 2") && names[1].length === TABLE_DATABASE_LIMITS.name);
});

test("the first row names the properties, the first column is the title", () => {
  const converted = tableToDatabase([
    cells("Aufgabe", "Stunden", "Fällig", "Erledigt", "Link", "Notiz"),
    [{ text: "42" }, { text: "1,5" }, { text: "04.11.2026" }, { text: "✓" }, { text: "Spec", href: "https://spec.test" }, { text: "Erst **lesen**" }],
    cells("", "", "", "", "", ""),
    cells("Zweite", "", "2026-12-01", "", "https://two.test", ""),
  ]);
  assert.deepEqual(
    converted.fields.map((f) => [f.id, f.name, f.type]),
    [
      ["title", "Aufgabe", "text"],
      ["f1", "Stunden", "number"],
      ["f2", "Fällig", "date"],
      ["f3", "Erledigt", "checkbox"],
      ["f4", "Link", "url"],
      ["f5", "Notiz", "text"],
    ],
  );
  // The empty row is left out; empty cells stay empty, checkboxes false.
  assert.deepEqual(converted.rows, [
    // Formatted text (#126): plain text keeps its stars.
    { title: "42", f1: 1.5, f2: "2026-11-04", f3: true, f4: "https://spec.test", f5: "Erst \\*\\*lesen\\*\\*" },
    { title: "Zweite", f2: "2026-12-01", f3: false, f4: "https://two.test" },
  ]);
  // A cell's formatting from the editor stays in text properties; the
  // title takes the plain text.
  const formatted = tableToDatabase([
    cells("Name", "Notiz"),
    [
      { text: "Alpha fett", markdown: "Alpha **fett**" },
      { text: "Erst lesen", markdown: "Erst **lesen**" },
    ],
  ]);
  assert.deepEqual(formatted.rows, [{ title: "Alpha fett", f1: "Erst **lesen**" }]);
  // Only a header (or nothing): properties without records.
  assert.deepEqual(tableToDatabase([cells("A", "B")]).rows, []);
  assert.equal(tableToDatabase([[]]).fields[0].name, "Spalte 1");
  assert.equal(TABLE_DATABASE_LIMITS.rows, MAX_IMPORT_ROWS);
});

const schema = documentSchema();
const text = (value: string, marks: unknown[] = []) => ({ type: "text", text: value, ...(marks.length ? { marks } : {}) });
const cell = (type: string, content: unknown[], attrs: Record<string, unknown> = {}) => ({
  type,
  attrs,
  content: [{ type: "paragraph", content }],
});
function documentWithTable() {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text("Projekte")] },
      { type: "paragraph", content: [text("Davor")] },
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", [text("Name", [{ type: "bold" }])]), cell("tableHeader", [text("Wert")]), cell("tableHeader", [text("Web")])] },
          {
            type: "tableRow",
            content: [
              cell("tableCell", [text("Alpha "), text("fett", [{ type: "bold" }]), { type: "hardBreak" }, text("zwei")]),
              cell("tableCell", [text("3,5")], { colspan: 2 }),
            ],
          },
          {
            type: "tableRow",
            content: [cell("tableCell", [text("Beta")]), cell("tableCell", [text("4")]), cell("tableCell", [text("Seite", [{ type: "link", attrs: { href: "https://beta.test" } }])])],
          },
        ],
      },
    ],
  });
}

test("reading an editor table: plain text, merged cells, links of whole cells, the title", () => {
  const doc = documentWithTable();
  let tablePos = -1;
  doc.forEach((node, offset) => {
    if (node.type.name === "table") tablePos = offset;
  });
  const rows = readTable(doc.nodeAt(tablePos)!);
  // With the cell's inline formatting (#126) where it has any.
  assert.deepEqual(rows, [
    [{ text: "Name", markdown: "**Name**" }, { text: "Wert" }, { text: "Web" }],
    [{ text: "Alpha fett\nzwei", markdown: "Alpha **fett**\nzwei" }, { text: "3,5" }, { text: "" }],
    [{ text: "Beta" }, { text: "4" }, { text: "Seite", href: "https://beta.test", markdown: "[Seite](https://beta.test)" }],
  ]);
  assert.equal(tableTitle(doc, tablePos), "Projekte");
  const converted = tableToDatabase(rows);
  assert.deepEqual(converted.fields.map((f) => f.type), ["text", "number", "url"]);
  // A caption wins over the heading; without either the server names it.
  const plain = schema.nodeFromJSON({ type: "doc", content: [doc.nodeAt(tablePos)!.toJSON()] });
  assert.equal(tableTitle(plain, 0), "");
  const withCaption = schema.nodeFromJSON({ type: "doc", content: [{ ...doc.nodeAt(tablePos)!.toJSON(), attrs: { caption: "Budget 2026" } }] });
  assert.equal(tableTitle(withCaption, 0), "Budget 2026");
});

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}

test("table.toDatabase creates the database below the document with typed properties and records", () => {
  const owner = user("owner"),
    viewer = user("viewer");
  const wid = createWorkspace(owner.id, "Tables"),
    boot = bootstrap(owner, wid);
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const space = boot.spaces[0].id;
  const host = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Host", kind: "document" }) as { id: string }).id;
  const rows = [
    cells("Aufgabe", "Stunden", "Fällig", "Erledigt"),
    cells("Lesen", "1,5", "04.11.2026", "ja"),
    cells("Schreiben", "2", "", "nein"),
  ];
  const result = command(owner, { action: "table.toDatabase", pageId: host, title: "Projekte", rows }) as {
    id: string;
    view: { id: string; type: string };
    fields: number;
    rows: number;
  };
  assert.equal(result.fields, 4);
  assert.equal(result.rows, 2);
  assert.equal(result.view.type, "table");
  const page = one<{ parent_id: string; space_id: string; kind: string; title: string }>("SELECT * FROM pages WHERE id=?", result.id)!;
  assert.deepEqual([page.parent_id, page.space_id, page.kind, page.title], [host, space, "database", "Projekte"]);
  const data = database(result.id) as unknown as { fields: { id: string; name: string; type: string }[]; views: { id: string }[] };
  assert.deepEqual(data.fields.map((f) => [f.name, f.type]), [["Aufgabe", "text"], ["Stunden", "number"], ["Fällig", "date"], ["Erledigt", "checkbox"]]);
  assert.deepEqual(data.views.map((v) => v.id), [result.view.id]);
  const stored = all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? ORDER BY position", result.id).map((r) => JSON.parse(r.cells));
  assert.deepEqual(stored, [
    { title: "Lesen", f1: 1.5, f2: "2026-11-04", f3: true },
    { title: "Schreiben", f1: 2, f3: false },
  ]);
  // Without a title the database is called "Tabelle".
  const untitled = command(owner, { action: "table.toDatabase", pageId: host, rows }) as { id: string };
  assert.equal(one<{ title: string }>("SELECT title FROM pages WHERE id=?", untitled.id)!.title, "Tabelle");

  // Viewers may not; nothing is created.
  const before = one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n;
  assert.throws(() => command(viewer, { action: "table.toDatabase", pageId: host, rows }), /Kein|Zugriff|Rechte|darf/i);
  // A guest who may edit the document still may not create pages.
  const guest = user("guest");
  run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
  run("INSERT INTO workspace_guests VALUES(?,?)", wid, guest.id);
  run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", host, guest.id, "editor");
  assert.throws(() => command(guest, { action: "table.toDatabase", pageId: host, rows }), /Gäste/);
  // Too many columns or rows: refused with the importer's limits.
  const wide = [Array.from({ length: TABLE_DATABASE_LIMITS.columns + 1 }, (_, i) => ({ text: `S${i}` }))];
  assert.throws(() => command(owner, { action: "table.toDatabase", pageId: host, rows: wide }), (e: Error & { status?: number }) => e.status === 413);
  const long = Array.from({ length: TABLE_DATABASE_LIMITS.rows + 2 }, (_, i) => [{ text: `R${i}` }]);
  assert.throws(() => command(owner, { action: "table.toDatabase", pageId: host, rows: long }));
  // Encrypted spaces have no databases.
  run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  assert.throws(() => command(owner, { action: "table.toDatabase", pageId: host, rows }), (e: Error & { status?: number }) => e.status === 409);
  run("UPDATE spaces SET encrypted=0 WHERE id=?", space);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n, before);
});
