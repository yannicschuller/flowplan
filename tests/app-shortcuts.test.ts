import { test } from "node:test";
import assert from "node:assert/strict";
import { appKeyCommands, pressGuard } from "../lib/app-shortcuts";
import { DEFAULT_KEYMAP, resolveKeymap } from "../lib/keymap";

const title = (action: string) => `T:${action}`;

test("the global shortcuts become the app's key commands, with ⌘ on the iPad", () => {
  const commands = appKeyCommands(DEFAULT_KEYMAP, title);
  assert.deepEqual(commands.find((c) => c.action === "search"), { action: "search", title: "T:search", input: "k", modifiers: ["command"] });
  assert.deepEqual(commands.find((c) => c.action === "capture"), { action: "capture", title: "T:capture", input: "n", modifiers: ["alternate", "command"] });
  // "?" stays with the page (typing), ⌘/ is the key command of the overview.
  assert.deepEqual(commands.filter((c) => c.action === "shortcuts"), [{ action: "shortcuts", title: "T:shortcuts", input: "/", modifiers: ["command"] }]);
  // Actions without a combination have no key command.
  assert.equal(commands.some((c) => c.action === "theme"), false);
  assert.ok(commands.every((c) => c.modifiers.some((m) => m !== "shift")));
  // Off the Mac "Mod" is Ctrl (the Android app with a keyboard).
  assert.deepEqual(appKeyCommands(DEFAULT_KEYMAP, title, false).find((c) => c.action === "search")?.modifiers, ["control"]);
});

test("own combinations count; further ones of an action work but are listed once", () => {
  const map = resolveKeymap({ search: ["Mod+K", "Mod+Shift+F", "Ctrl+ArrowUp"], present: ["Mod+F5"], theme: ["Alt+T"], sidebar: ["Shift+B"], newPage: [] });
  const commands = appKeyCommands(map, title);
  assert.deepEqual(
    commands.filter((c) => c.action === "search"),
    [
      { action: "search", title: "T:search", input: "k", modifiers: ["command"] },
      { action: "search", title: "T:search", input: "f", modifiers: ["command", "shift"], hidden: true },
      { action: "search", title: "T:search", input: "up", modifiers: ["control"], hidden: true },
    ],
  );
  assert.deepEqual(commands.find((c) => c.action === "present"), { action: "present", title: "T:present", input: "f5", modifiers: ["command"] });
  assert.deepEqual(commands.find((c) => c.action === "theme"), { action: "theme", title: "T:theme", input: "t", modifiers: ["alternate"] });
  // Shift alone is typing; a removed shortcut is gone.
  assert.equal(commands.some((c) => c.action === "sidebar" || c.action === "newPage"), false);
});

test("an action reported by the key event and by the app runs once", () => {
  let now = 1000;
  const first = pressGuard(() => now);
  assert.equal(first("search"), true);
  now += 20;
  assert.equal(first("search"), false, "the same press, the second report");
  assert.equal(first("capture"), true, "another action");
  now += 1000;
  assert.equal(first("capture"), true, "a new press");
});
