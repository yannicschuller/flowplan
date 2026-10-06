import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-sprints-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { sprintCharts } = await import("../lib/sprints");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner");
const wid = createWorkspace(owner.id, "Scrum"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Backlog" }).id as string;
act({
  action: "database.update",
  pageId,
  version: database(pageId).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
    { id: "sp", name: "Points", type: "number" },
  ],
  views: database(pageId).views,
});
const cells = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);
const version = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;

test("setup, planning, completing and charts", () => {
  const { viewId } = act({ action: "sprint.setup", pageId });
  const db = database(pageId);
  const field = db.fields.find((f) => f.type === "sprint")!;
  assert.ok(db.views.some((v) => v.id === viewId && v.type === "sprint"));
  const [first] = db.settings!.sprints!;
  const second = act({ action: "sprint.create", pageId });
  assert.equal(second.start > first.end, true);
  act({ action: "sprint.points", pageId, pointsField: "sp" });
  const a = act({ action: "row.create", pageId, cells: { title: "A", status: "Todo", sp: 3, [field.id]: first.id } }).id;
  const b = act({ action: "row.create", pageId, cells: { title: "B", status: "Todo", sp: 5, [field.id]: first.id } }).id;
  assert.throws(() => act({ action: "row.update", pageId, rowId: a, version: version(a), cells: { [field.id]: "nope" } }), /Unbekannter Sprint/);
  act({ action: "sprint.start", pageId, sprintId: first.id });
  assert.throws(() => act({ action: "sprint.start", pageId, sprintId: second.id }), /läuft schon/);
  act({ action: "row.update", pageId, rowId: a, version: version(a), cells: { status: "Done" } });
  const charts = sprintCharts(owner, pageId, first.id);
  assert.equal(charts.total, 8);
  assert.equal(charts.ideal[0], 8);
  assert.equal(charts.remaining.filter((v) => v !== null).at(-1), 5);
  const done = act({ action: "sprint.complete", pageId, sprintId: first.id });
  assert.equal(done.moved, 1);
  assert.equal(cells(b)[field.id], second.id);
  assert.equal(cells(a)[field.id], first.id);
  const closed = database(pageId).settings!.sprints!.find((s) => s.id === first.id)!;
  assert.deepEqual([closed.state, closed.completed, closed.committed], ["closed", 3, 8]);
  assert.deepEqual(sprintCharts(owner, pageId, second.id).velocity, [{ name: first.name, completed: 3, committed: 8 }]);
});
