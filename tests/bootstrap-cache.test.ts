// The bootstrap's page list kept across requests and its cheap ETag (#383,
// lib/bootstrap-pages.ts, lib/cache-versions.ts, schema 109): every write
// that can change the list moves a version (triggers, also for writes
// outside the app's code), the kept answer always equals one computed from
// scratch, every change of a source changes the ETag, and an unchanged
// answer is a 304.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-bootstrap-cache-"));
const { id, run, one, transaction } = await import("../lib/db");
const { bootstrap, command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { bootstrapResponse } = await import("../lib/bootstrap-pages");
const { withReadMemo } = await import("../lib/read-memo");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await user("owner"),
  viewer = await user("viewer"),
  guest = await user("guest"),
  wid = await createWorkspace(owner.id, "Cache"),
  boot = await bootstrap(owner, wid),
  team = boot.spaces[0].id;
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, guest.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const privateSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", owner.id);
const page = async (extra: Record<string, unknown> = {}) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Seite", ...extra })) as { id: string }).id;
const doc = await page({ title: "Doc" });
const hidden = await page({ title: "Hidden", spaceId: privateSpace });
const database = await page({ title: "Tasks", kind: "database" });
const record = id();
await run("INSERT INTO rows(id,page_id,cells,created_by,access) VALUES(?,?,?,?,?)", record, database, JSON.stringify({ title: "R" }), owner.id, "inherit");
const below = await page({ title: "Below a record", parentId: database, parentRowId: record });

const version = async (name: string) => (await one<{ version: number }>("SELECT version FROM cache_versions WHERE name=?", name))?.version ?? 0;
// Whether `write` moves the named versions (and only those listed).
async function moves(write: () => Promise<unknown>, expected: { roles: boolean; pages: boolean }, label: string) {
  const before = { roles: await version("roles"), pages: await version(`pages:${wid}`) };
  await write();
  const after = { roles: await version("roles"), pages: await version(`pages:${wid}`) };
  assert.deepEqual({ roles: before.roles !== after.roles, pages: before.pages !== after.pages }, expected, label);
}
const forget = () => {
  const g = globalThis as unknown as Record<string, { clear(): void } | undefined>;
  for (const name of ["flowplanRoles", "flowplanWorkspacePages", "flowplanPageLists", "flowplanMemberLists"]) g[name]?.clear();
};
const request = (tag?: string | null) => new Request("http://localhost/api/bootstrap", { headers: tag ? { "if-none-match": tag } : {} });
// One GET as the route answers it (in a read memo, as every request).
const get = async (person: Identity, tag?: string | null) => await withReadMemo(async () => bootstrapResponse(request(tag), await bootstrap(person, wid)));
// The answer, its tag, and the same computed with nothing kept.
async function check(person: Identity, label: string) {
  const response = await get(person);
  assert.equal(response.status, 200, label);
  const body = JSON.parse(await response.text());
  forget();
  const fresh = JSON.parse(JSON.stringify(await bootstrap(person, wid)));
  // The whole answer, kept parts and all, as if nothing had been kept.
  assert.deepEqual(body, fresh, `${label}: kept answer = fresh answer`);
  return { tag: response.headers.get("etag")!, ids: (body.pages as { id: string }[]).map((p) => p.id) };
}

test("the triggers move the versions with every write that can change the list or the roles", async () => {
  const yes = { roles: true, pages: true },
    rolesOnly = { roles: true, pages: false },
    pagesOnly = { roles: false, pages: true },
    neither = { roles: false, pages: false };
  const extra = id();
  await moves(() => run("INSERT INTO pages(id,workspace_id,space_id,title) VALUES(?,?,?,?)", extra, wid, team, "x"), yes, "page insert");
  await moves(() => run("UPDATE pages SET title='y' WHERE id=?", extra), pagesOnly, "title");
  await moves(() => run("UPDATE pages SET icon='star' WHERE id=?", extra), pagesOnly, "icon");
  await moves(() => run("UPDATE pages SET updated_at='2030-01-01 00:00:00' WHERE id=?", extra), pagesOnly, "updated_at");
  await moves(() => run("UPDATE pages SET deleted_at='2030-01-01 00:00:00' WHERE id=?", extra), pagesOnly, "trash");
  await moves(() => run("UPDATE pages SET kind='whiteboard' WHERE id=?", extra), pagesOnly, "kind");
  await moves(() => run("UPDATE pages SET parent_id=? WHERE id=?", doc, extra), yes, "parent");
  await moves(() => run("UPDATE pages SET parent_id=parent_id WHERE id=?", extra), pagesOnly, "parent unchanged");
  await moves(() => run("UPDATE pages SET space_id=? WHERE id=?", privateSpace, extra), yes, "space");
  await moves(() => run("UPDATE pages SET parent_id=?,parent_row_id=? WHERE id=?", database, record, extra), yes, "below a record");
  const other = await createWorkspace(owner.id, "Other");
  const otherBefore = await version(`pages:${other}`);
  await moves(() => run("UPDATE pages SET workspace_id=?,parent_id=NULL,parent_row_id=NULL WHERE id=?", other, extra), yes, "to another workspace");
  assert.notEqual(await version(`pages:${other}`), otherBefore, "the other workspace's list moves too");
  await moves(() => run("UPDATE pages SET workspace_id=? WHERE id=?", wid, extra), yes, "back");
  await moves(() => run("DELETE FROM pages WHERE id=?", extra), yes, "page delete");
  // Grants, memberships, guests, groups.
  await moves(() => run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", hidden, viewer.id, "", "viewer", "page", wid), rolesOnly, "grant");
  await moves(() => run("UPDATE grants SET role='editor' WHERE resource_id=? AND user_id=?", hidden, viewer.id), rolesOnly, "grant role");
  await moves(() => run("DELETE FROM grants WHERE resource_id=? AND user_id=?", hidden, viewer.id), rolesOnly, "grant delete");
  const someone = await user("someone");
  await moves(() => run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, someone.id, "viewer"), rolesOnly, "member");
  await moves(() => run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, someone.id), rolesOnly, "member role");
  await moves(() => run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, someone.id), rolesOnly, "guest");
  await moves(() => run("DELETE FROM workspace_guests WHERE workspace_id=? AND user_id=?", wid, someone.id), rolesOnly, "guest removed");
  const group = id();
  await moves(() => run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", group, wid, "G"), neither, "an empty group");
  await moves(() => run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", group, someone.id), rolesOnly, "group member");
  await moves(() => run("DELETE FROM groups WHERE id=?", group), rolesOnly, "group deleted (its members cascade)");
  await moves(() => run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, someone.id), rolesOnly, "member removed");
  // Spaces.
  const space = id();
  await moves(() => run("INSERT INTO spaces(id,workspace_id,name) VALUES(?,?,?)", space, wid, "S"), yes, "space");
  await moves(() => run("UPDATE spaces SET name='T' WHERE id=?", space), pagesOnly, "space name (schema 118: the sidebar shows it)");
  await moves(() => run("UPDATE spaces SET visibility='private' WHERE id=?", space), yes, "visibility");
  await moves(() => run("UPDATE spaces SET owner_id=? WHERE id=?", viewer.id, space), yes, "owner");
  await moves(() => run("UPDATE spaces SET deleted_at='2030-01-01 00:00:00' WHERE id=?", space), yes, "space trash");
  await moves(() => run("DELETE FROM spaces WHERE id=?", space), yes, "space delete");
  // Records: only those with their own access count.
  const plain = id(),
    own = id();
  await moves(() => run("INSERT INTO rows(id,page_id,cells,access) VALUES(?,?,?,?)", plain, database, "{}", "inherit"), neither, "a record that inherits");
  await moves(() => run("UPDATE rows SET cells='{\"title\":\"z\"}' WHERE id=?", plain), neither, "cells");
  await moves(() => run("UPDATE rows SET created_by=? WHERE id=?", viewer.id, plain), neither, "creator of a record that inherits");
  await moves(() => run("UPDATE rows SET access='private' WHERE id=?", plain), rolesOnly, "access");
  await moves(() => run("UPDATE rows SET created_by=? WHERE id=?", owner.id, plain), rolesOnly, "creator of a private record");
  await moves(() => run("INSERT INTO rows(id,page_id,cells,access) VALUES(?,?,?,?)", own, database, "{}", "readonly"), rolesOnly, "a read-only record");
  await moves(() => run("INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,?,?)", own, viewer.id, "", "editor"), rolesOnly, "record grant");
  await moves(() => run("DELETE FROM row_grants WHERE row_id=?", own), rolesOnly, "record grant removed");
  await moves(() => run("UPDATE rows SET page_id=? WHERE id=?", database, own), neither, "page_id unchanged");
  await moves(() => run("DELETE FROM rows WHERE id=?", own), rolesOnly, "a read-only record deleted");
  await moves(() => run("DELETE FROM rows WHERE id=?", plain), rolesOnly, "a private record deleted");
  const trashed = id();
  await moves(() => run("INSERT INTO rows(id,page_id,cells,access) VALUES(?,?,?,?)", trashed, database, "{}", "inherit"), neither, "record");
  await moves(() => run("INSERT INTO row_trash(id,page_id,workspace_id,title,payload) VALUES(?,?,?,?,?)", trashed, database, wid, "R", "{}"), rolesOnly, "record trash");
  await moves(() => run("DELETE FROM rows WHERE id=?", trashed), rolesOnly, "a record the trash knows (inherits)");
  await moves(() => run("INSERT INTO rows(id,page_id,cells,access) VALUES(?,?,?,?)", trashed, database, "{}", "inherit"), rolesOnly, "back from the trash (inherits)");
  await moves(() => run("DELETE FROM row_trash WHERE id=?", trashed), rolesOnly, "out of the trash");
  // Accounts: what member lists show of them.
  const people = async (write: () => Promise<unknown>, expected: boolean, label: string) => {
    const before = await version("people");
    await write();
    assert.equal((await version("people")) !== before, expected, label);
  };
  await people(() => run("UPDATE users SET name='Owner' WHERE id=?", owner.id), true, "name");
  await people(() => run("UPDATE users SET email='owner2@example.com' WHERE id=?", owner.id), true, "address");
  await people(() => run("UPDATE users SET avatar='a.png' WHERE id=?", owner.id), true, "avatar");
  await people(() => run("UPDATE users SET disabled=1 WHERE id=?", someone.id), true, "disabled");
  await people(() => run("UPDATE users SET name=name WHERE id=?", owner.id), false, "unchanged");
  await people(() => run("UPDATE users SET onboarded_at=1 WHERE id=?", owner.id), false, "another column");
  await people(() => run("DELETE FROM users WHERE id=?", someone.id), true, "deleted");
  // Writes elsewhere leave both alone.
  await moves(() => run("UPDATE users SET name='Owner' WHERE id=?", owner.id), neither, "a user");
  await moves(() => run("UPDATE documents SET html=html WHERE page_id=?", doc), neither, "a document");
});

test("every change of a source changes the ETag; the kept list equals a fresh one", async () => {
  let last = await check(viewer, "start");
  const changed = async (label: string, write: () => Promise<unknown>, person = viewer) => {
    await write();
    const now = await check(person, label);
    assert.notEqual(now.tag, last.tag, `${label}: new ETag`);
    last = now;
    return now;
  };
  // Unchanged: the same ETag, a 304.
  assert.equal((await get(viewer, last.tag)).status, 304);
  assert.equal((await check(viewer, "again")).tag, last.tag);
  // Sources of the list.
  await changed("title", () => run("UPDATE pages SET title='Doc 2' WHERE id=?", doc));
  await changed("icon", () => run("UPDATE pages SET icon='star' WHERE id=?", doc));
  await changed("position", () => run("UPDATE pages SET position=99 WHERE id=?", doc));
  await changed("trash", () => command(owner, { action: "page.delete", pageId: doc }));
  assert.ok(last.ids.includes(doc), "trashed pages stay in the list (the trash view)");
  await changed("new page", () => page({ title: "New" }));
  assert.ok(!last.ids.includes(hidden));
  const shown = await changed("page grant", () => run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", hidden, viewer.id, "", "viewer", "page", wid));
  assert.ok(shown.ids.includes(hidden));
  await changed("grant removed", () => run("DELETE FROM grants WHERE resource_id=? AND user_id=?", hidden, viewer.id));
  assert.ok(!last.ids.includes(hidden));
  const group = id();
  await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", group, wid, "G");
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", privateSpace, "", group, "viewer", "space", wid);
  await check(viewer, "group grant without members");
  await changed("group member", () => run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", group, viewer.id));
  assert.ok(last.ids.includes(hidden), "space shared with the group");
  await changed("left the group", () => run("DELETE FROM group_members WHERE group_id=? AND user_id=?", group, viewer.id));
  assert.ok(!last.ids.includes(hidden));
  await changed("space visibility", () => run("UPDATE spaces SET visibility='team' WHERE id=?", privateSpace));
  assert.ok(last.ids.includes(hidden));
  await changed("space owner", () => run("UPDATE spaces SET visibility='private',owner_id=? WHERE id=?", viewer.id, privateSpace));
  await changed("space trash", () => run("UPDATE spaces SET deleted_at='2030-01-01 00:00:00' WHERE id=?", privateSpace));
  assert.ok(!last.ids.includes(hidden));
  await run("UPDATE spaces SET deleted_at=NULL,owner_id=? WHERE id=?", owner.id, privateSpace);
  await check(viewer, "space back");
  // The page below a record follows the record's access.
  assert.ok(last.ids.includes(below));
  await changed("private record", () => run("UPDATE rows SET access='private' WHERE id=?", record));
  assert.ok(!last.ids.includes(below));
  await changed("record grant", () => run("INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,?,?)", record, viewer.id, "", "viewer"));
  assert.ok(last.ids.includes(below));
  await changed("record grant removed", () => run("DELETE FROM row_grants WHERE row_id=?", record));
  await changed("record creator", () => run("UPDATE rows SET created_by=? WHERE id=?", viewer.id, record));
  assert.ok(last.ids.includes(below));
  await run("UPDATE rows SET access='inherit',created_by=? WHERE id=?", owner.id, record);
  await check(viewer, "record inherits");
  // Membership: the role changes what the rest of the answer says as well.
  await changed("member role", () => run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, viewer.id));
  // Sources of the rest of the answer, built anew every time.
  await changed("notification", () =>
    run("INSERT INTO notifications(id,user_id,kind,body,created_at) VALUES(?,?,?,?,?)", id(), viewer.id, "mention", "Hallo", Date.now()),
  );
  await changed("favourite", () => run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", viewer.id, below));
  await changed("a member's name", () => run("UPDATE users SET name='Owner Two' WHERE id=?", owner.id));
  await changed("a member's avatar", () => run("UPDATE users SET avatar='b.png' WHERE id=?", owner.id));
  const newcomer = await user("newcomer");
  await changed("new member", () => run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, newcomer.id, "viewer"));
  await changed("member left", () => run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, newcomer.id));
  await changed("workspace name", () => run("UPDATE workspaces SET name='Cache 2' WHERE id=?", wid));
  // A guest: no workflows, only what is shared.
  const flow = await page({ title: "Flow", kind: "workflow" });
  let g = await check(guest, "guest");
  assert.ok(!g.ids.includes(flow));
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", flow, guest.id, "", "viewer", "page", wid);
  g = await check(guest, "guest with a workflow grant");
  assert.ok(!g.ids.includes(flow), "still no workflow for guests");
  await run("DELETE FROM workspace_guests WHERE workspace_id=? AND user_id=?", wid, guest.id);
  g = await check(guest, "no longer a guest");
  assert.ok(g.ids.includes(flow));
});

test("people do not share a list or an ETag; a rolled back change leaves nothing behind", async () => {
  const a = await check(owner, "owner"),
    b = await check(viewer, "viewer");
  assert.notEqual(a.tag, b.tag);
  assert.equal((await get(viewer, a.tag)).status, 200, "another person's ETag is no match");
  // A grant inside a transaction that fails: not kept, not shown.
  await assert.rejects(
    transaction(async () => {
      await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?)", hidden, viewer.id, "", "viewer", "page", wid);
      // Asked inside the transaction: computed, not kept.
      assert.ok((await bootstrap(viewer, wid)).pages.some((p) => p.id === hidden));
      throw new Error("rolled back");
    }),
    /rolled back/,
  );
  const after = await check(viewer, "after the rollback");
  assert.ok(!after.ids.includes(hidden));
  assert.equal(after.tag, b.tag);
});

test("a kept page is frozen: a caller that changed it would fail instead of changing it for everyone", async () => {
  await get(viewer);
  const answer = await withReadMemo(async () => await bootstrap(viewer, wid));
  assert.ok(Object.isFrozen(answer.pages[0]));
});
