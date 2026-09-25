import { test } from "node:test";
import assert from "node:assert/strict";
import type { Field, Filter } from "../lib/types";
import { filterSchema, matches, operatorsFor } from "../lib/database-filters";
import { columnSummary } from "../lib/database-summary";
import { aggregateRollup } from "../lib/rollups";
import { remapViewReferences } from "../lib/view-references";
const f = (id: string, type: Field["type"], extra = {}): Field => ({
  id,
  name: id,
  type,
  ...extra,
});
const rule = (field: string, op: Filter["op"], extra = {}): Filter => ({
  field,
  op,
  value: "",
  ...extra,
});

test("filters match any, none or all of several values", () => {
  const tags = f("tags", "multiselect", { options: ["A", "B", "C"] });
  const cells = { tags: ["A", "B"] };
  assert.equal(
    matches(cells, rule("tags", "any_of", { values: ["C", "b"] }), tags),
    true,
  );
  assert.equal(
    matches(cells, rule("tags", "none_of", { values: ["C"] }), tags),
    true,
  );
  assert.equal(
    matches(cells, rule("tags", "none_of", { values: ["A"] }), tags),
    false,
  );
  assert.equal(
    matches(cells, rule("tags", "all_of", { values: ["A", "B"] }), tags),
    true,
  );
  assert.equal(
    matches(cells, rule("tags", "all_of", { values: ["A", "C"] }), tags),
    false,
  );
  // Single-value properties and empty cells.
  const status = f("status", "select", { options: ["Offen", "Fertig"] });
  assert.equal(
    matches(
      { status: "Offen" },
      rule("status", "any_of", { values: ["Offen", "Fertig"] }),
      status,
    ),
    true,
  );
  assert.equal(
    matches({}, rule("status", "none_of", { values: ["Offen"] }), status),
    true,
  );
  assert.equal(
    matches({}, rule("status", "any_of", { values: ["Offen"] }), status),
    false,
  );
  assert.ok(operatorsFor(tags).includes("all_of"));
  assert.ok(!operatorsFor(status).includes("all_of"));
  assert.equal(filterSchema.safeParse(rule("tags", "any_of")).success, false);
  assert.equal(
    filterSchema.safeParse(rule("tags", "any_of", { values: ["A"] })).success,
    true,
  );
});

test("filters for ranges, checkboxes and checklists", () => {
  const due = f("due", "date"),
    n = f("n", "number");
  const between = (from: string, to: string) =>
    rule("due", "between", { value: from, to });
  assert.equal(
    matches({ due: "2026-09-10" }, between("2026-09-01", "2026-09-10"), due),
    true,
  );
  assert.equal(
    matches(
      { due: "2026-09-10T08:00" },
      between("2026-09-10", "2026-09-01"),
      due,
    ),
    true,
  );
  assert.equal(
    matches({ due: "2026-09-11" }, between("2026-09-01", "2026-09-10"), due),
    false,
  );
  assert.equal(matches({}, between("2026-09-01", "2026-09-10"), due), false);
  assert.equal(
    matches({ n: 5 }, rule("n", "between", { value: "1", to: "5" }), n),
    true,
  );
  assert.equal(
    matches({ n: "" }, rule("n", "between", { value: "0", to: "5" }), n),
    false,
  );
  assert.equal(
    filterSchema.safeParse(rule("n", "between", { value: "1" })).success,
    false,
  );
  const done = f("done", "checkbox");
  assert.deepEqual(operatorsFor(done), ["checked", "unchecked"]);
  assert.equal(matches({ done: true }, rule("done", "checked"), done), true);
  assert.equal(matches({}, rule("done", "unchecked"), done), true);
  const list = f("list", "checklist");
  const items = (...done: boolean[]) =>
    done.map((d, i) => ({ text: `${i}`, done: d }));
  assert.equal(
    matches({ list: items(true, true) }, rule("list", "complete"), list),
    true,
  );
  assert.equal(
    matches({ list: items(true, false) }, rule("list", "incomplete"), list),
    true,
  );
  assert.equal(matches({ list: [] }, rule("list", "incomplete"), list), true);
  assert.equal(matches({ list: [] }, rule("list", "complete"), list), false);
});

test("empty means the same in filters, calculations and rollups", () => {
  const text = f("value", "text"),
    box = f("value", "checkbox");
  // Blank text and unchecked boxes are empty.
  assert.equal(matches({ value: "   " }, rule("value", "empty"), text), true);
  assert.equal(matches({ value: false }, rule("value", "empty"), box), true);
  assert.equal(matches({ value: true }, rule("value", "notempty"), box), true);
  const rows = (...values: unknown[]) =>
    values.map((value, i) => ({
      id: String(i),
      page_id: "p",
      cells: { value },
      position: i,
      created_at: "",
      updated_at: "",
      created_by: "",
      updated_by: "",
      version: 1,
    }));
  assert.equal(
    columnSummary(text, rows("a", " ", "", null), "count_empty")?.value,
    3,
  );
  assert.equal(
    columnSummary(box, rows(true, false, null), "count_not_empty")?.value,
    1,
  );
  assert.equal(
    columnSummary(box, rows(true, false, null), "percent_empty")?.value,
    2 / 3,
  );
  // Rollups use the same rule; numbers keep zero as a value.
  assert.equal(aggregateRollup(["x", "  ", [], [""], 0], "count_not_empty"), 2);
});

test("copies remap relation ids in multi-value filters", () => {
  const views = remapViewReferences(
    [
      {
        id: "v",
        name: "V",
        type: "table",
        sorts: [],
        filters: [rule("rel", "any_of", { values: ["old", "keep"] })],
        groupSettings: {
          hideEmpty: true,
          sort: "manual",
          collapsed: [JSON.stringify(["sub", '"old"', '"x"', '"old"'])],
        },
        groupBy: "rel",
      },
    ],
    [f("rel", "relation", { relationPage: "p" })],
    new Map([["old", "new"]]),
  );
  assert.deepEqual(views[0].filters[0].values, ["new", "keep"]);
  assert.deepEqual(JSON.parse(views[0].groupSettings!.collapsed[0]), [
    "sub",
    '"new"',
    '"x"',
    '"new"',
  ]);
});
