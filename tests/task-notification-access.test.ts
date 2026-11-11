// Task notifications (lib/doc-tasks.ts) reach only people who may read the
// task: the assignment notice and the morning reminder leave out a page the
// assignee cannot open and a private record hidden from them, like "My
// tasks" (taskRows) and the mention notices already do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-task-notice-"));
const { run, id, all, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { myTasks, processDueTasks } = await import("../lib/doc-tasks");

const person = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = await person("Anna");
const ben = await person("Ben");
const wid = await createWorkspace(anna.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const team = (await bootstrap(anna, wid)).spaces[0].id;
const task = (text: string, due: string) => `<li data-type="taskItem" data-checked="false" data-due="${due}"><p>${text}</p></li>`;
const mention = (user: Identity) => `<span data-mention="${user.id}" class="mention">@${user.name}</span>`;
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const notices = async (user: Identity) => (await all<{ body: string }>("SELECT body FROM notifications WHERE user_id=?", user.id)).map((n) => n.body);

test("a task in a page the assignee cannot open: no notice and no morning reminder", async () => {
  const space = ((await command(anna, { action: "space.create", workspaceId: wid, name: "Privat", private: true })) as { id: string }).id;
  const pageId = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Kündigungen", kind: "document" })) as { id: string }).id;
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  const html = `<ul data-type="taskList">${task(`Ben-Kündigung vorbereiten ${mention(ben)}`, today)}</ul>`;
  await command(anna, { action: "document.sync", workspaceId: wid, pageId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  // Ben cannot open the page: My tasks leaves it out, and so does the assignment notice.
  assert.deepEqual(await myTasks(ben, wid), []);
  assert.deepEqual(await notices(ben), []);
  // The morning reminder must not tell him either.
  await processDueTasks(today);
  assert.deepEqual(await notices(ben), [], "the due reminder reaches someone without access to the page");
});

test("a task in a private record: no notice and no morning reminder for a member it is hidden from", async () => {
  await run("DELETE FROM notifications");
  const db = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: team, title: "Personal", kind: "database" })) as { id: string }).id;
  const rowId = ((await command(anna, { action: "row.create", pageId: db, cells: { title: "Gehälter" } })) as { id: string }).id;
  await command(anna, { action: "row.access", pageId: db, rowId, access: "private", grants: [] });
  const { ensureRowDocument } = await import("../lib/row-documents");
  const row = (await one<{ id: string; page_id: string }>("SELECT * FROM rows WHERE id=?", rowId))!;
  const stored = await ensureRowDocument(row as never);
  const html = `<ul data-type="taskList">${task(`Gehalt Ben auf 99999 senken ${mention(ben)}`, today)}</ul>`;
  await command(anna, { action: "row.document.sync", pageId: db, rowId, generation: stored.generation, update: Buffer.from(htmlState(html)).toString("base64") });
  // Ben may read the database but not this record.
  assert.deepEqual(await myTasks(ben, wid), []);
  assert.deepEqual(await notices(ben), [], "the assignment notice carries the private record's task text");
  await processDueTasks(today);
  assert.deepEqual(await notices(ben), [], "the due reminder carries the private record's task text");
});

test("still notified where the assignee may read the task", async () => {
  await run("DELETE FROM notifications");
  const pageId = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: team, title: "Sprint", kind: "document" })) as { id: string }).id;
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  const html = `<ul data-type="taskList">${task(`Angebot schreiben ${mention(ben)}`, today)}</ul>`;
  await command(anna, { action: "document.sync", workspaceId: wid, pageId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  assert.equal((await myTasks(ben, wid)).length, 1);
  assert.equal((await notices(ben)).length, 1);
  await processDueTasks(today);
  const all = await notices(ben);
  assert.equal(all.length, 2);
  assert.ok(all.some((b) => /Heute fällig: Angebot schreiben/.test(b)));
});
