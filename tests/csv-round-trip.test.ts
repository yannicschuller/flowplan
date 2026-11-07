// The CSV export and import of a database view (components/database-view.tsx):
// the apostrophe that keeps formula-like text from running in a spreadsheet
// comes off again, and multi-select values with a comma stay one value.
import { test } from "node:test";
import assert from "node:assert/strict";
import Papa from "papaparse";
import { CSV_FORMULA, cellText, csvImportText, csvListValues } from "../lib/cell-text";

// Export and import as the database view does them.
const exported = (fields: string[], rows: unknown[][]) =>
  Papa.unparse({ fields, data: rows.map((r) => r.map(cellText)) }, { escapeFormulae: CSV_FORMULA });
const imported = (csv: string) =>
  Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: csvImportText,
    transform: csvImportText,
  }).data;

test("formula-like text gets its apostrophe on export and loses it on import", () => {
  const values = [
    "+1 805 555 0100",
    "=fake total",
    "-not a number",
    "@mention",
    "\tindented",
    "-5",
    "'hello",
    "it's",
    "'=already quoted",
    "''+twice",
    "plain",
  ];
  const csv = exported(["=Summe", "Name"], values.map((v) => [v, v]));
  // The export still protects spreadsheets.
  assert.match(csv, /^"'=Summe",Name\r\n"'\+1 805 555 0100","'\+1 805 555 0100"/);
  assert.match(csv, /\r\n-5,-5\r\n/);
  assert.match(csv, /\r\n"'''\+twice","'''\+twice"\r\n/);
  const rows = imported(csv);
  assert.deepEqual(rows.map((r) => r["=Summe"]), values);
  assert.deepEqual(rows.map((r) => r.Name), values);
});

test("only an apostrophe the export would have added is removed", () => {
  assert.equal(csvImportText("'=SUM(1,2)"), "=SUM(1,2)");
  assert.equal(csvImportText("'-x"), "-x");
  // Numbers are never guarded, so their apostrophe was typed.
  assert.equal(csvImportText("'-5"), "'-5");
  assert.equal(csvImportText("'hello"), "'hello");
  assert.equal(csvImportText("'"), "'");
  assert.equal(csvImportText("rock 'n' roll"), "rock 'n' roll");
  assert.equal(csvImportText("=no apostrophe"), "=no apostrophe");
});

test("multi-select values with a comma come back whole when they are options", () => {
  const options = ["Night, Weekend", "Day", "Night", "a,b"];
  const csv = exported(["Name", "Schicht"], [
    ["Eins", ["Night, Weekend", "Day"]],
    ["Zwei", ["Night", "Day"]],
    ["Drei", ["a,b"]],
  ]);
  const cells = imported(csv).map((r) => csvListValues(r.Schicht, options));
  assert.deepEqual(cells, [["Night, Weekend", "Day"], ["Night", "Day"], ["a,b"]]);
  // Hand-made spreadsheets: any case and spacing, unknown values split.
  assert.deepEqual(csvListValues("night,  weekend ,day", options), ["Night, Weekend", "Day"]);
  assert.deepEqual(csvListValues("Neu, Night", options), ["Neu", "Night"]);
  assert.deepEqual(csvListValues("Night, Weekend"), ["Night", "Weekend"]);
  assert.deepEqual(csvListValues(" , A,,B ,"), ["A", "B"]);
  assert.deepEqual(csvListValues(""), []);
});

test("a multi-select cell starting like a formula round-trips", () => {
  const csv = exported(["Tags"], [[["=Kosten", "Day"]]]);
  assert.match(csv, /"'=Kosten, Day"/);
  assert.deepEqual(csvListValues(imported(csv)[0].Tags, ["=Kosten", "Day"]), ["=Kosten", "Day"]);
});

test("a cell with thousands of comma-separated values splits in linear time", () => {
  const cell = Array.from({ length: 2000 }, (_, i) => `v${i}`).join(",");
  const started = performance.now();
  const values = csvListValues(cell, ["Früh, Spät", "Nacht"]);
  assert.equal(values.length, 2000);
  assert.ok(performance.now() - started < 200, `took ${performance.now() - started} ms`);
});

test("formulas after leading spaces are defused and come back as written", () => {
  for (const value of ["  =SUM(1,2)", " +1", "\n@x", " -x"]) {
    assert.ok(CSV_FORMULA.test(value), JSON.stringify(value));
    assert.equal(csvImportText(`'${value}`), value);
  }
  for (const value of [" -5", "  text", "-1.5"]) assert.ok(!CSV_FORMULA.test(value), JSON.stringify(value));
});
