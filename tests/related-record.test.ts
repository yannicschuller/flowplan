// #192: a related record opens on top of the current view on a plain click;
// modified and middle clicks keep the link; the overlay is a history entry
// of its own with the same address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRelatedEntry, pushRelatedEntry, relationClick, RELATED_STATE } from "../lib/related-record";

const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

test("a plain click opens another database's record on top, the same database's in place", () => {
  assert.equal(relationClick(plain, "customers", "tasks"), "overlay");
  assert.equal(relationClick(plain, "tasks", "tasks"), "here");
});

test("modified, middle and already handled clicks keep the link", () => {
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const)
    assert.equal(relationClick({ ...plain, [modifier]: true }, "customers", "tasks"), "native", modifier);
  assert.equal(relationClick({ ...plain, button: 1 }, "customers", "tasks"), "native");
  assert.equal(relationClick({ ...plain, button: 2 }, "customers", "tasks"), "native");
  assert.equal(relationClick({ ...plain, defaultPrevented: true }, "customers", "tasks"), "native");
});

test("the overlay's history entry keeps the address and is told apart by its token", () => {
  const calls: { kind: string; state: unknown; url?: string }[] = [];
  const history = {
    state: null as unknown,
    pushState(state: unknown, _title: string, url?: string) {
      calls.push({ kind: "push", state, url });
      this.state = state;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      calls.push({ kind: "replace", state, url });
      this.state = state;
    },
  };
  assert.equal(onRelatedEntry(history, "a"), false);
  pushRelatedEntry(history, "a");
  assert.deepEqual(calls, [{ kind: "push", state: { [RELATED_STATE]: "a" }, url: undefined }]);
  assert.equal(onRelatedEntry(history, "a"), true);
  assert.equal(onRelatedEntry(history, "b"), false);
  assert.equal(onRelatedEntry(history, ""), false);
  // Another record from inside the overlay takes the same entry.
  pushRelatedEntry(history, "b", true);
  assert.equal(calls[1].kind, "replace");
  assert.equal(onRelatedEntry(history, "a"), false);
  assert.equal(onRelatedEntry(history, "b"), true);
});
