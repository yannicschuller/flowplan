// What a person folds and unfolds in the sidebar (#97): stored per person
// and workspace in the account (schema 86), changed by sending only the
// changes, pruned of deleted pages and spaces, and the pure helpers the
// client uses (reveal, "Alle aufklappen", journal folders, the old copy on
// the device).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sidebar-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { commandActionNames, commandActions } = await import("../lib/openapi");
const folds = await import("../lib/sidebar-folds");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Olga"),
  viewer = account("Vera"),
  stranger = account("Sven");
const wid = createWorkspace(owner.id, "Agentur");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = bootstrap(owner, wid).spaces[0].id;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Record<string, unknown>;
const page = (title: string, parentId?: string) =>
  (act({ action: "page.create", workspaceId: wid, spaceId: team, title, kind: "document", ...(parentId ? { parentId } : {}) }) as { id: string }).id;
const save = (changes: Record<string, boolean>, as = owner) =>
  act({ action: "sidebar.state", workspaceId: wid, changes }, as) as { keys: string[]; updatedAt: number };
const stateOf = (as = owner) => bootstrap(as, wid).sidebar;

const projekte = page("Projekte");
const kunde = page("Kunde A", projekte);
const notizen = page("Notizen", kunde);
const leer = page("Leer");

test("schema 86: the table exists", () => {
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sidebar_state'"));
  assert.equal((globalThis as { flowplanSchema?: number }).flowplanSchema, 86);
});

test("nothing stored yet: null in the bootstrap", () => {
  assert.equal(stateOf(), null);
});

test("changes per person, the same in every bootstrap (all devices)", () => {
  const saved = save({ [`p:${projekte}`]: true, [`p:${kunde}`]: true, [`s:${team}`]: true, "g:favorites": true });
  assert.deepEqual(saved.keys, [`p:${projekte}`, `p:${kunde}`, `s:${team}`, "g:favorites"]);
  assert.deepEqual(stateOf()?.keys, saved.keys);
  assert.equal(typeof stateOf()?.updatedAt, "number");
  // Folding again removes only that key: another device's changes stay.
  save({ [`p:${kunde}`]: false, "g:collections": true });
  assert.deepEqual(stateOf()?.keys, [`p:${projekte}`, `s:${team}`, "g:favorites", "g:collections"]);
  // Another person has their own.
  assert.equal(stateOf(viewer), null);
  save({ [`p:${projekte}`]: true }, viewer);
  assert.deepEqual(stateOf(viewer)?.keys, [`p:${projekte}`]);
  assert.deepEqual(stateOf()?.keys, [`p:${projekte}`, `s:${team}`, "g:favorites", "g:collections"]);
  void notizen;
});

test("pages without sub-pages, unknown keys and other workspaces' pages drop out", () => {
  const elsewhere = createWorkspace(owner.id, "Privat");
  const otherSpace = bootstrap(owner, elsewhere).spaces[0].id;
  const saved = save({
    [`p:${leer}`]: true,
    [`s:${otherSpace}`]: true,
    "x:whatever": true,
    "g:sidebar": true,
    [`p:${id()}`]: true,
  });
  assert.deepEqual(saved.keys, [`p:${projekte}`, `s:${team}`, "g:favorites", "g:collections"]);
});

test("deleted pages are pruned when read and saved", () => {
  const extra = page("Archiv");
  const child = page("Alt", extra);
  save({ [`p:${extra}`]: true });
  assert.ok(stateOf()?.keys.includes(`p:${extra}`));
  // The only sub-page goes to the trash: nothing left to unfold.
  act({ action: "page.delete", pageId: child });
  assert.ok(!stateOf()?.keys.includes(`p:${extra}`));
  save({ [`p:${extra}`]: true });
  act({ action: "page.delete", pageId: extra });
  assert.ok(!stateOf()?.keys.includes(`p:${extra}`));
  const stored = JSON.parse(one<{ keys: string }>("SELECT keys FROM sidebar_state WHERE user_id=? AND workspace_id=?", owner.id, wid)!.keys);
  save({});
  const after = JSON.parse(one<{ keys: string }>("SELECT keys FROM sidebar_state WHERE user_id=? AND workspace_id=?", owner.id, wid)!.keys);
  assert.ok(after.length <= stored.length);
  assert.ok(!after.includes(`p:${extra}`));
});

test("members only; bad input refused; documented", () => {
  assert.throws(() => save({ [`p:${projekte}`]: true }, stranger), /Arbeitsbereich|Zugriff|Mitglied|Berechtigung|gefunden/);
  assert.throws(() => act({ action: "sidebar.state", workspaceId: "nope", changes: {} }));
  assert.throws(() => act({ action: "sidebar.state", workspaceId: wid, changes: { "p:x": "yes" } }));
  const many = Object.fromEntries(Array.from({ length: folds.SIDEBAR_CHANGES_LIMIT + 1 }, (_, i) => [`g:${i}`, true]));
  assert.throws(() => act({ action: "sidebar.state", workspaceId: wid, changes: many }));
  assert.ok(commandActionNames.includes("sidebar.state"));
  assert.ok(commandActions.some((a) => a.action === "sidebar.state"));
});

test("gone with the person", () => {
  run("DELETE FROM users WHERE id=?", viewer.id);
  assert.equal(one("SELECT 1 FROM sidebar_state WHERE user_id=?", viewer.id), undefined);
});

test("keys: only the known kinds", () => {
  const u = "0b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
  for (const key of [`p:${u}`, `s:${u}`, "g:favorites", "g:collections", `jo:${u}:2025`, `jc:${u}:2025-03`]) assert.ok(folds.isSidebarKey(key), key);
  for (const key of ["p:abc", `q:${u}`, "g:other", `jo:${u}:25`, `jo:${u}:2025-3`, `p:${u} `, 5, null]) assert.ok(!folds.isSidebarKey(key), String(key));
});

test("applying changes: newest last, limited", () => {
  const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  assert.deepEqual(folds.applySidebarChanges([`p:${u(1)}`, `p:${u(2)}`], { [`p:${u(1)}`]: true, [`p:${u(2)}`]: false, bogus: true }), [`p:${u(1)}`]);
  const many = Array.from({ length: folds.SIDEBAR_STATE_LIMIT + 10 }, (_, i) => `p:${u(i)}`);
  const kept = folds.applySidebarChanges([], Object.fromEntries(many.map((k) => [k, true])));
  assert.equal(kept.length, folds.SIDEBAR_STATE_LIMIT);
  assert.equal(kept.at(-1), many.at(-1));
  assert.ok(!kept.includes(many[0]));
});

test("pruning", () => {
  const a = "00000000-0000-4000-8000-00000000000a",
    b = "00000000-0000-4000-8000-00000000000b",
    s = "00000000-0000-4000-8000-00000000000c";
  const known = { pages: new Set([a, b]), parents: new Set([a]), spaces: new Set([s]) };
  assert.deepEqual(
    folds.pruneSidebarKeys([`p:${a}`, `p:${b}`, `p:${a}`, `s:${s}`, `s:${a}`, `jo:${b}:2025`, `jc:${s}:2025`, "g:favorites"], known),
    [`p:${a}`, `s:${s}`, `jo:${b}:2025`, "g:favorites"],
  );
});

test("reveal, fold all, journal folders, the old device copy", () => {
  const pages = [
    { id: "r", parent_id: null, space_id: "s1" },
    { id: "c", parent_id: "r", space_id: "s1" },
    { id: "g", parent_id: "c", space_id: "s1" },
    { id: "x", parent_id: null, space_id: "s2" },
    { id: "y", parent_id: "x", space_id: "s2" },
    { id: "z", parent_id: "c", space_id: "s1", deleted_at: "2026-01-01" },
  ];
  assert.deepEqual(folds.ancestorIds(pages, "g"), ["c", "r"]);
  assert.deepEqual(folds.ancestorIds(pages, "r"), []);
  assert.deepEqual(folds.ancestorIds(pages, null), []);
  // A loop in broken data ends.
  assert.deepEqual(folds.ancestorIds([{ id: "a", parent_id: "b", space_id: "s" }, { id: "b", parent_id: "a", space_id: "s" }], "a"), ["b"]);
  assert.deepEqual(folds.spaceFoldChanges(pages, "s1", true), { "p:r": true, "p:c": true });
  assert.deepEqual(folds.spaceFoldChanges(pages, "s2", false), { "p:x": false });
  const j = "0b7c6a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
  assert.equal(folds.journalFoldKey(`journal:${j}:2025`, true), `jo:${j}:2025`);
  assert.equal(folds.journalFoldKey(`journal:${j}:2025-03`, false), `jc:${j}:2025-03`);
  const { open, closed } = folds.journalFolds([`jo:${j}:2025`, `jc:${j}:2025-03`, `p:${j}`]);
  assert.deepEqual([...open], [`journal:${j}:2025`]);
  assert.deepEqual([...closed], [`journal:${j}:2025-03`]);
  assert.deepEqual(folds.legacyFoldChanges([j, "nope"], true), { [`s:${j}`]: true, "g:collections": true });
  assert.deepEqual(folds.legacyFoldChanges([], false), {});
  const server = { keys: ["g:favorites"], updatedAt: 10 },
    device = { keys: [], updatedAt: 20 };
  assert.equal(folds.newerSidebar(server, device), device);
  assert.equal(folds.newerSidebar({ ...server, updatedAt: 30 }, device)?.updatedAt, 30);
  assert.equal(folds.newerSidebar(null, null), null);
  assert.equal(folds.newerSidebar(server, null), server);
});
