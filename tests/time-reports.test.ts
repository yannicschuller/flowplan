import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-time-reports-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { timeReportData, timeReportCsv, setBilling, setRate, setCurrency, periodRange } = await import("../lib/time-reports");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("Olga"),
  editor = await user("Emil"),
  viewer = await user("Vera"),
  stranger = await user("Sam");
const wid = await createWorkspace(owner.id, "Agentur"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const create = async (title: string) => (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
const projects = await create("Projekte"),
  tasks = await create("Aufgaben");
await act({ action: "database.update", pageId: projects, version: (await database(projects)).version, fields: [{ id: "title", name: "Name", type: "text" }], views: (await database(projects)).views });
const alpha = (await act({ action: "row.create", pageId: projects, cells: { title: "Alpha" } })).id as string;
const beta = (await act({ action: "row.create", pageId: projects, cells: { title: "Beta" } })).id as string;
const fields = [
  { id: "title", name: "Titel", type: "text" },
  { id: "project", name: "Projekt", type: "relation", relationPage: projects },
  { id: "spent", name: "Zeit", type: "time" },
];
await act({ action: "database.update", pageId: tasks, version: (await database(tasks)).version, fields, views: (await database(tasks)).views });
const design = (await act({ action: "row.create", pageId: tasks, cells: { title: "Design", project: [alpha] } })).id as string;
const build = (await act({ action: "row.create", pageId: tasks, cells: { title: "Bau", project: [beta] } })).id as string;
const secret = (await act({ action: "row.create", pageId: tasks, cells: { title: "Geheim" } })).id as string;
await act({ action: "row.access", pageId: tasks, rowId: secret, access: "private", grants: [] });
// The local day, as the reports group by it (not UTC: near midnight the
// two differ wherever the clock is not on UTC).
const today = new Date().toLocaleDateString("sv-SE");
const add = async (rowId: string, minutes: number, who = owner, note = "") => await act({ action: "time.add", pageId: tasks, rowId, fieldId: "spent", minutes, date: today, note }, who);
await add(design, 120);
await add(design, 60, editor, "Entwurf");
await add(build, 30, editor);
await add(secret, 45);
// An entry of the viewer on the private record (e.g. from before it became private).
await run(`INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start,"end",note) VALUES(?,?,?,?,?,?,?,?)`, id(), tasks, secret, "spent", viewer.id, new Date().setHours(0, 0, 0, 0), new Date().setHours(0, 30, 0, 0), "");

test("periods: presets and custom ranges", () => {
  const now = new Date(2026, 9, 22, 12).getTime(); // Thursday
  assert.deepEqual([periodRange("this-week", undefined, undefined, now).from, periodRange("this-week", undefined, undefined, now).to], ["2026-10-19", "2026-10-25"]);
  assert.equal(periodRange("this-month", undefined, undefined, now).to, "2026-10-31");
  assert.deepEqual([periodRange("last-month", undefined, undefined, now).from, periodRange("last-month", undefined, undefined, now).to], ["2026-09-01", "2026-09-30"]);
  assert.equal(periodRange("custom", "2026-01-01", "2026-01-31").from, "2026-01-01");
  assert.throws(() => periodRange("custom", "2026-02-01", "2026-01-01"), /Startdatum/);
  assert.throws(() => periodRange("custom"), /Start- und Enddatum/);
});

test("database report groups by person, project and record with totals", async () => {
  const byPerson = await timeReportData(owner, { page: tasks, period: "this-week" });
  assert.equal(byPerson.total.seconds, (120 + 60 + 30 + 45 + 30) * 60);
  assert.equal(byPerson.groups.find((g) => g.label === "Emil")!.seconds, 90 * 60);
  const byProject = await timeReportData(owner, { page: tasks, period: "this-week", group: "project" });
  assert.equal(byProject.groups.find((g) => g.label === "Alpha")!.seconds, 180 * 60);
  assert.equal(byProject.groups.find((g) => g.key === "none")!.seconds, 75 * 60);
  const onlyAlpha = await timeReportData(owner, { page: tasks, period: "this-week", project: alpha, group: "record" });
  assert.deepEqual(onlyAlpha.groups.map((g) => g.label), ["Design"]);
  const onlyEmil = await timeReportData(owner, { workspace: wid, period: "this-month", person: editor.id, group: "day" });
  assert.equal(onlyEmil.total.seconds, 90 * 60);
  assert.deepEqual(onlyEmil.groups.map((g) => g.key), [new Date().toLocaleDateString("sv-SE")]);
});

test("people see their own entries and those of records they may read", async () => {
  const seen = await timeReportData(viewer, { workspace: wid, period: "this-week" });
  // Not the owner's entry on the private record, but the viewer's own one – without its title.
  assert.equal(seen.entries.filter((e) => e.rowId === secret).length, 1);
  const own = seen.entries.find((e) => e.rowId === secret)!;
  assert.equal(own.userId, viewer.id);
  assert.equal(own.restricted, true);
  assert.equal(own.title, "");
  assert.equal(seen.total.seconds, (120 + 60 + 30 + 30) * 60);
  // Viewers neither see amounts nor change the billing status.
  assert.equal(seen.showAmounts, false);
  assert.ok(seen.entries.every((e) => !e.editable));
  await assert.rejects(async () => await timeReportData(stranger, { workspace: wid }), /Keine Berechtigung/);
});

test("field permissions hide the time property's entries of others", async () => {
  await act({
    action: "database.update",
    pageId: tasks,
    version: (await database(tasks)).version,
    fields: fields.map((f) => (f.id === "spent" ? { ...f, access: { read: "editors" } } : f)),
    views: (await database(tasks)).views,
  });
  const seen = await timeReportData(viewer, { page: tasks, period: "this-week" });
  assert.deepEqual([...new Set(seen.entries.map((e) => e.userId))], [viewer.id]);
  assert.equal((await timeReportData(editor, { page: tasks, period: "this-week" })).total.entries, 3);
  await act({ action: "database.update", pageId: tasks, version: (await database(tasks)).version, fields, views: (await database(tasks)).views });
});

test("billing: editors mark the filtered set as billed, audit-logged; viewers cannot", async () => {
  await assert.rejects(async () => await setBilling(viewer, { status: "billed", filter: { page: tasks, period: "this-week" } }), /Bearbeitungsrechten/);
  const unbillable = (await timeReportData(owner, { page: tasks, period: "this-week" })).entries.find((e) => e.rowId === build)!;
  assert.deepEqual(await setBilling(editor, { status: "unbillable", ids: [unbillable.id], workspace: wid }), { changed: 1, skipped: 0 });
  // Emil may edit all records he can read; the private one stays untouched.
  const result = await setBilling(editor, { status: "billed", filter: { page: tasks, period: "this-week" } });
  assert.equal(result.changed, 2);
  assert.equal(result.skipped, 0);
  const after = await timeReportData(owner, { page: tasks, period: "this-week" });
  assert.equal(after.byStatus.unbillable, 30 * 60);
  assert.equal(after.byStatus.billed, 180 * 60);
  assert.equal(after.byStatus.open, 75 * 60);
  assert.equal((await timeReportData(owner, { page: tasks, period: "this-week", billable: "no" })).total.seconds, 30 * 60);
  assert.equal((await timeReportData(owner, { page: tasks, period: "this-week", status: "open" })).total.entries, 2);
  const logged = await all<{ action: string; detail: string }>("SELECT action,detail FROM audit WHERE action='time.billing'");
  assert.ok(logged.some((a) => JSON.parse(a.detail).status === "billed" && JSON.parse(a.detail).entries === 2));
  assert.equal((await one<{ billed_by: string }>("SELECT billed_by FROM time_entries WHERE billing='billed' LIMIT 1"))!.billed_by, editor.id);
});

test("hourly rates per person or project give amounts; only owners set them", async () => {
  await assert.rejects(async () => await setRate(editor, { workspace: wid, kind: "person", targetId: editor.id, rate: 80 }), /Eigentümer/);
  await setRate(owner, { workspace: wid, kind: "person", targetId: editor.id, rate: 80 });
  await setRate(owner, { workspace: wid, kind: "project", targetId: alpha, rate: 100 });
  await setCurrency(owner, { workspace: wid, currency: "CHF" });
  const report = await timeReportData(owner, { page: tasks, period: "this-week", group: "person" });
  // Emil: 60 min on Alpha (project rate 100) + 30 min on Beta (his rate 80).
  assert.equal(report.groups.find((g) => g.label === "Emil")!.amount, 140);
  // Olga: 120 min on Alpha at 100; her private-record time has no rate.
  assert.equal(report.groups.find((g) => g.label === "Olga")!.amount, 200);
  assert.equal(report.currency, "CHF");
  assert.equal(report.showAmounts, true);
  await setRate(owner, { workspace: wid, kind: "project", targetId: alpha, rate: null });
  assert.equal((await timeReportData(owner, { page: tasks, period: "this-week" })).groups.find((g) => g.label === "Olga")!.amount, 0);
});

test("CSV export in two variants, with formulas neutralized", async () => {
  await add(design, 15, owner, "=HYPERLINK(1)");
  const plain = await timeReportCsv(owner, { page: tasks, period: "this-week" }, "csv");
  assert.ok(!plain.body.startsWith("﻿"));
  assert.match(plain.body.split("\r\n")[0], /^Datum,Person,/);
  assert.ok(plain.body.includes("'=HYPERLINK(1)"));
  const excel = await timeReportCsv(owner, { page: tasks, period: "this-week" }, "excel");
  assert.ok(excel.body.startsWith("﻿"));
  assert.match(excel.body, /;0,5;/);
  // Viewers get no amount columns.
  assert.ok(!(await timeReportCsv(viewer, { page: tasks, period: "this-week" })).body.includes("Betrag"));
});
