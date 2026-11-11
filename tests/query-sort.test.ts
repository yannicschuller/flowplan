// Sorting and searching people, related records and sprints (lib/database.ts
// queryRows): by the names the table shows, not by the stored ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryRows } from "../lib/database";
import type { Field, Row, View } from "../lib/types";

const ANNA = "ffffffff-0000-4000-8000-000000000001",
  ZOE = "00000000-0000-4000-8000-000000000002";
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "owner", name: "Zuständig", type: "person" },
  { id: "client", name: "Kunde", type: "relation", relationPage: "clients" },
  { id: "sprint", name: "Sprint", type: "sprint" },
  { id: "by", name: "Erstellt von", type: "created_by" },
];
const row = (id: string, cells: Record<string, unknown>, created_by = ""): Row => ({
  id,
  page_id: "db",
  cells,
  position: 0,
  created_at: "",
  updated_at: "",
  created_by,
  updated_by: "",
  version: 1,
});
// Related records whose ids sort the other way round than their titles; the
// linked database's first property is its title (not "title" here).
const ALPHA = "ffffffff-0000-4000-8000-00000000000a",
  ZETA = "00000000-0000-4000-8000-00000000000b";
const rows = [
  row("zoe", { title: "Z", owner: ZOE, client: [ZETA], sprint: "s-a" }, ZOE),
  row("anna", { title: "A", owner: ANNA, client: [ALPHA], sprint: "s-b" }, ANNA),
  row("none", { title: "N", owner: "", client: [], sprint: "" }),
];
const related = {
  clients: [row(ALPHA, { firm: "Alpha GmbH" }), row(ZETA, { firm: "Zeta AG" })],
};
const schemas = { clients: [{ id: "firm", name: "Firma", type: "text" } as Field] };
const labels = {
  members: [
    { id: ANNA, name: "Anna" },
    { id: ZOE, name: "Zoe" },
  ],
  // Sprint ids sort the other way round than their names.
  sprints: [
    { id: "s-a", name: "Sprint 9" },
    { id: "s-b", name: "Sprint 10" },
  ],
};
const view = (field: string): View =>
  ({ id: "v", name: "V", type: "table", filters: [], sorts: [{ field, direction: "asc" }] }) as unknown as View;
const sorted = (field: string) =>
  queryRows(rows, fields, view(field), "", related, schemas, new Date(), labels).map((r) => r.id);

test("people, related records and sprints sort by their names", () => {
  assert.deepEqual(sorted("owner"), ["none", "anna", "zoe"]);
  assert.deepEqual(sorted("by"), ["none", "anna", "zoe"]);
  assert.deepEqual(sorted("client"), ["none", "anna", "zoe"]);
  assert.deepEqual(sorted("sprint"), ["none", "zoe", "anna"]);
});

test("the search finds records by a person's or a sprint's name", () => {
  const search = (query: string) =>
    queryRows(rows, fields, { ...view("title"), sorts: [] }, query, related, schemas, new Date(), labels).map((r) => r.id);
  assert.deepEqual(search("anna"), ["anna"]);
  assert.deepEqual(search("sprint 10"), ["anna"]);
  assert.deepEqual(search("zeta"), ["zoe"]);
});
