// Own units of number properties (#522): "12,5 kg" everywhere a number is
// shown formatted; stored values, sorting and sums stay numeric.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayText,
  fieldUnit,
  formatFieldNumber,
  stripUnit,
  UNIT_SPACE,
} from "../lib/field-format";
import { columnSummary, summaryText } from "../lib/database-summary";
import { field as fieldSchema } from "../lib/database-schema";
import { databaseGroups } from "../lib/database-groups";
import { clipboardCell } from "../lib/database-clipboard";
import { csvImporter, databaseCsv } from "../lib/database-csv";
import type { Field, Row } from "../lib/types";

// Thousands separators of Intl as plain spaces; the unit's narrow space stays.
const nbsp = (s: string) => s.replace(/\u00a0/g, " ");
const u = (s: string) => s.replace(/ (\S+)$/, `${UNIT_SPACE}$1`);
const number = (extra: Partial<Field> = {}): Field => ({ id: "n", name: "Gewicht", type: "number", ...extra });
const rows = (...values: unknown[]): Row[] =>
  values.map((v, i) => ({ id: `r${i}`, page_id: "p", position: i, cells: { n: v } }) as unknown as Row);

test("the unit follows the number with a narrow no-break space in the property's format", () => {
  assert.equal(formatFieldNumber(12.5, number({ unit: "kg" })), u("12,5 kg"));
  assert.equal(nbsp(formatFieldNumber(1234.5, number({ unit: "m" }))), u("1.234,5 m"));
  assert.equal(formatFieldNumber(1234.5, number({ unit: "m", format: "plain" })), u("1234,5 m"));
  assert.equal(nbsp(formatFieldNumber(3, number({ unit: "h", format: "decimal2" }))), u("3,00 h"));
  // Decimals are respected, also passed explicitly.
  assert.equal(formatFieldNumber(2, number({ unit: "kg", decimals: 1 })), u("2,0 kg"));
  assert.equal(formatFieldNumber(2.345, number({ unit: "kg" }), 2), u("2,35 kg"));
  // Trimmed; without a unit nothing changes.
  assert.equal(formatFieldNumber(5, number({ unit: "  km " })), u("5 km"));
  assert.equal(formatFieldNumber(5, number({ unit: "" })), "5");
  assert.equal(formatFieldNumber(5, number()), "5");
  // Not a number: no unit.
  assert.equal(formatFieldNumber(NaN, number({ unit: "kg" })), "NaN");
});

test("currencies and percent carry their own sign and ignore the unit", () => {
  assert.equal(fieldUnit({ unit: "kg", format: "eur" }), "");
  assert.equal(fieldUnit({ unit: "kg", format: "percent" }), "");
  assert.equal(nbsp(formatFieldNumber(10, number({ unit: "kg", format: "eur" }))), "10,00 €");
  assert.equal(nbsp(formatFieldNumber(0.5, number({ unit: "kg", format: "percent" }))), "50 %");
  // A format key that is no currency ("constructor", "toString") is no currency.
  assert.equal(fieldUnit({ unit: "kg", format: "constructor" }), "kg");
});

test("displayText shows the unit for numbers and number formulas", () => {
  assert.equal(displayText(number({ unit: "kg" }), 12.5), u("12,5 kg"));
  assert.equal(displayText({ type: "formula", unit: "m" }, 3), u("3 m"));
  assert.equal(displayText({ type: "formula", unit: "m" }, "text"), "text");
  assert.equal(displayText({ type: "text", unit: "m" }, "3"), "3");
});

test("the server refuses long units and control characters and trims", () => {
  const base = { id: "n", name: "Gewicht", type: "number" };
  assert.equal(fieldSchema.parse({ ...base, unit: " kg " }).unit, "kg");
  assert.equal(fieldSchema.parse({ ...base, unit: "m²" }).unit, "m²");
  assert.equal(fieldSchema.parse({ ...base, unit: "x".repeat(12) }).unit, "x".repeat(12));
  assert.equal(fieldSchema.safeParse({ ...base, unit: "x".repeat(13) }).success, false);
  assert.equal(fieldSchema.safeParse({ ...base, unit: "k\ng" }).success, false);
  assert.equal(fieldSchema.safeParse({ ...base, unit: "kg\u0000" }).success, false);
  assert.equal(fieldSchema.safeParse({ ...base, unit: "\u202ekg" }).success, false);
  assert.equal(fieldSchema.safeParse({ ...base, unit: 5 }).success, false);
  assert.equal(fieldSchema.parse(base).unit, undefined);
});

test("calculations show the unit for values, not for counts and shares", () => {
  const f = number({ unit: "kg" }),
    data = rows(10, 2.5, null);
  assert.equal(summaryText(columnSummary(f, data, "sum")!, f), `Σ ${u("12,5 kg")}`);
  assert.equal(summaryText(columnSummary(f, data, "average")!, f), `Ø ${u("6,25 kg")}`);
  for (const c of ["min", "max", "median", "range"] as const)
    assert.ok(summaryText(columnSummary(f, data, c)!, f).endsWith(`${UNIT_SPACE}kg`), c);
  assert.ok(!summaryText(columnSummary(f, data, "count")!, f).includes("kg"));
  assert.ok(!summaryText(columnSummary(f, data, "count_empty")!, f).includes("kg"));
  assert.ok(!summaryText(columnSummary(f, data, "percent_empty")!, f).includes("kg"));
  // With decimals the property's format, still with the unit.
  const two = number({ unit: "kg", decimals: 2 });
  assert.equal(summaryText(columnSummary(two, data, "sum")!, two), `Σ ${u("12,50 kg")}`);
  // A currency ignores it; the sum itself stays a number.
  const eur = number({ unit: "kg", format: "eur" });
  assert.equal(nbsp(summaryText(columnSummary(eur, data, "sum")!, eur)), "Σ 12,50 €");
  assert.equal(columnSummary(f, data, "sum")!.value, 12.5);
});

test("group labels, the clipboard and the CSV import know the unit; the CSV export stays raw", () => {
  const f = number({ unit: "kg" });
  const groups = databaseGroups(rows(12.5, 3), f, {});
  assert.deepEqual(
    groups.filter((g) => g.rows.length).map((g) => g.label).sort(),
    [`12.5${UNIT_SPACE}kg`, `3${UNIT_SPACE}kg`].sort(),
  );
  assert.equal(clipboardCell(f, 12.5, { yes: "Ja", no: "Nein", untitled: "", unavailable: "" } as never), u("12,5 kg"));
  // Typed or pasted with the unit, the number reads.
  assert.equal(stripUnit("12 kg", f), "12");
  assert.equal(stripUnit("12,5KG", f), "12,5");
  assert.equal(stripUnit(`12,5${UNIT_SPACE}kg`, f), "12,5");
  assert.equal(stripUnit("12 m", f), "12 m");
  assert.equal(stripUnit("kg", f), "kg");
  assert.equal(stripUnit("12 kg", number({ unit: "kg", format: "eur" })), "12 kg");
  const title: Field = { id: "title", name: "Name", type: "text" };
  const read = csvImporter([title, f], [title, f], { untitled: "", unavailable: "" } as never);
  assert.equal(read({ Name: "A", Gewicht: "12,5 kg" }).n, 12.5);
  assert.equal(read({ Name: "A", Gewicht: "7" }).n, 7);
  assert.equal(read({ Name: "A", Gewicht: "7 m" }).n, "7 m");
  // The export writes the stored number.
  const csv = databaseCsv([title, f], [title, f], [{ cells: { title: "A", n: 12.5 } }], { untitled: "", unavailable: "" } as never);
  assert.ok(!String(csv).includes("kg"), String(csv));
});
