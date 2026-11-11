// Personal tasks (#208, lib/personal-tasks.ts): "Aufgabe hinzufügen" in My
// tasks writes into the person's own private page (made once), the tasks
// are marked as their own, tasks given by others are new until My tasks is
// opened again, and tasks ticked off show below the journal day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-personal-tasks-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { myTasks, openTasksEverywhere } = await import("../lib/doc-tasks");
const { personalTaskPage } = await import("../lib/personal-tasks");
const { completedOn } = await import("../lib/journal-completed");
const { pageRole } = await import("../lib/permissions");

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
const pageOf = async (pid: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pid))!;
const html = async (pid: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))!.html;

test("the first task makes a private page in a new private space, later ones reuse it", async () => {
  const first = await add("Steuererklärung abgeben");
  assert.equal(first.created, true);
  assert.equal(first.spaceCreated, true);
  const page = await pageOf(first.pageId);
  assert.equal(page.kind, "document");
  assert.equal(page.title, "Aufgaben");
  assert.equal(page.created_by, anna.id);
  const space = (await one<{ visibility: string; owner_id: string; name: string }>("SELECT visibility,owner_id,name FROM spaces WHERE id=?", page.space_id))!;
  assert.deepEqual(space, { visibility: "private", owner_id: anna.id, name: "Privat" });
  // Private: Ben and the reader cannot open it.
  assert.equal(await pageRole(ben, page), null);
  assert.equal(await pageRole(reader, page), null);
  const second = await add("Blumen gießen morgen");
  assert.equal(second.created, false);
  assert.equal(second.pageId, first.pageId);
  assert.equal((await all("SELECT 1 FROM personal_task_pages WHERE user_id=?", anna.id)).length, 1);
  assert.equal((await all("SELECT 1 FROM spaces WHERE owner_id=? AND visibility='private'", anna.id)).length, 1);
  // One task list, the shorthand date applied and taken out of the text.
  const body = await html(first.pageId);
  assert.equal((body.match(/data-type="taskList"/g) || []).length, 1);
  assert.match(body, /Steuererklärung abgeben/);
  assert.match(body, new RegExp(`data-due="${shift(1)}"[^>]*>|data-due="${shift(1)}"`));
  assert.ok(!/gießen morgen/.test(body));
  // Both are Anna's own: in My tasks (also without a date), marked as own.
  const mine = await myTasks(anna, wid);
  assert.deepEqual(mine.filter((t) => t.own).map((t) => [t.text, t.due]).sort(), [["Blumen gießen", shift(1)], ["Steuererklärung abgeben", null]]);
  assert.ok((await openTasksEverywhere(anna)).some((t) => t.text === "Steuererklärung abgeben" && t.own));
  // Nobody else sees them.
  assert.ok(!(await myTasks(ben, wid)).some((t) => t.own || t.text.includes("Steuer")));
  // The page answers GET /api/tasks.
  assert.equal((await personalTaskPage(anna, wid))!.id, first.pageId);
});

test("a private space that exists is used; a date picked wins over the text", async () => {
  const own = (await act({ action: "space.create", workspaceId: wid, name: "Bens Ecke", private: true }, ben)).id as string;
  const result = await add("Rechnung zahlen Freitag", ben, { due: shift(3) });
  assert.equal(result.spaceCreated, false);
  assert.equal((await pageOf(result.pageId)).space_id, own);
  assert.deepEqual((await myTasks(ben, wid)).filter((t) => t.own).map((t) => t.due), [shift(3)]);
});

test("@name: only for someone who may open the page, else it stays text and the answer names them", async () => {
  const result = await add("Ben fragen @ben");
  assert.equal(result.unassigned, "Ben");
  assert.equal(result.task.assignee, null);
  assert.match(await html(result.pageId), /Ben fragen @ben/);
  assert.ok(!(await all("SELECT 1 FROM doc_tasks WHERE assignee=?", ben.id)).length);
  // Shared with Ben: now he gets the task.
  await run("INSERT INTO grants(resource_id,resource_kind,workspace_id,user_id,role) VALUES(?,?,?,?,?)", result.pageId, "page", wid, ben.id, "editor");
  const shared = await add("Ben fragen @ben morgen");
  assert.equal(shared.unassigned, null);
  assert.equal(shared.task.assignee, ben.id);
  assert.ok((await myTasks(ben, wid)).some((t) => t.text === "Ben fragen @Ben" && t.assigned && t.due === shift(1)));
  await run("DELETE FROM grants WHERE resource_id=?", result.pageId);
});

test("readers and guests cannot add; a deleted page is made again", async () => {
  await assert.rejects(add("Nein", reader), /Keine Berechtigung/);
  await assert.rejects(add("Nein", guest), /Gäste/);
  assert.equal(await one("SELECT 1 FROM personal_task_pages WHERE user_id IN (?,?)", reader.id, guest.id), undefined);
  const before = (await personalTaskPage(anna, wid))!;
  await act({ action: "page.delete", pageId: before.id });
  assert.equal(await personalTaskPage(anna, wid), null);
  const again = await add("Neu anfangen");
  assert.equal(again.created, true);
  assert.notEqual(again.pageId, before.id);
  // In the same private space as before.
  assert.equal((await pageOf(again.pageId)).space_id, before.space_id);
  // Renamed: still the own page.
  await act({ action: "page.update", pageId: again.pageId, patch: { title: "Meine To-dos" } });
  assert.equal((await add("Noch eine")).pageId, again.pageId);
});

// Tasks written into a team document by someone.
const doc = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Projekt", kind: "document" })).id as string;
const write = async (who: Identity, body: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", doc))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", doc);
  await act({ action: "document.sync", pageId: doc, generation, update: Buffer.from(htmlState(body)).toString("base64") }, who);
};
const item = (text: string, checked = false) => `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p></li>`;
const mention = (u: Identity) => `<span data-mention="${u.id}" class="mention">@${u.name}</span>`;

test("tasks given by others are new until My tasks is opened; saving again keeps that", async () => {
  await act({ action: "tasks.seen" }, ben);
  await write(anna, `<ul data-type="taskList">${item(`Angebot prüfen ${mention(ben)}`)}${item(`Eigenes ${mention(anna)}`)}</ul>`);
  const boot = (await bootstrap(ben, wid)) as { newTasks?: number };
  assert.equal(boot.newTasks, 1);
  assert.deepEqual((await myTasks(ben, wid)).filter((t) => t.fresh).map((t) => t.text), ["Angebot prüfen @Ben"]);
  // Anna's task to herself is not new for her.
  assert.equal(((await bootstrap(anna, wid)) as { newTasks?: number }).newTasks, 0);
  // Opening My tasks: seen.
  await new Promise((r) => setTimeout(r, 5));
  await act({ action: "tasks.seen" }, ben);
  assert.equal(((await bootstrap(ben, wid)) as { newTasks?: number }).newTasks, 0);
  // Saving the document again (even by someone else) does not make it new again.
  await write(ben, `<ul data-type="taskList">${item(`Angebot prüfen ${mention(ben)}`)}${item(`Eigenes ${mention(anna)}`)}</ul><p>mehr</p>`);
  await write(anna, `<ul data-type="taskList">${item(`Angebot prüfen ${mention(ben)}`)}${item(`Eigenes ${mention(anna)}`)}</ul><p>noch mehr</p>`);
  assert.equal(((await bootstrap(ben, wid)) as { newTasks?: number }).newTasks, 0);
  // A task Ben writes for himself is never new; a new one from Anna is.
  await write(ben, `<ul data-type="taskList">${item(`Angebot prüfen ${mention(ben)}`)}${item(`Selbst ${mention(ben)}`)}</ul>`);
  assert.equal(((await bootstrap(ben, wid)) as { newTasks?: number }).newTasks, 0);
  await write(anna, `<ul data-type="taskList">${item(`Angebot prüfen ${mention(ben)}`)}${item(`Selbst ${mention(ben)}`)}${item(`Neu dazu ${mention(ben)}`)}</ul>`);
  assert.equal(((await bootstrap(ben, wid)) as { newTasks?: number }).newTasks, 1);
  // Done tasks are not counted.
  await write(anna, `<ul data-type="taskList">${item(`Angebot prüfen ${mention(ben)}`)}${item(`Selbst ${mention(ben)}`)}${item(`Neu dazu ${mention(ben)}`, true)}</ul>`);
  assert.equal(((await bootstrap(ben, wid)) as { newTasks?: number }).newTasks, 0);
});

test("tasks ticked off show below the journal day, the own page's included; untick takes them out", async () => {
  const own = (await personalTaskPage(anna, wid))!;
  const [task] = (await myTasks(anna, wid)).filter((t) => t.own && t.text === "Noch eine");
  await act({ action: "task.update", pageId: own.id, rowId: null, index: task.index, text: task.text, checked: true });
  // A task in the team document ticked off by Ben.
  const [offer] = (await myTasks(ben, wid)).filter((t) => t.text === "Angebot prüfen @Ben");
  await act({ action: "task.update", pageId: doc, rowId: null, index: offer.index, text: offer.text, checked: true }, ben);
  const list = await completedOn(anna, wid, today, "UTC");
  const tasks = list.items.filter((i) => i.kind === "task");
  // "Neu dazu" was ticked off by Anna in the test before.
  assert.deepEqual(tasks.map((i) => [i.title, i.database]).sort(), [["Angebot prüfen @Ben", "Projekt"], ["Neu dazu @Ben", "Projekt"], ["Noch eine", "Meine To-dos"]]);
  assert.equal(tasks.find((i) => i.title === "Noch eine")!.rowId, "");
  // "Nur meine": only what Anna ticked off or was given.
  assert.deepEqual((await completedOn(anna, wid, today, "UTC", { mine: true })).items.map((i) => i.title).sort(), ["Neu dazu @Ben", "Noch eine"]);
  // Ben: what he ticked off and what was given to him, whoever ticked it off.
  assert.deepEqual((await completedOn(ben, wid, today, "UTC", { mine: true })).items.map((i) => i.title).sort(), ["Angebot prüfen @Ben", "Neu dazu @Ben"]);
  // Ben does not see Anna's private page.
  assert.ok(!(await completedOn(ben, wid, today, "UTC")).items.some((i) => i.title === "Noch eine"));
  // Another day: nothing.
  assert.equal((await completedOn(anna, wid, shift(-1), "UTC")).items.filter((i) => i.kind === "task").length, 0);
  // Not done any more: out of the list.
  await act({ action: "task.update", pageId: own.id, rowId: null, index: task.index, text: task.text, checked: false });
  assert.ok(!(await completedOn(anna, wid, today, "UTC")).items.some((i) => i.title === "Noch eine"));
  // A cancelled task is not "done".
  await act({ action: "task.update", pageId: own.id, rowId: null, index: task.index, text: task.text, status: "cancelled" });
  assert.ok(!(await completedOn(anna, wid, today, "UTC")).items.some((i) => i.title === "Noch eine"));
});
