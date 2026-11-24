// "Offene Aufgaben: verschieben / kopieren" (#469): with copy, a new day
// gets the open tasks of the day before as with move, but the day before
// keeps them, closed and marked as carried over – not open, not counted,
// not carried again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-copy-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal, hasOwnEntry, withContinuedTasks, openTasks } = await import("../lib/journal");
const { journalSettings, journalReview } = await import("../lib/journal-extras");
const { stillOpenTasks } = await import("../lib/journal-summary");
const { indexPageTasks, myTasks, extractTasks } = await import("../lib/doc-tasks");
const { isContinuedTask, taskStatusOf } = await import("../lib/task-status");
const { documentSchema } = await import("../lib/document-schema");
const { Node: PMNode } = await import("@tiptap/pm/model");
const { yDocToProsemirrorJSON } = await import("y-prosemirror");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Mia", "mia@example.test");
const owner = { id: uid, name: "Mia", email: "mia@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Stand-up");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>) => (await command(owner, { workspaceId: wid, ...b })) as Record<string, unknown>;
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "");
// Written as a person would, then indexed for My tasks as a save does.
const write = async (pageId: string, body: string) => {
  await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
  await indexPageTasks(pageId, false);
};
const roll = async (journalId: string, date: string) => await rollJournal(owner, await page(journalId), date, date);
const task = (text: string, checked = false, inner = "") =>
  `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p>${inner}</li>`;
const tasks = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
const schema = documentSchema();
const docOf = (body: string) => {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState(body));
  return PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
};
const count = (body: string, text: string) => body.split(text).length - 1;
const newJournal = async (title: string, carry?: "move" | "copy") => {
  const journalId = String((await act({ action: "page.create", spaceId: space, title, kind: "journal" })).id);
  if (carry) await act({ action: "journal.settings", pageId: journalId, options: { carry } });
  return journalId;
};
const openMine = async () => (await myTasks(owner, wid)).map((t) => t.text);

test("the option defaults to move and takes only move or copy", async () => {
  const journalId = await newJournal("Standard");
  assert.equal((await journalSettings(journalId)).options.carry, "move");
  await act({ action: "journal.settings", pageId: journalId, options: { carry: "copy" } });
  assert.equal((await journalSettings(journalId)).options.carry, "copy");
  // Other options stay as they were.
  assert.equal((await journalSettings(journalId)).options.carried, "top");
  await assert.rejects(async () => await act({ action: "journal.settings", pageId: journalId, options: { carry: "both" } }));
  assert.equal((await journalSettings(journalId)).options.carry, "copy");
});

test("move: the open tasks leave the day before (as before #469)", async () => {
  const journalId = await newJournal("Verschieben", "move");
  const monday = (await roll(journalId, "2026-10-05")).dayId;
  await write(monday, `<p>Notiz</p>${tasks(task("Angebot"), task("Erledigt", true))}`);
  const tuesday = (await roll(journalId, "2026-10-06")).dayId;
  assert.doesNotMatch(await html(monday), /Angebot/);
  assert.doesNotMatch(await html(monday), /data-journal-continued/);
  assert.match(await html(tuesday), /Angebot/);
  assert.equal((await openMine()).filter((t) => t === "Angebot").length, 1);
});

test("copy: the day before keeps its open tasks, marked as carried over and closed", async () => {
  const journalId = await newJournal("Kopieren", "copy");
  const monday = (await roll(journalId, "2026-10-05")).dayId;
  await write(monday, `<p>Stand-up</p>${tasks(task("Bericht"), task("Mails", true), task("Plan", false, tasks(task("Teil A"), task("Teil B", true))))}`);
  assert.deepEqual((await openMine()).filter((t) => ["Bericht", "Plan", "Teil A"].includes(t)).sort(), ["Bericht", "Plan", "Teil A"]);
  const tuesday = (await roll(journalId, "2026-10-06")).dayId;
  const before = await html(monday);
  // Still there on Monday, closed as continued on to Tuesday; done ones untouched.
  assert.match(before, /Bericht/);
  assert.match(before, /Teil A/);
  assert.equal(count(before, 'data-journal-continued="2026-10-06"'), 3, "Bericht, Plan and its open subtask");
  assert.equal(count(before, 'data-status="cancelled"'), 3);
  assert.match(before, /Mails/);
  const doc = docOf(before);
  const states: Record<string, string> = {};
  doc.descendants((node) => {
    if (node.type.name === "taskItem") states[node.firstChild!.textContent] = isContinuedTask(node.attrs) ? "continued" : taskStatusOf(node.attrs);
    return true;
  });
  assert.deepEqual(states, { Bericht: "continued", Mails: "done", Plan: "continued", "Teil A": "continued", "Teil B": "done" });
  assert.equal(openTasks(doc).length, 0, "nothing open is left on Monday");
  // Tuesday got them as with move, open, with the day they are from.
  const after = await html(tuesday);
  assert.match(after, /Bericht/);
  assert.match(after, /Teil A/);
  assert.match(after, /data-journal-since="2026-10-05"/);
  assert.doesNotMatch(after, /data-journal-continued/);
  assert.doesNotMatch(after, /Mails/);
  // Monday keeps its page: something was written on it.
  assert.equal((await page(monday)).deleted_at, null);
});

test("copy does not double tasks across three days", async () => {
  const journalId = await newJournal("Drei Tage", "copy");
  const one_ = (await roll(journalId, "2026-10-12")).dayId;
  await write(one_, `<p>Montag</p>${tasks(task("Review"))}`);
  const two = (await roll(journalId, "2026-10-13")).dayId;
  // Tuesday: something of its own, so it stays.
  await write(two, `${await html(two)}<p>Dienstag</p>`);
  await indexPageTasks(two, false);
  const three = (await roll(journalId, "2026-10-14")).dayId;
  // Each day holds the task once; only Wednesday's is open.
  assert.equal(count(await html(one_), ">Review<"), 1);
  assert.equal(count(await html(two), ">Review<"), 1);
  assert.equal(count(await html(three), ">Review<"), 1);
  assert.match(await html(one_), /data-journal-continued="2026-10-13"/);
  assert.match(await html(two), /data-journal-continued="2026-10-14"/);
  assert.doesNotMatch(await html(three), /data-journal-continued/);
  assert.match(await html(three), /data-journal-since="2026-10-12"/);
  // Opening the journal again the same day changes nothing.
  assert.equal((await roll(journalId, "2026-10-14")).changed, false);
  assert.equal(count(await html(three), ">Review<"), 1);
  // My tasks: exactly one "Review", on Wednesday – also with done tasks shown.
  const mine = (await myTasks(owner, wid)).filter((t) => t.text === "Review");
  assert.deepEqual(mine.map((t) => t.pageId), [three]);
  assert.deepEqual((await myTasks(owner, wid, true)).filter((t) => t.text === "Review").map((t) => t.pageId), [three]);
  // The originals are not in the task index at all (counts, widgets, digest).
  for (const day of [one_, two])
    assert.equal((await one<{ n: number }>("SELECT COUNT(*) AS n FROM doc_tasks WHERE page_id=? AND text='Review'", day))!.n, 0);
  // A month review counts it once as still open, never as done.
  const review = await journalReview(await page(journalId), "2026-10-01", "2026-10-31");
  assert.equal(review.open, 1);
  assert.equal(review.done.filter((d) => d.text === "Review").length, 0);
  assert.deepEqual((await stillOpenTasks(await page(journalId), "2026-10-01", "2026-10-31")).map((t) => t.text), ["Review"]);
  // A fourth day: still one open copy, the older originals untouched.
  const four = (await roll(journalId, "2026-10-15")).dayId;
  assert.equal(count(await html(four), ">Review<"), 1);
  assert.match(await html(one_), /data-journal-continued="2026-10-13"/);
  assert.equal((await myTasks(owner, wid)).filter((t) => t.text === "Review").length, 1);
});

test("copy: a day that only passed carried tasks on goes to the trash; restoring it doubles nothing", async () => {
  const journalId = await newJournal("Leere Tage", "copy");
  const monday = (await roll(journalId, "2026-11-02")).dayId;
  await write(monday, `<p>Montag</p>${tasks(task("Lesen"))}`);
  const tuesday = (await roll(journalId, "2026-11-03")).dayId;
  // Nothing written on Tuesday: on Wednesday it is tidied away.
  const wednesday = (await roll(journalId, "2026-11-04")).dayId;
  assert.ok((await page(tuesday)).deleted_at, "Tuesday only held the carried task");
  assert.equal((await page(monday)).deleted_at, null, "Monday has its own entry");
  // The trashed day keeps its copy, marked as continued: opening its date
  // brings it back without a second open task.
  assert.match(await html(tuesday), /data-journal-continued="2026-11-04"/);
  const back = await rollJournal(owner, await page(journalId), "2026-11-03", "2026-11-04");
  assert.equal(back.dayId, tuesday);
  assert.equal((await page(tuesday)).deleted_at, null);
  assert.deepEqual((await myTasks(owner, wid)).filter((t) => t.text === "Lesen").map((t) => t.pageId), [wednesday]);
});

test("hasOwnEntry: continued originals count like carried tasks", () => {
  const day = "2026-11-04";
  const continued = (since?: string) =>
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-status="cancelled" data-journal-continued="2026-11-05"${since ? ` data-journal-since="${since}"` : ""}><p>Alt</p></li></ul>`;
  // Carried in from an earlier day and passed on: no entry of that day.
  assert.equal(hasOwnEntry(docOf(continued("2026-11-01")), day), false);
  // Written that day and copied on: an entry.
  assert.equal(hasOwnEntry(docOf(continued()), day), true);
  // Cancelled for real (no continued mark): an entry, as before.
  assert.equal(hasOwnEntry(docOf(`<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-status="cancelled" data-journal-since="2026-11-01"><p>Alt</p></li></ul>`), day), true);
});

test("withContinuedTasks marks what openTasks carries, nothing more", () => {
  const doc = docOf(
    tasks(task("Täglich", false, tasks(task("Unter täglich"))), task(""), task("Fertig", true, tasks(task("Offen darin"))), task("Neu")),
  );
  const marked = withContinuedTasks(doc, "2026-11-05", (t) => t.textContent.trim().startsWith("Täglich"));
  const states: Record<string, boolean> = {};
  marked.descendants((node) => {
    if (node.type.name === "taskItem") states[node.firstChild!.textContent || "(leer)"] = isContinuedTask(node.attrs);
    return true;
  });
  // The template's own task and its subtasks stay open; an empty task stays;
  // an open task below a done one is carried by itself and so marked.
  assert.deepEqual(states, { Täglich: false, "Unter täglich": false, "(leer)": false, Fertig: false, "Offen darin": true, Neu: true });
  // Continued tasks keep their position for task.update / MCP, but are not stored.
  const list = extractTasks(marked.toJSON());
  assert.deepEqual(list.map((t) => t.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(list.filter((t) => t.continued).map((t) => t.text), ["Offen darin", "Neu"]);
});
