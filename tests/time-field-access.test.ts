// Audit (Nov 2026): a time property can carry its own read and write rule,
// but its entries and total (GET /api/time) and the weekly time report
// ignored it, and anyone who may edit the record started timers or added
// entries on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-time-access-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const api = await import("../lib/api");
const { recordTime, timeReport } = await import("../lib/time-tracking");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
type Result = { id: string } & Record<string, unknown>;
const owner = account("Olga"),
  editor = account("Eddi");
const wid = createWorkspace(owner.id, "Firma");
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = (input: Record<string, unknown>, as = owner) => api.command(as, input) as Result;
const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? String(e);
  }
};
const team = act({ action: "space.create", workspaceId: wid, name: "Team" }).id;
const db = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Mandate", kind: "database", databaseKind: "empty" }).id;
const d = api.database(db);
act({
  action: "database.update",
  pageId: db,
  version: d.version,
  views: d.views,
  fields: [
    ...d.fields,
    { id: "billable", name: "Abrechenbar", type: "time", access: { read: "owners", write: "owners" } },
    { id: "spent", name: "Aufwand", type: "time" },
  ],
});
const page = one<Page>("SELECT * FROM pages WHERE id=?", db)!;
const rid = act({ action: "row.create", pageId: db, cells: { [d.fields[0].id]: "Mandat A" } }).id;
const today = new Date().toISOString().slice(0, 10);
act({ action: "time.add", pageId: db, rowId: rid, fieldId: "billable", minutes: 420, date: today, note: "Geheimes Gutachten" });

test("entries of a hidden time property stay with those who may read it", () => {
  assert.equal(status(() => recordTime(editor, page, rid, "billable")), 404);
  assert.equal(recordTime(owner, page, rid, "billable").total, 420 * 60);
  // The weekly report counts only time properties the reader may read.
  act({ action: "time.add", pageId: db, rowId: rid, fieldId: "spent", minutes: 30, date: today }, editor);
  act({ action: "time.add", pageId: db, rowId: rid, fieldId: "billable", minutes: 60, date: today });
  const forEditor = timeReport(editor, db);
  assert.deepEqual(forEditor.records.map((r) => r.seconds), [30 * 60]);
  assert.equal(JSON.stringify(forEditor).includes("Olga"), false);
  assert.deepEqual(timeReport(owner, db).records.map((r) => r.seconds), [510 * 60]);
});

test("only people who may write a time property track time on it", () => {
  assert.equal(status(() => act({ action: "time.start", pageId: db, rowId: rid, fieldId: "billable" }, editor)), 403);
  assert.equal(status(() => act({ action: "time.add", pageId: db, rowId: rid, fieldId: "billable", minutes: 5, date: today }, editor)), 403);
  assert.equal(status(() => act({ action: "time.start", pageId: db, rowId: rid, fieldId: "spent" }, editor)), 200);
  assert.equal(status(() => act({ action: "time.stop", pageId: db, rowId: rid, fieldId: "spent" }, editor)), 200);
});
