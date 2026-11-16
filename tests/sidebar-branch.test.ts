// A branch of the page tree focused in the sidebar (#318): the path above
// it, "←", leaving it for a page outside, and the copy on the device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchKey, branchPath, branchUp, inBranch, leavesBranch, readBranch, writeBranch } from "../lib/sidebar-branch";

const page = (id: string, parent_id: string | null, deleted_at: string | null = null) => ({ id, parent_id, space_id: "s", deleted_at });
// a ─ b ─ c       x (another top-level page)
//      └ d
const pages = [page("a", null), page("b", "a"), page("c", "b"), page("d", "b"), page("x", null), page("gone", "a", "2026-01-01")];

test("the path runs from the top of the space down to the page", () => {
  assert.deepEqual(branchPath(pages, "c"), ["a", "b", "c"]);
  assert.deepEqual(branchPath(pages, "a"), ["a"]);
  assert.deepEqual(branchPath(pages, "nope"), []);
  assert.deepEqual(branchPath(pages, "gone"), []);
  assert.deepEqual(branchPath(pages, null), []);
});

test("a cycle in the parents does not loop", () => {
  const cyclic = [page("p", "q"), page("q", "p")];
  assert.deepEqual(branchPath(cyclic, "p"), ["q", "p"]);
});

test("pages below the focused page are in the branch, others are not", () => {
  assert.equal(inBranch(pages, "b", "b"), true);
  assert.equal(inBranch(pages, "b", "c"), true);
  assert.equal(inBranch(pages, "b", "a"), false);
  assert.equal(inBranch(pages, "b", "x"), false);
});

test("← goes to the parent, from the top of a space to the whole tree", () => {
  assert.equal(branchUp(pages, "c"), "b");
  assert.equal(branchUp(pages, "b"), "a");
  assert.equal(branchUp(pages, "a"), null);
});

test("opening a page outside the branch leaves it; inside or unchanged it stays", () => {
  assert.equal(leavesBranch(pages, "b", "c", "x"), true);
  assert.equal(leavesBranch(pages, "b", "c", "a"), true);
  assert.equal(leavesBranch(pages, "b", "c", "d"), false);
  assert.equal(leavesBranch(pages, "b", null, "b"), false);
  // The same page again (a re-render, a reload of its data): nothing changes.
  assert.equal(leavesBranch(pages, "b", "x", "x"), false);
  assert.equal(leavesBranch(pages, null, "c", "x"), false);
  assert.equal(leavesBranch(pages, "b", "c", null), false);
});

test("the focus is kept per workspace and dropped when its page is gone", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  writeBranch(storage, "w1", "b");
  assert.equal(store.get(branchKey("w1")), "b");
  assert.equal(readBranch(storage, "w1", pages), "b");
  assert.equal(readBranch(storage, "w2", pages), null);
  assert.equal(readBranch(storage, "w1", pages.filter((p) => p.id !== "b")), null);
  writeBranch(storage, "w1", null);
  assert.equal(store.has(branchKey("w1")), false);
  // Storage that throws (private mode): no focus, no error.
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  assert.equal(readBranch(broken, "w1", pages), null);
  assert.doesNotThrow(() => writeBranch(broken, "w1", "b"));
});
