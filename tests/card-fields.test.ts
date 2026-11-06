// Issue #130: board and gallery cards show every visible property that has a
// value; empty ones and the footer date take no slot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardFields } from "../lib/card-fields";
import type { Field } from "../lib/types";

const f = (id: string, type: Field["type"] = "text"): Field => ({ id, name: id, type });
const fields = [f("title"), f("empty"), f("due", "date"), f("a"), f("b"), f("count", "number"), f("done", "checkbox"), f("tags", "multiselect"), f("c")];

test("empty properties and the footer date take no slot", () => {
  const cells = { title: "Card", empty: " ", due: "2026-11-06", a: "A", b: "B", count: 0, done: false, tags: [], c: "C" };
  assert.deepEqual(
    cardFields(fields, cells, ["title", "due"]).map((x) => x.id),
    ["a", "b", "count", "c"],
  );
});

test("cards show every property with a value; a limit keeps lists compact", () => {
  const cells = { title: "Card", empty: "x", due: "2026-11-06", a: "A", b: "B", count: 3, done: true, tags: ["x"], c: "C" };
  assert.equal(cardFields(fields, cells, ["title"]).length, 8);
  assert.deepEqual(cardFields(fields, cells, ["title", "due"], 3).map((x) => x.id), ["empty", "a", "b"]);
  assert.deepEqual(cardFields(fields, cells, [undefined]).map((x) => x.id)[0], "title");
});
