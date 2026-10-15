import { test } from "node:test";
import assert from "node:assert/strict";
import { printSnapshot, storePrintSnapshot } from "../lib/print-snapshots";

test("print views are found by their secret address only, one per person", () => {
  const first = storePrintSnapshot("user-a", "<!doctype html><p>eins</p>");
  assert.match(first, /^[\w-]{32}$/);
  assert.equal(printSnapshot(first), "<!doctype html><p>eins</p>");
  assert.equal(printSnapshot("x".repeat(32)), null);
  const other = storePrintSnapshot("user-b", "<!doctype html><p>b</p>");
  const second = storePrintSnapshot("user-a", "<!doctype html><p>zwei</p>");
  assert.equal(printSnapshot(first), null);
  assert.equal(printSnapshot(second), "<!doctype html><p>zwei</p>");
  assert.equal(printSnapshot(other), "<!doctype html><p>b</p>");
});
