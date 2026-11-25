// Sorting puts records with an empty value last, in both directions (#551).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, Row, View } from "../lib/types";
import { queryRows } from "../lib/database";

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "date", name: "Due", type: "date" },
  { id: "priority", name: "Priority", type: "number" },
  { id: "tags", name: "Tags", type: "multiselect", options: ["a", "b"] },
];
const row = (id: string, cells: Record<string, unknown>, position: number): Row => ({
  id, page_id: "page", cells, position, version: 1, created_at: "", updated_at: "", created_by: "", updated_by: "",
});
const rows = [
  row("none", { title: "Ohne" }, 0),
  row("late", { title: "Spät", date: "2026-12-24", priority: 3, tags: ["b"] }, 1),
  row("blank", { title: "", date: "", priority: null, tags: [] }, 2),
  row("early", { title: "Früh", date: "2026-01-02", priority: 0, tags: ["a"] }, 3),
];
const ids = (sorts: View["sorts"]) =>
  queryRows(rows, fields, { id: "v", name: "V", type: "table", filters: [], sorts }).map((r) => r.id);

test("a date sorted ascending starts with the earliest date, records without one at the end", () => {
  assert.deepEqual(ids([{ field: "date", direction: "asc" }]), ["early", "late", "none", "blank"]);
});
test("descending keeps the empty ones at the end too", () => {
  assert.deepEqual(ids([{ field: "date", direction: "desc" }]), ["late", "early", "none", "blank"]);
});
test("numbers: 0 is a value, no value goes last", () => {
  assert.deepEqual(ids([{ field: "priority", direction: "asc" }]), ["early", "late", "none", "blank"]);
});
test("an empty list and an empty text count as empty", () => {
  assert.deepEqual(ids([{ field: "tags", direction: "desc" }]), ["late", "early", "none", "blank"]);
  assert.deepEqual(ids([{ field: "title", direction: "asc" }]).at(-1), "blank");
});
test("empty ones are ordered by the next sort", () => {
  assert.deepEqual(
    ids([{ field: "date", direction: "asc" }, { field: "title", direction: "desc" }]),
    ["early", "late", "none", "blank"],
  );
});
