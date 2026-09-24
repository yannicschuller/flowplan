import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatNumber,
  formatFieldDate,
  displayText,
  numberFormats,
} from "../lib/field-format";
import { formatDateValue } from "../lib/date-values";
import { summaryText } from "../lib/database-summary";
import { field as fieldSchema } from "../lib/database-schema";

const nbsp = (s: string) => s.replace(/ | /g, " ");

test("number formats cover currencies, percent, grouping and fixed decimals", () => {
  assert.equal(nbsp(formatNumber(1234.5)), "1.234,5");
  assert.equal(nbsp(formatNumber(1234.5, "plain")), "1234,5");
  assert.equal(nbsp(formatNumber(3, "decimal2")), "3,00");
  assert.equal(nbsp(formatNumber(0.125, "percent")), "12,5 %");
  assert.equal(nbsp(formatNumber(1234.5, "eur")), "1.234,50 €");
  assert.equal(nbsp(formatNumber(10, "usd")), "10,00 $");
  assert.equal(nbsp(formatNumber(10, "jpy")), "10 ¥");
  assert.equal(nbsp(formatNumber(10, "chf")), "10,00 CHF");
  assert.equal(nbsp(formatNumber(-2, "unknown")), "-2");
  assert.ok(Object.keys(numberFormats).length > 35);
});

test("date and time formats change only the presentation", () => {
  const f = (format: string, timeFormat?: "24" | "12") => ({
    format,
    timeFormat,
  });
  assert.equal(formatFieldDate("2026-09-04", f("")), "4. Sept. 2026");
  assert.equal(formatFieldDate("2026-09-04", f("long")), "4. September 2026");
  assert.equal(formatFieldDate("2026-09-04", f("eu")), "04.09.2026");
  assert.equal(formatFieldDate("2026-09-04", f("iso")), "2026-09-04");
  assert.equal(formatFieldDate("2026-09-04", f("us")), "09/04/2026");
  assert.equal(
    formatFieldDate("2026-09-04T14:05:00Z", f("eu", "12"), "UTC"),
    "04.09.2026, 2:05 PM (UTC+00:00)",
  );
  assert.equal(
    formatFieldDate("2026-09-04T00:30:00Z", f("iso", "12"), "UTC"),
    "2026-09-04, 12:30 AM (UTC+00:00)",
  );
  assert.equal(
    formatDateValue("2026-09-04T14:05:00Z", "Europe/Berlin"),
    "4. Sept. 2026, 16:05 (UTC+02:00)",
  );
  assert.equal(
    displayText({ type: "number", format: "eur" }, 5).replace(/ /g, " "),
    "5,00 €",
  );
  assert.equal(displayText({ type: "text" }, ["a", "b"]), "a, b");
});

test("summaries use the property format for value calculations only", () => {
  const eur = { type: "number" as const, format: "eur" };
  assert.equal(
    nbsp(
      summaryText(
        { calculation: "sum", value: 12.5, errors: 0, overflow: false },
        eur,
      ),
    ),
    "Σ 12,50 €",
  );
  assert.ok(
    !summaryText(
      { calculation: "count", value: 3, errors: 0, overflow: false },
      eur,
    ).includes("€"),
  );
  assert.equal(
    summaryText(
      {
        calculation: "earliest_date",
        value: "2026-01-02",
        errors: 0,
        overflow: false,
      },
      { type: "date", format: "iso" },
    ).endsWith("2026-01-02"),
    true,
  );
  assert.equal(
    fieldSchema.safeParse({
      id: "d",
      name: "D",
      type: "date",
      timeFormat: "12",
    }).success,
    true,
  );
  assert.equal(
    fieldSchema.safeParse({
      id: "d",
      name: "D",
      type: "date",
      timeFormat: "13",
    }).success,
    false,
  );
});
