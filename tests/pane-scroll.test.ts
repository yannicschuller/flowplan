import { test } from "node:test";
import assert from "node:assert/strict";
import { keepPosition, paneTarget } from "../lib/pane-scroll";

// #262: a place starts at its top unless its own history entry kept a
// position for it – never the position of another place.
test("the pane's target: the entry's own position for the same place, else the top", () => {
  const kept = new Map<string, { place: string; top: number }>();
  keepPosition(kept, "e1", "page:a", 2000);
  keepPosition(kept, "e0", "home:", 0);
  assert.equal(paneTarget(kept, "e1", "page:a"), 2000);
  assert.equal(paneTarget(kept, "e0", "home:"), 0);
  // A new entry, or the entry now showing another place: the top.
  assert.equal(paneTarget(kept, "e2", "home:"), 0);
  assert.equal(paneTarget(kept, "e1", "home:"), 0);
  // Without the Navigation API: no entries, the top.
  assert.equal(paneTarget(kept, null, "page:a"), 0);
});

test("only the newest entries are kept", () => {
  const kept = new Map<string, { place: string; top: number }>();
  for (let i = 0; i < 5; i++) keepPosition(kept, `e${i}`, "page:a", i * 10, 3);
  keepPosition(kept, "e2", "page:a", 99, 3);
  assert.deepEqual([...kept.keys()], ["e3", "e4", "e2"]);
  assert.equal(paneTarget(kept, "e0", "page:a"), 0);
});
