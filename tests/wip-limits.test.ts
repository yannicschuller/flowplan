import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, View } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wip-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner");
const wid = createWorkspace(owner.id, "WIP"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Board" }).id as string;

test("a locked column takes no more records than its limit", () => {
  const board: View = { id: "board", name: "Board", type: "board", groupBy: "status", filters: [], sorts: [], wip: { [JSON.stringify("In Arbeit")]: { max: 1, lock: true } } };
  act({
    action: "database.update",
    pageId,
    version: database(pageId).version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit"] },
    ],
    views: [board],
  });
  const key = Object.keys(database(pageId).views[0].wip!)[0];
  assert.equal(key, JSON.stringify("In Arbeit"));
  const a = act({ action: "row.create", pageId, cells: { title: "A", status: "Offen" } }).id;
  const b = act({ action: "row.create", pageId, cells: { title: "B", status: "Offen" } }).id;
  const version = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;
  act({ action: "row.update", pageId, rowId: a, version: version(a), cells: { status: "In Arbeit" } });
  assert.throws(() => act({ action: "row.update", pageId, rowId: b, version: version(b), cells: { status: "In Arbeit" } }), /ist voll \(höchstens 1\)/);
  // Without the lock the column is only marked.
  act({ action: "database.update", pageId, version: database(pageId).version, fields: database(pageId).fields, views: [{ ...board, wip: { [JSON.stringify("In Arbeit")]: { max: 1 } } }] });
  act({ action: "row.update", pageId, rowId: b, version: version(b), cells: { status: "In Arbeit" } });
});
