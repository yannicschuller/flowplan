// "Menü bei Textauswahl" (#200, lib/text-menu-pref.ts, lib/user-text-menu.ts):
// whether selecting text shows the text menu, by the person's choice and the
// input the selection was made with; the choice is saved per person on the
// server, validated, and comes with the bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-text-menu-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/text-menu-pref")), ...(await import("../lib/text-menu-pref-client")) };

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>, status: number) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === status || (status === 400 && (e as Error).name === "ZodError"));

// ---- The decision ----

test("selecting shows the menu: always for every input, never for none, by default only for mouse and keyboard", () => {
  const expected: Record<string, Record<string, boolean>> = {
    always: { mouse: true, keyboard: true, touch: true, pen: true },
    computer: { mouse: true, keyboard: true, touch: false, pen: false },
    never: { mouse: false, keyboard: false, touch: false, pen: false },
  };
  for (const setting of pref.TEXT_MENU_PREFS)
    for (const input of ["mouse", "keyboard", "touch", "pen"] as const)
      assert.equal(pref.showsMenuOnSelection(setting, input), expected[setting][input], `${setting} × ${input}`);
  assert.equal(pref.DEFAULT_TEXT_MENU_PREF, "computer");
});

test("the input of a selection follows the pointer that pressed; without one a coarse pointer counts as touch", () => {
  // An iPad with a trackpad: coarse device, but the trackpad reports "mouse".
  assert.equal(pref.pointerInput("mouse", true), "mouse");
  assert.equal(pref.pointerInput("touch", true), "touch");
  // A touch screen on a laptop: the finger counts as touch.
  assert.equal(pref.pointerInput("touch", false), "touch");
  assert.equal(pref.pointerInput("pen", false), "pen");
  // No press seen (a long press the system handled, or an old browser).
  assert.equal(pref.pointerInput(null, true), "touch");
  assert.equal(pref.pointerInput("", false), "mouse");
  assert.equal(pref.pointerInput(undefined, false), "mouse");
  // On a phone, by default: a finger selection shows nothing, a right click does (not decided here).
  assert.equal(pref.showsMenuOnSelection("computer", pref.pointerInput("touch", true)), false);
  assert.equal(pref.showsMenuOnSelection("computer", pref.pointerInput("mouse", true)), true);
});

test("stored values are read leniently: unknown or missing is the default", () => {
  assert.equal(pref.textMenuPrefOf("never"), "never");
  assert.equal(pref.textMenuPrefOf("always"), "always");
  for (const value of [null, undefined, "", "sometimes", 1, true]) assert.equal(pref.textMenuPrefOf(value), "computer", String(value));
});

test("the browser's copy changes with the bootstrap and tells its listeners", () => {
  assert.equal(pref.textMenuPref(), "computer");
  pref.setTextMenuPrefLocal("never");
  assert.equal(pref.textMenuPref(), "never");
  pref.setTextMenuPrefLocal(undefined);
  assert.equal(pref.textMenuPref(), "computer", "a bootstrap without the field means the default");
});

// ---- Saving ----

test("each person saves their choice; it comes with the bootstrap on every device and is validated", async () => {
  const anna = await account("text-menu-anna"),
    ben = await account("text-menu-ben");
  const wid = await createWorkspace(anna.id, "Auswahl");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).textMenu, "computer", "never chosen: the default");
  assert.equal((await one<{ text_menu: string | null }>("SELECT text_menu FROM users WHERE id=?", anna.id))?.text_menu, null);

  assert.deepEqual(await command(anna, { action: "profile.textMenu", textMenu: "never" }), { textMenu: "never" });
  assert.equal((await bootstrap(anna, wid)).textMenu, "never");
  assert.equal((await bootstrap(ben, wid)).textMenu, "computer", "only for that person");
  assert.deepEqual(await command(anna, { action: "profile.textMenu", textMenu: "always" }), { textMenu: "always" });
  assert.equal((await bootstrap(anna, wid)).textMenu, "always");

  for (const bad of ["sometimes", "", null, true, 2, undefined, { value: "never" }])
    await rejects(() => command(anna, { action: "profile.textMenu", textMenu: bad }), 400);
  assert.equal((await bootstrap(anna, wid)).textMenu, "always", "a rejected value changes nothing");

  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET text_menu=? WHERE id=?", "bogus", ben.id);
  assert.equal((await bootstrap(ben, wid)).textMenu, "computer");
});
