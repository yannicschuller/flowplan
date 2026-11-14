import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activate,
  activePlace,
  close,
  closeFrame,
  closeOthers,
  cycle,
  follow,
  go,
  move,
  moveBy,
  nth,
  open,
  placeOf,
  restore,
  serialize,
  singleLayout,
  tabOf,
  tabSteps,
  MAX_STACK,
  MAX_TABS,
  type Layout,
} from "../lib/frame-tabs";

const A = "page=00000000-0000-4000-8000-00000000000a";
const B = "page=00000000-0000-4000-8000-00000000000b";
const C = "page=00000000-0000-4000-8000-00000000000c";
const D = "page=00000000-0000-4000-8000-00000000000d";
const places = (layout: Layout, frame = 0) => layout.frames[frame].tabs.map(placeOf);
const ids = (layout: Layout, frame = 0) => layout.frames[frame].tabs.map((t) => t.id);

test("opening: a new tab beside the active one, an open place is activated", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = activate(l, 0, "a");
  l = open(l, C, { id: "c" });
  assert.deepEqual(places(l), [A, C, B]);
  assert.equal(l.frames[0].active, "c");
  l = open(l, B);
  assert.equal(l.frames[0].active, "b");
  assert.equal(l.frames[0].tabs.length, 3);
  // In the background: the active tab stays.
  l = open(l, D, { id: "d", background: true });
  assert.equal(l.frames[0].active, "b");
  assert.deepEqual(places(l), [A, C, B, D]);
});

test("opening to the side creates the second frame (at most two)", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { frame: 1, id: "b" });
  assert.equal(l.frames.length, 2);
  assert.equal(l.focused, 1);
  assert.deepEqual(places(l, 1), [B]);
  l = open(l, C, { frame: 2, id: "c" });
  assert.equal(l.frames.length, 2);
  assert.deepEqual(places(l, 1), [B, C]);
  // The same place may be open in both frames.
  l = open(l, A, { frame: 1 });
  assert.deepEqual(places(l, 1), [B, C, A]);
});

test("a full frame sends the place to the active tab", () => {
  let l = singleLayout("home", "x");
  for (let i = 0; i < MAX_TABS + 3; i++) l = open(l, `page=00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  assert.equal(l.frames[0].tabs.length, MAX_TABS);
});

test("closing: the right neighbour becomes active, the last tab closes the frame", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = activate(l, 0, "b");
  l = close(l, 0, "b");
  assert.deepEqual(places(l), [A, C]);
  assert.equal(l.frames[0].active, "c");
  l = close(l, 0, "c");
  assert.equal(l.frames[0].active, "a");
  // Closing an inactive tab keeps the active one.
  l = open(l, D, { id: "d" });
  l = close(l, 0, "a");
  assert.equal(l.frames[0].active, "d");
  // The second frame closes with its last tab; the focus goes back left.
  l = open(l, B, { frame: 1, id: "b2" });
  assert.equal(l.focused, 1);
  l = close(l, 1, "b2");
  assert.equal(l.frames.length, 1);
  assert.equal(l.focused, 0);
  // The very last tab leaves the start page.
  l = close(l, 0, "d");
  assert.deepEqual(places(l), ["home"]);
});

test("closing the left frame's last tab makes the right frame the only one", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { frame: 1, id: "b" });
  l = close(l, 0, "a");
  assert.equal(l.frames.length, 1);
  assert.deepEqual(places(l), [B]);
  assert.equal(l.focused, 0);
});

test("close others and close frame", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = closeOthers(l, 0, "b");
  assert.deepEqual(ids(l), ["b"]);
  l = open(l, D, { frame: 1 });
  l = closeFrame(l, 1);
  assert.equal(l.frames.length, 1);
  assert.equal(closeFrame(l, 0), l);
});

test("reordering within a frame", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  // a b c → drag a behind c
  l = move(l, 0, "a", 0, 3);
  assert.deepEqual(ids(l), ["b", "c", "a"]);
  assert.equal(l.frames[0].active, "a");
  // c to the front
  l = move(l, 0, "c", 0, 0);
  assert.deepEqual(ids(l), ["c", "b", "a"]);
  l = moveBy(l, 0, "c", 1);
  assert.deepEqual(ids(l), ["b", "c", "a"]);
  l = moveBy(l, 0, "c", 1);
  assert.deepEqual(ids(l), ["b", "a", "c"]);
  assert.equal(moveBy(l, 0, "c", 1), l);
  l = moveBy(l, 0, "b", -1);
  assert.deepEqual(ids(l), ["b", "a", "c"]);
});

test("moving between frames, into a new frame, and the frame left empty closes", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  // Onto the right edge: a second frame with the tab.
  l = move(l, 0, "b", 1, 0);
  assert.equal(l.frames.length, 2);
  assert.deepEqual(ids(l, 0), ["a", "c"]);
  assert.deepEqual(ids(l, 1), ["b"]);
  assert.equal(l.focused, 1);
  // Into the other frame at a position.
  l = move(l, 0, "a", 1, 0);
  assert.deepEqual(ids(l, 1), ["a", "b"]);
  assert.equal(l.frames[1].active, "a");
  // The last tab of the left frame leaves: the right frame is the only one.
  l = move(l, 0, "c", 1, 2);
  assert.equal(l.frames.length, 1);
  assert.deepEqual(ids(l, 0), ["a", "b", "c"]);
  assert.equal(l.focused, 0);
  // The only tab of the only frame stays.
  const one = singleLayout(A, "x");
  assert.equal(move(one, 0, "x", 1, 0), one);
});

test("history per tab: push, back, forward, replace, the browser's own steps", () => {
  let l = singleLayout(A, "a");
  l = follow(l, 0, B);
  l = follow(l, 0, C);
  assert.deepEqual(tabOf(l.frames[0]).stack, [A, B, C]);
  l = go(l, 0, -1);
  assert.equal(activePlace(l), B);
  const first = go(l, 0, -5);
  assert.equal(go(first, 0, -1), first);
  assert.equal(activePlace(go(l, 0, -5)), A);
  // A new place drops the forward steps.
  l = follow(l, 0, D);
  assert.deepEqual(tabOf(l.frames[0]).stack, [A, B, D]);
  // Without knowing the change: a neighbouring place is back or forward.
  l = follow(l, 0, B, "unknown");
  assert.equal(tabOf(l.frames[0]).index, 1);
  l = follow(l, 0, D, "unknown");
  assert.equal(tabOf(l.frames[0]).index, 2);
  l = follow(l, 0, C, "replace");
  assert.deepEqual(tabOf(l.frames[0]).stack, [A, B, C]);
  // The browser's back to an entry of another tab: this tab's own step.
  l = follow(l, 0, "inbox", "back");
  assert.equal(activePlace(l), B);
  l = follow(l, 0, "inbox", "forward");
  assert.equal(activePlace(l), C);
  // At the beginning of the tab's history the browser's place joins it.
  let start = singleLayout(A, "s");
  start = follow(start, 0, B, "back");
  assert.deepEqual(tabOf(start.frames[0]).stack, [B, A]);
  assert.equal(activePlace(start), B);
  start = follow(start, 0, C, "forward");
  assert.equal(activePlace(start), A);
  start = follow(start, 0, C, "forward");
  assert.deepEqual(tabOf(start.frames[0]).stack, [B, A, C]);
  // Each tab has its own history.
  l = open(l, "tasks", { id: "t" });
  l = follow(l, 0, "inbox");
  assert.deepEqual(tabOf(l.frames[0]).stack, ["tasks", "inbox"]);
  const steps = tabSteps(l, 0);
  assert.deepEqual(steps.back, [{ place: "tasks", delta: -1 }]);
  assert.deepEqual(steps.forward, []);
  l = activate(l, 0, "a");
  assert.deepEqual(tabSteps(l, 0).back.map((s) => s.place), [B, A]);
  // The history is bounded.
  let long = singleLayout("home");
  for (let i = 0; i < MAX_STACK + 10; i++) long = follow(long, 0, `page=00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  assert.equal(tabOf(long.frames[0]).stack.length, MAX_STACK);
});

test("cycling and the n-th tab", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = cycle(l, 0, 1);
  assert.equal(l.frames[0].active, "a");
  l = cycle(l, 0, -1);
  assert.equal(l.frames[0].active, "c");
  l = nth(l, 0, 1);
  assert.equal(l.frames[0].active, "b");
  l = nth(l, 0, Infinity);
  assert.equal(l.frames[0].active, "c");
});

test("serialize and restore: pages no longer there are dropped silently", () => {
  let l = singleLayout(A, "a");
  l = follow(l, 0, B);
  l = follow(l, 0, C);
  l = go(l, 0, -1); // a: A B [C] → current B
  l = open(l, D, { id: "d" });
  l = open(l, "settings/account", { frame: 1, id: "s" });
  l = open(l, B, { frame: 1, id: "b" });
  l = activate(l, 1, "s");
  const stored = JSON.parse(JSON.stringify(serialize(l)));
  const all = restore(stored, () => true)!;
  assert.deepEqual(places(all), [B, D]);
  assert.deepEqual(all.frames[0].tabs[0].stack, [A, B, C]);
  assert.equal(all.frames[0].tabs[0].index, 1);
  assert.equal(placeOf(tabOf(all.frames[0])), D);
  assert.equal(all.focused, 1);
  assert.equal(placeOf(tabOf(all.frames[1])), "settings/account");
  // B is gone: tab a falls back to the place before it, frame 1 keeps its other tab.
  const noB = restore(stored, (p) => p !== B)!;
  assert.deepEqual(noB.frames[0].tabs[0].stack, [A, C]);
  assert.equal(placeOf(noB.frames[0].tabs[0]), A);
  assert.deepEqual(places(noB, 1), ["settings/account"]);
  // D gone too and the settings: frame 1 goes, the active tab of frame 0 was d → the remaining one.
  const little = restore(stored, (p) => p === A || p === C)!;
  assert.equal(little.frames.length, 1);
  assert.equal(little.frames[0].tabs.length, 1);
  assert.equal(little.focused, 0);
  // Nothing left, broken or foreign values: null.
  assert.equal(restore(stored, () => false), null);
  assert.equal(restore(null, () => true), null);
  assert.equal(restore({ v: 2, frames: [] }, () => true), null);
  assert.equal(restore({ v: 1, frames: [{ tabs: [{ stack: ["javascript:alert(1)", 5], index: 0 }], active: 0 }], focused: 0 }, () => true), null);
  // Places are normalised: block links and threads are parts of their page.
  const normal = restore({ v: 1, focused: 7, frames: [{ active: 0, tabs: [{ stack: [`#${A}&block=x1`, A, B], index: 9 }] }] }, () => true)!;
  assert.deepEqual(tabOf(normal.frames[0]).stack, [A, B]);
  assert.equal(tabOf(normal.frames[0]).index, 1);
  assert.equal(normal.focused, 0);
});
