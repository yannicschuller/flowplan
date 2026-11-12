// #249: a task ticked off and then reworded keeps its place in "An diesem
// Tag erledigt" below the journal day (lib/journal-completed.ts). The done
// log (task_done_log) is matched to the task by its text, so syncDocTasks
// carries the entry over when a done task's text changes – found by its
// block id, or (no ids) by its position.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-task-done-rename-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { myTasks } = await import("../lib/doc-tasks");
const { completedOn } = await import("../lib/journal-completed");

async function account(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const anna = await account("Anna");
const wid = await createWorkspace(anna.id, "Team");
const space = (await bootstrap(anna, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>, as = anna): Promise<any> => await command(as, body);
const today = new Date().toISOString().slice(0, 10);

const page = async (title: string) => (await act({ action: "page.create", workspaceId: wid, spaceId: space, title, kind: "document" })).id as string;
// Writes the whole document as the editor would (document.sync).
const write = async (pid: string, body: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pid))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pid);
  await act({ action: "document.sync", pageId: pid, generation, update: Buffer.from(htmlState(body)).toString("base64") });
};
const item = (text: string, checked = false, block?: string) =>
  `<li data-type="taskItem" data-checked="${checked}"${block ? ` data-block-id="${block}"` : ""}><p>${text}</p></li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
const completed = async () =>
  (await completedOn(anna, wid, today, "UTC")).items.filter((i) => i.kind === "task").map((i) => i.title).sort();
const tick = async (pid: string, text: string) => {
  const task = (await myTasks(anna, wid, true)).find((t) => t.pageId === pid && t.text === text)!;
  await act({ action: "task.update", pageId: pid, rowId: null, index: task.index, text: task.text, checked: true });
};

test("a done task with a block id keeps its entry when its text changes, also when it moves", async () => {
  const pid = await page("Mit Ids");
  // Own to-dos with a due date: in My tasks, so they can be ticked from there.
  await write(pid, list(item("Erstens", false, "aaaa1111"), item("Zweitens", false, "bbbb2222")));
  await run("UPDATE doc_tasks SET due=? WHERE page_id=?", today, pid);
  await tick(pid, "Zweitens");
  assert.deepEqual(await completed(), ["Zweitens"]);
  // Reworded (more characters, as in the report): still listed, with the new text.
  await write(pid, list(item("Erstens", false, "aaaa1111"), item("Zweitens, länger geschrieben", true, "bbbb2222")));
  assert.deepEqual(await completed(), ["Zweitens, länger geschrieben"]);
  // Moved to the top and reworded again in the same save: the id finds it.
  await write(pid, list(item("Zweitens, nochmal anders", true, "bbbb2222"), item("Erstens", false, "aaaa1111")));
  assert.deepEqual(await completed(), ["Zweitens, nochmal anders"]);
  // One entry, carried over – not a new one.
  assert.equal((await all("SELECT 1 FROM task_done_log WHERE page_id=?", pid)).length, 1);
  // Unticked: out of the list, as before.
  await write(pid, list(item("Zweitens, nochmal anders", false, "bbbb2222"), item("Erstens", false, "aaaa1111")));
  assert.deepEqual(await completed(), []);
});

test("without block ids the position finds it; a different task at that place does not take the entry", async () => {
  await run("DELETE FROM task_done_log");
  const pid = await page("Ohne Ids");
  await write(pid, list(item("Alpha"), item("Beta")));
  await run("UPDATE doc_tasks SET due=? WHERE page_id=?", today, pid);
  await tick(pid, "Alpha");
  assert.deepEqual(await completed(), ["Alpha"]);
  await write(pid, list(item("Alpha mit mehr Text", true), item("Beta")));
  assert.deepEqual(await completed(), ["Alpha mit mehr Text"]);
  // The done task is deleted and a new done task written in its place – but
  // the old text is still there further down: not a rename.
  await write(pid, list(item("Gamma", true), item("Beta"), item("Alpha mit mehr Text", true)));
  assert.deepEqual(await completed(), ["Alpha mit mehr Text"]);
});

test("tasks stored before block ids were kept: the position decides", async () => {
  await run("DELETE FROM task_done_log");
  const pid = await page("Mit Ids 2");
  await write(pid, list(item("Rechnung schreiben", false, "cccc3333")));
  await run("UPDATE doc_tasks SET due=? WHERE page_id=?", today, pid);
  await tick(pid, "Rechnung schreiben");
  // Stored before this version: no block id in doc_tasks yet.
  await run("UPDATE doc_tasks SET block_id=NULL WHERE page_id=?", pid);
  await write(pid, list(item("Rechnung schreiben und senden", true, "cccc3333")));
  assert.deepEqual(await completed(), ["Rechnung schreiben und senden"]);
});
