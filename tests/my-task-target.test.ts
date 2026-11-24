// Where "Aufgabe hinzufügen" of My tasks writes (#457, lib/my-task-target.ts,
// lib/personal-tasks.ts): the own page by default, or a task database the
// person chose – the task becomes a record there (title, due date, person,
// "open" status; defaults and templates apply) – with a fallback to the own
// page when the database can no longer take tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-my-task-target-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { myTaskTarget, taskTargetDatabases } = await import("../lib/my-task-target");
const { personalTaskPage } = await import("../lib/personal-tasks");
const { crossRecords } = await import("../lib/cross-records");
const { commandActionNames } = await import("../lib/openapi");

async function account(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const anna = await account("Anna"),
  ben = await account("Ben"),
  reader = await account("Rita"),
  guest = await account("Gast");
const wid = await createWorkspace(anna.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const team = (await bootstrap(anna, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>, as = anna): Promise<any> => await command(as, body);
const today = new Date().toISOString().slice(0, 10);
const shift = (days: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const add = async (text: string, as = anna, extra: Record<string, unknown> = {}) =>
  await act({ action: "task.add", workspaceId: wid, text, today, locale: "de", ...extra }, as);
const target = async (databaseId: string | null, as = anna) => await act({ action: "task.target", workspaceId: wid, databaseId }, as);
const create = async (title: string, kind: string, extra: Record<string, unknown> = {}, spaceId = team) =>
  (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind, ...extra })).id as string;
const cellsOf = async (rowId: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId))!.cells) as Record<string, unknown>;

// A task database: Aufgabe, Status (Nicht begonnen / In Arbeit / Erledigt),
// Priorität, Fällig am, Verantwortlich, Tags.
const tasksDb = await create("Projekt", "database", { databaseKind: "tasks" });
// A database without a status or a done checkbox: no task database.
const notes = await create("Notizen", "database", { databaseKind: "documents" });

test("by default the own page; only databases that count for My tasks are offered", async () => {
  assert.deepEqual(await myTaskTarget(anna, wid), { kind: "page" });
  const offered = (await taskTargetDatabases(anna, wid)).map((d) => d.id);
  assert.ok(offered.includes(tasksDb));
  assert.ok(!offered.includes(notes), "no status, no done checkbox");
  await assert.rejects(target(notes), /zählt nicht für Meine Aufgaben/);
  // Readers may read the database, but not add to it.
  assert.ok(!(await taskTargetDatabases(reader, wid)).length);
  await assert.rejects(target(tasksDb, reader), /Keine Berechtigung/);
  await assert.rejects(target(tasksDb, guest), /Gäste/);
  assert.ok(commandActionNames.includes("task.target"));
});

test("with a task database chosen, the task becomes a record: title, due date, me as the person, the open status", async () => {
  const chosen = await target(tasksDb);
  assert.deepEqual(chosen.target, { kind: "database", id: tasksDb, title: "Projekt", icon: (await one<{ icon: string }>("SELECT icon FROM pages WHERE id=?", tasksDb))!.icon || "", problem: null });
  assert.equal((await myTaskTarget(anna, wid)).kind, "database");
  assert.equal((await myTaskTarget(ben, wid)).kind, "page", "only for that person");
  const before = await personalTaskPage(anna, wid);
  const result = await add("Angebot schreiben morgen #design !hoch");
  assert.equal(result.target, "database");
  assert.equal(result.pageId, tasksDb);
  assert.equal(result.fallback, null);
  assert.equal(await personalTaskPage(anna, wid), before, "no own page made");
  const cells = await cellsOf(result.rowId);
  assert.equal(cells.title, "Angebot schreiben");
  assert.equal(cells.date, shift(1));
  assert.equal(cells.assignee, anna.id);
  assert.equal(cells.status, "Nicht begonnen");
  assert.equal(cells.priority, "Hoch");
  assert.deepEqual(cells.tags, ["Design"]);
  assert.deepEqual(result.task, { text: "Angebot schreiben", due: shift(1), assignee: anna.id });
  // In My tasks, assigned to me.
  const mine = await crossRecords(anna, wid, { mine: true, open: true, tasks: true, today });
  assert.ok(mine.records.some((r) => r.rowId === result.rowId));
  // A date picked next to the field wins; null takes the date away.
  assert.equal((await cellsOf((await add("Rechnung zahlen Freitag", anna, { due: shift(5) })).rowId)).date, shift(5));
  assert.equal((await cellsOf((await add("Ohne Datum morgen", anna, { due: null })).rowId)).date, undefined);
});

test("@name: the person property for someone who may open the database, else the name stays", async () => {
  const given = await add("Ben fragen @ben");
  assert.equal(given.unassigned, null);
  assert.equal((await cellsOf(given.rowId)).assignee, ben.id);
  assert.equal((await cellsOf(given.rowId)).title, "Ben fragen");
  // A database in Anna's private space: Ben cannot open it.
  const own = (await act({ action: "space.create", workspaceId: wid, name: "Annas Ecke", private: true })).id as string;
  const privateDb = await create("Privat-Aufgaben", "database", { databaseKind: "tasks" }, own);
  await target(privateDb);
  const kept = await add("Ben fragen @ben");
  assert.equal(kept.unassigned, "Ben");
  assert.equal(kept.unassignedReason, "access");
  assert.equal((await cellsOf(kept.rowId)).title, "Ben fragen @ben");
  assert.equal((await cellsOf(kept.rowId)).assignee, anna.id);
  await target(tasksDb);
});

test("default values and the default record template come before the open status", async () => {
  await run(
    "INSERT INTO row_templates(id,page_id,name,cells,html,is_default) VALUES(?,?,?,?,?,1)",
    id(),
    tasksDb,
    "Standard",
    JSON.stringify({ status: "In Arbeit" }),
    "",
  );
  assert.equal((await cellsOf((await add("Mit Vorlage")).rowId)).status, "In Arbeit");
  await run("DELETE FROM row_templates WHERE page_id=?", tasksDb);
  const fields = (await database(tasksDb)).fields as Field[];
  await run(
    "UPDATE databases SET fields=?,version=version+1 WHERE page_id=?",
    JSON.stringify(fields.map((f) => (f.id === "status" ? { ...f, defaultValue: { kind: "value", value: "Erledigt" } } : f))),
    tasksDb,
  );
  assert.equal((await cellsOf((await add("Mit Standardwert")).rowId)).status, "Erledigt");
  await run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(fields), tasksDb);
});

test("a database that can no longer take tasks: the own page, and the answer says why", async () => {
  // Locked: read-only.
  await run("UPDATE pages SET locked=1 WHERE id=?", tasksDb);
  assert.equal(((await myTaskTarget(anna, wid)) as { problem: string }).problem, "readonly");
  const locked = await add("Trotzdem notieren");
  assert.equal(locked.target, "page");
  assert.equal(locked.fallback, "readonly");
  assert.equal(locked.pageId, (await personalTaskPage(anna, wid))!.id);
  await run("UPDATE pages SET locked=0 WHERE id=?", tasksDb);
  // No status any more.
  const fields = (await database(tasksDb)).fields as Field[];
  await run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(fields.filter((f) => f.id !== "status")), tasksDb);
  assert.equal((await add("Ohne Status")).fallback, "untracked");
  await run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(fields), tasksDb);
  // In the trash: missing – restored, it is used again.
  await act({ action: "page.delete", pageId: tasksDb });
  const trashed = await myTaskTarget(anna, wid);
  assert.deepEqual({ ...trashed, icon: "" }, { kind: "database", id: tasksDb, title: "Projekt", icon: "", problem: "missing" }, "in the trash it keeps its name");
  assert.equal((await add("Im Papierkorb")).fallback, "missing");
  await act({ action: "page.restore", pageId: tasksDb });
  const back = await add("Wieder da");
  assert.equal(back.target, "database");
  assert.equal(back.fallback, null);
  // Purged: the choice goes with it.
  await act({ action: "page.delete", pageId: tasksDb });
  await act({ action: "page.purge", pageId: tasksDb });
  assert.deepEqual(await myTaskTarget(anna, wid), { kind: "page" });
  assert.equal(await one("SELECT 1 FROM my_task_targets WHERE user_id=?", anna.id), undefined);
});

test("back to the own page; readers and guests still cannot add", async () => {
  const other = await create("Sprint", "database", { databaseKind: "tasks" });
  await target(other);
  assert.deepEqual((await target(null)).target, { kind: "page" });
  const result = await add("Wieder auf die Seite");
  assert.equal(result.target, "page");
  assert.equal(result.fallback, null);
  assert.equal(await one("SELECT 1 FROM rows WHERE page_id=?", other), undefined);
  await assert.rejects(add("Nein", reader), /Keine Berechtigung/);
  await assert.rejects(add("Nein", guest), /Gäste/);
});
