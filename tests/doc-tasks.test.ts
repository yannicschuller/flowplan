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

const person = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = person("Anna");
const ben = person("Ben");
const wid = createWorkspace(anna.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const space = bootstrap(anna, wid).spaces[0].id;
const pageId = (
  command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Sprint", kind: "document" }) as { id: string }
).id;
const task = (text: string, attrs = "") =>
  `<li data-type="taskItem" data-checked="false"${attrs}><p>${text}</p></li>`;
const mention = (user: Identity) => `<span data-mention="${user.id}" class="mention">@${user.name}</span>`;
const sync = (user: Identity, html: string) => {
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId)!.generation);
  run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  command(user, {
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

test("a task with @person is given to that person, with its due date", () => {
  sync(
    anna,
    `<ul data-type="taskList">${task(`Angebot schreiben ${mention(ben)}`, ` data-due="${today}"`)}${task("Eigene Notiz")}${task("Mit Datum", ' data-due="2026-12-24"')}</ul>`,
  );
  const tasks = myTasks(ben, wid);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, "Angebot schreiben @Ben");
  assert.equal(tasks[0].due, today);
  assert.equal(tasks[0].assigned, true);
  // Ben is told once, as a task (not also as a mention).
  const notes = all<{ body: string }>("SELECT body FROM notifications WHERE user_id=?", ben.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Anna hat dir eine Aufgabe in „Sprint“ gegeben: Angebot schreiben/);
  // Anna's own dated to-dos show for her; undated ones do not.
  assert.deepEqual(myTasks(anna, wid).map((t) => t.text), ["Mit Datum"]);
  assert.equal((bootstrap(ben, wid) as { dueTasks: number }).dueTasks, 1);
  // Saving again does not notify again.
  sync(anna, `<ul data-type="taskList">${task(`Angebot schreiben ${mention(ben)}`, ` data-due="${today}"`)}</ul><p>mehr</p>`);
  assert.equal(all("SELECT 1 FROM notifications WHERE user_id=?", ben.id).length, 1);
});

test("due tasks remind their person once", () => {
  assert.equal(processDueTasks(today), 1);
  assert.equal(processDueTasks(today), 0);
  const reminder = one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='reminder'", ben.id)!;
  assert.match(reminder.body, /Heute fällig: Angebot schreiben/);
});

test("ticking a task off in the list changes the document", () => {
  const [mine] = myTasks(ben, wid);
  assert.throws(
    () => command(ben, { action: "task.update", pageId, rowId: null, index: 0, text: "Anderer Text", checked: true }),
    /inzwischen geändert/,
  );
  command(ben, { action: "task.update", pageId, rowId: null, index: mine.index, text: mine.text, checked: true });
  const html = String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html);
  assert.match(html, /data-checked="true"/);
  assert.equal(myTasks(ben, wid).length, 0);
  assert.equal(myTasks(ben, wid, true)[0].checked, true);
  // Changing the due date works the same way.
  const [done] = myTasks(ben, wid, true);
  command(ben, { action: "task.update", pageId, index: done.index, text: done.text, due: "2027-01-05" });
  assert.match(String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html), /data-due="2027-01-05"/);
});

test("tasks written before indexing are picked up once", () => {
  run("DELETE FROM doc_tasks");
  run("DELETE FROM instance_state WHERE key='doc_tasks_indexed'");
  backfillDocTasks();
  assert.equal(myTasks(ben, wid, true).length, 1);
});

const syncPage = (user: Identity, workspaceId: string, target: string, html: string) => {
  const generation = String(one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", target)!.generation);
  command(user, {
    action: "document.sync",
    workspaceId,
    pageId: target,
    generation,
    update: Buffer.from(htmlState(html)).toString("base64"),
  });
};

test("tasks in the own journal count without @mention and without a date", async () => {
  const journal = (command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" }) as { id: string }).id;
  const { dayId } = command(anna, { action: "journal.roll", workspaceId: wid, pageId: journal, date: today }) as { dayId: string };
  syncPage(anna, wid, dayId, `<ul data-type="taskList">${task("Zahnarzt anrufen")}${task("Blumen gießen", ` data-due="${today}"`)}</ul>`);
  const mine = myTasks(anna, wid).filter((t) => t.journal);
  assert.deepEqual(mine.map((t) => t.text).sort(), ["Blumen gießen", "Zahnarzt anrufen"]);
  // Only for the journal's person, and they count for the badge.
  assert.equal(myTasks(ben, wid).some((t) => t.journal), false);
  assert.equal((bootstrap(anna, wid) as { dueTasks: number }).dueTasks, 1);
  // The next day takes the open tasks along; each is listed once, in the new day.
  const { rollJournal } = await import("../lib/journal");
  const next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const tomorrow = next.toISOString().slice(0, 10);
  const journalPage = one<import("../lib/types").Page>("SELECT * FROM pages WHERE id=?", journal)!;
  const { dayId: nextDay } = rollJournal(anna, journalPage, tomorrow);
  const moved = myTasks(anna, wid).filter((t) => t.journal);
  assert.deepEqual(moved.map((t) => t.text).sort(), ["Blumen gießen", "Zahnarzt anrufen"]);
  assert.ok(moved.every((t) => t.pageId === nextDay));
  // Moving tasks tells nobody anything.
  assert.equal(all("SELECT 1 FROM notifications WHERE user_id=? AND kind='mention'", anna.id).length, 0);
});

test("tasks of the other workspaces come separately, per workspace", () => {
  const other = createWorkspace(anna.id, "Privat");
  const otherSpace = bootstrap(anna, other).spaces[0].id;
  const note = (command(anna, { action: "page.create", workspaceId: other, spaceId: otherSpace, title: "Umzug", kind: "document" }) as { id: string }).id;
  syncPage(anna, other, note, `<ul data-type="taskList">${task("Kartons kaufen", ' data-due="2026-12-01"')}</ul>`);
  assert.equal(myTasks(anna, wid).some((t) => t.text === "Kartons kaufen"), false);
  const groups = otherWorkspaceTasks(anna, wid);
  assert.deepEqual(groups.map((g) => g.name), ["Privat"]);
  assert.deepEqual(groups[0].tasks.map((t) => t.text), ["Kartons kaufen"]);
  // Seen from "Privat", the team's tasks are the other ones.
  assert.equal(otherWorkspaceTasks(anna, other)[0].name, "Team");
  // Ben is not in "Privat".
  assert.deepEqual(otherWorkspaceTasks(ben, wid), []);
});

test("ticking a task off in the list ticks off its subtasks", () => {
  const nested = (command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Umzug", kind: "document" }) as { id: string }).id;
  syncPage(anna, wid, nested, `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-12-01"><p>Umziehen</p><ul data-type="taskList">${task("Kartons")}</ul></li>${task("Danach")}</ul>`);
  const parent = myTasks(anna, wid).find((t) => t.text === "Umziehen")!;
  command(anna, { action: "task.update", pageId: nested, index: parent.index, text: parent.text, checked: true });
  const html = String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", nested)!.html);
  assert.equal((html.match(/data-checked="true"/g) || []).length, 2);
  assert.match(html, /data-checked="false"[^>]*>(<label[^]*?)?<div><p>Danach/);
});
