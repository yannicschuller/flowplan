import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tasks-"));
const { run, id, all, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { myTasks, otherWorkspaceTasks, processDueTasks, backfillDocTasks } = await import("../lib/doc-tasks");

const person = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = await person("Anna");
const ben = await person("Ben");
const wid = await createWorkspace(anna.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = (await bootstrap(anna, wid)).spaces[0].id;
const pageId = (
  (await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Sprint", kind: "document" })) as { id: string }
).id;
const task = (text: string, attrs = "") =>
  `<li data-type="taskItem" data-checked="false"${attrs}><p>${text}</p></li>`;
const mention = (user: Identity) => `<span data-mention="${user.id}" class="mention">@${user.name}</span>`;
const sync = async (user: Identity, html: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  await command(user, {
    action: "document.sync",
    workspaceId: wid,
    pageId,
    generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
};
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

test("a task with @person is given to that person, with its due date", async () => {
  await sync(
    anna,
    `<ul data-type="taskList">${task(`Angebot schreiben ${mention(ben)}`, ` data-due="${today}"`)}${task("Eigene Notiz")}${task("Mit Datum", ' data-due="2026-12-24"')}</ul>`,
  );
  const tasks = await myTasks(ben, wid);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, "Angebot schreiben @Ben");
  assert.equal(tasks[0].due, today);
  assert.equal(tasks[0].assigned, true);
  // Ben is told once, as a task (not also as a mention).
  const notes = await all<{ body: string }>("SELECT body FROM notifications WHERE user_id=?", ben.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Anna hat dir eine Aufgabe in „Sprint“ gegeben: Angebot schreiben/);
  // Anna's own dated to-dos show for her; undated ones do not.
  assert.deepEqual((await myTasks(anna, wid)).map((t) => t.text), ["Mit Datum"]);
  assert.equal(((await bootstrap(ben, wid)) as { dueTasks: number }).dueTasks, 1);
  // Saving again does not notify again.
  await sync(anna, `<ul data-type="taskList">${task(`Angebot schreiben ${mention(ben)}`, ` data-due="${today}"`)}</ul><p>mehr</p>`);
  assert.equal((await all("SELECT 1 FROM notifications WHERE user_id=?", ben.id)).length, 1);
});

test("due tasks remind their person once", async () => {
  assert.equal(await processDueTasks(today), 1);
  assert.equal(await processDueTasks(today), 0);
  const reminder = (await one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='reminder'", ben.id))!;
  assert.match(reminder.body, /Heute fällig: Angebot schreiben/);
});

test("ticking a task off in the list changes the document", async () => {
  const [mine] = await myTasks(ben, wid);
  await assert.rejects(
    async () => await command(ben, { action: "task.update", pageId, rowId: null, index: 0, text: "Anderer Text", checked: true }),
    /inzwischen geändert/,
  );
  await command(ben, { action: "task.update", pageId, rowId: null, index: mine.index, text: mine.text, checked: true });
  const html = String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
  assert.match(html, /data-checked="true"/);
  assert.equal((await myTasks(ben, wid)).length, 0);
  assert.equal((await myTasks(ben, wid, true))[0].checked, true);
  // Changing the due date works the same way.
  const [done] = await myTasks(ben, wid, true);
  await command(ben, { action: "task.update", pageId, index: done.index, text: done.text, due: "2027-01-05" });
  assert.match(String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html), /data-due="2027-01-05"/);
});

test("tasks written before indexing are picked up once", async () => {
  await run("DELETE FROM doc_tasks");
  await run("DELETE FROM instance_state WHERE key='doc_tasks_indexed'");
  await backfillDocTasks();
  assert.equal((await myTasks(ben, wid, true)).length, 1);
});

const syncPage = async (user: Identity, workspaceId: string, target: string, html: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", target))!.generation);
  await command(user, {
    action: "document.sync",
    workspaceId,
    pageId: target,
    generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
};

test("tasks in the own journal count without @mention and without a date", async () => {
  const journal = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" })) as { id: string }).id;
  const { dayId } = (await command(anna, { action: "journal.roll", workspaceId: wid, pageId: journal, date: today })) as { dayId: string };
  await syncPage(anna, wid, dayId, `<ul data-type="taskList">${task("Zahnarzt anrufen")}${task("Blumen gießen", ` data-due="${today}"`)}</ul>`);
  const mine = (await myTasks(anna, wid)).filter((t) => t.journal);
  assert.deepEqual(mine.map((t) => t.text).sort(), ["Blumen gießen", "Zahnarzt anrufen"]);
  // Only for the journal's person, and they count for the badge.
  assert.equal((await myTasks(ben, wid)).some((t) => t.journal), false);
  assert.equal(((await bootstrap(anna, wid)) as { dueTasks: number }).dueTasks, 1);
  // The next day takes the open tasks along; each is listed once, in the new day.
  const { rollJournal } = await import("../lib/journal");
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  const journalPage = (await one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", journal))!;
  const { dayId: nextDay } = await rollJournal(anna, journalPage, tomorrow, today);
  const moved = (await myTasks(anna, wid)).filter((t) => t.journal);
  assert.deepEqual(moved.map((t) => t.text).sort(), ["Blumen gießen", "Zahnarzt anrufen"]);
  assert.ok(moved.every((t) => t.pageId === nextDay));
  // Moving tasks tells nobody anything.
  assert.equal((await all("SELECT 1 FROM notifications WHERE user_id=? AND kind='mention'", anna.id)).length, 0);
});

test("tasks of the other workspaces come separately, per workspace", async () => {
  const other = await createWorkspace(anna.id, "Privat");
  const otherSpace = (await bootstrap(anna, other)).spaces[0].id;
  const note = ((await command(anna, { action: "page.create", workspaceId: other, spaceId: otherSpace, title: "Umzug", kind: "document" })) as { id: string }).id;
  await syncPage(anna, other, note, `<ul data-type="taskList">${task("Kartons kaufen", ' data-due="2026-12-01"')}</ul>`);
  assert.equal((await myTasks(anna, wid)).some((t) => t.text === "Kartons kaufen"), false);
  const groups = await otherWorkspaceTasks(anna, wid);
  assert.deepEqual(groups.map((g) => g.name), ["Privat"]);
  assert.deepEqual(groups[0].tasks.map((t) => t.text), ["Kartons kaufen"]);
  // Seen from "Privat", the team's tasks are the other ones.
  assert.equal((await otherWorkspaceTasks(anna, other))[0].name, "Team");
  // Ben is not in "Privat".
  assert.deepEqual(await otherWorkspaceTasks(ben, wid), []);
});

test("ticking a task off in the list ticks off its subtasks", async () => {
  const nested = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Umzug", kind: "document" })) as { id: string }).id;
  await syncPage(anna, wid, nested, `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-12-01"><p>Umziehen</p><ul data-type="taskList">${task("Kartons")}</ul></li>${task("Danach")}</ul>`);
  const parent = (await myTasks(anna, wid)).find((t) => t.text === "Umziehen")!;
  await command(anna, { action: "task.update", pageId: nested, index: parent.index, text: parent.text, checked: true });
  const html = String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", nested))!.html);
  assert.equal((html.match(/data-checked="true"/g) || []).length, 2);
  assert.match(html, /data-checked="false"[^>]*>(<label[^]*?)?<div><p>Danach/);
});

// #53: tasks in a record's content go with the record – deleted, restored,
// purged, or turned into a page.
test("tasks of a deleted record leave My tasks and come back with it", async () => {
  const { indexRowTasks } = await import("../lib/doc-tasks");
  const { requirePage } = await import("../lib/permissions");
  const db = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Aufträge", kind: "database" })) as { id: string }).id;
  const record = async (title: string) => {
    const rowId = ((await command(anna, { action: "row.create", pageId: db, cells: { title } })) as { id: string }).id;
    const html = `<ul data-type="taskList">${task(`${title} prüfen ${mention(ben)}`, ` data-due="${today}"`)}</ul>`;
    await run("INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)", rowId, Buffer.from(htmlState(html)), html, id());
    await indexRowTasks(anna, await requirePage(anna, db), rowId);
    return rowId;
  };
  const texts = async () => (await myTasks(ben, wid)).map((t) => t.text).filter((t) => /prüfen/.test(t));
  const kept = await record("Alpha");
  const gone = await record("Beta");
  assert.deepEqual((await texts()).sort(), ["Alpha prüfen @Ben", "Beta prüfen @Ben"]);
  // Deleted: out of My tasks, no reminder.
  await command(anna, { action: "row.delete", pageId: db, rowId: gone });
  assert.deepEqual(await texts(), ["Alpha prüfen @Ben"]);
  await run("DELETE FROM task_reminders");
  assert.ok(!(await all<{ text: string }>("SELECT text FROM doc_tasks WHERE row_id=?", gone)).length);
  // Restored from the trash: back.
  await command(anna, { action: "row.trash.restore", pageId: db, trashId: gone });
  assert.deepEqual((await texts()).sort(), ["Alpha prüfen @Ben", "Beta prüfen @Ben"]);
  // Deleted and purged: gone for good.
  await command(anna, { action: "row.delete", pageId: db, rowId: gone });
  await command(anna, { action: "row.trash.purge", pageId: db, trashId: gone });
  assert.deepEqual(await texts(), ["Alpha prüfen @Ben"]);
  // Turned into a page: listed once, from the page.
  await command(anna, { action: "record.toPage", pageId: db, rowId: kept, spaceId: space, parentId: null, keepProperties: true });
  const after = (await myTasks(ben, wid)).filter((t) => t.text === "Alpha prüfen @Ben");
  assert.equal(after.length, 1);
  assert.equal(after[0].rowId ?? null, null);
  // Orphans from before the fix are removed by the migration's statement.
  await run("INSERT INTO doc_tasks(id,page_id,row_id,idx,text,checked,assignee,due,workspace_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id(), db, id(), 0, "Waise", 0, ben.id, today, wid, Date.now());
  // Until then, the lists already leave them out.
  assert.ok(!(await myTasks(ben, wid)).some((t) => t.text === "Waise"));
  await run("DELETE FROM doc_tasks WHERE row_id<>'' AND NOT EXISTS (SELECT 1 FROM rows r WHERE r.id=doc_tasks.row_id AND r.page_id=doc_tasks.page_id)");
  assert.ok(!(await one("SELECT 1 FROM doc_tasks WHERE text='Waise'")));
});
