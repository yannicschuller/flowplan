import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-memo-383-"));
const { id, run, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { withReadMemo } = await import("../lib/read-memo");
const { encryptedSpace } = await import("../lib/e2ee-server");
const { rowRoleResolver } = await import("../lib/row-access");

// #383: the encryption check of a space and the record grants of a database
// are looked up once per request (read memo), and again after a write.
const account = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const owner = await account("m383-owner"),
  member = await account("m383-member");
const wid = await createWorkspace(owner.id, "Memo 383");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const space = (await bootstrap(owner, wid)).spaces[0];

test("encryptedSpace is remembered within a request until the next write", async () => {
  await withReadMemo(async () => {
    assert.equal(await encryptedSpace(space.id), null);
    await run("UPDATE spaces SET encrypted=1 WHERE id=?", space.id);
    const first = await encryptedSpace(space.id);
    assert.equal(first?.id, space.id, "the write is seen");
    assert.equal(await encryptedSpace(space.id), first, "asked once");
    await run("UPDATE spaces SET encrypted=0 WHERE id=?", space.id);
    assert.equal(await encryptedSpace(space.id), null);
  });
  // Outside a request nothing is remembered.
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", space.id);
  const a = await encryptedSpace(space.id),
    b = await encryptedSpace(space.id);
  assert.ok(a && b && a !== b);
  await run("UPDATE spaces SET encrypted=0 WHERE id=?", space.id);
});

test("record grants are read once per database and request, again after a write", async () => {
  const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Akten", kind: "database" })) as { id: string }).id;
  const rowId = ((await command(owner, { action: "row.create", pageId, cells: { title: "Privat" } })) as { id: string }).id;
  await run("UPDATE rows SET access='private' WHERE id=?", rowId);
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
  const record = (await one<{ id: string; access: string; created_by: string }>("SELECT id,access,created_by FROM rows WHERE id=?", rowId))!;
  await withReadMemo(async () => {
    assert.equal((await rowRoleResolver(member, page))(record), null);
    await run("INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,'',?)", rowId, member.id, "viewer");
    const resolve = await rowRoleResolver(member, page);
    assert.equal(resolve(record), "viewer", "the new grant is seen");
    assert.equal((await rowRoleResolver(member, page))(record), "viewer");
    // The owner's resolver is a different one.
    assert.equal((await rowRoleResolver(owner, page))(record), "owner");
    await run("DELETE FROM row_grants WHERE row_id=?", rowId);
    assert.equal((await rowRoleResolver(member, page))(record), null);
  });
});
