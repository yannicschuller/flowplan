import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-derived-access-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { rowDocumentData, replaceRowDocument } = await import("../lib/row-documents");
const { rowRole } = await import("../lib/row-access");

// Records derived from another record (a detached occurrence, the next
// occurrence of a repeating task) keep its creator and record permissions.

async function account(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
}
const page = async (p: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", p))!;
const row = async (r: string) =>
  (await one<{ id: string; access: string; created_by: string; version: number; cells: string }>(
    "SELECT id,access,created_by,version,cells FROM rows WHERE id=?",
    r,
  ))!;
const status = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
async function setup(tag: string) {
  const owner = await account(`${tag}-owner`),
    alice = await account(`${tag}-alice`),
    bob = await account(`${tag}-bob`),
    carol = await account(`${tag}-carol`);
  const wid = await createWorkspace(owner.id, tag);
  await run("INSERT INTO members VALUES(?,?,?)", wid, alice.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, bob.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", wid, carol.id, "viewer");
  const db = ((await command(owner, {
    action: "page.create",
    workspaceId: wid,
    spaceId: (await bootstrap(owner, wid)).spaces[0].id,
    title: tag,
    kind: "database",
    databaseKind: "empty",
  })) as { id: string }).id;
  return { owner, alice, bob, carol, db };
}

test("a detached occurrence keeps the creator, access and grants of its series (#486)", async () => {
  const { owner, alice, bob, carol, db } = await setup("detach");
  await command(owner, {
    action: "database.update",
    pageId: db,
    version: (await database(db)).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
    ],
    views: (await database(db)).views,
  });
  const rid = ((await command(alice, {
    action: "row.create",
    pageId: db,
    cells: { title: "Private series", start: "2026-03-02T09:00", end: "2026-03-02T10:00" },
  })) as { id: string }).id;
  await command(alice, { action: "row.recurrence", pageId: db, rowId: rid, version: (await row(rid)).version, recurrence: { freq: "weekly", interval: 1 } });
  await replaceRowDocument(rid, "<p>DUMMY-NOTE</p>", alice.id);
  await command(alice, { action: "row.access", pageId: db, rowId: rid, access: "private", grants: [{ userId: bob.id, role: "editor" }] });
  assert.equal(await status(rowDocumentData(carol, db, rid)), 404);

  for (const [who, date, mode] of [
    [alice, "2026-03-16", "single"],
    [bob, "2026-03-30", "following"],
  ] as const) {
    const copy = ((await command(who, {
      action: "row.detachOccurrence",
      pageId: db,
      rowId: rid,
      version: (await row(rid)).version,
      date,
      startField: "start",
      endField: "end",
      mode,
    })) as { id: string }).id;
    const r = await row(copy);
    assert.equal(r.access, "private");
    assert.equal(r.created_by, alice.id);
    assert.equal(await rowRole(carol, await page(db), r), null);
    assert.equal(await status(rowDocumentData(carol, db, copy)), 404);
    assert.equal(await rowRole(alice, await page(db), r), "editor");
    assert.equal(await rowRole(bob, await page(db), r), "editor");
    // A grantee who detached does not manage the copy.
    assert.equal(
      await status(command(bob, { action: "row.access", pageId: db, rowId: copy, access: "inherit", grants: [] })),
      403,
    );
  }
});

test("the next occurrence of a repeating record keeps its creator and grants (#487)", async () => {
  const { owner, alice, bob, carol, db } = await setup("repeat");
  await command(owner, {
    action: "database.update",
    pageId: db,
    version: (await database(db)).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "due", name: "Fällig", type: "date" },
    ],
    views: (await database(db)).views,
  });
  const rid = ((await command(alice, {
    action: "row.create",
    pageId: db,
    cells: { title: "Repeating task", status: "Offen", due: "2026-01-31" },
  })) as { id: string }).id;
  await command(alice, { action: "row.repeat", pageId: db, rowId: rid, version: (await row(rid)).version, repeat: { freq: "monthly", interval: 1, field: "due" } });
  await command(alice, {
    action: "row.access",
    pageId: db,
    rowId: rid,
    access: "private",
    grants: [{ userId: bob.id, role: "editor" }, { userId: carol.id, role: "viewer" }],
  });
  await command(bob, { action: "row.update", pageId: db, rowId: rid, version: (await row(rid)).version, cells: { status: "Erledigt" } });
  const next = (await one<{ id: string }>("SELECT id FROM rows WHERE page_id=? AND id<>?", db, rid))!;
  const r = await row(next.id);
  assert.equal(r.access, "private");
  assert.equal(r.created_by, alice.id);
  assert.equal(await rowRole(alice, await page(db), r), "editor");
  assert.equal(await rowRole(bob, await page(db), r), "editor");
  assert.equal(await rowRole(carol, await page(db), r), "viewer");
  assert.equal(
    await status(command(bob, { action: "row.access", pageId: db, rowId: next.id, access: "private", grants: [] })),
    403,
  );
});
