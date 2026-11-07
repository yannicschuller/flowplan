import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-row-access-"),
);
const { id, run, one } = await import("../lib/db");
const { command, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { rowDocumentData } = await import("../lib/row-documents");
const { searchWorkspace } = await import("../lib/search-index");
const { sharedContent } = await import("../lib/shared-content");
const { listRowTrash } = await import("../lib/row-trash");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.com`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.com`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = await user("owner"),
  alice = await user("alice"),
  bob = await user("bob"),
  wid = await createWorkspace(owner.id, "Rechte"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, alice.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
const fails = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: any) => e.status === status);
const pid = (
  (await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Personalakten",
    kind: "database",
  })) as { id: string }
).id;
const row = async (who: Identity, title: string) =>
  (
    (await command(who, { action: "row.create", pageId: pid, cells: { title } })) as {
      id: string;
    }
  ).id;
const version = async (rid: string) =>
  Number((await one("SELECT version FROM rows WHERE id=?", rid))?.version);
const update = async (who: Identity, rid: string, title: string) =>
  await command(who, {
    action: "row.update",
    pageId: pid,
    rowId: rid,
    version: await version(rid),
    cells: { title },
  });
const titles = async (who: Identity) =>
  (((await pageData(who, pid)) as any).rows as { cells: { title: string } }[]).map(
    (r) => r.cells.title,
  );

test("records can be read-only or private with grants for people and groups", async () => {
  const secret = await row(alice, "Gehalt Alice"),
    fixed = await row(owner, "Richtlinie"),
    open = await row(owner, "Offen");
  // Only managers (database owners and the creator) change permissions.
  fails(
    async () =>
      await command(bob, {
        action: "row.access",
        pageId: pid,
        rowId: secret,
        access: "private",
        grants: [],
      }),
    403,
  );
  await command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [],
  });
  await command(owner, {
    action: "row.access",
    pageId: pid,
    rowId: fixed,
    access: "readonly",
    grants: [],
  });
  assert.deepEqual(await titles(bob), ["Richtlinie", "Offen"]);
  assert.deepEqual(await titles(alice), ["Gehalt Alice", "Richtlinie", "Offen"]);
  assert.deepEqual(await titles(owner), ["Gehalt Alice", "Richtlinie", "Offen"]);
  const roles = Object.fromEntries(
    (((await pageData(bob, pid)) as any).rows as { id: string; role: string }[]).map((r) => [
      r.id,
      r.role,
    ]),
  );
  assert.equal(roles[fixed], "viewer");
  assert.equal(roles[open], "editor");
  fails(async () => await rowDocumentData(bob, pid, secret), 404);
  fails(async () => await update(bob, secret, "x"), 404);
  fails(async () => await update(bob, fixed, "x"), 403);
  fails(
    async () => await command(bob, { action: "row.delete", pageId: pid, rowId: fixed }),
    403,
  );
  await update(bob, open, "Offen 2");
  await update(owner, fixed, "Richtlinie 2");
  // Bulk changes stop at read-only records.
  fails(
    async () =>
      await command(bob, {
        action: "rows.bulk",
        pageId: pid,
        operation: "update",
        rows: [{ id: fixed, version: await version(fixed) }],
        cells: { title: "y" },
      }),
    403,
  );
  // Search leaves out private records.
  assert.ok(
    !(await searchWorkspace(bob, wid, "Gehalt")).some((r) => r.rowId === secret),
  );
  assert.ok(
    (await searchWorkspace(alice, wid, "Gehalt")).some((r) => r.rowId === secret),
  );
  // A group grant opens the private record for reading, a person grant for editing.
  const gid = (
    (await command(owner, {
      action: "group.create",
      workspaceId: wid,
      name: "HR",
    })) as {
      id: string;
    }
  ).id;
  await run("INSERT INTO group_members VALUES(?,?)", gid, bob.id);
  await command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [{ groupId: gid, role: "viewer" }],
  });
  assert.ok((await titles(bob)).includes("Gehalt Alice"));
  fails(async () => await update(bob, secret, "x"), 403);
  await command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [{ userId: bob.id, role: "editor" }],
  });
  await update(bob, secret, "Gehalt Alice 2");
  // Editor grants on read-only records allow changes.
  await command(owner, {
    action: "row.access",
    pageId: pid,
    rowId: fixed,
    access: "readonly",
    grants: [{ userId: bob.id, role: "editor" }],
  });
  await update(bob, fixed, "Richtlinie 3");
  await command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [],
  });
  assert.ok(!(await titles(bob)).includes("Gehalt Alice 2"));
});

test("private records stay hidden in copies, trash, versions and public pages", async () => {
  const hidden = await row(alice, "Vertraulich");
  await command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: hidden,
    access: "private",
    grants: [{ userId: owner.id, role: "viewer" }],
  });
  // Copies by someone without access leave the record out.
  const copy = (
    (await command(bob, { action: "page.duplicate", pageId: pid })) as { id: string }
  ).id;
  assert.ok(
    !(((await pageData(bob, copy)) as any).rows as { cells: { title: string } }[]).some(
      (r) => r.cells.title === "Vertraulich",
    ),
  );
  // Public pages and share links never show private records.
  await command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const token = String(
    (await one("SELECT public_token FROM pages WHERE id=?", pid))?.public_token,
  );
  fails(async () => await sharedContent(token, pid, hidden), 404);
  // Trash keeps the permissions.
  await command(alice, { action: "row.delete", pageId: pid, rowId: hidden });
  assert.ok(!(await listRowTrash(bob, wid)).some((t) => t.id === hidden));
  assert.ok((await listRowTrash(alice, wid)).some((t) => t.id === hidden));
  await command(alice, { action: "row.trash.restore", trashId: hidden });
  assert.equal(
    (await one("SELECT access FROM rows WHERE id=?", hidden))?.access,
    "private",
  );
  assert.equal(
    (await one(
      "SELECT role FROM row_grants WHERE row_id=? AND user_id=?",
      hidden,
      owner.id,
    ))?.role,
    "viewer",
  );
  // Versions with restricted records are restored by owners only.
  const { databaseSnapshot } = await import("../lib/database-operations");
  const page = await one<any>("SELECT * FROM pages WHERE id=?", pid);
  const snapshot = await databaseSnapshot(owner, page);
  fails(
    async () =>
      await command(bob, {
        action: "snapshot.restore",
        pageId: pid,
        snapshotId: snapshot,
      }),
    403,
  );
});
