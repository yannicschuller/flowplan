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
function user(name: string): Identity {
  const uid = id();
  run(
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
const owner = user("owner"),
  alice = user("alice"),
  bob = user("bob"),
  wid = createWorkspace(owner.id, "Rechte"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, alice.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
const fails = (fn: () => unknown, status: number) =>
  assert.throws(fn, (e: any) => e.status === status);
const pid = (
  command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Personalakten",
    kind: "database",
  }) as { id: string }
).id;
const row = (who: Identity, title: string) =>
  (
    command(who, { action: "row.create", pageId: pid, cells: { title } }) as {
      id: string;
    }
  ).id;
const version = (rid: string) =>
  Number(one("SELECT version FROM rows WHERE id=?", rid)?.version);
const update = (who: Identity, rid: string, title: string) =>
  command(who, {
    action: "row.update",
    pageId: pid,
    rowId: rid,
    version: version(rid),
    cells: { title },
  });
const titles = (who: Identity) =>
  ((pageData(who, pid) as any).rows as { cells: { title: string } }[]).map(
    (r) => r.cells.title,
  );

test("records can be read-only or private with grants for people and groups", () => {
  const secret = row(alice, "Gehalt Alice"),
    fixed = row(owner, "Richtlinie"),
    open = row(owner, "Offen");
  // Only managers (database owners and the creator) change permissions.
  fails(
    () =>
      command(bob, {
        action: "row.access",
        pageId: pid,
        rowId: secret,
        access: "private",
        grants: [],
      }),
    403,
  );
  command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [],
  });
  command(owner, {
    action: "row.access",
    pageId: pid,
    rowId: fixed,
    access: "readonly",
    grants: [],
  });
  assert.deepEqual(titles(bob), ["Richtlinie", "Offen"]);
  assert.deepEqual(titles(alice), ["Gehalt Alice", "Richtlinie", "Offen"]);
  assert.deepEqual(titles(owner), ["Gehalt Alice", "Richtlinie", "Offen"]);
  const roles = Object.fromEntries(
    ((pageData(bob, pid) as any).rows as { id: string; role: string }[]).map((r) => [
      r.id,
      r.role,
    ]),
  );
  assert.equal(roles[fixed], "viewer");
  assert.equal(roles[open], "editor");
  fails(() => rowDocumentData(bob, pid, secret), 404);
  fails(() => update(bob, secret, "x"), 404);
  fails(() => update(bob, fixed, "x"), 403);
  fails(
    () => command(bob, { action: "row.delete", pageId: pid, rowId: fixed }),
    403,
  );
  update(bob, open, "Offen 2");
  update(owner, fixed, "Richtlinie 2");
  // Bulk changes stop at read-only records.
  fails(
    () =>
      command(bob, {
        action: "rows.bulk",
        pageId: pid,
        operation: "update",
        rows: [{ id: fixed, version: version(fixed) }],
        cells: { title: "y" },
      }),
    403,
  );
  // Search leaves out private records.
  assert.ok(
    !searchWorkspace(bob, wid, "Gehalt").some((r) => r.rowId === secret),
  );
  assert.ok(
    searchWorkspace(alice, wid, "Gehalt").some((r) => r.rowId === secret),
  );
  // A group grant opens the private record for reading, a person grant for editing.
  const gid = (
    command(owner, {
      action: "group.create",
      workspaceId: wid,
      name: "HR",
    }) as {
      id: string;
    }
  ).id;
  run("INSERT INTO group_members VALUES(?,?)", gid, bob.id);
  command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [{ groupId: gid, role: "viewer" }],
  });
  assert.ok(titles(bob).includes("Gehalt Alice"));
  fails(() => update(bob, secret, "x"), 403);
  command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [{ userId: bob.id, role: "editor" }],
  });
  update(bob, secret, "Gehalt Alice 2");
  // Editor grants on read-only records allow changes.
  command(owner, {
    action: "row.access",
    pageId: pid,
    rowId: fixed,
    access: "readonly",
    grants: [{ userId: bob.id, role: "editor" }],
  });
  update(bob, fixed, "Richtlinie 3");
  command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: secret,
    access: "private",
    grants: [],
  });
  assert.ok(!titles(bob).includes("Gehalt Alice 2"));
});

test("private records stay hidden in copies, trash, versions and public pages", async () => {
  const hidden = row(alice, "Vertraulich");
  command(alice, {
    action: "row.access",
    pageId: pid,
    rowId: hidden,
    access: "private",
    grants: [{ userId: owner.id, role: "viewer" }],
  });
  // Copies by someone without access leave the record out.
  const copy = (
    command(bob, { action: "page.duplicate", pageId: pid }) as { id: string }
  ).id;
  assert.ok(
    !((pageData(bob, copy) as any).rows as { cells: { title: string } }[]).some(
      (r) => r.cells.title === "Vertraulich",
    ),
  );
  // Public pages and share links never show private records.
  command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const token = String(
    one("SELECT public_token FROM pages WHERE id=?", pid)?.public_token,
  );
  fails(() => sharedContent(token, pid, hidden), 404);
  // Trash keeps the permissions.
  command(alice, { action: "row.delete", pageId: pid, rowId: hidden });
  assert.ok(!listRowTrash(bob, wid).some((t) => t.id === hidden));
  assert.ok(listRowTrash(alice, wid).some((t) => t.id === hidden));
  command(alice, { action: "row.trash.restore", trashId: hidden });
  assert.equal(
    one("SELECT access FROM rows WHERE id=?", hidden)?.access,
    "private",
  );
  assert.equal(
    one(
      "SELECT role FROM row_grants WHERE row_id=? AND user_id=?",
      hidden,
      owner.id,
    )?.role,
    "viewer",
  );
  // Versions with restricted records are restored by owners only.
  const { databaseSnapshot } = await import("../lib/database-operations");
  const page = one<any>("SELECT * FROM pages WHERE id=?", pid);
  const snapshot = databaseSnapshot(owner, page);
  fails(
    () =>
      command(bob, {
        action: "snapshot.restore",
        pageId: pid,
        snapshotId: snapshot,
      }),
    403,
  );
});
