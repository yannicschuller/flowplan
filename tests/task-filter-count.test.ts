// "Filter (n)" of My tasks on phones: n counts the filters in its sheet that
// differ from the default; the source and the date range (in the row) do
// not count, the database and the search only while records take part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetFilterCount } from "../lib/task-filter-count";

const base = { person: "mine" as const, done: false, unassigned: false, database: "", query: "", records: true };

test("nothing set: 0", () => {
  assert.equal(sheetFilterCount(base), 0);
  assert.equal(sheetFilterCount({ ...base, query: "   " }), 0);
});

test("each differing filter counts once", () => {
  assert.equal(sheetFilterCount({ ...base, person: "all" }), 1);
  assert.equal(sheetFilterCount({ ...base, person: "own", done: true }), 2);
  assert.equal(sheetFilterCount({ ...base, done: true, unassigned: true, database: "db", query: "drucker" }), 4);
});

test("the records' tools only while records take part", () => {
  assert.equal(sheetFilterCount({ ...base, database: "db", query: "x", records: false }), 0);
});
