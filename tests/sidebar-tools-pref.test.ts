// "Symbole unten in der Seitenleiste" (#589, lib/sidebar-tools-pref.ts,
// lib/user-sidebar-tools.ts): each person chooses which symbols the
// sidebar's bottom row shows – saved on the server, validated, delivered
// with the bootstrap; the phone's "Mehr" sheet always keeps Settings, and a
// hidden Settings moves into the workspace menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sidebar-tools-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = await import("../lib/sidebar-tools-pref");
const client = await import("../lib/sidebar-tools-pref-client");
const { commandActions } = await import("../lib/openapi");
const { SETTINGS_SECTIONS } = await import("../lib/settings-sections");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");
const tools = pref.SIDEBAR_TOOL_IDS.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((tool) => tool.id);

test("stored values: known symbols only, each once, in the row's order", () => {
  for (const value of [null, undefined, "", "nope", "{}", 1, {}, "[1,2]"]) assert.deepEqual(pref.hiddenSidebarToolsOf(value), [], String(value));
  assert.deepEqual(pref.hiddenSidebarToolsOf('["trash","graph","graph","later-tool"]'), ["graph", "trash"]);
  assert.deepEqual(pref.hiddenSidebarToolsOf(["shortcuts", "templates"]), ["templates", "shortcuts"]);
  assert.deepEqual(pref.setSidebarToolShown(["graph"], "tags", false), ["tags", "graph"]);
  assert.deepEqual(pref.setSidebarToolShown(["tags", "graph"], "tags", true), ["graph"]);
  assert.equal(pref.hiddenSidebarToolsSchema.safeParse(["graph", "admin"]).success, false);
  assert.equal(pref.hiddenSidebarToolsSchema.safeParse(Array(17).fill("graph")).success, false);
});

test("the row leaves hidden symbols out; the phone's sheet keeps Settings; a hidden Settings goes into the workspace menu", () => {
  assert.deepEqual(ids(pref.toolRowOf(tools, [])), [...pref.SIDEBAR_TOOL_IDS]);
  assert.deepEqual(ids(pref.toolRowOf(tools, ["graph", "settings"])), ["templates", "media", "study", "tags", "trash", "shortcuts"]);
  assert.deepEqual(ids(pref.moreSheetOf(tools, ["graph", "settings"])), ["templates", "media", "study", "tags", "trash", "settings", "shortcuts"]);
  // Everything hidden: the sheet still leads to Settings, where it is undone.
  assert.deepEqual(ids(pref.moreSheetOf(tools, [...pref.SIDEBAR_TOOL_IDS])), ["settings"]);
  assert.equal(pref.settingsInMenu(["graph"]), false);
  assert.equal(pref.settingsInMenu(["settings"]), true);
  // A place the workspace hides (#564) is not in the list to begin with.
  const withoutGraph = tools.filter((tool) => tool.id !== "graph");
  assert.deepEqual(ids(pref.toolRowOf(withoutGraph, [])), ids(withoutGraph));
});

test("each person saves the choice; it is validated and delivered with the bootstrap", async () => {
  const anna = await account("tools-anna"),
    ben = await account("tools-ben");
  const wid = await createWorkspace(anna.id, "Leiste");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.deepEqual((await bootstrap(anna, wid)).hiddenSidebarTools, [], "never chosen: every symbol");
  assert.deepEqual(await command(anna, { action: "profile.sidebarTools", hidden: ["trash", "graph", "graph"] }), { hidden: ["graph", "trash"] });
  assert.equal((await one<{ sidebar_tools: string | null }>("SELECT sidebar_tools FROM users WHERE id=?", anna.id))?.sidebar_tools, '["graph","trash"]');
  assert.deepEqual((await bootstrap(anna, wid)).hiddenSidebarTools, ["graph", "trash"]);
  assert.deepEqual((await bootstrap(ben, wid)).hiddenSidebarTools, [], "only for her");
  for (const bad of [["admin"], "graph", null, [1]]) await rejects(() => command(anna, { action: "profile.sidebarTools", hidden: bad }));
  assert.deepEqual((await bootstrap(anna, wid)).hiddenSidebarTools, ["graph", "trash"], "a refused value changes nothing");
  // All shown again: stored as none.
  assert.deepEqual(await command(anna, { action: "profile.sidebarTools", hidden: [] }), { hidden: [] });
  assert.equal((await one<{ sidebar_tools: string | null }>("SELECT sidebar_tools FROM users WHERE id=?", anna.id))?.sidebar_tools, null);
});

test("the browser store: a save shows at once, goes back when it fails, and wins over an older bootstrap", async () => {
  client.setHiddenSidebarToolsFromServer([]);
  let release!: () => void;
  const saved: string[][] = [];
  const done = client.saveHiddenSidebarTools(["graph"], async (hidden) => {
    saved.push(hidden);
    await new Promise<void>((resolve) => (release = resolve));
  });
  assert.deepEqual(client.hiddenSidebarTools(), ["graph"]);
  client.setHiddenSidebarToolsFromServer([]);
  assert.deepEqual(client.hiddenSidebarTools(), ["graph"], "the bootstrap read before the save is ignored");
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await done;
  assert.deepEqual(saved, [["graph"]]);
  await assert.rejects(
    client.saveHiddenSidebarTools(["graph", "tags"], async () => {
      throw new Error("offline");
    }),
  );
  assert.deepEqual(client.hiddenSidebarTools(), ["graph"], "back to the previous choice");
});

test("documented as a command, found in the settings search, and the row has its menu", () => {
  const doc = commandActions.find((a) => a.action === "profile.sidebarTools");
  assert.ok(doc);
  assert.equal(doc!.input.safeParse({ action: "profile.sidebarTools", hidden: ["graph"] }).success, true);
  assert.equal(doc!.input.safeParse({ action: "profile.sidebarTools", hidden: ["nope"] }).success, false);
  const entry = SETTINGS_SECTIONS.find((s) => s.id === "appearance")?.entries?.find((e) => e.anchor === "sidebar-tools");
  assert.ok(entry);
  const row = readFileSync("components/sidebar-tools.tsx", "utf8");
  assert.match(row, /onContextMenu/);
  assert.match(row, /pointerType !== "touch"/, "a long press on touch screens");
  assert.match(row, /t\("Aus Leiste ausblenden", "Hide from toolbar"\)/);
  assert.match(row, /t\("Leiste anpassen …", "Customize toolbar…"\)/);
  const app = readFileSync("components/workspace-app.tsx", "utf8");
  assert.match(app, /toolRowOf\(sidebarTools, hiddenTools\)/);
  assert.match(app, /moreSheetOf\(sidebarTools, hiddenTools\)/);
  assert.match(app, /settingsInMenu\(hiddenTools\)/);
});
