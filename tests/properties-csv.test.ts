// Property-based tests (fast-check, tests/helpers/properties.ts) of a
// database's CSV export and import (lib/database-csv.ts): random tables of
// text, numbers and multi-select values with quotes, commas, semicolons,
// tabs, line breaks, formula-like text and a byte order mark come back as
// they were. First the bug they found.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check, nastyText } from "./helpers/properties";
import { type CsvContext, csvImporter, databaseCsv, parseCsvFile } from "../lib/database-csv";
import { escapeInline } from "../lib/inline-markdown";
import type { Field } from "../lib/types";

const ctx: CsvContext = { untitled: "Untitled", unavailable: "Not available" };

/* ---------- Regressions found by the properties ---------- */

test("regression: a one-column CSV with semicolons stays one column", () => {
  // Unquoted, the import took ";" for the delimiter.
  const fields: Field[] = [{ id: "title", name: "Name;Typ", type: "text" }];
  const csv = databaseCsv(fields, fields, [{ cells: { title: "a;b" } }, { cells: { title: "c;d" } }], ctx);
  assert.equal(csv, '"Name;Typ"\r\n"a;b"\r\n"c;d"');
  assert.deepEqual(parseCsvFile(csv).rows, [{ "Name;Typ": "a;b" }, { "Name;Typ": "c;d" }]);
});

/* ---------- Properties ---------- */

const CSV_TEXT = ["\"", "\"\"", ",", ";", "\t", "\n", "\r\n", "'", "=", "+", "-", "@", " ", "\ufeff", "|", "\\", "#"];
// Text a CSV has to quote or a spreadsheet would run.
const cellText = fc
  .array(fc.oneof(fc.constantFrom(...CSV_TEXT), nastyText(2)), { maxLength: 8 })
  .map((parts) => parts.join(""));
// Papa Parse takes a byte order mark off every column name: none starts
// with one here (no column is named so).
const columnName = fc
  .array(fc.oneof(fc.constantFrom(...CSV_TEXT), fc.constantFrom("Name", "Notiz", "Status", "日付", "Größe")), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("").replace(/^\ufeff+/, "") || "Name");

type Table = { fields: Field[]; rows: { cells: Record<string, unknown> }[] };
const OPTIONS = ["Night, Weekend", "Day", "a,b", "\"quoted\"", "x;y"];
// A table: the title (plain text), other text (formatted text, #126), a
// number and a multi-select property; unique column names.
const table: fc.Arbitrary<Table> = fc
  .tuple(fc.uniqueArray(columnName, { minLength: 4, maxLength: 4, selector: (name) => name.trim().toLowerCase() }), fc.integer({ min: 1, max: 5 }))
  .chain(([names, count]) => {
    const fields: Field[] = [
      { id: "title", name: names[0], type: "text" },
      { id: "note", name: names[1], type: "text" },
      { id: "count", name: names[2], type: "number" },
      { id: "tags", name: names[3], type: "multiselect", options: OPTIONS },
    ];
    const row = fc
      .record({
        title: cellText,
        note: cellText,
        // -0 is written "0" (no number property tells them apart).
        count: fc.option(fc.oneof(fc.integer({ min: -1e6, max: 1e6 }), fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map((n) => n || 0)), { nil: null }),
        tags: fc.uniqueArray(fc.constantFrom(...OPTIONS), { maxLength: 3 }),
      })
      // Formatted text is stored as inline Markdown.
      .map((cells) => ({ cells: { ...cells, note: escapeInline(cells.note) } as Record<string, unknown> }));
    return fc.record({ fields: fc.constant(fields), rows: fc.array(row, { minLength: count, maxLength: count }) });
  });

// What the import makes of the export, in the export's order.
function roundTrip({ fields, rows }: Table, bom: boolean) {
  const csv = databaseCsv(fields, fields, rows, ctx);
  const parsed = parseCsvFile((bom ? "\ufeff" : "") + csv);
  assert.equal(parsed.unreadable, false, csv);
  return { csv, parsed, cells: parsed.rows.map(csvImporter(fields, fields, ctx)) };
}
test("property: a CSV export reads back as the same table", () => {
  check(
    fc.property(table, fc.boolean(), (t, bom) => {
      const { csv, parsed, cells } = roundTrip(t, bom);
      assert.deepEqual(parsed.columns, t.fields.map((f) => f.name), csv);
      // Rows of empty cells stay too: ",,," is no empty line.
      assert.deepEqual(cells, t.rows.map((r) => r.cells), csv);
    }),
    400,
  );
});

// Papa Parse guesses the delimiter from the first rows: text in which
// another candidate (";", tab, "|") turns up the same number of times in
// every cell must not make it the delimiter.
test("property: text full of semicolons, tabs or pipes does not change the delimiter", () => {
  check(
    fc.property(
      fc.constantFrom(";", "\t", "|"),
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 1, max: 6 }),
      fc.array(fc.constantFrom("a", "Name", "x y", "1", "😀"), { minLength: 1, maxLength: 4 }),
      (delimiter, columns, times, count, words) => {
        // Known limitation, reported: in a CSV of one column a row whose
        // only cell is empty is an empty line, which the import skips – so
        // no cell is empty here.
        const text = (i: number) => Array.from({ length: times + 1 }, (_, k) => words[(i + k) % words.length]).join(delimiter);
        const fields: Field[] = Array.from({ length: columns }, (_, i) => ({ id: `f${i}`, name: `${text(i)}${i}`, type: "text" }));
        const rows = Array.from({ length: count }, (_, r) => ({ cells: Object.fromEntries(fields.map((f, i) => [f.id, text(r + i)])) }));
        const csv = databaseCsv(fields, fields, rows, ctx);
        const parsed = parseCsvFile(csv);
        assert.deepEqual(parsed.columns, fields.map((f) => f.name), csv);
        // Formatted text (#126, every text column but the first) is stored
        // as inline Markdown.
        assert.deepEqual(
          parsed.rows.map(csvImporter(fields, fields, ctx)),
          rows.map((r) => Object.fromEntries(fields.map((f, i) => [f.id, i ? escapeInline(String(r.cells[f.id])) : r.cells[f.id]]))),
          csv,
        );
      },
    ),
    300,
  );
});
