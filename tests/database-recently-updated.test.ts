// #369: changing a record counts as editing its database – the database
// moves up in "Recently updated" on the start page (pages.updated_at),
// as it does when a record is added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-db-recent-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "recent", "recent@example.test");
const owner = { id: uid, name: "recent", email: "recent@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Haus");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>) => (await command(owner, input)) as { id: string } & Record<string, unknown>;
const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, title: "Aufgaben", kind: "database" })).id;
const stamp = async () => String((await one<{ updated_at: string }>("SELECT updated_at FROM pages WHERE id=?", db))!.updated_at);
const old = "2000-01-01 00:00:00";
const backdate = () => run("UPDATE pages SET updated_at=? WHERE id=?", old, db);

test("adding, changing, deleting and restoring a record touches its database (#369)", async () => {
  await backdate();
  const row = (await act({ action: "row.create", pageId: db, cells: { title: "Steuer" } })).id;
  assert.notEqual(await stamp(), old, "row.create");

  await backdate();
  const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", row))!.version;
  await act({ action: "row.update", pageId: db, rowId: row, version, cells: { title: "Steuererklärung" } });
  assert.notEqual(await stamp(), old, "row.update");

  await backdate();
  await act({ action: "row.delete", pageId: db, rowId: row });
  assert.notEqual(await stamp(), old, "row.delete");

  await backdate();
  await act({ action: "row.trash.restore", trashId: row });
  assert.notEqual(await stamp(), old, "row.trash.restore");
});
