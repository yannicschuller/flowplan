import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-notion-relations-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap, rows } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importZip } = await import("../lib/zip-import");
const { notionCsvColumns, notionPropertyTypes, relationItems, notionDate, notionNumber, notionFormula } = await import("../lib/importers/notion-props");
const { importReport } = await import("../lib/importers/types");
const { reportHtml } = await import("../lib/importers/report");

// Notion's HTML export with two related databases (tests/fixtures/import/
// notion-relations): Projekte ↔ Aufgaben, a rollup and a formula, property
// types named by the icons of the database's table.
const FIXTURE = new URL("./fixtures/import/notion-relations/", import.meta.url).pathname;
function fixtureFiles(dir = FIXTURE): [string, Buffer][] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? fixtureFiles(path) : [[relative(FIXTURE, path), readFileSync(path)] as [string, Buffer]];
  });
}
async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}-${uid.slice(0, 6)}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("cells and types: relations, dates with time and ranges, formatted numbers, formulas", () => {
  assert.deepEqual(relationItems("Planen (Aufgaben%20x/Planen%20y.html), Bauen (https://www.notion.so/Bauen-abc)"), [
    { title: "Planen", href: "Aufgaben%20x/Planen%20y.html" },
    { title: "Bauen", href: "https://www.notion.so/Bauen-abc" },
  ]);
  assert.deepEqual(relationItems("Eins, Zwei"), [{ title: "Eins" }, { title: "Zwei" }]);
  assert.deepEqual(relationItems("Titel (mit Klammer)"), [{ title: "Titel (mit Klammer)" }]);
  assert.equal(notionDate("March 3, 2025 9:15 AM"), "2025-03-03T09:15");
  assert.equal(notionDate("March 4, 2025 10:00 PM"), "2025-03-04T22:00");
  assert.equal(notionDate("April 1, 2026 → April 3, 2026"), "2026-04-01");
  assert.equal(notionDate("2026-05-01T08:30"), "2026-05-01T08:30");
  assert.equal(notionNumber("1,250.50"), 1250.5);
  assert.equal(notionNumber("1.250,50"), 1250.5);
  assert.equal(notionNumber("$12"), 12);
  assert.equal(notionNumber("50%"), 50);
  assert.equal(notionNumber("zwölf"), null);
  const names = new Map([["pt", "Punkte"], ["ti", "Name"]]);
  assert.equal(notionFormula("{{notion:block_property:pt:0000:abc}} * 2 + 1", names), 'prop("Punkte") * 2 + 1');
  assert.equal(notionFormula('if(prop("Punkte") > 2, "viel", "wenig")', names), 'if(prop("Punkte") > 2, "viel", "wenig")');
  // Notion's methods and unknown properties have no counterpart.
  assert.equal(notionFormula('prop("Name").length()', names), null);
  assert.equal(notionFormula("{{notion:block_property:zz:0000:abc}} * 2", names), null);
  // The Markdown export has no types: relations, links and multi-selects
  // are read from the values.
  const columns = notionCsvColumns(
    ["Name", "Projekt", "Seite", "Tags"],
    [
      ["a", "Alpha (Projekte%20x/Alpha%20y.md)", "https://a.example", "rot, grün"],
      ["b", "Beta (Projekte%20x/Beta%20z.md)", "https://b.example", "rot"],
      ["c", "", "", "grün, rot"],
    ],
    new Map(),
    () => undefined,
    (v) => v,
  );
  assert.deepEqual(columns.map((c) => c.field.type), ["text", "relation", "url", "multiselect"]);
});

test("the HTML export names its property types", () => {
  const types = notionPropertyTypes(readFileSync(join(FIXTURE, "Projekte 11111111111111111111111111111111.html"), "utf8"));
  assert.deepEqual(Object.fromEntries(types), {
    Name: "title", Aufgaben: "relation", Anzahl: "rollup", Score: "formula", Tags: "multi_select", Owner: "people", Erstellt: "created_time",
    Link: "url", Mail: "email", Tel: "phone_number", Budget: "number", Aktiv: "checkbox", Start: "date",
  });
  const rowTypes = notionPropertyTypes(readFileSync(join(FIXTURE, "Projekte 11111111111111111111111111111111/Alpha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1.html"), "utf8"));
  assert.equal(rowTypes.get("Aufgaben"), "relation");
});

test("a Notion export: property types, relations across databases, rollups and formulas as text, and the import report", async () => {
  const owner = await account("Ada");
  const wid = await createWorkspace(owner.id, "Notion Relationen");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const bytes = await writeZip(new Map(fixtureFiles().map(([name, data]) => [`Export-123/${name}`, data])));
  const result = await importZip(owner, wid, space, bytes);
  const pageOf = async (title: string) => (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL", wid, title))!.id;
  const projects = await pageOf("Projekte"),
    tasks = await pageOf("Aufgaben"),
    start = await pageOf("Start");
  type F = { id: string; name: string; type: string; relationPage?: string; options?: string[]; optionColors?: Record<string, string> };
  const fieldsOf = async (pid: string) => JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pid))!.fields) as F[];
  const projectFields = await fieldsOf(projects),
    taskFields = await fieldsOf(tasks);
  const field = (fields: F[], name: string) => fields.find((f) => f.name === name)!;
  assert.deepEqual(Object.fromEntries(projectFields.map((f) => [f.name, f.type])), {
    Name: "text", Aufgaben: "relation", Anzahl: "text", Score: "text", Tags: "multiselect", Owner: "text", Erstellt: "created_at",
    Link: "url", Mail: "email", Tel: "phone", Budget: "number", Aktiv: "checkbox", Start: "date",
  });
  assert.deepEqual(field(projectFields, "Tags").optionColors, { Web: "purple", App: "green" });
  assert.equal(field(projectFields, "Aufgaben").relationPage, tasks);
  assert.equal(field(taskFields, "Projekt").relationPage, projects);
  assert.equal(field(taskFields, "Status").type, "select");

  const projectRows = await rows(projects),
    taskRows = await rows(tasks);
  const task = (title: string) => taskRows.find((r) => r.cells.title === title)!.id;
  const alpha = projectRows.find((r) => r.cells.title === "Alpha")!,
    beta = projectRows.find((r) => r.cells.title === "Beta")!;
  // By the record pages' paths …
  assert.deepEqual(alpha.cells[field(projectFields, "Aufgaben").id], [task("Planen"), task("Bauen")]);
  // … and by Notion's addresses; a record outside the export is left out.
  assert.deepEqual(beta.cells[field(projectFields, "Aufgaben").id], [task("Testen")]);
  assert.deepEqual(taskRows.map((r) => r.cells[field(taskFields, "Projekt").id]), [[alpha.id], [alpha.id], [beta.id]]);
  assert.equal(alpha.cells[field(projectFields, "Anzahl").id], "2");
  assert.equal(alpha.cells[field(projectFields, "Score").id], "8");
  assert.deepEqual(alpha.cells[field(projectFields, "Tags").id], ["Web", "App"]);
  assert.equal(alpha.cells[field(projectFields, "Budget").id], 1250.5);
  assert.equal(alpha.cells[field(projectFields, "Aktiv").id], true);
  assert.equal(alpha.cells[field(projectFields, "Start").id], "2026-04-01");
  assert.equal(alpha.cells[field(projectFields, "Tel").id], "+49 30 1234");
  // Created time: the record's own.
  assert.match(alpha.created_at, /^2025-03-03 09:15/);
  assert.match(beta.created_at, /^2025-03-04 22:00/);
  // Record documents still come from the record pages.
  assert.match((await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", alpha.id))!.html, /Projekt Alpha/);

  // The report: a page at the top of the space, linked from the result.
  assert.ok(result.report);
  assert.equal(result.report!.counts.formula, 1);
  assert.equal(result.report!.counts.rollup, 1);
  const report = (await one<{ title: string; parent_id: string | null; space_id: string }>("SELECT title,parent_id,space_id FROM pages WHERE id=?", result.report!.pageId))!;
  assert.equal(report.title, "Importbericht: Notion");
  assert.equal(report.parent_id, null);
  assert.equal(report.space_id, space);
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", result.report!.pageId))!.html;
  for (const expected of [
    new RegExp(`<a [^>]*href="/#page=${projects}"[^>]*>Projekte</a>: Formel „Score“: Werte als Text übernommen`),
    /Rollup „Anzahl“: Werte als Text übernommen/,
    /Eigenschaft „Owner“ als Text übernommen/,
    new RegExp(`href="/#page=${projects}&amp;row=${beta.id}"[^>]*>Projekte › Beta</a>: „Aufgaben“: „Extern“ ist nicht Teil des Imports`),
    new RegExp(`href="/#page=${start}"[^>]*>Start</a>: https://example\\.com/lesezeichen`),
    /„fehlt\.png“ fehlt in der ZIP-Datei/,
  ])
    assert.match(html, expected);
});

test("the report page: sections in order, counts, entries beyond the limit only counted", () => {
  const report = importReport();
  report.add("relation", "„A“: „X“ ist nicht Teil des Imports", "p1");
  report.add("relation", "„A“: „X“ ist nicht Teil des Imports", "p1");
  report.add("block", "ai_block", "p2");
  report.add("other", "Ohne Seite");
  for (let i = 0; i < 2100; i++) report.add("file", `Datei ${i}`, "p1");
  assert.equal(report.counts.relation, 1);
  assert.equal(report.entries.length, 2000);
  const html = reportHtml("Test", report, (entry) => (entry.page === "p1" ? { href: "/#page=x", title: "Eins" } : null));
  assert.ok(html.indexOf("Nicht übernommene Blöcke (1)") < html.indexOf("Nicht aufgelöste Verknüpfungen (1)"));
  assert.match(html, /Dateien zu groß, fehlend oder nicht geladen \(2100\)/);
  assert.match(html, /… und 103 weitere\./);
  assert.match(html, /<li><p>ai_block<\/p><\/li>/);
  assert.match(html, /<li><p>Ohne Seite<\/p><\/li>/);
  assert.match(html, /<a href="\/#page=x"[^>]*>Eins<\/a>: „A“: „X“ ist nicht Teil des Imports/);
});

test("Notion's Markdown export: relations by the records' .md paths, a missing image in the report", async () => {
  const owner = await account("Grace");
  const wid = await createWorkspace(owner.id, "Notion Markdown");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const P = "44444444444444444444444444444444",
    K = "55555555555555555555555555555555",
    k1 = "66666666666666666666666666666661",
    k2 = "66666666666666666666666666666662";
  const bytes = await writeZip(
    new Map([
      [`Leute ${P}.csv`, Buffer.from(`Name,Kunde,Tags\nAda,Acme (Kunden%20${K}/Acme%20${k1}.md),"rot, blau"\nGrace,"Acme (Kunden%20${K}/Acme%20${k1}.md), Initech (Kunden%20${K}/Initech%20${k2}.md)",rot\nLinus,,"blau, rot"\n`)],
      [`Kunden ${K}.csv`, Buffer.from("Name,Ort\nAcme,Berlin\nInitech,Hamburg\n")],
      [`Kunden ${K}/Acme ${k1}.md`, Buffer.from("# Acme\n\nOrt: Berlin\n\nGroßkunde ![Logo](Acme/logo.png)\n")],
      [`Kunden ${K}/Initech ${k2}.md`, Buffer.from("# Initech\n\nOrt: Hamburg\n")],
    ]),
  );
  const result = await importZip(owner, wid, space, bytes);
  const pageOf = async (title: string) => (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL", wid, title))!.id;
  const people = await pageOf("Leute"),
    customers = await pageOf("Kunden");
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", people))!.fields) as { id: string; name: string; type: string; relationPage?: string }[];
  const kunde = fields.find((f) => f.name === "Kunde")!;
  assert.equal(kunde.type, "relation");
  assert.equal(kunde.relationPage, customers);
  assert.equal(fields.find((f) => f.name === "Tags")!.type, "multiselect");
  const customerRows = await rows(customers);
  const idOf = (title: string) => customerRows.find((r) => r.cells.title === title)!.id;
  assert.deepEqual((await rows(people)).map((r) => r.cells[kunde.id]), [[idOf("Acme")], [idOf("Acme"), idOf("Initech")], []]);
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", result.report!.pageId))!.html;
  assert.match(html, new RegExp(`href="/#page=${customers}"[^>]*>Kunden</a>: „logo\\.png“ fehlt in der ZIP-Datei`));
});
