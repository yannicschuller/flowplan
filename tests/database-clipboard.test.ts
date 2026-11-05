import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipboardCell,
  clipboardHtml,
  clipboardTable,
  clipboardTsv,
  recordsClipboard,
  tsvCell,
  type ClipboardContext,
} from "../lib/database-clipboard";
import type { Field } from "../lib/types";

const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const ctx: ClipboardContext = {
  members: [{ id: "u1", name: "Ada" }, { id: "u2", name: "Linus" }],
  related: { tasks: [{ id: "t1", cells: { title: "Steuer" } }, { id: "t2", cells: {} }] },
  files: [{ url: "/api/files/00000000-0000-4000-8000-000000000001", name: "Beleg.pdf" }],
  sprints: [{ id: "s1", name: "Sprint 4" }],
  yes: "Ja",
  no: "Nein",
  untitled: "Ohne Titel",
  unavailable: "Nicht verfügbar",
  zone: "Europe/Berlin",
};
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "amount", name: "Betrag", type: "number", format: "eur" },
  { id: "due", name: "Fällig", type: "date", format: "iso" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
  { id: "tags", name: "Tags", type: "multiselect" },
  { id: "done", name: "Erledigt", type: "checkbox" },
  { id: "owner", name: "Verantwortlich", type: "person" },
  { id: "rel", name: "Aufgaben", type: "relation", relationPage: "tasks" },
];

test("cells are written as the table shows them", () => {
  assert.equal(nbsp(clipboardCell(fields[1], 1234.5, ctx)), "1.234,50 €");
  assert.equal(clipboardCell(fields[2], "2026-09-04", ctx), "2026-09-04");
  assert.equal(clipboardCell(fields[3], "Offen", ctx), "Offen");
  assert.equal(clipboardCell(fields[4], ["a", "b"], ctx), "a, b");
  assert.equal(clipboardCell(fields[5], true, ctx), "Ja");
  assert.equal(clipboardCell(fields[5], undefined, ctx), "Nein");
  assert.equal(clipboardCell(fields[6], ["u1", "u2", "gone"], ctx), "Ada, Linus");
  assert.equal(clipboardCell(fields[6], "u2", ctx), "Linus");
  assert.equal(clipboardCell(fields[7], ["t1", "t2", "x"], ctx), "Steuer, Ohne Titel, Nicht verfügbar");
  assert.equal(clipboardCell({ id: "c", name: "C", type: "created_by" }, "u1", ctx), "Ada");
  assert.equal(clipboardCell({ id: "f", name: "F", type: "files" }, ["/api/files/00000000-0000-4000-8000-000000000001", "https://x.org/a/plan.png"], ctx), "Beleg.pdf, plan.png");
  assert.equal(clipboardCell({ id: "s", name: "S", type: "sprint" }, "s1", ctx), "Sprint 4");
  assert.equal(clipboardCell({ id: "t", name: "T", type: "time" }, 5400, ctx), "1 h 30 min");
  assert.equal(nbsp(clipboardCell({ id: "p", name: "P", type: "progress" }, 0.5, ctx)), "50 %");
  assert.equal(clipboardCell({ id: "l", name: "L", type: "checklist" }, [{ text: "A", done: true }, { text: "B" }], ctx), "[x] A; [ ] B");
  assert.equal(nbsp(clipboardCell({ id: "x", name: "X", type: "formula", format: "percent" }, 0.25, ctx)), "25 %");
  assert.equal(clipboardCell({ id: "x", name: "X", type: "formula" }, "abc", ctx), "abc");
  assert.equal(clipboardCell(fields[0], undefined, ctx), "");
});

test("TSV keeps one cell per value, like Excel's own clipboard text", () => {
  assert.equal(tsvCell("a\tb"), "a b");
  assert.equal(tsvCell("Zeile 1\r\nZeile \"2\""), '"Zeile 1\nZeile ""2"""');
  assert.equal(tsvCell('"zitiert" am Anfang'), '"""zitiert"" am Anfang"');
  assert.equal(tsvCell('mit "Zitat"'), 'mit "Zitat"');
  // Formulas stay text; negative numbers and number cells stay as they are.
  assert.equal(tsvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(tsvCell("-5"), "-5");
  assert.equal(tsvCell("-1.234,50 €", true), "-1.234,50 €");
});

test("selected records become a TSV and an HTML table with a header row", () => {
  const rows = [
    { cells: { title: "Miete", amount: 1234.5, due: "2026-09-04", status: "Offen", done: true, owner: "u1", rel: ["t1"] } },
    { cells: { title: "<b>Strom</b> & Gas", amount: -20, tags: ["x"], rel: [] } },
  ];
  const { text, html } = recordsClipboard(fields, rows, ctx);
  const lines = text.split("\r\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[3], "");
  assert.equal(lines[0], "Name\tBetrag\tFällig\tStatus\tTags\tErledigt\tVerantwortlich\tAufgaben");
  assert.equal(nbsp(lines[1]), "Miete\t1.234,50 €\t2026-09-04\tOffen\t\tJa\tAda\tSteuer");
  assert.equal(nbsp(lines[2]), "<b>Strom</b> & Gas\t-20,00 €\t\t\tx\tNein\t\t");
  assert.ok(html.startsWith("<table><thead><tr><th>Name</th><th>Betrag</th>"));
  assert.ok(html.includes("<td>&lt;b&gt;Strom&lt;/b&gt; &amp; Gas</td>"));
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.ok(html.includes("</tbody></table>"));
  // Line breaks inside a value stay in one HTML cell.
  const table = clipboardTable([fields[0]], [{ cells: { title: "a\nb" } }], ctx);
  assert.equal(clipboardHtml(table), "<table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>a<br>b</td></tr></tbody></table>");
  assert.equal(clipboardTsv(table), 'Name\r\n"a\nb"\r\n');
});
