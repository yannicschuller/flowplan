import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-auto-"));
const { id, run, one, all, transaction } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { processOverdueAutomations } = await import("../lib/automations");
const { doneRule } = await import("../lib/database-settings-schema");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  editor = user("editor");
const wid = createWorkspace(owner.id, "Auto"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = (body: Record<string, unknown>, who = owner): any => command(who, body);
const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Doing", "Done"] },
  { id: "solution", name: "Solution", type: "text" },
  { id: "closed", name: "Closed on", type: "date" },
  { id: "due", name: "Due", type: "date" },
  { id: "owner", name: "Owner", type: "person" },
];
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Tickets" }).id as string;
act({ action: "database.update", pageId, version: database(pageId).version, fields, views: database(pageId).views });
const cells = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);
const version = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;
const update = (rid: string, patch: Record<string, unknown>, who = owner) =>
  act({ action: "row.update", pageId, rowId: rid, version: version(rid), cells: patch }, who);
const settings = (patch: Record<string, unknown>) => act({ action: "database.settings", pageId, settings: patch });

test("done is recognised without configuration", () => {
  const rule = doneRule(fields, {});
  assert.equal(rule?.field.id, "status");
  assert.deepEqual(rule?.values, ["Done"]);
});

test("workflow: allowed steps, required properties, owners only", () => {
  settings({
    workflow: { field: "status", transitions: { Open: ["Doing"], Doing: ["Open", "Done"] }, required: { Done: ["solution"] }, ownersOnly: ["Done"] },
  });
  const rid = act({ action: "row.create", pageId, cells: { title: "A", status: "Open" } }).id;
  assert.throws(() => update(rid, { status: "Done" }), /nicht vorgesehen/);
  update(rid, { status: "Doing" });
  assert.throws(() => update(rid, { status: "Done" }), /braucht: Solution/);
  update(rid, { solution: "Fixed" }, editor);
  assert.throws(() => update(rid, { status: "Done" }, editor), /nur Verantwortliche/);
  update(rid, { status: "Done" });
  assert.equal(cells(rid).status, "Done");
  settings({ workflow: null });
});

test("automations: set a date when done, assign new form records", () => {
  settings({
    automations: [
      { id: "a1", name: "Closed date", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "set", field: "closed", value: "@today" }] },
      { id: "a2", name: "Assign", trigger: { type: "created" }, conditions: [{ field: "status", op: "empty", value: "" }], actions: [{ type: "set", field: "owner", value: "@actor" }, { type: "set", field: "status", value: "Open" }] },
    ],
  });
  const rid = act({ action: "row.create", pageId, cells: { title: "B" } }, editor).id;
  assert.equal(cells(rid).owner, editor.id);
  assert.equal(cells(rid).status, "Open");
  update(rid, { status: "Done" });
  assert.equal(cells(rid).closed, new Date().toISOString().slice(0, 10));
  // Records that were done are logged for sprint charts.
  assert.ok(one("SELECT 1 FROM row_status_log WHERE row_id=? AND done=1", rid));
});

test("overdue rules notify once per due date", () => {
  settings({
    automations: [
      { id: "late", name: "Late", trigger: { type: "overdue", field: "due" }, actions: [{ type: "notify", to: "field:owner", message: "Overdue" }] },
    ],
  });
  const late = act({ action: "row.create", pageId, cells: { title: "Late", due: "2020-01-01", owner: editor.id, status: "Open" } }).id;
  act({ action: "row.create", pageId, cells: { title: "Done late", due: "2020-01-01", owner: editor.id, status: "Done" } });
  assert.equal(transaction(() => processOverdueAutomations()), 1);
  assert.equal(transaction(() => processOverdueAutomations()), 0);
  const notes = all<{ body: string; row_id: string }>("SELECT body,row_id FROM notifications WHERE user_id=? AND kind='automation'", editor.id);
  assert.deepEqual(notes.map((n) => [n.body, n.row_id]), [["Overdue – „Late“", late]]);
});

test("settings are checked", () => {
  assert.throws(() => settings({ done: { field: "nope", values: [] } }), /unbekannte Eigenschaft/);
  assert.throws(() => settings({ git: { token: "x", secret: "y", createdAt: "" } }), /Unbekannte Einstellung/);
});
