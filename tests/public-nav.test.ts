// Getting around a published database (#393, lib/public-nav.ts): the view's
// state in a record's address, the link back to the view, and the record's
// title as the last item of the path – only when visitors may read it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordCrumb,
  recordHref,
  truncateTitle,
  viewHref,
  viewScrollKey,
  viewStateOf,
  viewStateQuery,
} from "../lib/public-nav";
import { publicFieldIds } from "../lib/shared-content";
import type { Field } from "../lib/types";

test("a record opened from a view keeps the view's state in its address", () => {
  const state = viewStateOf({ view: "timeline", month: "2026-11", scale: "week", other: "x", row: "r0" });
  assert.deepEqual(state, { view: "timeline", month: "2026-11", scale: "week" });
  assert.equal(recordHref("/share/tok/db", "r1", state), "/share/tok/db?row=r1&view=timeline&month=2026-11&scale=week");
  assert.equal(recordHref("/share/tok/db", "r1"), "/share/tok/db?row=r1");
  // Back: the same view with the same state, without the record.
  const back = new URL(recordHref("/share/tok/db", "r1", state), "https://x.test");
  const parsed = viewStateOf(back.searchParams);
  assert.deepEqual(parsed, state);
  assert.equal(viewHref("/share/tok/db", parsed), "/share/tok/db?view=timeline&month=2026-11&scale=week");
  assert.equal(viewHref("/", {}), "/");
  // The same key on both pages, whatever the order of the parameters.
  assert.equal(
    viewScrollKey("db", viewStateOf(new URLSearchParams("month=2026-11&view=timeline&scale=week"))),
    viewScrollKey("db", state),
  );
});

test("only plain values are passed on", () => {
  assert.deepEqual(viewStateOf({ view: ["a", "b"], month: "2026-11\"><script>", cards: "2" }), { view: "a", cards: "2" });
  assert.deepEqual(viewStateOf(new URLSearchParams("view=a%20b&period=" + "x".repeat(81))), {});
  assert.deepEqual(viewStateOf(undefined), {});
  assert.equal(viewStateQuery({ view: "v:1" }), "view=v%3A1");
});

test("the path shows the record's title when the title is public", () => {
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "text" },
  ];
  assert.equal(recordCrumb({ title: "Umsetzung" }, fields, publicFieldIds(fields)), "Umsetzung");
  // Without a title: the generic word (null).
  assert.equal(recordCrumb({ title: "  " }, fields, publicFieldIds(fields)), null);
  assert.equal(recordCrumb({}, fields, publicFieldIds(fields)), null);
  // Long titles are cut with an ellipsis; the full text when asked for.
  const long = "Ein sehr langer Titel ".repeat(6);
  const cut = recordCrumb({ title: long }, fields, publicFieldIds(fields))!;
  assert.equal(cut.length, 60);
  assert.ok(cut.endsWith("…"));
  assert.equal(recordCrumb({ title: long }, fields, publicFieldIds(fields), Infinity), long.trim());
  assert.equal(truncateTitle("kurz"), "kurz");
});

test("a title visitors may not read stays the generic word", () => {
  const restricted: Field[] = [
    { id: "title", name: "Name", type: "text", access: { read: "editors" } },
    { id: "status", name: "Status", type: "text" },
  ];
  assert.equal(recordCrumb({ title: "Geheim" }, restricted, publicFieldIds(restricted)), null);
  // A person as the first property is never public either.
  const person: Field[] = [{ id: "owner", name: "Wer", type: "person" }];
  assert.equal(recordCrumb({ owner: "u1" }, person, publicFieldIds(person)), null);
  assert.equal(recordCrumb({ title: "x" }, [], new Set()), null);
});
