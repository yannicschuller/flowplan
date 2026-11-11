import { test } from "node:test";
import assert from "node:assert/strict";
import { keyTokens, shortcutMatches } from "../lib/shortcut-search";
import { formatCombo } from "../lib/keymap";

const taskRow = (mac: boolean) => ({
  labels: ["Aufgabe anlegen oder ihren Status wechseln", "Make a task or change its status"],
  keys: [formatCombo("Mod+L", mac)],
});
const strikeRow = (mac: boolean) => ({ labels: ["Durchstreichen", "Strikethrough"], keys: [formatCombo("Mod+Shift+S", mac)] });

test("key tokens: one written form for Ctrl/Cmd/⌘/Mod, Shift/⇧, Alt/Option/⌥ and any separator", () => {
  assert.deepEqual(keyTokens("Ctrl + Shift + L"), ["mod", "shift", "l"]);
  assert.deepEqual(keyTokens("⇧ ⌘ L"), ["shift", "mod", "l"]);
  assert.deepEqual(keyTokens("⇧⌘L"), ["shift", "mod", "l"]);
  assert.deepEqual(keyTokens("mod+shift+l"), ["mod", "shift", "l"]);
  assert.deepEqual(keyTokens("Strg-Alt-N"), ["mod", "alt", "n"]);
  assert.deepEqual(keyTokens("cmd, option, n"), ["mod", "alt", "n"]);
  assert.deepEqual(keyTokens("⌥ ⌘ ↵"), ["alt", "mod", "enter"]);
  assert.deepEqual(keyTokens("Ctrl + Alt + Enter"), ["mod", "alt", "enter"]);
  assert.deepEqual(keyTokens("⌘ +"), ["mod", "+"]);
  assert.deepEqual(keyTokens("Ctrl + +"), ["mod", "+"]);
  assert.deepEqual(keyTokens("Mod+Shift+ArrowUp"), ["mod", "shift", "up"]);
});

test("Ctrl/Cmd+L (#201) is found by every way of writing it, on both platforms", () => {
  for (const mac of [true, false])
    for (const query of ["ctrl l", "Ctrl+L", "⌘L", "⌘ L", "cmd+l", "mod+l", "Strg L", "control-l"])
      assert.ok(shortcutMatches(query, taskRow(mac)), `${query} (mac: ${mac})`);
});

test("keys must all be in one combination", () => {
  assert.equal(shortcutMatches("mod+shift+l", taskRow(false)), false);
  assert.ok(shortcutMatches("mod+shift+s", strikeRow(true)));
  assert.ok(shortcutMatches("shift", strikeRow(false)));
  assert.ok(shortcutMatches("⇧", strikeRow(false)));
  assert.equal(shortcutMatches("alt", strikeRow(true)), false);
  assert.equal(shortcutMatches("ctrl x", taskRow(true)), false);
});

test("names match by words in any language given, case and accents ignored", () => {
  assert.ok(shortcutMatches("aufgabe", taskRow(false)));
  assert.ok(shortcutMatches("TASK", taskRow(false)));
  assert.ok(shortcutMatches("status task", taskRow(false)));
  assert.ok(shortcutMatches("ubersicht", { labels: ["Diese Übersicht"], keys: [] }));
  assert.equal(shortcutMatches("journal", taskRow(false)), false);
});

test("an empty query matches everything, a row without keys only by name", () => {
  assert.ok(shortcutMatches("   ", taskRow(false)));
  assert.equal(shortcutMatches("ctrl", { labels: ["Helles oder dunkles Design"], keys: [] }), false);
  assert.ok(shortcutMatches("design", { labels: ["Helles oder dunkles Design"], keys: [] }));
});

test("own combinations: matched by the raw stored form too", () => {
  const own = { labels: ["Neue Seite", "eigene"], keys: [formatCombo("Mod+Alt+G", false), "Mod+Alt+G"] };
  assert.ok(shortcutMatches("ctrl alt g", own));
  assert.ok(shortcutMatches("⌘⌥G", own));
  assert.ok(shortcutMatches("eigene", own));
});
