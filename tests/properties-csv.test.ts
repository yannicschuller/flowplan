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
