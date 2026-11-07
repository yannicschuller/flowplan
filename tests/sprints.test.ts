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

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Scrum"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Backlog" })).id as string;
await act({
  action: "database.update",
  pageId,
  version: (await database(pageId)).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
    { id: "sp", name: "Points", type: "number" },
  ],
  views: (await database(pageId)).views,
});
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;

test("setup, planning, completing and charts", async () => {
  const { viewId } = await act({ action: "sprint.setup", pageId });
  const db = await database(pageId);
  const field = db.fields.find((f) => f.type === "sprint")!;
  assert.ok(db.views.some((v) => v.id === viewId && v.type === "sprint"));
  const [first] = db.settings!.sprints!;
  const second = await act({ action: "sprint.create", pageId });
  assert.equal(second.start > first.end, true);
  await act({ action: "sprint.points", pageId, pointsField: "sp" });
  const a = (await act({ action: "row.create", pageId, cells: { title: "A", status: "Todo", sp: 3, [field.id]: first.id } })).id;
  const b = (await act({ action: "row.create", pageId, cells: { title: "B", status: "Todo", sp: 5, [field.id]: first.id } })).id;
  await assert.rejects(async () => await act({ action: "row.update", pageId, rowId: a, version: await version(a), cells: { [field.id]: "nope" } }), /Unbekannter Sprint/);
  await act({ action: "sprint.start", pageId, sprintId: first.id });
  await assert.rejects(async () => await act({ action: "sprint.start", pageId, sprintId: second.id }), /läuft schon/);
  await act({ action: "row.update", pageId, rowId: a, version: await version(a), cells: { status: "Done" } });
  const charts = await sprintCharts(owner, pageId, first.id);
  assert.equal(charts.total, 8);
  assert.equal(charts.ideal[0], 8);
  assert.equal(charts.remaining.filter((v) => v !== null).at(-1), 5);
  const done = await act({ action: "sprint.complete", pageId, sprintId: first.id });
  assert.equal(done.moved, 1);
  assert.equal((await cells(b))[field.id], second.id);
  assert.equal((await cells(a))[field.id], first.id);
  const closed = (await database(pageId)).settings!.sprints!.find((s) => s.id === first.id)!;
  assert.deepEqual([closed.state, closed.completed, closed.committed], ["closed", 3, 8]);
  assert.deepEqual((await sprintCharts(owner, pageId, second.id)).velocity, [{ name: first.name, completed: 3, committed: 8 }]);
});

test("a sprint is renamed and rescheduled; deleting it moves its records back to the backlog", async () => {
  const field = (await database(pageId)).fields.find((f) => f.type === "sprint")!;
  const sprint = await act({ action: "sprint.create", pageId });
  const updated = await act({ action: "sprint.update", pageId, sprintId: sprint.id, name: "Release 2", start: "2027-01-04", end: "2027-01-15", goal: "Ship it" });
  assert.deepEqual([updated.name, updated.start, updated.end, updated.goal], ["Release 2", "2027-01-04", "2027-01-15", "Ship it"]);
  await assert.rejects(async () => await act({ action: "sprint.update", pageId, sprintId: sprint.id, name: "Backwards", start: "2027-01-15", end: "2027-01-04" }), /Ende liegt vor dem Start/);
  await assert.rejects(async () => await act({ action: "sprint.update", pageId, sprintId: sprint.id, name: "", start: "2027-01-04", end: "2027-01-15" }));
  const stored = (await database(pageId)).settings!.sprints!.find((s) => s.id === sprint.id)!;
  assert.equal(stored.name, "Release 2");
  const planned = (await act({ action: "row.create", pageId, cells: { title: "Planned", [field.id]: sprint.id } })).id;
  const other = (await act({ action: "row.create", pageId, cells: { title: "Elsewhere" } })).id;
  const before = await version(planned);
  await act({ action: "sprint.delete", pageId, sprintId: sprint.id });
  assert.equal((await database(pageId)).settings!.sprints!.some((s) => s.id === sprint.id), false);
  assert.equal((await cells(planned))[field.id], "");
  assert.equal(await version(planned), before + 1);
  assert.equal((await cells(other)).title, "Elsewhere");
  await assert.rejects(async () => await act({ action: "sprint.delete", pageId, sprintId: sprint.id }));
  // Viewers change no sprints.
  const viewer = await user("viewer");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const next = await act({ action: "sprint.create", pageId });
  await assert.rejects(async () => await command(viewer, { action: "sprint.delete", pageId, sprintId: next.id }), (e: { status?: number }) => e.status === 403);
});
