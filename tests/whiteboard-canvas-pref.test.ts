// "Whiteboard-Fläche" (#399, lib/whiteboard-canvas-pref.ts,
// lib/user-whiteboard-canvas.ts): the canvas follows the colour scheme by
// default or always stays light – saved per person on the server,
// validated and delivered with the bootstrap; boards' colours stay as stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wb-canvas-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/whiteboard-canvas-pref")), ...(await import("../lib/whiteboard-canvas-pref-client")) };
const { commandActions } = await import("../lib/openapi");
const { SETTINGS_SECTIONS } = await import("../lib/settings-sections");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("follows the colour scheme by default; only an explicit “light” keeps it light", () => {
  assert.equal(pref.DEFAULT_WHITEBOARD_CANVAS, "theme");
  for (const value of [null, undefined, "", "dark", "theme", 0, 1, "LIGHT", {}]) assert.equal(pref.whiteboardCanvasOf(value), "theme", String(value));
  assert.equal(pref.whiteboardCanvasOf("light"), "light");
  assert.equal(pref.showsDarkCanvas("theme", true), true, "dark mode: dark canvas");
  assert.equal(pref.showsDarkCanvas("theme", false), false, "light mode: light canvas");
  assert.equal(pref.showsDarkCanvas("light", true), false, "kept light");
  assert.equal(pref.showsDarkCanvas("light", false), false);
});

test("the browser's copy changes with the bootstrap and tells its listeners", () => {
  assert.equal(pref.whiteboardCanvas(), "theme");
  pref.setWhiteboardCanvasLocal("light");
  assert.equal(pref.whiteboardCanvas(), "light");
  pref.setWhiteboardCanvasLocal(undefined);
  assert.equal(pref.whiteboardCanvas(), "theme", "a bootstrap without the field means the default");
});

test("each person saves the choice; the board itself is unchanged; values are validated", async () => {
  const anna = await account("canvas-anna"),
    ben = await account("canvas-ben");
  const wid = await createWorkspace(anna.id, "Fläche");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  const boot = await bootstrap(anna, wid);
  assert.equal(boot.whiteboardCanvas, "theme", "never chosen: the default");
  assert.equal((await one<{ whiteboard_canvas: string | null }>("SELECT whiteboard_canvas FROM users WHERE id=?", anna.id))?.whiteboard_canvas, null);
  const board = (await command(anna, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Board", kind: "whiteboard" })) as { id: string };
  const before = await one<{ updated_at: unknown }>("SELECT updated_at FROM pages WHERE id=?", board.id);

  assert.deepEqual(await command(anna, { action: "profile.whiteboardCanvas", whiteboardCanvas: "light" }), { whiteboardCanvas: "light" });
  assert.equal((await bootstrap(anna, wid)).whiteboardCanvas, "light");
  assert.equal((await bootstrap(ben, wid)).whiteboardCanvas, "theme", "only for that person");
  assert.deepEqual(await one<{ updated_at: unknown }>("SELECT updated_at FROM pages WHERE id=?", board.id), before, "the board is not touched");

  for (const bad of ["dark", "", "LIGHT", null, undefined, true, 1, { value: "light" }])
    await rejects(() => command(anna, { action: "profile.whiteboardCanvas", whiteboardCanvas: bad }));
  assert.equal((await bootstrap(anna, wid)).whiteboardCanvas, "light", "a rejected value changes nothing");

  await command(anna, { action: "profile.whiteboardCanvas", whiteboardCanvas: "theme" });
  assert.equal((await bootstrap(anna, wid)).whiteboardCanvas, "theme");
  // A value written outside Flowplan reads as the default.
  await run("UPDATE users SET whiteboard_canvas=? WHERE id=?", "purple", ben.id);
  assert.equal((await bootstrap(ben, wid)).whiteboardCanvas, "theme");
});

test("the command is documented in the API", () => {
  const doc = commandActions.find((a) => a.action === "profile.whiteboardCanvas");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.whiteboardCanvas", whiteboardCanvas: "light" }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.whiteboardCanvas", whiteboardCanvas: "dark" }).success, false);
});

test("the setting can be found in the settings search", () => {
  const appearance = SETTINGS_SECTIONS.find((s) => s.id === "appearance");
  assert.ok(appearance?.entries?.some((e) => e.anchor === "whiteboard-canvas"));
});

test("the stylesheet gives the dark canvas the theme's background and grid", () => {
  const css = readFileSync(new URL("../app/whiteboard-board.css", import.meta.url), "utf8");
  assert.match(css, /\.whiteboard\.wb-dark-canvas[^{]*\{\s*background: var\(--bg\);/);
  assert.match(css, /\.wb-dark-canvas \.wb-grid-dot \{\s*fill: [^;]*var\(--/);
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globals, /\.whiteboard \{[^}]*background: #fafbfc;/, "the light canvas stays as before");
});
