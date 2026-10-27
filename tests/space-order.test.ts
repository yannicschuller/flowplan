// The order of spaces (issue #48, lib/space-order.ts): "space.reorder",
// where new, restored, duplicated and imported spaces land, and the pure
// helpers of the sidebar (lib/space-moves.ts, lib/optimistic-commands.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bootstrap, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-space-order-"));
const { id, run, all, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive, readZip, writeZip } = await import("../lib/archive");
const { reorderPositions } = await import("../lib/space-order");
const { dropSpace, moveSpaceBy } = await import("../lib/space-moves");
const { commandOverlay, reorderList } = await import("../lib/optimistic-commands");

function user(name = "Order Tester"): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = (actor: Identity, input: Record<string, unknown>): any => command(actor, input);
// Names of the workspace's spaces in their stored order (all of them).
const stored = (wid: string) =>
  all<{ name: string }>("SELECT name FROM spaces WHERE workspace_id=? ORDER BY position,rowid", wid).map((s) => s.name);
const sidebar = (actor: Identity, wid: string) => (bootstrap(actor, wid) as unknown as Bootstrap).spaces.map((s) => s.name);
const spaceId = (wid: string, name: string) => one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND name=?", wid, name)!.id;
const positionOf = (sid: string) => one<{ position: number }>("SELECT position FROM spaces WHERE id=?", sid)!.position;

function fixture() {
  const owner = user("Owner"),
    editor = user("Editor"),
    viewer = user("Viewer"),
    wid = createWorkspace(owner.id, "Order checks");
  run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const space = (actor: Identity, name: string, priv = false) =>
    act(actor, { action: "space.create", workspaceId: wid, name, private: priv }).id as string;
  const a = space(owner, "A"),
    b = space(owner, "B"),
    c = space(owner, "C");
  const teamspace = spaceId(wid, "Teamspace");
  return { owner, editor, viewer, wid, space, a, b, c, teamspace };
}

test("new spaces go to the end; bootstrap, managed and trashed spaces follow the stored order", () => {
  const f = fixture();
  assert.deepEqual(stored(f.wid), ["Teamspace", "A", "B", "C"]);
  assert.deepEqual(sidebar(f.owner, f.wid), ["Teamspace", "A", "B", "C"]);
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.c, f.teamspace, f.a, f.b] });
  const boot = bootstrap(f.owner, f.wid) as unknown as Bootstrap;
  assert.deepEqual(boot.spaces.map((s) => s.name), ["C", "Teamspace", "A", "B"]);
  assert.deepEqual(boot.managedSpaces!.map((s) => s.name), ["C", "Teamspace", "A", "B"]);
  // Other members see the same order with the next bootstrap (the app
  // reloads it every few seconds).
  assert.deepEqual(sidebar(f.viewer, f.wid), ["C", "Teamspace", "A", "B"]);
  const d = f.space(f.owner, "D");
  assert.deepEqual(sidebar(f.owner, f.wid), ["C", "Teamspace", "A", "B", "D"]);
  for (const sid of [f.a, d]) {
    const s = one<{ version: number; name: string }>("SELECT version,name FROM spaces WHERE id=?", sid)!;
    act(f.owner, { action: "space.delete", spaceId: sid, version: s.version, confirmName: s.name });
  }
  assert.deepEqual((bootstrap(f.owner, f.wid) as unknown as Bootstrap).trashedSpaces!.map((s) => s.name), ["A", "D"]);
});

test("only workspace owners reorder; editors, viewers, guests and outsiders are refused", () => {
  const f = fixture();
  const order = [f.c, f.b, f.a, f.teamspace];
  for (const actor of [f.editor, f.viewer, user("Outsider")])
    assert.throws(() => act(actor, { action: "space.reorder", workspaceId: f.wid, order }), { status: 403 });
  const guest = user("Guest");
  run("INSERT INTO members VALUES(?,?,?)", f.wid, guest.id, "owner");
  run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", f.wid, guest.id);
  assert.throws(() => act(guest, { action: "space.reorder", workspaceId: f.wid, order }), { status: 403 });
  assert.deepEqual(stored(f.wid), ["Teamspace", "A", "B", "C"]);
  // A read-only API token never writes.
  assert.throws(() => act({ ...f.owner, apiScope: "read" }, { action: "space.reorder", workspaceId: f.wid, order }), { status: 403 });
  const answer = act(f.owner, { action: "space.reorder", workspaceId: f.wid, order });
  assert.deepEqual(answer, { ok: true, order });
});

test("input is checked: duplicates, unknown, deleted and other workspaces' spaces", () => {
  const f = fixture();
  const other = createWorkspace(f.owner.id, "Elsewhere"),
    foreign = spaceId(other, "Teamspace");
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.a, f.a] }), { status: 400 });
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [] }));
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: ["not-a-uuid"] }));
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [id(), f.a] }), { status: 404 });
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [foreign, f.a] }), { status: 404 });
  const s = one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.b)!;
  act(f.owner, { action: "space.delete", spaceId: f.b, version: s.version, confirmName: "B" });
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.b, f.a] }), { status: 404 });
});

test("hidden spaces keep their place and never show in the answer; private spaces of others stay unnamed", () => {
  const f = fixture();
  // Between A and B: the editor's private space, which the owner cannot see.
  const hidden = f.space(f.editor, "Editor private", true);
  run("UPDATE spaces SET position=? WHERE id=?", (positionOf(f.a) + positionOf(f.b)) / 2, hidden);
  assert.deepEqual(stored(f.wid), ["Teamspace", "A", "Editor private", "B", "C"]);
  assert.ok(!sidebar(f.owner, f.wid).includes("Editor private"));
  const before = positionOf(hidden);
  // The hidden space cannot be named in the request – same answer as unknown.
  assert.throws(() => act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [hidden, f.a] }), { status: 404 });
  const answer = act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.c, f.teamspace, f.b, f.a] });
  assert.deepEqual(answer.order, [f.c, f.teamspace, f.b, f.a]);
  assert.ok(!JSON.stringify(answer).includes(hidden));
  assert.ok(!JSON.stringify(answer).includes("Editor private"));
  assert.equal(positionOf(hidden), before);
  assert.deepEqual(sidebar(f.owner, f.wid), ["C", "Teamspace", "B", "A"]);
  // The editor sees their own space where it was relative to the others.
  assert.deepEqual(sidebar(f.editor, f.wid).filter((n) => n !== "Editor private").join(), "C,Teamspace,B,A");
  // A visible space left out of the request (created meanwhile) keeps its place.
  const e = f.space(f.owner, "E");
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.teamspace, f.c, f.b, f.a] });
  assert.deepEqual(sidebar(f.owner, f.wid), ["Teamspace", "C", "B", "A", "E"]);
  assert.equal(positionOf(hidden), before);
  void e;
});

test("positions are fractional: only moved spaces change, repeating an order changes nothing", () => {
  const f = fixture();
  const before = new Map([f.teamspace, f.a, f.b, f.c].map((sid) => [sid, positionOf(sid)]));
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.teamspace, f.c, f.a, f.b] });
  // C moved between Teamspace and A; the others kept their positions.
  for (const sid of [f.teamspace, f.a, f.b]) assert.equal(positionOf(sid), before.get(sid));
  assert.ok(positionOf(f.c) > before.get(f.teamspace)! && positionOf(f.c) < before.get(f.a)!);
  assert.ok(!Number.isInteger(positionOf(f.c)));
  const snapshot = [f.teamspace, f.a, f.b, f.c].map(positionOf);
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.teamspace, f.c, f.a, f.b] });
  assert.deepEqual([f.teamspace, f.a, f.b, f.c].map(positionOf), snapshot);
  // Many moves into the same gap: positions get spread out when the gap is gone.
  for (let i = 0; i < 80; i++) {
    const order = i % 2 ? [f.teamspace, f.c, f.a, f.b] : [f.teamspace, f.b, f.c, f.a];
    act(f.owner, { action: "space.reorder", workspaceId: f.wid, order });
    assert.deepEqual(
      sidebar(f.owner, f.wid),
      order.map((sid) => one<{ name: string }>("SELECT name FROM spaces WHERE id=?", sid)!.name),
    );
  }
});

test("reorderPositions keeps the longest ordered run and places the rest between neighbours", () => {
  const slots = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, position: n }));
  assert.deepEqual([...reorderPositions(slots, ["s1", "s2", "s3", "s4", "s5"])!], []);
  const toEnd = reorderPositions(slots, ["s2", "s3", "s4", "s5", "s1"])!;
  assert.deepEqual([...toEnd], [["s1", 6]]);
  const toStart = reorderPositions(slots, ["s5", "s1", "s2", "s3", "s4"])!;
  assert.deepEqual([...toStart], [["s5", 0]]);
  const middle = reorderPositions(slots, ["s1", "s4", "s2", "s3", "s5"])!;
  assert.equal(middle.size, 1);
  assert.equal(middle.get("s4"), 1.5);
  // Only a subset is visible: s2 and s4 hidden, their positions are not touched.
  const subset = reorderPositions(slots, ["s5", "s3", "s1"])!;
  assert.ok(!subset.has("s2") && !subset.has("s4"));
  const result = new Map(slots.map((s) => [s.id, subset.get(s.id) ?? s.position]));
  assert.ok(result.get("s5")! < result.get("s3")! && result.get("s3")! < result.get("s1")!);
  // No room left between two neighbours: the caller spreads out first.
  assert.equal(reorderPositions([{ id: "x", position: 1 }, { id: "y", position: 1 + 1e-12 }, { id: "z", position: 2 }], ["x", "z", "y"]), null);
});

test("a space restored from the trash keeps its old place", () => {
  const f = fixture();
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.b, f.teamspace, f.a, f.c] });
  let s = one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.teamspace)!;
  act(f.owner, { action: "space.delete", spaceId: f.teamspace, version: s.version, confirmName: "Teamspace" });
  assert.deepEqual(sidebar(f.owner, f.wid), ["B", "A", "C"]);
  // Reordering while it is in the trash does not touch it.
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.b, f.c, f.a] });
  f.space(f.owner, "New");
  s = one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.teamspace)!;
  act(f.owner, { action: "space.restore", spaceId: f.teamspace, version: s.version });
  assert.deepEqual(sidebar(f.owner, f.wid), ["B", "Teamspace", "C", "A", "New"]);
});

test("a duplicated space goes right after its original", () => {
  const f = fixture();
  const hidden = f.space(f.editor, "Hidden after A", true);
  run("UPDATE spaces SET position=? WHERE id=?", (positionOf(f.a) + positionOf(f.b)) / 2, hidden);
  const version = one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.a)!.version;
  act(f.owner, { action: "space.duplicate", spaceId: f.a, version, name: "A copy", visibility: "team" });
  assert.deepEqual(stored(f.wid), ["Teamspace", "A", "A copy", "Hidden after A", "B", "C"]);
  // The last one's copy goes last; a copy of a copy right after it.
  act(f.owner, { action: "space.duplicate", spaceId: f.c, version: 1, name: "C copy", visibility: "team" });
  act(f.owner, { action: "space.duplicate", spaceId: spaceId(f.wid, "A copy"), version: 1, name: "A copy 2", visibility: "team" });
  assert.deepEqual(stored(f.wid), ["Teamspace", "A", "A copy", "A copy 2", "Hidden after A", "B", "C", "C copy"]);
});

test("archives keep the order of their spaces; old archives without positions keep their list order", async () => {
  const f = fixture();
  for (const sid of [f.teamspace, f.a, f.b, f.c])
    act(f.owner, { action: "page.create", workspaceId: f.wid, spaceId: sid, title: "Page" });
  act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.c, f.a, f.teamspace, f.b] });
  const bytes = await exportArchive(f.owner, f.wid);
  const destination = createWorkspace(f.owner.id, "Destination");
  await importArchive(f.owner, destination, bytes);
  assert.deepEqual(stored(destination), ["Teamspace", "C (Import)", "A (Import)", "Teamspace (Import)", "B (Import)"]);
  // The manifest lists them in order, with positions; shuffled with
  // positions they still come in order.
  const entries = await readZip(bytes);
  const manifest = JSON.parse(entries.get("flowplan.json")!.toString());
  assert.deepEqual(manifest.spaces.map((s: { name: string }) => s.name), ["C", "A", "Teamspace", "B"]);
  manifest.spaces.reverse();
  entries.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const shuffled = createWorkspace(f.owner.id, "Shuffled");
  await importArchive(f.owner, shuffled, await writeZip(entries));
  assert.deepEqual(stored(shuffled), ["Teamspace", "C (Import)", "A (Import)", "Teamspace (Import)", "B (Import)"]);
  // Before schema 67 archives had no positions: their list order counts.
  for (const s of manifest.spaces) delete s.position;
  entries.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const legacy = createWorkspace(f.owner.id, "Legacy");
  await importArchive(f.owner, legacy, await writeZip(entries));
  assert.deepEqual(stored(legacy), ["Teamspace", "B (Import)", "Teamspace (Import)", "A (Import)", "C (Import)"]);
});

test("the migration fills positions in creation order", () => {
  const wid = createWorkspace(user().id, "Migrated");
  // As before schema 67: no positions (the trigger only fills missing ones
  // on insert, so clear them afterwards).
  for (const name of ["X", "Y"]) run("INSERT INTO spaces(id,workspace_id,name) VALUES(?,?,?)", id(), wid, name);
  run("UPDATE spaces SET position=NULL WHERE workspace_id=?", wid);
  run("UPDATE spaces SET position=(SELECT COUNT(*) FROM spaces o WHERE o.workspace_id IS spaces.workspace_id AND o.rowid<spaces.rowid)+1 WHERE workspace_id=?", wid);
  assert.deepEqual(stored(wid), ["Teamspace", "X", "Y"]);
  assert.deepEqual(all<{ position: number }>("SELECT position FROM spaces WHERE workspace_id=? ORDER BY rowid", wid).map((s) => s.position), [1, 2, 3]);
  // Ties (data from elsewhere) are spread out before a reorder.
  run("UPDATE spaces SET position=1 WHERE workspace_id=?", wid);
  const owner = one<{ user_id: string }>("SELECT user_id FROM members WHERE workspace_id=?", wid)!.user_id;
  const actor = { id: owner, name: "", email: "", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  const [t, x, y] = ["Teamspace", "X", "Y"].map((n) => spaceId(wid, n));
  act(actor, { action: "space.reorder", workspaceId: wid, order: [y, t, x] });
  assert.deepEqual(stored(wid), ["Y", "Teamspace", "X"]);
});

test("sidebar helpers and the optimistic layer", () => {
  assert.deepEqual(moveSpaceBy(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveSpaceBy(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.equal(moveSpaceBy(["a", "b", "c"], "a", -1), null);
  assert.equal(moveSpaceBy(["a", "b", "c"], "c", 1), null);
  assert.deepEqual(dropSpace(["a", "b", "c"], "c", "a", "before"), ["c", "a", "b"]);
  assert.deepEqual(dropSpace(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"]);
  assert.equal(dropSpace(["a", "b", "c"], "a", "b", "before"), null);
  assert.equal(dropSpace(["a", "b", "c"], "a", "a", "after"), null);
  const list = ["a", "h", "b", "c"].map((id) => ({ id }));
  assert.deepEqual(reorderList(list, ["c", "a", "b"]).map((s) => s.id), ["c", "h", "a", "b"]);
  const overlay = commandOverlay({ action: "space.reorder", order: ["c", "b", "a"] }, { userId: "u", userName: "U" })!;
  const boot = { spaces: [{ id: "a" }, { id: "b" }, { id: "c" }], managedSpaces: [{ id: "a" }, { id: "c" }] } as unknown as Bootstrap;
  const next = overlay.boot!(boot);
  assert.deepEqual(next.spaces.map((s) => s.id), ["c", "b", "a"]);
  assert.deepEqual(next.managedSpaces!.map((s) => s.id), ["c", "a"]);
});
