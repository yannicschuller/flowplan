// "Filter (n)" of My tasks and its chips (#612): every filter that differs
// from the default counts once, in the chips' order; the database and the
// search only while records take part and not in "Alle Arbeitsbereiche".
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTaskFilters } from "../lib/task-filter-count";

const base = {
  everywhere: false,
  source: "all" as const,
  person: "mine" as const,
  range: "any",
  done: false,
  unassigned: false,
  database: "",
  query: "",
  records: true,
};

test("nothing set: none", () => {
  assert.deepEqual(activeTaskFilters(base), []);
  assert.deepEqual(activeTaskFilters({ ...base, query: "   " }), []);
});

test("each differing filter counts once, in the chips' order", () => {
  assert.deepEqual(activeTaskFilters({ ...base, person: "all" }), ["person"]);
  assert.deepEqual(activeTaskFilters({ ...base, range: "week", source: "documents", everywhere: true }), ["scope", "source", "range"]);
  assert.deepEqual(activeTaskFilters({ ...base, person: "own", done: true }), ["person", "done"]);
  assert.deepEqual(activeTaskFilters({ ...base, done: true, unassigned: true, database: "db", query: "drucker" }), ["done", "unassigned", "database", "query"]);
});

test("the records' tools only while records take part, and only in one workspace", () => {
  assert.deepEqual(activeTaskFilters({ ...base, database: "db", query: "x", records: false }), []);
  assert.deepEqual(activeTaskFilters({ ...base, database: "db", query: "x", everywhere: true }), ["scope"]);
});
