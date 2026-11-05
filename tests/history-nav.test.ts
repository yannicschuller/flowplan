// Back and forward (#125, lib/history-nav.ts): which addresses are places,
// the lists before and after the current entry, the tab's trail without the
// Navigation API, and the shortcuts (⌘[ / Alt+←) that stay out of typing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { follow, LIST_SIZE, stepOf, stepsAround, trailEntries, type EntryLike } from "../lib/history-nav";
import { actionForEvent, DEFAULT_KEYMAP, preferredCombo, conflictsOf, type KeyLike } from "../lib/keymap";
import { appKeyCommands } from "../lib/app-shortcuts";

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  C = "33333333-3333-4333-8333-333333333333",
  R = "44444444-4444-4444-8444-444444444444",
  T = "55555555-5555-4555-8555-555555555555";
const at = (hash: string, path = "/") => `https://flowplan.example${path}${hash ? `#${hash}` : ""}`;
const entries = (...urls: string[]): EntryLike[] => urls.map((url, index) => ({ key: `k${index}`, url, index }));

test("places: pages with their record, screens, settings sections – not quick actions", () => {
  assert.equal(stepOf(""), "home");
  assert.equal(stepOf("#home"), "home");
  assert.equal(stepOf(`#page=${A}`), `page=${A}`);
  assert.equal(stepOf(`page=${A}&row=${R}`), `page=${A}&row=${R}`);
  // Threads, blocks and whiteboard elements are parts of the page.
  assert.equal(stepOf(`page=${A}&thread=${T}`), `page=${A}`);
  assert.equal(stepOf(`page=${A}&block=abc`), `page=${A}`);
  assert.equal(stepOf("settings/account"), "settings/account");
  // A view inside a section (a webhook, a setting the search jumps to).
  assert.equal(stepOf("settings/account/passkeys"), "settings/account/passkeys");
  assert.equal(stepOf("admin"), "admin");
  assert.equal(stepOf(`collection/${B}`), `collection/${B}`);
  assert.equal(stepOf(`tags/${B}`), `tags/${B}`);
  for (const screen of ["inbox", "tasks", "tags", "graph", "media", "trash"]) assert.equal(stepOf(screen), screen);
  for (const none of ["search", "new", "capture", "page=nope", `workspace=${A}`, "main-content"]) assert.equal(stepOf(none), null, none);
});

test("the places before and after, the nearest first", () => {
  const list = entries(at(`page=${A}`), at(`page=${B}`), at(`page=${C}`), at("inbox"));
  assert.deepEqual(stepsAround(list, 2, "/"), {
    current: `page=${C}`,
    back: [
      { key: "k1", hash: `page=${B}`, delta: -1 },
      { key: "k0", hash: `page=${A}`, delta: -2 },
    ],
    forward: [{ key: "k3", hash: "inbox", delta: 1 }],
  });
  // At the start and at the end: nothing in that direction.
  assert.deepEqual(stepsAround(list, 0, "/").back, []);
  assert.deepEqual(stepsAround(list, 3, "/").forward, []);
});

test("what is no place is skipped; the same place in a row counts once", () => {
  const list = entries(at(`page=${A}`), at("search"), at(`page=${B}`), at(`page=${B}&thread=${T}`), at(`page=${C}`), at(`page=${C}`));
  const { back } = stepsAround(list, 5, "/");
  assert.deepEqual(
    back.map((s) => [s.hash, s.delta]),
    [
      [`page=${B}`, -2],
      [`page=${A}`, -5],
    ],
  );
  // A record is a step of its own: back from the record is its database.
  const records = entries(at(`page=${A}`), at(`page=${A}&row=${R}`));
  assert.deepEqual(stepsAround(records, 1, "/").back.map((s) => s.hash), [`page=${A}`]);
});

test("other addresses end the lists (sign-in, public pages)", () => {
  const list = entries(at(`page=${A}`), at("", "/login"), at(`page=${B}`), at(`page=${C}`), at("", "/share/x"), at("inbox"));
  const { back, forward } = stepsAround(list, 3, "/");
  assert.deepEqual(back.map((s) => s.hash), [`page=${B}`]);
  assert.deepEqual(forward, []);
  // On another address nothing counts.
  assert.equal(stepsAround(list, 1, "/").current, null);
});

test("at most LIST_SIZE places in a list", () => {
  const many = entries(...Array.from({ length: 30 }, (_, i) => at(i % 2 ? "inbox" : `page=${A}`)));
  assert.equal(stepsAround(many, 29, "/").back.length, LIST_SIZE);
  assert.equal(stepsAround(many, 29, "/", 3).back.length, 3);
});

test("the trail follows new entries, back, forward and jumps", () => {
  const a = `/#page=${A}`,
    b = `/#page=${B}`,
    c = `/#page=${C}`;
  let trail = follow(null, a);
  assert.deepEqual(trail, { entries: [a], index: 0 });
  trail = follow(trail, b);
  trail = follow(trail, c);
  assert.deepEqual(trail, { entries: [a, b, c], index: 2 });
  // Back (the entry before), forward (the entry after).
  trail = follow(trail, b);
  assert.equal(trail.index, 1);
  trail = follow(trail, c);
  assert.equal(trail.index, 2);
  // A jump the page started goes where it said, even past equal addresses.
  trail = follow({ ...trail, expect: 0 }, a);
  assert.equal(trail.index, 0);
  // A new place in the middle drops what was ahead.
  trail = follow(trail, "/#inbox");
  assert.deepEqual(trail, { entries: [a, "/#inbox"], index: 1 });
  // In place: the entry changes, the index stays.
  trail = follow({ ...trail, expect: "replace" }, "/#tasks");
  assert.deepEqual(trail, { entries: [a, "/#tasks"], index: 1 });
  // The same address again (hashchange and popstate both report it) is no step.
  assert.deepEqual(follow(trail, "/#tasks"), trail);
  // Its entries make the same lists.
  assert.deepEqual(stepsAround(trailEntries(trail), trail.index, "/").back.map((s) => [s.hash, s.delta, s.key]), [[`page=${A}`, -1, "trail:0"]]);
});

test("the trail keeps the last addresses only", () => {
  let trail = follow(null, "/#home");
  for (let i = 0; i < 20; i++) trail = follow(trail, `/#page=${i % 2 ? A : B}&n=${i}`, 8);
  assert.equal(trail.entries.length, 8);
  assert.equal(trail.index, 7);
});

const key = (k: string, mods: Partial<KeyLike> = {}, code = ""): KeyLike => ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("⌘[ / ⌘] and Alt+← / Alt+→ – the arrows not while typing", () => {
  assert.equal(actionForEvent(key("[", { metaKey: true }, "BracketLeft"), DEFAULT_KEYMAP, true, false), "back");
  assert.equal(actionForEvent(key("]", { metaKey: true }, "BracketRight"), DEFAULT_KEYMAP, true, false), "forward");
  assert.equal(actionForEvent(key("[", { ctrlKey: true }, "BracketLeft"), DEFAULT_KEYMAP, false, false), "back");
  assert.equal(actionForEvent(key("ArrowLeft", { altKey: true }), DEFAULT_KEYMAP, false, false), "back");
  assert.equal(actionForEvent(key("ArrowRight", { altKey: true }), DEFAULT_KEYMAP, true, false), "forward");
  // Writing: Alt+← moves a word back; ⌘[ does not edit and still counts.
  assert.equal(actionForEvent(key("ArrowLeft", { altKey: true }), DEFAULT_KEYMAP, false, true), null);
  assert.equal(actionForEvent(key("ArrowRight", { altKey: true }), DEFAULT_KEYMAP, true, true), null);
  assert.equal(actionForEvent(key("[", { metaKey: true }, "BracketLeft"), DEFAULT_KEYMAP, true, true), "back");
  // No conflicts with the other defaults, the editor or the browser.
  assert.deepEqual(conflictsOf(DEFAULT_KEYMAP, "back", true), []);
  assert.deepEqual(conflictsOf(DEFAULT_KEYMAP, "forward", false), []);
});

test("the tooltip shows the system's own combination", () => {
  assert.equal(preferredCombo("back", true, DEFAULT_KEYMAP), "⌘ [");
  assert.equal(preferredCombo("forward", true, DEFAULT_KEYMAP), "⌘ ]");
  assert.equal(preferredCombo("back", false, DEFAULT_KEYMAP), "Alt + ←");
  assert.equal(preferredCombo("forward", false, DEFAULT_KEYMAP), "Alt + →");
  // Own combinations: the first one when none is the system's kind.
  assert.equal(preferredCombo("back", false, { ...DEFAULT_KEYMAP, back: ["Mod+Alt+B"] }), "Ctrl + Alt + B");
});

test("the iPad's key commands take ⌘[ but leave ⌥← to the text", () => {
  const commands = appKeyCommands(DEFAULT_KEYMAP, (a) => a, true).filter((c) => c.action === "back" || c.action === "forward");
  assert.deepEqual(
    commands.map((c) => [c.action, c.input, c.modifiers]),
    [
      ["back", "[", ["command"]],
      ["forward", "]", ["command"]],
    ],
  );
});
