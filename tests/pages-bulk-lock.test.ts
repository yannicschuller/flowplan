// Locking and favourites of a sidebar selection (#275): pages.bulk with
// "lock", "unlock", "favorite" and "unfavorite" runs the single command per
// page, skips pages the person may not change and audits like the single
// action.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tests-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
import type { Identity } from "../lib/types";

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("owner"),
  editor = await user("editor"),
  viewer = await user("viewer");
const wid = await createWorkspace(owner.id, "Bulk lock", true);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string, parentId?: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, parentId })) as { id: string }).id;
const bulk = async (as: Identity, operation: string, pageIds: string[]) =>
  (await command(as, { action: "pages.bulk", workspaceId: wid, operation, pageIds })) as { count: number; skipped: number };
const locked = async (pid: string) => (await one<{ locked: number }>("SELECT locked FROM pages WHERE id=?", pid))!.locked;
const audits = async (actor: string, action: string) =>
  (await all<{ resource_id: string }>("SELECT resource_id FROM audit WHERE actor_id=? AND action=?", actor, action)).map((r) => r.resource_id);

test("locks and unlocks a selection, skipping pages without edit rights", async () => {
  const a = await create("A"),
    b = await create("B"),
    c = await create("C"),
    child = await create("Kind", a);
  // The editor may only read C.
  await command(owner, { action: "grant.set", resourceId: c, userId: editor.id, role: "viewer" });
  assert.deepEqual(await bulk(editor, "lock", [a, b, c]), { ok: true, count: 2, skipped: 1, created: [] });
  assert.equal(await locked(a), 1);
  assert.equal(await locked(b), 1);
  assert.equal(await locked(c), 0);
  // Only the selected pages: a sub page stays as it was.
  assert.equal(await locked(child), 0);
  // One audit entry per page, as the single action writes.
  const updates = await audits(editor.id, "page.update");
  assert.ok(updates.includes(a) && updates.includes(b) && !updates.includes(c));
  // Already locked pages are neither changed nor skipped.
  assert.equal((await bulk(editor, "lock", [a, b])).count, 0);
  const unlocked = await bulk(editor, "unlock", [a, b, c]);
  assert.equal(unlocked.count, 2);
  assert.equal(unlocked.skipped, 1);
  assert.equal(await locked(a), 0);
  assert.equal(await locked(b), 0);
});

test("readers lock nothing; pages of another workspace are refused", async () => {
  const a = await create("Leser A");
  assert.deepEqual(await bulk(viewer, "lock", [a]), { ok: true, count: 0, skipped: 1, created: [] });
  assert.equal(await locked(a), 0);
  const other = await createWorkspace(owner.id, "Anderer", true);
  const otherSpace = (await bootstrap(owner, other)).spaces[0].id;
  const foreign = ((await command(owner, { action: "page.create", workspaceId: other, spaceId: otherSpace, title: "Fremd" })) as { id: string }).id;
  await assert.rejects(async () => await bulk(owner, "lock", [a, foreign]), /anderen Arbeitsbereich/);
  // All or nothing: the first page is not locked either.
  assert.equal(await locked(a), 0);
});

test("adds and removes favourites of a selection with read rights", async () => {
  const a = await create("Fav A"),
    b = await create("Fav B");
  const favorites = async (as: Identity) =>
    (await all<{ page_id: string }>("SELECT page_id FROM favorites WHERE user_id=?", as.id)).map((r) => r.page_id);
  const audited = (await audits(viewer.id, "pages.bulk")).length;
  assert.equal((await bulk(viewer, "favorite", [a, b])).count, 2);
  assert.deepEqual((await favorites(viewer)).sort(), [a, b].sort());
  assert.equal((await bulk(viewer, "unfavorite", [a])).count, 1);
  assert.deepEqual(await favorites(viewer), [b]);
  // Favourites stay out of the audit log, single or several.
  assert.equal((await audits(viewer.id, "pages.bulk")).length, audited);
});
