// The CSV of a database view (lib/database-csv.ts): the view's columns, names
// instead of ids, and an import that finds the same people and records again.
import { test } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { csvImportText } from "../lib/cell-text";
import { type CsvContext, csvImporter, databaseCsv, parseCsvFile, viewCsvFields } from "../lib/database-csv";
import type { Field } from "../lib/types";

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "owner", name: "Zuständig", type: "person" },
  { id: "to", name: "Stelle", type: "relation", relationPage: "clinics" },
  { id: "parent", name: "Übergeordnet", type: "relation", relationPage: "self", parent: true },
  { id: "docs", name: "Dateien", type: "files" },
  { id: "sprint", name: "Sprint", type: "sprint" },
  { id: "by", name: "Erstellt von", type: "created_by" },
  { id: "at", name: "Erstellt", type: "created_at" },
  { id: "note", name: "Notiz", type: "text" },
  { id: "count", name: "Anzahl", type: "number" },
];
const ctx: CsvContext = {
  members: [
    { id: "u1", name: "Dana Reyes", email: "dana@example.org" },
    { id: "u2", name: "Sam Lee", email: "sam.a@example.org" },
    { id: "u3", name: "Sam Lee", email: "sam.b@example.org" },
    { id: "u4", name: "", email: "nameless@example.org" },
    { id: "u5", name: "=HYPERLINK(1)", email: "odd@example.org" },
  ],
  related: {
    clinics: [
      { id: "c1", cells: { name: "Klinik Nord" } },
      { id: "c2", cells: { name: "Praxis Süd, Haus 2" } },
      { id: "c3", cells: { name: "" } },
      { id: "c4", cells: { name: "Doppelt" } },
      { id: "c5", cells: { name: "Doppelt" } },
    ],
    self: [{ id: "r1", cells: { title: "Akte 1" } }],
  },
  relatedSchemas: { clinics: [{ id: "name" }] },
  files: [{ url: "/api/files/11111111-2222-4333-8444-555555555555", name: "Befund.pdf" }],
  sprints: [{ id: "s1", name: "Sprint 12" }],
  untitled: "Untitled",
  unavailable: "Not available",
};
const parse = (csv: string) =>
  Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true, transformHeader: csvImportText, transform: csvImportText });

test("the CSV has the view's columns: the title stays in card views", () => {
  const visible = [fields[1], fields[0]];
  assert.deepEqual(viewCsvFields({ type: "table" }, fields, visible), visible);
  // A table without its title column exports without it.
  assert.deepEqual(viewCsvFields({ type: "table" }, fields, [fields[1]]), [fields[1]]);
  // Boards, lists and calendars always show the title.
  assert.deepEqual(viewCsvFields({ type: "board" }, fields, [fields[1]]), [fields[0], fields[1]]);
  assert.deepEqual(viewCsvFields({ type: "list" }, fields, visible), visible);
});

test("people, related records, files and sprints are exported by name", () => {
  const csv = databaseCsv(fields, fields, [
    {
      cells: {
        title: "A",
        owner: "u1",
        to: ["c1", "c2"],
        parent: ["r1"],
        docs: ["/api/files/11111111-2222-4333-8444-555555555555", "https://example.org/a.pdf"],
        sprint: "s1",
        by: "u2",
        at: "2026-11-05 17:39:02",
        note: "**fett**",
        count: -3,
      },
    },
    { cells: { title: "B", owner: "u4", to: ["c3", "c4", "gone"], by: "removed", sprint: "old" } },
    { cells: { title: "C", owner: "u5" } },
  ], ctx);
  assert.deepEqual(csv.split("\r\n"), [
    "Name,Zuständig,Stelle,Übergeordnet,Dateien,Sprint,Erstellt von,Erstellt,Notiz,Anzahl",
    // A name two members share is written as the e-mail address.
    'A,Dana Reyes,"Klinik Nord, Praxis Süd, Haus 2",Akte 1,"Befund.pdf, https://example.org/a.pdf",Sprint 12,sam.a@example.org,2026-11-05T17:39:02Z,fett,-3',
    // An untitled record and a title two records share are written as the
    // table shows them, never as ids (#174).
    "B,nameless@example.org,\"Untitled, Doppelt, Not available\",,,Not available,Not available,,,",
    // The formula guard still applies to names.
    "C,\"'=HYPERLINK(1)\",,,,,,,,",
  ]);
  assert.doesNotMatch(csv, /\bu\d\b|\bc\d\b|\/api\/files/);
});

test("the import finds the same people, records, files and sprints again", () => {
  const writable = fields.filter((f) => !["created_by", "created_at"].includes(f.type));
  const exported = databaseCsv(writable, fields, [
    { cells: { title: "A", owner: "u2", to: ["c2", "c1"], parent: ["r1"], docs: ["/api/files/11111111-2222-4333-8444-555555555555", "https://example.org/a.pdf"], sprint: "s1", note: "x", count: 4 } },
    { cells: { title: "B", owner: "u5", to: [] } },
  ], ctx);
  const result = parse(exported);
  const rows = result.data.map(csvImporter(writable.filter((f) => result.meta.fields!.includes(f.name)), fields, ctx));
  assert.deepEqual(rows[0], {
    title: "A",
    owner: "u2",
    to: ["c2", "c1"],
    parent: ["r1"],
    docs: ["/api/files/11111111-2222-4333-8444-555555555555", "https://example.org/a.pdf"],
    sprint: "s1",
    note: "x",
    count: 4,
  });
  assert.equal(rows[1].owner, "u5");
  assert.deepEqual(rows[1].to, []);
});

test("hand-made and older files: e-mails, any case, ids, unknown and ambiguous names", () => {
  const importer = csvImporter(fields.filter((f) => ["owner", "to", "parent", "sprint", "docs"].includes(f.id)), fields, ctx);
  const cells = (row: Record<string, string>) => importer(row);
  assert.equal(cells({ Zuständig: "DANA@example.org" }).owner, "u1");
  assert.equal(cells({ Zuständig: " dana  reyes " }).owner, "u1");
  // Older exports wrote ids.
  assert.equal(cells({ Zuständig: "u3" }).owner, "u3");
  assert.deepEqual(cells({ Stelle: "c1, c4" }).to, ["c1", "c4"]);
  // A name two members or records share links nobody rather than the wrong one.
  assert.equal(cells({ Zuständig: "Sam Lee" }).owner, "");
  assert.deepEqual(cells({ Stelle: "Doppelt, klinik nord, Unbekannt" }).to, ["c1"]);
  // A title with a comma stays whole; a subtask has one parent.
  assert.deepEqual(cells({ Stelle: "Praxis Süd, Haus 2" }).to, ["c2"]);
  assert.deepEqual(cells({ Übergeordnet: "Akte 1, Akte 1" }).parent, ["r1"]);
  assert.equal(cells({ Sprint: "sprint 12" }).sprint, "s1");
  assert.equal(cells({ Sprint: "Sprint 99" }).sprint, "");
  assert.deepEqual(cells({ Dateien: "befund.pdf, Fremd.pdf, http://x.org/y" }).docs, ["/api/files/11111111-2222-4333-8444-555555555555", "http://x.org/y"]);
  // Only the properties it is given: hidden columns are not in the file.
  assert.deepEqual(Object.keys(cells({})).sort(), ["docs", "owner", "parent", "sprint", "to"]);
});

test("names are read once per file: 5,000 records linked to 5,000 records", () => {
  const records = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, cells: { title: `Akte ${i}` } }));
  const big: CsvContext = { ...ctx, related: { self: records } };
  const field: Field = { id: "link", name: "Link", type: "relation", relationPage: "self" };
  const started = performance.now();
  const csv = databaseCsv([field], [fields[0], field], records.map((r, i) => ({ cells: { link: [`r${(i + 1) % 5000}`] } })), big);
  const result = parse(csv);
  const rows = result.data.map(csvImporter([field], [fields[0], field], big));
  assert.deepEqual(rows[4999].link, ["r0"]);
  assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`);
});

// Names that would come back as another record, file or person, or as nobody,
// are written as ids (people as e-mail first), so nothing is lost on re-import.
test("shared and empty titles, shared file names and clashing names are written by name; the import links nothing for them", () => {
  const scan = (n: number) => `/api/files/${n}1111111-2222-4333-8444-555555555555`;
  const clash: CsvContext = {
    ...ctx,
    members: [
      { id: "u1", name: "Dana Reyes", email: "dana@example.org" },
      // Her name is someone else's e-mail address.
      { id: "u2", name: "dana@example.org", email: "other@example.org" },
    ],
    related: {
      clinics: [
        { id: "c1", cells: { name: "Klinik Nord" } },
        { id: "c3", cells: { name: "" } },
        { id: "c4", cells: { name: "Doppelt" } },
        { id: "c5", cells: { name: "Doppelt" } },
        // Titles that read like the placeholders and an id.
        { id: "c6", cells: { name: "Untitled" } },
        { id: "c7", cells: { name: "Not available" } },
        { id: "c8", cells: { name: "c1" } },
      ],
    },
    files: [
      { url: scan(1), name: "scan.pdf" },
      { url: scan(2), name: "scan.pdf" },
      { url: scan(3), name: "Befund.pdf" },
    ],
  };
  const writable = fields.filter((f) => ["title", "owner", "to", "docs"].includes(f.id));
  const originals = [
    { title: "A", owner: "u1", to: ["c4", "c5"], docs: [scan(1), scan(2), scan(3)] },
    { title: "B", owner: "u2", to: ["c3", "c1"], docs: ["https://example.org/a,b.pdf", scan(3)] },
    { title: "C", owner: "", to: ["c6", "c7", "c8"], docs: [] },
  ];
  const csv = databaseCsv(writable, fields, originals.map((cells) => ({ cells })), clash);
  assert.deepEqual(csv.split("\r\n"), [
    "Name,Zuständig,Stelle,Dateien",
    'A,Dana Reyes,"Doppelt, Doppelt","scan.pdf, scan.pdf, Befund.pdf"',
    'B,other@example.org,"Untitled, Klinik Nord","https://example.org/a,b.pdf, Befund.pdf"',
    'C,,"Untitled, Not available, c1",',
  ]);
  assert.doesNotMatch(csv, /\bc[2-8]\b|\/api\/files/);
  // Unique names come back; shared ones and the placeholders link nobody.
  const result = parse(csv);
  assert.deepEqual(result.data.map(csvImporter(writable, fields, clash)), [
    { title: "A", owner: "u1", to: [], docs: [scan(3)] },
    { title: "B", owner: "u2", to: ["c1"], docs: ["https://example.org/a,b.pdf", scan(3)] },
    // A title that reads like another record's id stays that record's (ids
    // are UUIDs in practice, so a real title never does).
    { title: "C", owner: "", to: ["c1"], docs: [] },
  ]);
});

test("placeholders link nobody unless one real record has exactly that title", () => {
  const records = (...titles: string[]) => titles.map((name, i) => ({ id: `c${i}`, cells: { name } }));
  const importer = (titles: string[]) =>
    csvImporter([fields[2]], fields, { ...ctx, related: { clinics: records(...titles) } });
  // "Not available" never links, even to a record with that title.
  assert.deepEqual(importer(["Not available", "Klinik"])({ Stelle: "Not available" }).to, []);
  assert.deepEqual(
    csvImporter([fields[1], fields[4], fields[5]], fields, ctx)({ Zuständig: "Not available", Dateien: "Not available", Sprint: "Not available" }),
    { owner: "", docs: [], sprint: "" },
  );
  // "Untitled" next to an untitled record is ambiguous; one untitled record
  // alone is not linked by it either.
  assert.deepEqual(importer(["Untitled", ""])({ Stelle: "Untitled" }).to, []);
  assert.deepEqual(importer([""])({ Stelle: "untitled" }).to, []);
  // The one record titled "Untitled", with no untitled record beside it.
  assert.deepEqual(importer(["Untitled", "Klinik"])({ Stelle: "Untitled" }).to, ["c0"]);
});

test("numbers, checkboxes, dates and options: empty stays empty, common writings are read", () => {
  const typed: Field[] = [
    { id: "n", name: "Zahl", type: "number" },
    { id: "d", name: "Datum", type: "date" },
    { id: "c", name: "Ok", type: "checkbox" },
    { id: "s", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
  ];
  const importer = csvImporter(typed, typed, ctx);
  // An export round trip: an empty number stays empty, not 0.
  const csv = databaseCsv(typed, typed, [
    { cells: { n: null, d: "2026-11-05", c: false, s: "Offen" } },
    { cells: { n: 0.0000001, d: "2026-11-05T09:30:00Z", c: true, s: "" } },
  ], ctx);
  assert.deepEqual(parse(csv).data.map(importer), [
    { n: null, d: "2026-11-05", c: false, s: "Offen" },
    { n: 0.0000001, d: "2026-11-05T09:30:00Z", c: true, s: "" },
  ]);
  assert.deepEqual(importer({ Zahl: "1,5", Datum: "05.11.2026", Ok: "Yes", Status: "offen" }), {
    n: 1.5,
    d: "2026-11-05",
    c: true,
    s: "Offen",
  });
  assert.deepEqual(importer({ Zahl: "1.234,56", Datum: "", Ok: "nein", Status: "" }), { n: 1234.56, d: "", c: false, s: "" });
  // What cannot be read stays as written: the import refuses a number,
  // checkbox or date with the property's name instead of losing or inventing
  // a value (tests/rows-import.test.ts); an unknown option is kept.
  assert.deepEqual(importer({ Zahl: "12 %", Datum: "2026-02-30", Ok: "vielleicht", Status: "Neu" }), {
    n: "12 %",
    d: "2026-02-30",
    c: "vielleicht",
    s: "Neu",
  });
});

test("a file with one column, short or long rows reads; a broken quote does not", () => {
  const one = parseCsvFile(databaseCsv([fields[0]], fields, [{ cells: { title: "Alpha" } }, { cells: { title: "Beta" } }], ctx));
  assert.equal(one.unreadable, false);
  assert.deepEqual(one.columns, ["Name"]);
  assert.deepEqual(one.rows.map((r) => r.Name), ["Alpha", "Beta"]);
  const ragged = parseCsvFile("Name,Notiz\r\nA\r\nB,x,\r\n");
  assert.equal(ragged.unreadable, false);
  assert.deepEqual(ragged.rows.map((r) => [r.Name, r.Notiz]), [["A", undefined], ["B", "x"]]);
  assert.equal(parseCsvFile('Name,Notiz\r\n"A,x\r\n').unreadable, true);
});
