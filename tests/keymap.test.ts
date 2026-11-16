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
  shortcutLetter,
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
  // "KI fragen" (#59): ⌘⌥A / Ctrl+Alt+A, also while typing in the document;
  // on the Mac ⌥A types "å", the physical key counts.
  assert.equal(actionForEvent(key("a", { ctrlKey: true, altKey: true }), map, false, true), "ask");
  assert.equal(actionForEvent(key("å", { metaKey: true, altKey: true }, "KeyA"), map, true, true), "ask");
  assert.ok(needsModifier("?"));
  assert.ok(needsModifier("Shift+F2"));
  assert.ok(!needsModifier("Alt+F2"));
});

test("shortcuts are stored per person (shortcuts.save)", async () => {
  process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-keymap-"));
  const { run, id } = await import("../lib/db");
  const { createWorkspace } = await import("../lib/seed");
  const { command, bootstrap } = await import("../lib/api");
  const account = async (name: string) => {
    const uid = id();
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
    return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  };
  const me = await account("keys-me"),
    other = await account("keys-other");
  const mine = await createWorkspace(me.id, "Tasten"),
    theirs = await createWorkspace(other.id, "Andere");
  assert.deepEqual((await bootstrap(me, mine)).shortcuts, {});
  const saved = (await command(me, {
    action: "shortcuts.save",
    bindings: { search: ["mod+shift+k"], present: [], newPage: ["Mod+N"] },
  })) as { bindings: Record<string, string[]> };
  assert.deepEqual(saved.bindings, { search: ["Mod+Shift+K"], present: [] });
  assert.deepEqual((await bootstrap(me, mine)).shortcuts, { search: ["Mod+Shift+K"], present: [] });
  assert.deepEqual((await bootstrap(other, theirs)).shortcuts, {});
  await assert.rejects(async () => await command(me, { action: "shortcuts.save", bindings: { search: ["Mod+"] } }));
  await assert.rejects(async () => await command(me, { action: "shortcuts.save", bindings: { unknown: ["Mod+K"] } }));
  await assert.rejects(async () => await command(me, { action: "shortcuts.save", bindings: { search: ["Mod+A", "Mod+B", "Mod+C", "Mod+D"] } }));
  await command(me, { action: "shortcuts.save", bindings: {} });
  assert.deepEqual((await bootstrap(me, mine)).shortcuts, {});
});

test("shortcut letters: the Latin letter of the layout, else the physical key (#319)", () => {
  // Latin layouts: the letter as written, lower case.
  assert.equal(shortcutLetter(key("z", { ctrlKey: true })), "z");
  assert.equal(shortcutLetter(key("Z", { ctrlKey: true, shiftKey: true })), "z");
  // QWERTZ: Z and Y keep their labels, not their US places.
  assert.equal(shortcutLetter(key("z", { ctrlKey: true }, "KeyY")), "z");
  assert.equal(shortcutLetter(key("y", { ctrlKey: true }, "KeyZ")), "y");
  // AZERTY: A and Q swapped, the label counts.
  assert.equal(shortcutLetter(key("a", { ctrlKey: true }, "KeyQ")), "a");
  // Cyrillic and Greek: the physical key.
  assert.equal(shortcutLetter(key("я", { ctrlKey: true }, "KeyZ")), "z");
  assert.equal(shortcutLetter(key("в", { ctrlKey: true }, "KeyD")), "d");
  assert.equal(shortcutLetter(key("Я", { ctrlKey: true, shiftKey: true }, "KeyZ")), "z");
  assert.equal(shortcutLetter(key("м", {}, "KeyV")), "v");
  assert.equal(shortcutLetter(key("ζ", { metaKey: true }, "KeyZ")), "z");
  // ⌥ on the Mac writes another character: the physical key.
  assert.equal(shortcutLetter(key("∂", { metaKey: true, altKey: true }, "KeyD")), "d");
  // Digits, also where the layout writes a character without Shift (AZERTY).
  assert.equal(shortcutLetter(key("0", { ctrlKey: true })), "0");
  assert.equal(shortcutLetter(key("à", { ctrlKey: true }, "Digit0")), "0");
  // With Shift the character of a digit key counts ("/" is Shift+7 in German).
  assert.equal(shortcutLetter(key("/", { shiftKey: true }, "Digit7")), "/");
  assert.equal(shortcutLetter(key("!", { shiftKey: true }, "Digit1")), "!");
  // Other keys stay as they are.
  assert.equal(shortcutLetter(key("Enter", {}, "Enter")), "Enter");
  assert.equal(shortcutLetter(key(" ", {}, "Space")), " ");
  assert.equal(shortcutLetter(key("Escape", {}, "Escape")), "Escape");
  assert.equal(shortcutLetter(key("+", { ctrlKey: true }, "BracketRight")), "+");
  // Punctuation keys: a Cyrillic letter there is the US character, a Latin
  // one (German ü on the same key) is not.
  assert.equal(shortcutLetter(key("х", { ctrlKey: true }, "BracketLeft")), "[");
  assert.equal(shortcutLetter(key("ü", { ctrlKey: true }, "BracketLeft")), "ü");
  // AltGr typing a character, and input methods composing text: unchanged.
  const altGr = { ...key("€", { ctrlKey: true, altKey: true }, "KeyE"), getModifierState: (m: string) => m === "AltGraph" };
  assert.equal(shortcutLetter(altGr), "€");
  assert.equal(shortcutLetter(key("Process", {}, "KeyA")), "Process");
  assert.equal(shortcutLetter(key("ф", { isComposing: true }, "KeyA")), "ф");
});

test("keymap shortcuts, own ones too, work with a Cyrillic layout (#319)", () => {
  assert.ok(eventMatches(key("л", { ctrlKey: true }, "KeyK"), "Mod+K", false));
  assert.ok(eventMatches(key("ш", { ctrlKey: true, altKey: true }, "KeyI"), "Mod+Alt+I", false));
  assert.ok(eventMatches(key("х", { metaKey: true }, "BracketLeft"), "Mod+[", true));
  assert.ok(!eventMatches(key("ü", { ctrlKey: true }, "BracketLeft"), "Mod+[", false));
  assert.equal(comboFromEvent(key("з", { ctrlKey: true, shiftKey: true }, "KeyP"), false), "Mod+Shift+P");
  const own = resolveKeymap({ search: ["Mod+Shift+F"] });
  assert.ok(eventMatches(key("А", { ctrlKey: true, shiftKey: true }, "KeyF"), own.search[0], false));
});
