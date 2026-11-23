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
  pin,
  pinnedCount,
  createGroup,
  joinGroup,
  leaveGroup,
  updateGroup,
  ungroup,
  closeGroup,
  moveGroup,
  groupTabs,
  tidy,
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
  // The browser's entry before holds another place: still a replace.
  assert.deepEqual(tabOf(follow(l, 0, D, "replace", B).frames[0]).stack, [A, B, D]);
  // An entry on top of the tab's place (the related record's overlay)
  // replaced by a new place: a new step, Back returns to the place below.
  const overlay = follow(l, 0, D, "replace", C);
  assert.deepEqual(tabOf(overlay.frames[0]).stack, [A, B, C, D]);
  assert.equal(activePlace(follow(overlay, 0, C, "back")), C);
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

test("pinned tabs (#444): lead their frame, new tabs and moves stay behind them", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = pin(l, 0, "c");
  assert.deepEqual(ids(l), ["c", "a", "b"]);
  assert.equal(l.frames[0].tabs[0].pinned, true);
  l = pin(l, 0, "b");
  // To the end of the pinned ones.
  assert.deepEqual(ids(l), ["c", "b", "a"]);
  assert.equal(pinnedCount(l.frames[0]), 2);
  assert.equal(pin(l, 0, "b"), l);
  // A new tab beside a pinned active one: after the pinned ones.
  l = activate(l, 0, "c");
  l = open(l, D, { id: "d" });
  assert.deepEqual(ids(l), ["c", "b", "d", "a"]);
  // Moving an unpinned tab to the front, or a pinned one to the end, keeps
  // the pinned ones first.
  l = move(l, 0, "a", 0, 0);
  assert.deepEqual(ids(l), ["c", "b", "a", "d"]);
  l = move(l, 0, "c", 0, 4);
  assert.deepEqual(ids(l), ["b", "c", "a", "d"]);
  l = moveBy(l, 0, "c", 1);
  assert.deepEqual(ids(l), ["b", "c", "a", "d"]);
  // Unpinned: the first place after the pinned ones.
  l = pin(l, 0, "b", false);
  assert.deepEqual(ids(l), ["c", "b", "a", "d"]);
  assert.equal(l.frames[0].tabs[1].pinned, undefined);
  // Into the other frame: pinned stays pinned, at the front there.
  l = open(l, A, { frame: 1, id: "r", reuse: false });
  l = move(l, 0, "c", 1, 5);
  assert.deepEqual(ids(l, 1), ["c", "r"]);
});

test("close other tabs keeps the pinned ones", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = open(l, D, { id: "d" });
  l = pin(l, 0, "b");
  l = closeOthers(l, 0, "d");
  assert.deepEqual(ids(l), ["b", "d"]);
  assert.equal(l.frames[0].active, "d");
  // A pinned tab closes when asked to directly (its menu).
  l = close(l, 0, "b");
  assert.deepEqual(ids(l), ["d"]);
});

test("pins are kept and read back; layouts from before (no pins) still load", () => {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = pin(l, 0, "c");
  const stored = JSON.parse(JSON.stringify(serialize(l)));
  assert.deepEqual(stored.frames[0].tabs.map((t: { pinned?: boolean }) => t.pinned ?? false), [true, false, false]);
  assert.equal("pinned" in stored.frames[0].tabs[1], false);
  const back = restore(stored, () => true)!;
  assert.deepEqual(places(back), [C, A, B]);
  assert.deepEqual(back.frames[0].tabs.map((t) => !!t.pinned), [true, false, false]);
  assert.equal(placeOf(tabOf(back.frames[0])), C);
  // Old layout: no pins at all.
  const old = restore({ v: 1, focused: 0, frames: [{ active: 1, tabs: [{ stack: [A], index: 0 }, { stack: [B], index: 0 }] }] }, () => true)!;
  assert.deepEqual(places(old), [A, B]);
  assert.equal(old.frames[0].tabs.some((t) => "pinned" in t), false);
  assert.equal(placeOf(tabOf(old.frames[0])), B);
  // A pin stored out of order (edited by hand) leads again; junk is no pin.
  const odd = restore({ v: 1, focused: 0, frames: [{ active: 0, tabs: [{ stack: [A], index: 0 }, { stack: [B], index: 0, pinned: true }, { stack: [C], index: 0, pinned: "yes" }] }] }, () => true)!;
  assert.deepEqual(places(odd), [B, A, C]);
  assert.deepEqual(odd.frames[0].tabs.map((t) => !!t.pinned), [true, false, false]);
  assert.equal(placeOf(tabOf(odd.frames[0])), A);
});

// Tab groups (#444).
const groupIds = (l: Layout, frame = 0) => l.frames[frame].tabs.map((t) => t.group ?? "-");
function five() {
  let l = singleLayout(A, "a");
  l = open(l, B, { id: "b" });
  l = open(l, C, { id: "c" });
  l = open(l, D, { id: "d" });
  l = open(l, `${A}&row=00000000-0000-4000-8000-0000000000e1`, { id: "e" });
  return l;
}

test("groups: create, join at the end, leave after the group, new tabs join the active tab's group", () => {
  let l = five();
  l = createGroup(l, 0, "b", { id: "g", name: "  Recherche  " });
  assert.deepEqual(l.frames[0].groups, [{ id: "g", name: "Recherche", color: "blue" }]);
  l = joinGroup(l, 0, "e", "g");
  assert.deepEqual(ids(l), ["a", "b", "e", "c", "d"]);
  assert.deepEqual(groupIds(l), ["-", "g", "g", "-", "-"]);
  // A second group takes the next colour.
  l = createGroup(l, 0, "d", { id: "h", name: "" });
  assert.equal(l.frames[0].groups![1].color, "green");
  assert.equal(l.frames[0].groups![1].name, "…");
  // Leaving: right after the group.
  l = leaveGroup(l, 0, "b");
  assert.deepEqual(ids(l), ["a", "e", "b", "c", "d"]);
  assert.deepEqual(groupIds(l), ["-", "g", "-", "-", "h"]);
  // A tab opened from a grouped tab joins that group, beside it.
  l = activate(l, 0, "e");
  l = open(l, B + "&x", { id: "n" });
  assert.deepEqual(ids(l), ["a", "e", "n", "b", "c", "d"]);
  assert.deepEqual(groupIds(l), ["-", "g", "g", "-", "-", "h"]);
  // The last tab out: the group goes.
  l = leaveGroup(l, 0, "d");
  assert.deepEqual(l.frames[0].groups!.map((g) => g.id), ["g"]);
  // Pinned tabs are in no group; pinning takes a tab out of its group.
  const withPin = pin(l, 0, "a");
  assert.equal(createGroup(withPin, 0, "a", { name: "x" }), withPin);
  l = pin(l, 0, "n");
  assert.deepEqual(ids(l), ["n", "a", "e", "b", "c", "d"]);
  assert.deepEqual(groupIds(l), ["-", "-", "g", "-", "-", "-"]);
});

test("groups: collapse never hides the active tab, expand on switching into it, cycling skips it", () => {
  let l = five();
  l = createGroup(l, 0, "b", { id: "g", name: "G" });
  l = joinGroup(l, 0, "c", "g");
  l = activate(l, 0, "c");
  // Collapsing the active tab's group: the next tab after the group is shown.
  l = updateGroup(l, 0, "g", { collapsed: true });
  assert.equal(l.frames[0].groups![0].collapsed, true);
  assert.equal(l.frames[0].active, "d");
  // Ctrl+Tab passes it by.
  l = cycle(l, 0, -1);
  assert.equal(l.frames[0].active, "a");
  l = cycle(l, 0, -1);
  assert.equal(l.frames[0].active, "e");
  // Switching into it opens it.
  l = activate(l, 0, "b");
  assert.equal(l.frames[0].groups![0].collapsed, undefined);
  // A frame of that group alone does not collapse.
  let only = singleLayout(A, "x");
  only = open(only, B, { id: "y" });
  only = createGroup(only, 0, "x", { id: "g", name: "G" });
  only = joinGroup(only, 0, "y", "g");
  assert.equal(updateGroup(only, 0, "g", { collapsed: true }), only);
  // Rename (blank keeps the name) and colour.
  l = updateGroup(l, 0, "g", { name: "  Neu  ", color: "teal" });
  assert.deepEqual(l.frames[0].groups![0], { id: "g", name: "Neu", color: "teal" });
  assert.equal(updateGroup(l, 0, "g", { name: "   " }).frames[0].groups![0].name, "Neu");
});

test("groups: ungroup, close group, move the group as a whole", () => {
  let l = five();
  l = createGroup(l, 0, "b", { id: "g", name: "G" });
  l = joinGroup(l, 0, "c", "g");
  // Moving the group: past single tabs, not past the pinned ones.
  l = moveGroup(l, 0, "g", 1);
  assert.deepEqual(ids(l), ["a", "d", "b", "c", "e"]);
  l = pin(l, 0, "a");
  l = moveGroup(l, 0, "g", -1);
  assert.deepEqual(ids(l), ["a", "b", "c", "d", "e"]);
  assert.equal(moveGroup(l, 0, "g", -1), l);
  // Past another group as a whole.
  l = createGroup(l, 0, "d", { id: "h", name: "H" });
  l = joinGroup(l, 0, "e", "h");
  l = moveGroup(l, 0, "g", 1);
  assert.deepEqual(ids(l), ["a", "d", "e", "b", "c"]);
  // Ungroup keeps the tabs.
  const loose = ungroup(l, 0, "h");
  assert.deepEqual(ids(loose), ["a", "d", "e", "b", "c"]);
  assert.deepEqual(loose.frames[0].groups!.map((g) => g.id), ["g"]);
  // Close group: its tabs go, the tab after it (else before) is active.
  l = activate(l, 0, "b");
  l = closeGroup(l, 0, "g");
  assert.deepEqual(ids(l), ["a", "d", "e"]);
  assert.equal(l.frames[0].active, "e");
  // Closing the only tabs of the only frame leaves the start page.
  l = closeGroup(closeOthers(l, 0, "e"), 0, "h");
  assert.deepEqual(places(l), [A]);
  assert.equal(pinnedCount(l.frames[0]), 1);
  let all = singleLayout(A, "x");
  all = createGroup(all, 0, "x", { id: "g", name: "G" });
  assert.deepEqual(places(closeGroup(all, 0, "g")), ["home"]);
});

test("groups: moving tabs keeps a group's tabs together; into the other frame without the group", () => {
  let l = five();
  l = createGroup(l, 0, "b", { id: "g", name: "G" });
  l = joinGroup(l, 0, "c", "g");
  // Dropped between two tabs of the group: in it.
  l = move(l, 0, "e", 0, 2);
  assert.deepEqual(ids(l), ["a", "b", "e", "c", "d"]);
  assert.deepEqual(groupTabs(l.frames[0], "g").map((t) => t.id), ["b", "e", "c"]);
  // Out of its run: out of the group.
  l = move(l, 0, "b", 0, 5);
  assert.deepEqual(ids(l), ["a", "e", "c", "d", "b"]);
  assert.deepEqual(groupIds(l), ["-", "g", "g", "-", "-"]);
  // Beside its group (at its edge): stays in.
  l = moveBy(l, 0, "e", 1);
  assert.deepEqual(ids(l), ["a", "c", "e", "d", "b"]);
  assert.deepEqual(groupIds(l), ["-", "g", "g", "-", "-"]);
  // Keyboard right once more: out.
  l = moveBy(l, 0, "e", 1);
  assert.deepEqual(groupIds(l), ["-", "g", "-", "-", "-"]);
  // Into the other frame: without the group.
  l = move(l, 0, "c", 1, 0);
  assert.equal(l.frames[1].tabs[0].group, undefined);
  assert.equal(l.frames[0].groups, undefined);
  // tidy() puts scattered tabs of a group together, where its first stands.
  const scattered = tidy({ tabs: [{ id: "1", stack: [A], index: 0, group: "g" }, { id: "2", stack: [B], index: 0 }, { id: "3", stack: [C], index: 0, group: "g" }, { id: "4", stack: [D], index: 0, group: "zz" }], active: "2", groups: [{ id: "g", name: "G", color: "red" }] });
  assert.deepEqual(scattered.tabs.map((t) => [t.id, t.group ?? "-"]), [["1", "g"], ["3", "g"], ["2", "-"], ["4", "-"]]);
});

test("groups are kept and read back; older layouts and junk load", () => {
  let l = five();
  l = pin(l, 0, "a");
  l = createGroup(l, 0, "c", { id: "g", name: "Recherche", color: "purple" });
  l = joinGroup(l, 0, "d", "g");
  l = activate(l, 0, "e");
  l = updateGroup(l, 0, "g", { collapsed: true });
  const stored = JSON.parse(JSON.stringify(serialize(l)));
  assert.deepEqual(stored.frames[0].groups, [{ name: "Recherche", color: "purple", collapsed: true }]);
  assert.deepEqual(stored.frames[0].tabs.map((t: { group?: number }) => t.group ?? -1), [-1, -1, 0, 0, -1]);
  const back = restore(stored, () => true)!;
  assert.deepEqual(places(back), places(l));
  const g = back.frames[0].groups![0];
  assert.deepEqual([g.name, g.color, g.collapsed], ["Recherche", "purple", true]);
  assert.deepEqual(back.frames[0].tabs.map((t) => (t.group ? "g" : "-")), ["-", "-", "g", "g", "-"]);
  assert.equal(back.frames[0].tabs[0].pinned, true);
  // Without groups (older layouts): none; a layout with groups but its
  // pages gone: the group goes as well.
  const plain = restore({ v: 1, focused: 0, frames: [{ active: 0, tabs: [{ stack: [A], index: 0 }] }] }, () => true)!;
  assert.equal(plain.frames[0].groups, undefined);
  const gone = restore(stored, (p) => p !== C && p !== D)!;
  assert.equal(gone.frames[0].groups, undefined);
  // Junk: unknown colour grey, overlong name cut, index out of range no group,
  // a pinned tab's group dropped, the active tab's group not collapsed.
  const odd = restore(
    {
      v: 1,
      focused: 0,
      frames: [
        {
          active: 1,
          groups: [{ name: "x".repeat(200), color: "magenta", collapsed: true }, null],
          tabs: [{ stack: [A], index: 0, group: 0, pinned: true }, { stack: [B], index: 0, group: 0 }, { stack: [C], index: 0, group: 7 }, { stack: [D], index: 0, group: "0" }],
        },
      ],
    },
    () => true,
  )!;
  const og = odd.frames[0].groups!;
  assert.equal(og.length, 1);
  assert.deepEqual([og[0].name.length, og[0].color, og[0].collapsed], [60, "gray", undefined]);
  assert.deepEqual(odd.frames[0].tabs.map((t) => [!!t.pinned, t.group ? "g" : "-"]), [[true, "-"], [false, "g"], [false, "-"], [false, "-"]]);
});
