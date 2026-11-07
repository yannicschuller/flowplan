// The order of spaces (issue #48, lib/space-order.ts): "space.reorder",
// where new, restored, duplicated and imported spaces land, and the pure
// helpers of the sidebar (lib/space-moves.ts, lib/optimistic-commands.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bootstrap, Identity } from "../lib/types";
import { mapAsync } from "../lib/each-async";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-space-order-"));
const { id, run, all, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive, readZip, writeZip } = await import("../lib/archive");
const { reorderPositions } = await import("../lib/space-order");
const { dropSpace, moveSpaceBy } = await import("../lib/space-moves");
const { commandOverlay, reorderList } = await import("../lib/optimistic-commands");

async function user(name = "Order Tester"): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = async (actor: Identity, input: Record<string, unknown>): Promise<any> => await command(actor, input);
// Names of the workspace's spaces in their stored order (all of them).
const stored = async (wid: string) =>
  (await all<{ name: string }>("SELECT name FROM spaces WHERE workspace_id=? ORDER BY position,seq", wid)).map((s) => s.name);
const sidebar = async (actor: Identity, wid: string) => ((await bootstrap(actor, wid)) as unknown as Bootstrap).spaces.map((s) => s.name);
const spaceId = async (wid: string, name: string) => (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND name=?", wid, name))!.id;
const positionOf = async (sid: string) => (await one<{ position: number }>("SELECT position FROM spaces WHERE id=?", sid))!.position;

async function fixture() {
  const owner = await user("Owner"),
    editor = await user("Editor"),
    viewer = await user("Viewer"),
    wid = await createWorkspace(owner.id, "Order checks");
  await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const space = async (actor: Identity, name: string, priv = false) =>
    (await act(actor, { action: "space.create", workspaceId: wid, name, private: priv })).id as string;
  const a = await space(owner, "A"),
    b = await space(owner, "B"),
    c = await space(owner, "C");
  const teamspace = await spaceId(wid, "Teamspace");
  return { owner, editor, viewer, wid, space, a, b, c, teamspace };
}

test("new spaces go to the end; bootstrap, managed and trashed spaces follow the stored order", async () => {
  const f = await fixture();
  assert.deepEqual(await stored(f.wid), ["Teamspace", "A", "B", "C"]);
  assert.deepEqual(await sidebar(f.owner, f.wid), ["Teamspace", "A", "B", "C"]);
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.c, f.teamspace, f.a, f.b] });
  const boot = (await bootstrap(f.owner, f.wid)) as unknown as Bootstrap;
  assert.deepEqual(boot.spaces.map((s) => s.name), ["C", "Teamspace", "A", "B"]);
  assert.deepEqual(boot.managedSpaces!.map((s) => s.name), ["C", "Teamspace", "A", "B"]);
  // Other members see the same order with the next bootstrap (the app
  // reloads it every few seconds).
  assert.deepEqual(await sidebar(f.viewer, f.wid), ["C", "Teamspace", "A", "B"]);
  const d = await f.space(f.owner, "D");
  assert.deepEqual(await sidebar(f.owner, f.wid), ["C", "Teamspace", "A", "B", "D"]);
  for (const sid of [f.a, d]) {
    const s = (await one<{ version: number; name: string }>("SELECT version,name FROM spaces WHERE id=?", sid))!;
    await act(f.owner, { action: "space.delete", spaceId: sid, version: s.version, confirmName: s.name });
  }
  assert.deepEqual(((await bootstrap(f.owner, f.wid)) as unknown as Bootstrap).trashedSpaces!.map((s) => s.name), ["A", "D"]);
});

test("only workspace owners reorder; editors, viewers, guests and outsiders are refused", async () => {
  const f = await fixture();
  const order = [f.c, f.b, f.a, f.teamspace];
  for (const actor of [f.editor, f.viewer, await user("Outsider")])
    await assert.rejects(async () => await act(actor, { action: "space.reorder", workspaceId: f.wid, order }), { status: 403 });
  const guest = await user("Guest");
  await run("INSERT INTO members VALUES(?,?,?)", f.wid, guest.id, "owner");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", f.wid, guest.id);
  await assert.rejects(async () => await act(guest, { action: "space.reorder", workspaceId: f.wid, order }), { status: 403 });
  assert.deepEqual(await stored(f.wid), ["Teamspace", "A", "B", "C"]);
  // A read-only API token never writes.
  await assert.rejects(async () => await act({ ...f.owner, apiScope: "read" }, { action: "space.reorder", workspaceId: f.wid, order }), { status: 403 });
  const answer = await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order });
  assert.deepEqual(answer, { ok: true, order });
});

test("input is checked: duplicates, unknown, deleted and other workspaces' spaces", async () => {
  const f = await fixture();
  const other = await createWorkspace(f.owner.id, "Elsewhere"),
    foreign = await spaceId(other, "Teamspace");
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.a, f.a] }), { status: 400 });
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [] }));
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: ["not-a-uuid"] }));
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [id(), f.a] }), { status: 404 });
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [foreign, f.a] }), { status: 404 });
  const s = (await one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.b))!;
  await act(f.owner, { action: "space.delete", spaceId: f.b, version: s.version, confirmName: "B" });
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.b, f.a] }), { status: 404 });
});

test("hidden spaces keep their place and never show in the answer; private spaces of others stay unnamed", async () => {
  const f = await fixture();
  // Between A and B: the editor's private space, which the owner cannot see.
  const hidden = await f.space(f.editor, "Editor private", true);
  await run("UPDATE spaces SET position=? WHERE id=?", ((await positionOf(f.a)) + (await positionOf(f.b))) / 2, hidden);
  assert.deepEqual(await stored(f.wid), ["Teamspace", "A", "Editor private", "B", "C"]);
  assert.ok(!(await sidebar(f.owner, f.wid)).includes("Editor private"));
  const before = await positionOf(hidden);
  // The hidden space cannot be named in the request – same answer as unknown.
  await assert.rejects(async () => await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [hidden, f.a] }), { status: 404 });
  const answer = await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.c, f.teamspace, f.b, f.a] });
  assert.deepEqual(answer.order, [f.c, f.teamspace, f.b, f.a]);
  assert.ok(!JSON.stringify(answer).includes(hidden));
  assert.ok(!JSON.stringify(answer).includes("Editor private"));
  assert.equal(await positionOf(hidden), before);
  assert.deepEqual(await sidebar(f.owner, f.wid), ["C", "Teamspace", "B", "A"]);
  // The editor sees their own space where it was relative to the others.
  assert.deepEqual((await sidebar(f.editor, f.wid)).filter((n) => n !== "Editor private").join(), "C,Teamspace,B,A");
  // A visible space left out of the request (created meanwhile) keeps its place.
  const e = await f.space(f.owner, "E");
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.teamspace, f.c, f.b, f.a] });
  assert.deepEqual(await sidebar(f.owner, f.wid), ["Teamspace", "C", "B", "A", "E"]);
  assert.equal(await positionOf(hidden), before);
  void e;
});

test("positions are fractional: only moved spaces change, repeating an order changes nothing", async () => {
  const f = await fixture();
  const before = new Map(await mapAsync([f.teamspace, f.a, f.b, f.c], async (sid) => [sid, await positionOf(sid)]));
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.teamspace, f.c, f.a, f.b] });
  // C moved between Teamspace and A; the others kept their positions.
  for (const sid of [f.teamspace, f.a, f.b]) assert.equal(await positionOf(sid), before.get(sid));
  assert.ok((await positionOf(f.c)) > before.get(f.teamspace)! && (await positionOf(f.c)) < before.get(f.a)!);
  assert.ok(!Number.isInteger(await positionOf(f.c)));
  const snapshot = await mapAsync([f.teamspace, f.a, f.b, f.c], positionOf);
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.teamspace, f.c, f.a, f.b] });
  assert.deepEqual(await mapAsync([f.teamspace, f.a, f.b, f.c], positionOf), snapshot);
  // Many moves into the same gap: positions get spread out when the gap is gone.
  for (let i = 0; i < 80; i++) {
    const order = i % 2 ? [f.teamspace, f.c, f.a, f.b] : [f.teamspace, f.b, f.c, f.a];
    await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order });
    assert.deepEqual(
      await sidebar(f.owner, f.wid),
      await mapAsync(order, async (sid) => (await one<{ name: string }>("SELECT name FROM spaces WHERE id=?", sid))!.name),
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

test("a space restored from the trash keeps its old place", async () => {
  const f = await fixture();
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.b, f.teamspace, f.a, f.c] });
  let s = (await one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.teamspace))!;
  await act(f.owner, { action: "space.delete", spaceId: f.teamspace, version: s.version, confirmName: "Teamspace" });
  assert.deepEqual(await sidebar(f.owner, f.wid), ["B", "A", "C"]);
  // Reordering while it is in the trash does not touch it.
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.b, f.c, f.a] });
  await f.space(f.owner, "New");
  s = (await one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.teamspace))!;
  await act(f.owner, { action: "space.restore", spaceId: f.teamspace, version: s.version });
  assert.deepEqual(await sidebar(f.owner, f.wid), ["B", "Teamspace", "C", "A", "New"]);
});

test("a duplicated space goes right after its original", async () => {
  const f = await fixture();
  const hidden = await f.space(f.editor, "Hidden after A", true);
  await run("UPDATE spaces SET position=? WHERE id=?", ((await positionOf(f.a)) + (await positionOf(f.b))) / 2, hidden);
  const version = (await one<{ version: number }>("SELECT version FROM spaces WHERE id=?", f.a))!.version;
  await act(f.owner, { action: "space.duplicate", spaceId: f.a, version, name: "A copy", visibility: "team" });
  assert.deepEqual(await stored(f.wid), ["Teamspace", "A", "A copy", "Hidden after A", "B", "C"]);
  // The last one's copy goes last; a copy of a copy right after it.
  await act(f.owner, { action: "space.duplicate", spaceId: f.c, version: 1, name: "C copy", visibility: "team" });
  await act(f.owner, { action: "space.duplicate", spaceId: await spaceId(f.wid, "A copy"), version: 1, name: "A copy 2", visibility: "team" });
  assert.deepEqual(await stored(f.wid), ["Teamspace", "A", "A copy", "A copy 2", "Hidden after A", "B", "C", "C copy"]);
});

test("archives keep the order of their spaces; old archives without positions keep their list order", async () => {
  const f = await fixture();
  for (const sid of [f.teamspace, f.a, f.b, f.c])
    await act(f.owner, { action: "page.create", workspaceId: f.wid, spaceId: sid, title: "Page" });
  await act(f.owner, { action: "space.reorder", workspaceId: f.wid, order: [f.c, f.a, f.teamspace, f.b] });
  const bytes = await exportArchive(f.owner, f.wid);
  const destination = await createWorkspace(f.owner.id, "Destination");
  await importArchive(f.owner, destination, bytes);
  assert.deepEqual(await stored(destination), ["Teamspace", "C (Import)", "A (Import)", "Teamspace (Import)", "B (Import)"]);
  // The manifest lists them in order, with positions; shuffled with
  // positions they still come in order.
  const entries = await readZip(bytes);
  const manifest = JSON.parse(entries.get("flowplan.json")!.toString());
  assert.deepEqual(manifest.spaces.map((s: { name: string }) => s.name), ["C", "A", "Teamspace", "B"]);
  manifest.spaces.reverse();
  entries.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const shuffled = await createWorkspace(f.owner.id, "Shuffled");
  await importArchive(f.owner, shuffled, await writeZip(entries));
  assert.deepEqual(await stored(shuffled), ["Teamspace", "C (Import)", "A (Import)", "Teamspace (Import)", "B (Import)"]);
  // Before schema 67 archives had no positions: their list order counts.
  for (const s of manifest.spaces) delete s.position;
  entries.set("flowplan.json", Buffer.from(JSON.stringify(manifest)));
  const legacy = await createWorkspace(f.owner.id, "Legacy");
  await importArchive(f.owner, legacy, await writeZip(entries));
  assert.deepEqual(await stored(legacy), ["Teamspace", "B (Import)", "Teamspace (Import)", "A (Import)", "C (Import)"]);
});

test("the migration fills positions in creation order", async () => {
  const wid = await createWorkspace((await user()).id, "Migrated");
  // As before schema 67: no positions (the trigger only fills missing ones
  // on insert, so clear them afterwards).
  for (const name of ["X", "Y"]) await run("INSERT INTO spaces(id,workspace_id,name) VALUES(?,?,?)", id(), wid, name);
  await run("UPDATE spaces SET position=NULL WHERE workspace_id=?", wid);
  await run("UPDATE spaces SET position=(SELECT COUNT(*) FROM spaces o WHERE o.workspace_id IS NOT DISTINCT FROM spaces.workspace_id AND o.seq<spaces.seq)+1 WHERE workspace_id=?", wid);
  assert.deepEqual(await stored(wid), ["Teamspace", "X", "Y"]);
  assert.deepEqual((await all<{ position: number }>("SELECT position FROM spaces WHERE workspace_id=? ORDER BY seq", wid)).map((s) => s.position), [1, 2, 3]);
  // Ties (data from elsewhere) are spread out before a reorder.
  await run("UPDATE spaces SET position=1 WHERE workspace_id=?", wid);
  const owner = (await one<{ user_id: string }>("SELECT user_id FROM members WHERE workspace_id=?", wid))!.user_id;
  const actor = { id: owner, name: "", email: "", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  const [t, x, y] = await mapAsync(["Teamspace", "X", "Y"], async (n) => await spaceId(wid, n));
  await act(actor, { action: "space.reorder", workspaceId: wid, order: [y, t, x] });
  assert.deepEqual(await stored(wid), ["Y", "Teamspace", "X"]);
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
