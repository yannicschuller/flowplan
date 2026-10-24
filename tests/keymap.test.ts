import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import {
  actionForEvent,
  actionsUsing,
  allConflicts,
  cleanOverrides,
  comboFromEvent,
  conflictsOf,
  DEFAULT_KEYMAP,
  eventMatches,
  formatCombo,
  needsModifier,
  normalizeCombo,
  parseCombo,
  platformCombo,
  resolveKeymap,
  type KeyLike,
} from "../lib/keymap";

const key = (k: string, mods: Partial<KeyLike> = {}, code?: string): KeyLike => ({
  key: k,
  code: code ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : ""),
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("combinations are parsed into one written form", () => {
  assert.equal(normalizeCombo("mod+k"), "Mod+K");
  assert.equal(normalizeCombo("Shift + Alt + Mod + n"), "Mod+Alt+Shift+N");
  assert.equal(normalizeCombo("ctrl+option+esc"), "Ctrl+Alt+Escape");
  // ⌘ / Cmd is the platform modifier: stored as Mod, so it is Ctrl on a PC.
  assert.equal(normalizeCombo("cmd+space"), "Mod+Space");
  assert.equal(normalizeCombo("⌘+⌥+N"), "Mod+Alt+N");
  assert.equal(normalizeCombo("Win+K"), "Meta+K");
  assert.equal(normalizeCombo("⌃+K"), "Ctrl+K");
  assert.equal(normalizeCombo("Mod+Plus"), "Mod+Plus");
  assert.equal(normalizeCombo("f2"), "F2");
  // A character typed with Shift carries it already.
  assert.equal(normalizeCombo("Shift+?"), "?");
  assert.deepEqual(parseCombo("Mod+/"), { mod: true, ctrl: false, meta: false, alt: false, shift: false, key: "/" });
  for (const bad of ["", "Mod", "Mod+", "Mod+Shift", "K+Mod", "Mod+Mod+K", "Mod+KK", "Hyper+K", "x".repeat(50)])
    assert.equal(normalizeCombo(bad), null, bad);
});

test("Mod is ⌘ on the Mac and Ctrl elsewhere", () => {
  assert.equal(platformCombo("Mod+K", true), "Meta+K");
  assert.equal(platformCombo("Mod+K", false), "Ctrl+K");
  assert.ok(eventMatches(key("k", { metaKey: true }), "Mod+K", true));
  assert.ok(!eventMatches(key("k", { ctrlKey: true }), "Mod+K", true));
  assert.ok(eventMatches(key("k", { ctrlKey: true }), "Mod+K", false));
  assert.ok(!eventMatches(key("k", { metaKey: true }), "Mod+K", false));
  // Explicit Ctrl on the Mac stays Ctrl.
  assert.ok(eventMatches(key("k", { ctrlKey: true }), "Ctrl+K", true));
  assert.equal(formatCombo("Mod+Alt+N", true), "⌥ ⌘ N");
  assert.equal(formatCombo("Mod+Alt+N", false), "Ctrl + Alt + N");
  assert.equal(formatCombo("Mod+Shift+ArrowUp", false), "Ctrl + Shift + ↑");
});

test("events match exactly, with the physical key under Alt", () => {
  assert.ok(eventMatches(key("K", { ctrlKey: true, shiftKey: true }), "Mod+Shift+K", false));
  assert.ok(!eventMatches(key("K", { ctrlKey: true, shiftKey: true }), "Mod+K", false));
  assert.ok(!eventMatches(key("k", { ctrlKey: true, altKey: true }), "Mod+K", false));
  // ⌥N on the Mac types "˜": the key itself decides.
  assert.ok(eventMatches(key("˜", { metaKey: true, altKey: true }, "KeyN"), "Mod+Alt+N", true));
  assert.ok(eventMatches(key("Dead", { metaKey: true, altKey: true }, "KeyE"), "Mod+Alt+E", true));
  // AltGr+E types "€" on Windows: not a shortcut.
  const euro = { ...key("€", { ctrlKey: true, altKey: true }, "KeyE"), getModifierState: (m: string) => m === "AltGraph" };
  assert.ok(!eventMatches(euro, "Mod+Alt+E", false));
  // German keyboards: the letter typed counts, not its place (Z and Y swapped).
  assert.ok(eventMatches(key("z", { ctrlKey: true }, "KeyY"), "Mod+Z", false));
  assert.ok(!eventMatches(key("y", { ctrlKey: true }, "KeyZ"), "Mod+Z", false));
  // "?" with or without Shift, "/" as Shift+7.
  assert.ok(eventMatches(key("?", { shiftKey: true }, "Slash"), "?", false));
  assert.ok(eventMatches(key("/", { ctrlKey: true, shiftKey: true }, "Digit7"), "Mod+/", false));
  assert.ok(eventMatches(key(" ", {}, "Space"), "Space", false));
});

test("recording turns an event into a combination", () => {
  assert.equal(comboFromEvent(key("p", { metaKey: true, altKey: true }), true), "Mod+Alt+P");
  assert.equal(comboFromEvent(key("π", { metaKey: true, altKey: true }, "KeyP"), true), "Mod+Alt+P");
  assert.equal(comboFromEvent(key("p", { ctrlKey: true, altKey: true }), false), "Mod+Alt+P");
  assert.equal(comboFromEvent(key("p", { ctrlKey: true }), true), "Ctrl+P");
  assert.equal(comboFromEvent(key("?", { shiftKey: true }, "Slash"), false), "?");
  assert.equal(comboFromEvent(key("Shift", { shiftKey: true }, "ShiftLeft"), false), null);
  assert.equal(comboFromEvent(key("Control", { ctrlKey: true }, "ControlLeft"), false), null);
  assert.equal(comboFromEvent(key("ArrowRight", { altKey: true }, "ArrowRight"), false), "Alt+ArrowRight");
});

test("own shortcuts replace defaults; overrides are cleaned", () => {
  const map = resolveKeymap({ search: ["mod+shift+p"], theme: ["Mod+Alt+T"], present: [] });
  assert.deepEqual(map.search, ["Mod+Shift+P"]);
  assert.deepEqual(map.theme, ["Mod+Alt+T"]);
  assert.deepEqual(map.present, []);
  assert.deepEqual(map.newPage, DEFAULT_KEYMAP.newPage);
  assert.deepEqual(
    cleanOverrides({ search: ["Mod+K"], newPage: ["mod+shift+n", "Mod+Shift+N", "nonsense+"], bogus: ["Mod+X"], capture: "Mod+X" }),
    { newPage: ["Mod+Shift+N"] },
  );
  assert.deepEqual(cleanOverrides(null), {});
  assert.deepEqual(cleanOverrides(["Mod+K"]), {});
});

test("conflicts with other actions, the editor and the browser", () => {
  const map = resolveKeymap({ newPage: ["Ctrl+K"], theme: ["Mod+B"], present: ["Mod+W"] });
  // Off the Mac Ctrl+K is the same as Mod+K (search).
  assert.deepEqual(conflictsOf(map, "newPage", false), [{ combo: "Ctrl+K", kind: "action", with: "search" }]);
  assert.deepEqual(conflictsOf(map, "newPage", true), []);
  assert.deepEqual(actionsUsing(map, "Mod+K", false), ["search", "newPage"]);
  assert.deepEqual(actionsUsing(map, "Mod+K", false, "search"), ["newPage"]);
  assert.deepEqual(conflictsOf(map, "theme", false), [{ combo: "Mod+B", kind: "editor", with: "bold" }]);
  assert.deepEqual(conflictsOf(map, "present", false), [{ combo: "Mod+W", kind: "browser" }]);
  const all = allConflicts(map, false);
  assert.deepEqual(Object.keys(all).sort(), ["newPage", "present", "search", "theme"]);
  // The defaults collide with nothing.
  assert.deepEqual(allConflicts(DEFAULT_KEYMAP, false), {});
  assert.deepEqual(allConflicts(DEFAULT_KEYMAP, true), {});
});

test("the action of an event; bare keys only outside of text", () => {
  const map = resolveKeymap({ splitView: ["Mod+Alt+\\"] });
  assert.equal(actionForEvent(key("k", { ctrlKey: true }), map, false, true), "search");
  assert.equal(actionForEvent(key("?", { shiftKey: true }, "Slash"), map, false, false), "shortcuts");
  assert.equal(actionForEvent(key("?", { shiftKey: true }, "Slash"), map, false, true), null);
  assert.equal(actionForEvent(key("/", { metaKey: true }, "Slash"), map, true, true), "shortcuts");
  assert.equal(actionForEvent(key("n", { ctrlKey: true, altKey: true }), map, false, false), "capture");
  assert.equal(actionForEvent(key("n", { ctrlKey: true }), map, false, false), "newPage");
  assert.equal(actionForEvent(key("\\", { ctrlKey: true, altKey: true }, "Backslash"), map, false, false), "splitView");
  assert.equal(actionForEvent(key("x", { ctrlKey: true }), map, false, false), null);
  assert.ok(needsModifier("?"));
  assert.ok(needsModifier("Shift+F2"));
  assert.ok(!needsModifier("Alt+F2"));
});

test("shortcuts are stored per person (shortcuts.save)", async () => {
  process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-keymap-"));
  const { run, id } = await import("../lib/db");
  const { createWorkspace } = await import("../lib/seed");
  const { command, bootstrap } = await import("../lib/api");
  const account = (name: string) => {
    const uid = id();
    run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
    return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  };
  const me = account("keys-me"),
    other = account("keys-other");
  const mine = createWorkspace(me.id, "Tasten"),
    theirs = createWorkspace(other.id, "Andere");
  assert.deepEqual(bootstrap(me, mine).shortcuts, {});
  const saved = command(me, {
    action: "shortcuts.save",
    bindings: { search: ["mod+shift+k"], present: [], newPage: ["Mod+N"] },
  }) as { bindings: Record<string, string[]> };
  assert.deepEqual(saved.bindings, { search: ["Mod+Shift+K"], present: [] });
  assert.deepEqual(bootstrap(me, mine).shortcuts, { search: ["Mod+Shift+K"], present: [] });
  assert.deepEqual(bootstrap(other, theirs).shortcuts, {});
  assert.throws(() => command(me, { action: "shortcuts.save", bindings: { search: ["Mod+"] } }));
  assert.throws(() => command(me, { action: "shortcuts.save", bindings: { unknown: ["Mod+K"] } }));
  assert.throws(() => command(me, { action: "shortcuts.save", bindings: { search: ["Mod+A", "Mod+B", "Mod+C", "Mod+D"] } }));
  command(me, { action: "shortcuts.save", bindings: {} });
  assert.deepEqual(bootstrap(me, mine).shortcuts, {});
});
