// The workspace as a library (#564, lib/workspace-navigation.ts): owners
// switch it with workspace.update (`library`, `hidden`), every space then
// shows as a library – spaces created later as well – without the spaces'
// own choice changing, and switching off restores it; the hidden places
// reach every member in the bootstrap; the library API and MCP see every
// space as a shelf; the setting travels in the archive and the JSON export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workspace-library-"));
const { id, one, run } = await import("../lib/db");
const { bootstrap, command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { libraryOverview, spaceLibrary } = await import("../lib/library-server");
const { exportArchive, importArchive, jsonExportWorkspace, readZip } = await import("../lib/archive");
const nav = await import("../lib/workspace-navigation");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = (actor: Identity, input: Record<string, unknown>): Promise<any> => command(actor, input);

const owner = await user("Owner"),
  editor = await user("Editor"),
  viewer = await user("Viewer");
const wid = await createWorkspace(owner.id, "Büro");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const first = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
// One space already a library of its own, one not.
const manual = (await act(owner, { action: "space.create", workspaceId: wid, name: "Handbuch", private: false })).id as string;
await act(owner, { action: "space.update", spaceId: manual, name: "Handbuch", private: false, library: true });
const book = (await act(owner, { action: "page.create", workspaceId: wid, spaceId: first, title: "Urlaubsregeln", kind: "document" })).id as string;

const spacesOf = async (actor: Identity) => new Map((await bootstrap(actor, wid)).spaces.map((s) => [s.id, s]));
const stored = async (sid: string) => (await one<{ library: number }>("SELECT library FROM spaces WHERE id=?", sid))!.library;

test("pure: lenient reading, places once and in order, spaces as shown", () => {
  assert.deepEqual(nav.navigationOf(null), { library: false, hidden: [] });
  assert.deepEqual(nav.navigationOf("{broken"), { library: false, hidden: [] });
  assert.deepEqual(nav.navigationOf('{"library":true,"hidden":["graph","tasks","tasks","gone"]}'), { library: true, hidden: ["tasks", "graph"] });
  assert.equal(nav.placeShownIn({ hidden: ["tasks"] }, "tasks"), false);
  assert.equal(nav.placeShownIn({ hidden: ["tasks"] }, "journal"), true);
  assert.equal(nav.placeShownIn(undefined, "tasks"), true);
  assert.equal(nav.placeShownIn({ hidden: ["tasks"] }, undefined), true);
  const spaces = [{ id: "a", library: 0 }, { id: "b", library: 1 }];
  assert.equal(nav.spacesAsShown(spaces, { library: false }), spaces);
  assert.deepEqual(nav.spacesAsShown(spaces, { library: true }), [{ id: "a", library: 1, own_library: 0 }, { id: "b", library: 1, own_library: 1 }]);
  assert.deepEqual(nav.spacesAsShown(spaces, { library: true }).map(nav.ownLibrary), [false, true]);
  // A tasks widget over a database view is not "My tasks".
  assert.equal(nav.widgetPlace({ kind: "tasks", config: { source: "mine" } }), "tasks");
  assert.equal(nav.widgetPlace({ kind: "tasks", config: { source: "view" } }), undefined);
  assert.equal(nav.widgetPlace({ kind: "study" }), "study");
  assert.equal(nav.widgetPlace({ kind: "notes" }), undefined);
});

test("only owners change it; members see it; bad input is refused", async () => {
  assert.deepEqual((await bootstrap(editor, wid)).navigation, { library: false, hidden: [] });
  await assert.rejects(act(editor, { action: "workspace.update", workspaceId: wid, library: true }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(act(viewer, { action: "workspace.update", workspaceId: wid, hidden: ["tasks"] }), (e: { status?: number }) => e.status === 403);
  await assert.rejects(act(owner, { action: "workspace.update", workspaceId: wid, hidden: ["inbox"] }));
  await assert.rejects(act(owner, { action: "workspace.update", workspaceId: wid, hidden: ["tasks", "tasks"] }));
  await assert.rejects(act(owner, { action: "workspace.update", workspaceId: wid, library: "yes" }));
  assert.equal((await one<{ navigation: string | null }>("SELECT navigation FROM workspaces WHERE id=?", wid))!.navigation, null);
  // Name and icon alone: the answer as before.
  assert.deepEqual(await act(owner, { action: "workspace.update", workspaceId: wid, name: "Büro" }), { ok: true });
});

test("on: every space a library, also one created later; the spaces' own choice stays; off restores it", async () => {
  const result = await act(owner, { action: "workspace.update", workspaceId: wid, library: true, hidden: ["journal", "tasks"] });
  assert.deepEqual(result, { ok: true, navigation: { library: true, hidden: ["tasks", "journal"] } });
  const later = (await act(owner, { action: "space.create", workspaceId: wid, name: "Später", private: false })).id as string;
  for (const actor of [owner, editor, viewer]) {
    const boot = await bootstrap(actor, wid);
    assert.deepEqual(boot.navigation, { library: true, hidden: ["tasks", "journal"] });
    const spaces = new Map(boot.spaces.map((s) => [s.id, s]));
    for (const sid of [first, manual, later]) assert.equal(spaces.get(sid)?.library, 1, `${actor.name}: ${sid}`);
    assert.deepEqual([first, manual, later].map((sid) => spaces.get(sid)?.own_library), [0, 1, 0]);
  }
  // Nothing written to the spaces.
  assert.deepEqual([await stored(first), await stored(manual), await stored(later)], [0, 1, 0]);
  // The library sees every space as a shelf, with its books.
  const overview = await libraryOverview(editor, wid);
  const shelves = [...overview.personal, ...overview.shared];
  assert.deepEqual(new Set(shelves.map((s) => s.id)), new Set([first, manual, later]));
  assert.ok(shelves.find((s) => s.id === first)!.books.some((b) => b.id === book));
  assert.equal((await spaceLibrary(editor, first)).space.library, true);
  // A space saved meanwhile keeps its own choice (what the settings send).
  await act(owner, { action: "space.update", spaceId: later, name: "Später", private: false, library: false });
  // Only the places change: the library mode stays.
  await act(owner, { action: "workspace.update", workspaceId: wid, hidden: ["study"] });
  assert.deepEqual((await bootstrap(viewer, wid)).navigation, { library: true, hidden: ["study"] });

  await act(owner, { action: "workspace.update", workspaceId: wid, library: false });
  const after = await spacesOf(editor);
  assert.deepEqual([first, manual, later].map((sid) => after.get(sid)?.library), [0, 1, 0]);
  assert.deepEqual([first, manual, later].map((sid) => after.get(sid)?.own_library), [undefined, undefined, undefined]);
  assert.deepEqual((await libraryOverview(editor, wid)).shared.map((s) => s.id), [manual]);
  assert.equal((await spaceLibrary(editor, first)).space.library, false);
  // The places stay hidden until switched back on.
  assert.deepEqual((await bootstrap(editor, wid)).navigation, { library: false, hidden: ["study"] });
  await act(owner, { action: "workspace.update", workspaceId: wid, hidden: [] });
  // Back to nothing set: nothing stored.
  assert.equal((await one<{ navigation: string | null }>("SELECT navigation FROM workspaces WHERE id=?", wid))!.navigation, null);
});

test("export and import: taken over into a workspace without one, never over one that has it", async () => {
  await act(owner, { action: "workspace.update", workspaceId: wid, library: true, hidden: ["tasks", "journal"] });
  const zip = await exportArchive(owner, wid);
  const manifest = JSON.parse((await readZip(zip)).get("flowplan.json")!.toString("utf8"));
  assert.deepEqual(manifest.navigation, { library: true, hidden: ["tasks", "journal"] });
  assert.deepEqual((await jsonExportWorkspace(wid)).navigation, { library: true, hidden: ["tasks", "journal"] });

  const restorer = await user("Restorer");
  const target = await createWorkspace(restorer.id, "Ziel");
  await importArchive(restorer, target, zip);
  assert.deepEqual((await bootstrap(restorer, target)).navigation, { library: true, hidden: ["tasks", "journal"] });

  const own = await createWorkspace(restorer.id, "Eigenes");
  await act(restorer, { action: "workspace.update", workspaceId: own, hidden: ["graph"] });
  await importArchive(restorer, own, zip);
  assert.deepEqual((await bootstrap(restorer, own)).navigation, { library: false, hidden: ["graph"] });
  await act(owner, { action: "workspace.update", workspaceId: wid, library: false, hidden: [] });
  // Nothing set: nothing exported.
  assert.equal("navigation" in (await jsonExportWorkspace(wid)), false);
});
