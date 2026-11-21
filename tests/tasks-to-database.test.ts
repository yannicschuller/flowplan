// "Aufgaben in Datenbank verschieben" (#420, lib/tasks-to-database.ts):
// the tasks of a document become records of a task database – status,
// due date and person mapped – and the document links, loses or keeps
// them; nested tasks, rights, field defaults and undo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-tasks-to-database-"));
const { run, one, all, id } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { collectTasks, replaceTasks, restoreTasks, taskSummary, tasksToDatabasePlan } = await import("../lib/tasks-to-database");
const { myTasks } = await import("../lib/doc-tasks");
const { undoFor } = await import("../lib/undo");

const person = async (name: string) => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const anna = await person("Anna");
const ben = await person("Ben");
const viewer = await person("Vera");
const wid = await createWorkspace(anna.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await bootstrap(anna, wid)).spaces[0].id;

const create = async (title: string, kind: string, extra: Record<string, unknown> = {}) =>
  ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title, kind, ...extra })) as { id: string }).id;
const writeDoc = async (pageId: string, html: string) => {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await run("UPDATE documents SET state=NULL,html='' WHERE page_id=?", pageId);
  await command(anna, { action: "document.sync", workspaceId: wid, pageId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
};
const docHtml = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
const records = async (db: string) =>
  (await all<{ id: string; cells: string; content: string | null }>("SELECT id,cells,content FROM rows WHERE page_id=? ORDER BY position", db)).map((r) => ({
    id: r.id,
    cells: JSON.parse(r.cells) as Record<string, unknown>,
    content: r.content || "",
  }));
const mention = (user: Identity) => `<span data-mention="${user.id}" class="mention">@${user.name}</span>`;
const task = (text: string, attrs = "", inner = "") => `<li data-type="taskItem" data-checked="false"${attrs}><p>${text}</p>${inner}</li>`;
const done = (text: string, inner = "") => `<li data-type="taskItem" data-checked="true"><p>${text}</p>${inner}</li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;

// A task database (the "tasks" kind: Status Nicht begonnen / In Arbeit /
// Erledigt, Fällig am, Verantwortlich) with a parent property and a default.
const taskDatabase = async (title: string) => {
  const db = await create(title, "database", { databaseKind: "tasks" });
  const fields = (await database(db)).fields as Field[];
  const next: Field[] = [
    ...fields.map((f) => (f.id === "priority" ? { ...f, defaultValue: { kind: "value", value: "Mittel" } } : f)),
    { id: "parent", name: "Übergeordnet", type: "relation", relationPage: db, parent: true },
  ] as Field[];
  await run("UPDATE databases SET fields=?,version=version+1 WHERE page_id=?", JSON.stringify(next), db);
  return db;
};

test("collecting tasks: titles, people, dates, notes and sub-tasks", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true, due: "2026-12-01", blockId: "t1" },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Angebot " }, { type: "mention", attrs: { userId: "u1", label: "Ben" } }, { type: "text", text: " schreiben" }] },
              { type: "paragraph", content: [{ type: "text", text: "Notiz" }] },
              { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Entwurf" }] }] }] },
            ],
          },
          { type: "taskItem", attrs: { checked: false, status: "cancelled" }, content: [{ type: "paragraph" }] },
          { type: "taskItem", attrs: { checked: true, status: "cancelled" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Abgesagt" }] }] },
        ],
      },
    ],
  };
  const tasks = collectTasks(doc);
  assert.deepEqual(
    tasks.map((t) => [t.index, t.title, t.assignees, t.due, t.closed, t.parent, t.empty, t.notes.length]),
    [
      [0, "Angebot schreiben", ["u1"], "2026-12-01", true, null, false, 1],
      [1, "Entwurf", [], null, false, 0, false, 0],
      [2, "", [], null, false, null, true, 0],
      [3, "Abgesagt", [], null, true, null, false, 0],
    ],
  );
  // Without a person property the @mention stays in the title.
  assert.equal(collectTasks(doc, false)[0].title, "Angebot @Ben schreiben");
  assert.deepEqual(taskSummary(tasks), { tasks: 3, done: 2, due: 1, assigned: 1, nested: 1 });
});

test("the document's lists: replaced by links or removed, and put back", () => {
  const original = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { blockId: "p1" }, content: [{ type: "text", text: "Vorher" }] },
      {
        type: "taskList",
        attrs: { blockId: "l1" },
        content: [
          { type: "taskItem", attrs: { checked: false, blockId: "t1" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Eins" }] }, { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Zwei" }] }] }] }] },
        ],
      },
      { type: "callout", attrs: { blockId: "c1" }, content: [{ type: "taskList", attrs: { blockId: "l2" }, content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Drei" }] }] }] }] },
      { type: "paragraph", attrs: { blockId: "p2" }, content: [{ type: "text", text: "Nachher" }] },
    ],
  };
  const link = (i: number) => ({ href: `/#page=db&row=r${i}`, title: ["Eins", "Zwei", "Drei"][i] });
  const linked = replaceTasks(original, "link", link, "Untitled");
  const top = linked.doc.content![1];
  assert.equal(top.type, "bulletList");
  assert.equal(top.attrs!.blockId, "l1");
  assert.equal(top.content![0].attrs!.blockId, "t1", "the item keeps the task's block id");
  assert.equal(top.content![0].content![0].content![0].marks![0].attrs!.href, "/#page=db&row=r0");
  assert.equal(top.content![0].content![1].content![0].content![0].content![0].text, "Zwei", "the sub-task's link below its parent's");
  assert.equal(linked.doc.content![2].content![0].type, "bulletList");
  assert.deepEqual(restoreTasks(linked.doc, linked.restore), original);

  const removed = replaceTasks(original, "remove", link, "Untitled");
  assert.deepEqual(removed.doc.content!.map((n) => n.type), ["paragraph", "callout", "paragraph"]);
  // The callout keeps an empty paragraph where its list was.
  assert.deepEqual(removed.doc.content![1].content!.map((n) => [n.type, n.content]), [["paragraph", undefined]]);
  assert.deepEqual(restoreTasks(removed.doc, removed.restore), original);
  // Edits elsewhere stay; a neighbour gone: the list goes before the next block.
  const edited = structuredClone(removed.doc);
  edited.content!.splice(0, 1);
  edited.content!.push({ type: "paragraph", attrs: { blockId: "p3" }, content: [{ type: "text", text: "Neu" }] });
  const back = restoreTasks(edited, removed.restore);
  assert.deepEqual(back.content!.map((n) => n.attrs?.blockId), ["l1", "c1", "p2", "p3"]);
  // The empty paragraph that was written into meanwhile stays; the list goes after its neighbour.
  const typed = structuredClone(removed.doc);
  typed.content![1].content![0].content = [{ type: "text", text: "getippt" }];
  const kept = restoreTasks(typed, removed.restore);
  assert.equal(kept.content![2].content!.length, 1);
  assert.equal(kept.content![2].content![0].type, "paragraph");
});

test("tasks become records with status, due date and person; the document links them; undo", async () => {
  const doc = await create("Sprint", "document");
  const db = await taskDatabase("Aufgaben");
  await writeDoc(
    doc,
    `<p>Plan</p>${list(task(`Angebot ${mention(ben)}`, ' data-due="2026-12-24"', "<p>Mit Kunde abstimmen</p>"), done("Rechnung", list(task("Belege sammeln"))), task(""))}<p>Ende</p>`,
  );
  assert.equal((await myTasks(ben, wid)).length, 1);
  const plan = await tasksToDatabasePlan(anna, doc);
  assert.deepEqual([plan.tasks, plan.done, plan.due, plan.assigned, plan.nested], [3, 1, 1, 1, 1]);
  assert.ok(plan.databases.some((d) => d.id === db));

  const result = (await command(anna, {
    action: "page.tasksToDatabase",
    pageId: doc,
    databaseId: db,
    statusField: "status",
    doneValue: "Erledigt",
    openValue: "Nicht begonnen",
    dueField: "date",
    personField: "assignee",
    parentField: "parent",
    document: "link",
  })) as { databaseId: string; rowIds: string[]; done: number; document: string; restore: unknown[] };
  assert.equal(result.rowIds.length, 3);
  assert.equal(result.done, 1);
  const rows = await records(db);
  assert.deepEqual(
    rows.map((r) => [r.cells.title, r.cells.status, r.cells.date ?? null, r.cells.assignee ?? null, r.cells.priority]),
    [
      ["Angebot", "Nicht begonnen", "2026-12-24", ben.id, "Mittel"],
      ["Rechnung", "Erledigt", null, null, "Mittel"],
      ["Belege sammeln", "Nicht begonnen", null, null, "Mittel"],
    ],
    "mapped values, and the property's default (#411) for the rest",
  );
  assert.deepEqual(rows[2].cells.parent, [rows[1].id], "the sub-task below its parent");
  assert.equal(rows[1].cells.parent, undefined);
  assert.match(rows[0].content, /Mit Kunde abstimmen/, "the task's notes are the record's document");
  const html = await docHtml(doc);
  assert.doesNotMatch(html, /data-type="taskItem"/);
  for (const r of rows) assert.ok(html.includes(`#page=${db}&amp;row=${r.id}`) || html.includes(`#page=${db}&row=${r.id}`), "a link to each record");
  assert.match(html, /Plan/);
  assert.match(html, /Ende/);
  assert.equal((await myTasks(ben, wid)).filter((t) => t.pageId === doc).length, 0, "no longer a document task");

  // Undo (as the toast builds it): the tasks are back, the records in the trash.
  const plan2 = undoFor({ action: "page.tasksToDatabase", pageId: doc, databaseId: db, document: "link" }, { boot: { pages: [] } as never, data: null }, null, result);
  assert.ok(plan2);
  for (const c of plan2!.commands({ boot: { pages: [] } as never, data: null })) await command(anna, c);
  assert.equal((await records(db)).length, 0);
  const restored = await docHtml(doc);
  assert.equal((restored.match(/data-type="taskItem"/g) || []).length, 4);
  assert.match(restored, /data-checked="true"/);
  assert.match(restored, /data-due="2026-12-24"/);
  assert.match(restored, /Mit Kunde abstimmen/);
  assert.doesNotMatch(restored, new RegExp(`row=${rows[0].id}`));
});

test("remove or keep the tasks; flat without a parent property; a checkbox for done", async () => {
  const doc = await create("Liste", "document");
  const db = await create("Erledigungen", "database", { databaseKind: "tasks" });
  const fields = (await database(db)).fields as Field[];
  await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([...fields, { id: "ok", name: "Erledigt", type: "checkbox" }]), db);
  await writeDoc(doc, `<p>Oben</p>${list(done("A", list(task("A1"))), task("B"))}`);

  const kept = (await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db, statusField: "ok", document: "keep" })) as { rowIds: string[]; restore: unknown[] };
  assert.equal(kept.rowIds.length, 3);
  assert.deepEqual(kept.restore, []);
  const rows = await records(db);
  assert.deepEqual(rows.map((r) => [r.cells.title, r.cells.ok, r.cells.parent]), [["A", true, undefined], ["A1", false, undefined], ["B", false, undefined]]);
  assert.equal((rows[0].cells.status as string | undefined) ?? "", "", "the status property is not touched");
  assert.equal(((await docHtml(doc)).match(/data-type="taskItem"/g) || []).length, 3, "kept as they are");

  const removed = (await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db, document: "remove" })) as { rowIds: string[] };
  assert.equal(removed.rowIds.length, 3);
  const html = await docHtml(doc);
  assert.doesNotMatch(html, /taskItem|taskList/);
  assert.match(html, /Oben/);
  // A document without tasks: refused.
  await assert.rejects(async () => await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db }), /keine Aufgaben/);
});

test("rights: edit the document and add records to the database; values checked", async () => {
  const doc = await create("Geheim", "document");
  const db = await taskDatabase("Team-Aufgaben");
  await writeDoc(doc, list(task("Eins")));
  // Viewers of the document may not.
  await assert.rejects(async () => await command(viewer, { action: "page.tasksToDatabase", pageId: doc, databaseId: db }), (e: Error & { status?: number }) => e.status === 403);
  // An editor of the document who may only read the database may not either.
  const own = await create("Nur lesen", "database", { databaseKind: "tasks" });
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,'','viewer','page',?)", own, ben.id, wid);
  assert.equal((await tasksToDatabasePlan(ben, doc)).databases.some((d) => d.id === own), false, "not offered");
  await assert.rejects(async () => await command(ben, { action: "page.tasksToDatabase", pageId: doc, databaseId: own }), (e: Error & { status?: number }) => e.status === 403);
  assert.equal((await records(own)).length, 0);
  // Unknown options and properties are refused; nothing is created.
  await assert.rejects(async () => await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db, statusField: "status", doneValue: "Fertig!" }), /Unbekannte Auswahl/);
  await assert.rejects(async () => await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db, dueField: "status" }), /Eigenschaft fehlt/);
  // A locked document.
  await run("UPDATE pages SET locked=1 WHERE id=?", doc);
  await assert.rejects(async () => await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db }), /gesperrt/);
  await run("UPDATE pages SET locked=0 WHERE id=?", doc);
  assert.equal((await records(db)).length, 0);
  assert.match(await docHtml(doc), /data-type="taskItem"/);
  // Undo removes only records its person created.
  const theirs = ((await command(ben, { action: "row.create", pageId: db, cells: { title: "Bens" } })) as { id: string }).id;
  await command(anna, { action: "page.tasksToDatabase.undo", pageId: doc, databaseId: db, rowIds: [theirs] });
  assert.equal((await records(db)).length, 1);
});

test("encrypted spaces: refused, the server cannot read their documents", async () => {
  const doc = await create("Verschlüsselt", "document");
  const db = await taskDatabase("Ziel");
  await writeDoc(doc, list(task("Geheim")));
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  try {
    await assert.rejects(async () => await command(anna, { action: "page.tasksToDatabase", pageId: doc, databaseId: db }), /verschlüsselte/);
    await assert.rejects(async () => await tasksToDatabasePlan(anna, doc), /verschlüsselte/);
  } finally {
    await run("UPDATE spaces SET encrypted=0 WHERE id=?", space);
  }
  assert.equal((await records(db)).length, 0);
});
