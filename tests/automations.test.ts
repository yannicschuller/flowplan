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
const { processOverdueAutomations, processScheduledAutomations } = await import("../lib/automations");
const { latestSlot } = await import("../lib/automation-schedule");
const { doneRule } = await import("../lib/database-settings-schema");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  editor = await user("editor");
const wid = await createWorkspace(owner.id, "Auto"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const fields: Field[] = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Doing", "Done"] },
  { id: "solution", name: "Solution", type: "text" },
  { id: "closed", name: "Closed on", type: "date" },
  { id: "due", name: "Due", type: "date" },
  { id: "owner", name: "Owner", type: "person" },
];
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Tickets" })).id as string;
await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: (await database(pageId)).views });
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const update = async (rid: string, patch: Record<string, unknown>, who = owner) =>
  await act({ action: "row.update", pageId, rowId: rid, version: await version(rid), cells: patch }, who);
const settings = async (patch: Record<string, unknown>) => await act({ action: "database.settings", pageId, settings: patch });

test("done is recognised without configuration", () => {
  const rule = doneRule(fields, {});
  assert.equal(rule?.field.id, "status");
  assert.deepEqual(rule?.values, ["Done"]);
});

test("workflow: allowed steps, required properties, owners only", async () => {
  await settings({
    workflow: { field: "status", transitions: { Open: ["Doing"], Doing: ["Open", "Done"] }, required: { Done: ["solution"] }, ownersOnly: ["Done"] },
  });
  const rid = (await act({ action: "row.create", pageId, cells: { title: "A", status: "Open" } })).id;
  await assert.rejects(async () => await update(rid, { status: "Done" }), /nicht vorgesehen/);
  await update(rid, { status: "Doing" });
  await assert.rejects(async () => await update(rid, { status: "Done" }), /braucht: Solution/);
  await update(rid, { solution: "Fixed" }, editor);
  await assert.rejects(async () => await update(rid, { status: "Done" }, editor), /nur Verantwortliche/);
  await update(rid, { status: "Done" });
  assert.equal((await cells(rid)).status, "Done");
  await settings({ workflow: null });
});

test("automations: set a date when done, assign new form records", async () => {
  await settings({
    automations: [
      { id: "a1", name: "Closed date", trigger: { type: "changed", field: "status", to: "Done" }, actions: [{ type: "set", field: "closed", value: "@today" }] },
      { id: "a2", name: "Assign", trigger: { type: "created" }, conditions: [{ field: "status", op: "empty", value: "" }], actions: [{ type: "set", field: "owner", value: "@actor" }, { type: "set", field: "status", value: "Open" }] },
    ],
  });
  const rid = (await act({ action: "row.create", pageId, cells: { title: "B" } }, editor)).id;
  assert.equal((await cells(rid)).owner, editor.id);
  assert.equal((await cells(rid)).status, "Open");
  await update(rid, { status: "Done" });
  assert.equal((await cells(rid)).closed, new Date().toISOString().slice(0, 10));
  // Records that were done are logged for sprint charts.
  assert.ok(await one("SELECT 1 FROM row_status_log WHERE row_id=? AND done=1", rid));
});

test("overdue rules notify once per due date", async () => {
  await settings({
    automations: [
      { id: "late", name: "Late", trigger: { type: "overdue", field: "due" }, actions: [{ type: "notify", to: "field:owner", message: "Overdue" }] },
    ],
  });
  const late = (await act({ action: "row.create", pageId, cells: { title: "Late", due: "2020-01-01", owner: editor.id, status: "Open" } })).id;
  await act({ action: "row.create", pageId, cells: { title: "Done late", due: "2020-01-01", owner: editor.id, status: "Done" } });
  assert.equal(await transaction(async () => await processOverdueAutomations()), 1);
  assert.equal(await transaction(async () => await processOverdueAutomations()), 0);
  const notes = await all<{ body: string; row_id: string }>("SELECT body,row_id FROM notifications WHERE user_id=? AND kind='automation'", editor.id);
  assert.deepEqual(notes.map((n) => [n.body, n.row_id]), [["Overdue – „Late“", late]]);
});

test("settings are checked", async () => {
  await assert.rejects(async () => await settings({ done: { field: "nope", values: [] } }), /unbekannte Eigenschaft/);
  await assert.rejects(async () => await settings({ git: { token: "x", secret: "y", createdAt: "" } }), /Unbekannte Einstellung/);
});

test("schedule slots: weekly, monthly with month ends, every n days, never before the rule", () => {
  const ms = (iso: string) => Date.parse(iso);
  const weekly = { type: "schedule" as const, freq: "weekly" as const, interval: 1, weekday: 1, day: 1, time: "09:00", timeZone: "Europe/Berlin" };
  // Set up on Wednesday: the Monday before does not count.
  assert.equal(latestSlot(weekly, "2026-10-21T10:00:00Z", ms("2026-10-25T12:00:00Z")), null);
  // Monday 09:00 in Berlin is 08:00 UTC (winter time from 25 October).
  assert.equal(latestSlot(weekly, "2026-10-21T10:00:00Z", ms("2026-10-26T07:59:00Z")), null);
  assert.equal(latestSlot(weekly, "2026-10-21T10:00:00Z", ms("2026-10-26T08:00:00Z"))?.key, "2026-10-26T09:00");
  assert.equal(latestSlot(weekly, "2026-10-21T10:00:00Z", ms("2026-11-01T20:00:00Z"))?.key, "2026-10-26T09:00");
  assert.equal(latestSlot({ ...weekly, interval: 2 }, "2026-10-21T10:00:00Z", ms("2026-11-03T08:00:00Z"))?.key, "2026-11-02T09:00");
  const monthly = { ...weekly, freq: "monthly" as const, day: 31, timeZone: "UTC" };
  assert.equal(latestSlot(monthly, "2026-01-01T00:00:00Z", ms("2026-02-28T09:00:00Z"))?.key, "2026-02-28T09:00");
  assert.equal(latestSlot(monthly, "2026-01-01T00:00:00Z", ms("2026-03-30T09:00:00Z"))?.key, "2026-02-28T09:00");
  const days = { ...weekly, freq: "daily" as const, interval: 3, timeZone: "UTC" };
  assert.equal(latestSlot(days, "2026-01-01T08:00:00Z", ms("2026-01-01T09:00:00Z"))?.key, "2026-01-01T09:00");
  assert.equal(latestSlot(days, "2026-01-01T08:00:00Z", ms("2026-01-03T23:00:00Z"))?.key, "2026-01-01T09:00");
  assert.equal(latestSlot(days, "2026-01-01T08:00:00Z", ms("2026-01-04T09:00:00Z"))?.key, "2026-01-04T09:00");
});

test("scheduled rules create records from a template, once per date, as their creator", async () => {
  await settings({ automations: [] });
  const template = (await act({ action: "row.create", pageId, cells: { title: "Weekly report", status: "Open" } })).id;
  await update(template, { solution: "Fill in the numbers" });
  const tid = (await act({ action: "row.template.save", pageId, rowId: template, name: "Report" })).id;
  const rule = (extra: Record<string, unknown> = {}) => ({
    id: "weekly",
    name: "Weekly",
    trigger: { type: "schedule", freq: "daily", interval: 1, time: "00:00", timeZone: "UTC" },
    actions: [{ type: "create", template: tid, cells: { owner: editor.id }, dates: { due: 3 } }],
    ...extra,
  });
  // Scheduled rules only create; other rules never create.
  await assert.rejects(async () => await settings({ automations: [rule({ actions: [{ type: "notify", to: "@creator" }] })] }), /Geplante Regeln/);
  await assert.rejects(
    async () => await settings({ automations: [{ id: "x", trigger: { type: "created" }, actions: [{ type: "create", template: tid }] }] }),
    /Geplante Regeln/,
  );
  await assert.rejects(async () => await settings({ automations: [rule({ trigger: { type: "schedule", freq: "daily", timeZone: "Mars/Base" } })] }), /Zeitzone/);
  await assert.rejects(async () => await settings({ automations: [rule({ actions: [{ type: "create", template: "nope" }] })] }), /vorlage nicht gefunden/);
  // The editor sets the rule up; the runs act for them.
  await act({ action: "database.settings", pageId, settings: { automations: [rule()] } }, editor);
  const stored = (await database(pageId)).settings?.automations?.[0];
  assert.equal(stored?.createdBy, editor.id);
  // An owner switching it off and on again does not take it over.
  await settings({ automations: [{ ...stored, enabled: false }] });
  await settings({ automations: [{ ...stored, enabled: true, createdBy: owner.id }] });
  assert.equal((await database(pageId)).settings?.automations?.[0].createdBy, editor.id);
  const since = Date.parse((await database(pageId)).settings!.automations![0].since!);
  const before = (await all<{ id: string }>("SELECT id FROM rows WHERE page_id=?", pageId)).length;
  const tomorrow = since + 86_400_000;
  assert.equal(await transaction(async () => await processScheduledAutomations(since)), 0);
  assert.equal(await transaction(async () => await processScheduledAutomations(tomorrow)), 1);
  // Once per date: running again for the same slot creates nothing. (Not a minute later: just
  // before midnight UTC that minute would already be the next day's slot.)
  assert.equal(await transaction(async () => await processScheduledAutomations(tomorrow)), 0);
  const created = (await one<{ cells: string; created_by: string; content: string }>(
    "SELECT cells,created_by,content FROM rows WHERE page_id=? ORDER BY number DESC LIMIT 1",
    pageId,
  ))!;
  const day = new Date(tomorrow).toISOString().slice(0, 10);
  const due = new Date(Date.parse(day) + 3 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(created.created_by, editor.id);
  assert.deepEqual(
    { ...JSON.parse(created.cells) },
    { title: "Weekly report", status: "Open", solution: "Fill in the numbers", owner: editor.id, due },
  );
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", pageId)).length, before + 1);
  // Without edit rights any more, the rule rests.
  await run("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?", wid, editor.id);
  assert.equal(await transaction(async () => await processScheduledAutomations(tomorrow + 86_400_000)), 0);
  await run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, editor.id);
  await settings({ automations: [] });
});
