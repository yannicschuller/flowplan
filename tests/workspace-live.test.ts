// The workspace's live signal (#383, lib/workspace-live.ts): what changed
// reaches the open tabs of the workspace – the tree (versions moved), the
// person's own notifications (wherever they are inserted), pages they may
// read – and nothing names a page someone cannot see. Signals from other
// instances (the cluster bus) are delivered here as well.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workspace-live-"));
const { id, run } = await import("../lib/db");
const { bootstrap, command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { watchWorkspace, tick, pagesChanged } = await import("../lib/workspace-live");
const { documentChanged } = await import("../lib/document-live");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await user("owner"),
  member = await user("member"),
  wid = await createWorkspace(owner.id, "Live"),
  other = await createWorkspace(owner.id, "Other"),
  team = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, member.id, "editor");
const privateSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", owner.id);
const create = async (extra: Record<string, unknown> = {}) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Seite", ...extra })) as { id: string }).id;
const tasks = await create({ title: "Tasks", kind: "database" });
const secret = await create({ title: "Geheim", kind: "database", spaceId: privateSpace });

type Signal = { type: string; parts?: string[]; pages?: string[] };
// A tab: what it was sent.
function tab(person: Identity, workspaceId = wid) {
  const got: Signal[] = [];
  const stop = watchWorkspace(person, workspaceId, (event) => got.push(JSON.parse(event.replace(/^data: /, "").trim())));
  return {
    got,
    stop,
    take() {
      const out = got.filter((s) => s.type === "changed");
      got.length = 0;
      return out;
    },
  };
}
// One round of the signal (it also runs on its own every 250 ms).
const settle = async () => {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (await tick()) return;
  }
};

const ownerTab = tab(owner),
  memberTab = tab(member),
  otherTab = tab(member, other);
// Everything so far delivered and forgotten.
const drain = async () => {
  await settle();
  for (const t of [ownerTab, memberTab, otherTab]) t.take();
};
await drain();
// The parts of what a tab got, and the pages named.
const parts = (got: Signal[]) => [...new Set(got.flatMap((s) => s.parts ?? []))].sort();
const named = (got: Signal[]) => [...new Set(got.flatMap((s) => s.pages ?? []))].sort();

test("a tab starts with ready", () => {
  const t = tab(member);
  assert.deepEqual(t.got, [{ type: "ready" }]);
  t.stop();
});

test("a changed record names its database – only to those who may read it", async () => {
  await drain();
  const row = ((await command(owner, { action: "row.create", pageId: tasks, cells: { title: "A" } })) as { id: string }).id;
  await settle();
  assert.deepEqual(named(memberTab.take()), [tasks]);
  assert.deepEqual(named(ownerTab.take()), [tasks]);
  assert.deepEqual(named(otherTab.take()), [], "another workspace hears no page");
  await command(owner, { action: "row.update", pageId: tasks, rowId: row, version: 1, cells: { title: "B" } });
  await settle();
  assert.deepEqual(named(memberTab.take()), [tasks]);
  await drain();
  // The private database: its id goes to the owner only.
  await command(owner, { action: "row.create", pageId: secret, cells: { title: "S" } });
  await settle();
  assert.deepEqual(named(ownerTab.take()), [secret]);
  assert.deepEqual(named(memberTab.take()), [], "nothing about a page the member cannot see");
});

test("the tree: a new page, a rename, a permission", async () => {
  await drain();
  const page = await create({ title: "Neu" });
  await settle();
  assert.ok(parts(memberTab.take()).includes("tree"), "new page");
  await drain();
  await command(owner, { action: "page.update", pageId: page, patch: { title: "Umbenannt" } });
  await settle();
  assert.ok(parts(memberTab.take()).includes("tree"), "rename");
  assert.deepEqual(otherTab.take(), [], "a rename: not another workspace's tabs");
  ownerTab.take();
  // Permissions anywhere: every workspace looks again (no ids in it).
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", secret, member.id, "", "viewer", "page", wid);
  await settle();
  assert.deepEqual(memberTab.take(), [{ type: "changed", parts: ["tree"] }]);
  assert.deepEqual(otherTab.take(), [{ type: "changed", parts: ["tree"] }]);
  ownerTab.take();
  await run("DELETE FROM grants WHERE resource_id=? AND user_id=?", secret, member.id);
  await settle();
  for (const t of [ownerTab, memberTab, otherTab]) t.take();
});

test("the tree: a space moved, renamed or given another icon (schema 118)", async () => {
  await drain();
  await run("UPDATE spaces SET position=? WHERE id=?", 7, team);
  await settle();
  assert.ok(parts(memberTab.take()).includes("tree"), "moved");
  assert.deepEqual(otherTab.take(), [], "not another workspace's tabs");
  await drain();
  await run("UPDATE spaces SET name=? WHERE id=?", "Team neu", team);
  await settle();
  assert.ok(parts(memberTab.take()).includes("tree"), "renamed");
  await drain();
  await run("UPDATE spaces SET icon=? WHERE id=?", "star", team);
  await settle();
  assert.ok(parts(memberTab.take()).includes("tree"), "icon");
  await drain();
});

test("notifications: to the recipient's tabs only, from wherever they are inserted", async () => {
  await drain();
  await run("INSERT INTO notifications(id,user_id,body,kind) VALUES(?,?,?,'mention')", id(), member.id, "Hallo");
  await settle();
  const got = memberTab.take();
  assert.deepEqual(got, [{ type: "changed", parts: ["notifications"] }]);
  assert.deepEqual(otherTab.take(), [{ type: "changed", parts: ["notifications"] }], "the person's tab in another workspace too");
  assert.deepEqual(ownerTab.take(), [], "not someone else's");
  // Marking read through a command.
  await command(member, { action: "notification.read" }).catch(() => undefined);
  await settle();
  assert.ok(memberTab.take().some((s) => s.parts?.includes("notifications")));
  otherTab.take();
  ownerTab.take();
});

test("changes outside commands (documentChanged) and from other instances (bus)", async () => {
  await drain();
  documentChanged(tasks, null);
  await settle();
  assert.deepEqual(memberTab.take(), [{ type: "changed", parts: ["pages"], pages: [tasks] }]);
  ownerTab.take();
  // What another instance saw arrives on the bus.
  const bus = (globalThis as unknown as { flowplanBus?: { handlers: Map<string, Set<(p: unknown, o: string) => void>> } }).flowplanBus;
  const handlers = bus?.handlers.get("workspace");
  assert.ok(handlers?.size, "listening on the bus");
  for (const handler of handlers!) handler({ trees: [], people: [member.id], pages: [tasks, secret] }, "other-instance");
  await settle();
  const memberGot = memberTab.take();
  assert.deepEqual([parts(memberGot), named(memberGot)], [["notifications", "pages"], [tasks]], "the private page is left out here too");
  assert.deepEqual(named(ownerTab.take()), [tasks, secret].sort());
  otherTab.take();
});

test("a stopped tab hears nothing; a deleted page is not named", async () => {
  await drain();
  const t = tab(member);
  t.stop();
  pagesChanged([tasks]);
  await settle();
  assert.deepEqual(t.take(), []);
  memberTab.take();
  ownerTab.take();
  const gone = await create({ title: "Weg" });
  await settle();
  for (const x of [ownerTab, memberTab, otherTab]) x.take();
  await run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", gone);
  pagesChanged([gone]);
  await settle();
  const got = memberTab.take();
  assert.ok(got.every((s) => !s.pages?.includes(gone)), "a page in the trash is not named");
  assert.ok(got.some((s) => s.parts?.includes("tree")), "the tree changed");
  ownerTab.stop();
  memberTab.stop();
  otherTab.stop();
});
