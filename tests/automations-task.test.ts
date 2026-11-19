// "Aufgabe erstellen" of the database rules (#380, lib/automation-task.ts):
// a task in the record's document or a record in a task database, with
// placeholders, people, relative due dates, select values and a relation
// back; as the rule's creator; once per record; no chains of tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-auto-task-"));
const { id, run, one, all, transaction } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { processScheduledAutomations } = await import("../lib/automations");
const { automationToGraph } = await import("../lib/workflows/legacy");
const { englishMessage } = await import("../lib/i18n-errors");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("Olga"),
  editor = await user("Emil"),
  other = await user("Otto");
const wid = await createWorkspace(owner.id, "Tasks"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, other.id, "editor");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const makeDatabase = async (title: string, fields: Field[]) => {
  const pid = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  await act({ action: "database.update", pageId: pid, version: (await database(pid)).version, fields, views: (await database(pid)).views });
  return pid;
};
const tickets = await makeDatabase("Tickets", [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Doing", "Done"] },
  { id: "owner", name: "Owner", type: "person" },
]);
const tasks = await makeDatabase("To-dos", [
  { id: "name", name: "Name", type: "text" },
  { id: "who", name: "Assignee", type: "person" },
  { id: "deadline", name: "Deadline", type: "date" },
  { id: "prio", name: "Priority", type: "select", options: ["Low", "High"] },
  { id: "ticket", name: "Ticket", type: "relation", relationPage: tickets },
]);
// The relation both ways: the ticket gets a "To-dos" property.
{
  const db = await database(tasks);
  await act({ action: "database.update", pageId: tasks, version: db.version, fields: db.fields, views: db.views, relation: { fieldId: "ticket", enabled: true, name: "To-dos", targetVersion: (await database(tickets)).version } });
}
const inverse = (await database(tickets)).fields.find((f) => f.type === "relation")!.id;
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const update = async (rid: string, patch: Record<string, unknown>, who = owner) => await act({ action: "row.update", pageId: tickets, rowId: rid, version: await version(rid), cells: patch }, who);
const rules = async (automations: unknown[], who = owner, pageId = tickets) => await act({ action: "database.settings", pageId, settings: { automations } }, who);
const html = async (rid: string) => (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rid))?.html || "";
const taskRows = async () => (await all<{ id: string; cells: string; created_by: string }>("SELECT id,cells,created_by FROM rows WHERE page_id=? ORDER BY position", tasks)).map((r) => ({ ...r, cells: JSON.parse(r.cells) }));
const plusDays = (days: number, from = new Date().toISOString().slice(0, 10)) => new Date(Date.parse(from) + days * 86_400_000).toISOString().slice(0, 10);
const task = (extra: Record<string, unknown>) => ({ type: "task", text: "Follow up: {{Title}} ({{Status}})", ...extra });

test("into the record's document: task item with person, due date and heading; once per record", async () => {
  await rules([{ id: "doc", name: "Follow up", trigger: { type: "changed", field: "status", to: "Done" }, actions: [task({ assignee: "field:owner", due: 3, heading: "Next steps" })] }]);
  const rid = (await act({ action: "row.create", pageId: tickets, cells: { title: "Printer", status: "Open", owner: editor.id } })).id;
  assert.equal(await html(rid), "", "nothing before the trigger");
  await update(rid, { status: "Done" });
  const doc = await html(rid);
  assert.match(doc, /<h2[^>]*>Next steps<\/h2>/);
  assert.match(doc, /data-type="taskItem"/);
  assert.match(doc, new RegExp(`data-due="${plusDays(3)}"`));
  assert.match(doc, /Follow up: Printer \(Done\)/);
  assert.match(doc, new RegExp(`data-mention="${editor.id}"`));
  // It is in the task index ("Meine Aufgaben") for its person.
  const indexed = await all<{ text: string; due: string; assignee: string }>("SELECT text,due,assignee FROM doc_tasks WHERE page_id=? AND row_id=?", tickets, rid);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].assignee, editor.id);
  assert.equal(indexed[0].due, plusDays(3));
  // Done → Open → Done again: still one task.
  await update(rid, { status: "Open" });
  await update(rid, { status: "Done" });
  assert.equal((await html(rid)).match(/data-type="taskItem"/g)?.length, 1);
});

test("people: who triggered it, the creator, a fixed member, nobody", async () => {
  const run1 = async (assignee: string) => {
    await rules([{ id: `p-${assignee || "none"}`, name: "People", trigger: { type: "created" }, actions: [task({ assignee, due: null, text: "Check {{Title}}" })] }]);
    const rid = (await act({ action: "row.create", pageId: tickets, cells: { title: `T ${assignee}` } }, other)).id;
    return { rid, doc: await html(rid), tasks: await all<{ assignee: string | null; due: string | null }>("SELECT assignee,due FROM doc_tasks WHERE row_id=?", rid) };
  };
  assert.equal((await run1("@actor")).tasks[0].assignee, other.id);
  assert.equal((await run1("@creator")).tasks[0].assignee, other.id);
  const fixed = await run1(editor.id);
  assert.equal(fixed.tasks[0].assignee, editor.id);
  assert.equal(fixed.tasks[0].due, null);
  const none = await run1("");
  assert.equal(none.tasks.length, 1);
  assert.equal(none.tasks[0].assignee, null);
  assert.doesNotMatch(none.doc, /data-mention/);
  // A person who is no member is refused when saving.
  const stranger = await user("Stranger");
  await assert.rejects(rules([{ id: "x", trigger: { type: "created" }, actions: [task({ assignee: stranger.id })] }]), /kein Mitglied/);
});

test("a template of the same rule still finds the document empty", async () => {
  const template = (await act({ action: "row.create", pageId: tickets, cells: { title: "Tpl" } })).id;
  const { replaceRowDocument } = await import("../lib/row-documents");
  await replaceRowDocument(template, "<p>From the template</p>", owner.id);
  const tid = (await act({ action: "row.template.save", pageId: tickets, rowId: template, name: "Tpl" })).id;
  await rules([{ id: "both", name: "Both", trigger: { type: "created" }, actions: [{ type: "template", template: tid }, task({ text: "After the template" })] }]);
  const rid = (await act({ action: "row.create", pageId: tickets, cells: { title: "Combined" } })).id;
  const doc = await html(rid);
  assert.match(doc, /From the template[\s\S]*After the template/);
});

test("into a task database: title, person, relative due date, select value, relation back", async () => {
  await rules([
    {
      id: "db",
      name: "To-do",
      trigger: { type: "created" },
      actions: [task({ target: "database", database: tasks, assignee: "field:owner", due: 2, values: { prio: "High" }, relation: "ticket", personField: "who", dueField: "deadline" })],
    },
  ]);
  const rid = (await act({ action: "row.create", pageId: tickets, cells: { title: "Router", status: "Open", owner: editor.id } }, other)).id;
  const made = (await taskRows()).at(-1)!;
  assert.deepEqual(made.cells, { name: "Follow up: Router (Open)", who: editor.id, deadline: plusDays(2), prio: "High", ticket: [rid] });
  // Made by the rule's creator (who saved it), not by who triggered it.
  assert.equal(made.created_by, owner.id);
  // The back link on the ticket.
  assert.deepEqual((await cells(rid))[inverse], [made.id]);
  // Once per record: a change does not make another.
  await update(rid, { status: "Doing" });
  assert.equal((await taskRows()).filter((r) => (r.cells.ticket || []).includes(rid)).length, 1);
});

test("saving checks the task database, its properties and the rights of who saves", async () => {
  const base = { id: "chk", trigger: { type: "created" } };
  await assert.rejects(rules([{ ...base, actions: [task({ text: " " })] }]), /braucht einen Text/);
  await assert.rejects(rules([{ ...base, actions: [task({ target: "database" })] }]), /Wähle eine Datenbank/);
  await assert.rejects(rules([{ ...base, actions: [task({ target: "database", database: tickets + "x" })] }]), /gibt es nicht/);
  await assert.rejects(rules([{ ...base, actions: [task({ target: "database", database: tasks, values: { prio: "Urgent" } })] }]), /nicht zur Eigenschaft/);
  await assert.rejects(rules([{ ...base, actions: [task({ target: "database", database: tasks, relation: "name" })] }]), /unbekannte Eigenschaft/);
  await assert.rejects(rules([{ ...base, actions: [task({ target: "database", database: tasks, personField: "deadline" })] }]), /unbekannte Eigenschaft/);
  // Only viewing the task database: the rule cannot be saved by them.
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,'','viewer','page',?)", tasks, editor.id, wid);
  await assert.rejects(rules([{ ...base, actions: [task({ target: "database", database: tasks })] }], editor), /darfst du keine Einträge anlegen/);
  await run("DELETE FROM grants WHERE resource_id=? AND user_id=?", tasks, editor.id);
  // Scheduled rules have no record: no document, no relation, no record people.
  const schedule = { type: "schedule", freq: "daily", interval: 1, time: "00:00", timeZone: "UTC" };
  await assert.rejects(rules([{ id: "s", trigger: schedule, actions: [task({})] }]), /keinen auslösenden Eintrag/);
  await assert.rejects(rules([{ id: "s", trigger: schedule, actions: [task({ target: "database", database: tasks, relation: "ticket" })] }]), /keinen auslösenden Eintrag/);
  await assert.rejects(rules([{ id: "s", trigger: schedule, actions: [{ type: "notify", to: "@creator" }] }]), /Geplante Regeln/);
});

test("the rule acts with its creator's rights: without edit rights on the task database the change fails visibly", async () => {
  await rules([{ id: "rights", name: "Hand over", trigger: { type: "created" }, actions: [task({ target: "database", database: tasks, text: "Take {{Title}}" })] }], editor);
  assert.equal((await database(tickets)).settings?.automations?.[0].createdBy, editor.id);
  // A person who may not edit the task database triggers it: still made (the creator's rights).
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,'','viewer','page',?)", tasks, other.id, wid);
  const before = (await taskRows()).length;
  await act({ action: "row.create", pageId: tickets, cells: { title: "By Otto" } }, other);
  assert.equal((await taskRows()).length, before + 1);
  assert.equal((await taskRows()).at(-1)!.created_by, editor.id);
  await run("DELETE FROM grants WHERE resource_id=? AND user_id=?", tasks, other.id);
  // The creator loses edit rights on the task database: an error, nothing saved.
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,'','viewer','page',?)", tasks, editor.id, wid);
  const count = (await all("SELECT id FROM rows WHERE page_id=?", tickets)).length;
  await assert.rejects(act({ action: "row.create", pageId: tickets, cells: { title: "Blocked" } }), (e: Error) => {
    assert.match(e.message, /^Regel „Hand over“: Aufgabe nicht erstellt – Emil darf in „To-dos“ nichts anlegen\.$/);
    assert.equal(englishMessage(e.message), "Rule “Hand over”: task not created – Emil may not create anything in “To-dos”.");
    return true;
  });
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", tickets)).length, count);
  await run("DELETE FROM grants WHERE resource_id=? AND user_id=?", tasks, editor.id);
});

test("loops: a task record runs its database's rules once, but their tasks make nothing further", async () => {
  // Tickets → task in To-dos; To-dos → task back in Tickets (and so on).
  await rules([{ id: "there", name: "There", trigger: { type: "created" }, actions: [task({ target: "database", database: tasks, text: "Task for {{Title}}" })] }]);
  await rules(
    [
      {
        id: "back",
        name: "Back",
        trigger: { type: "created" },
        actions: [{ type: "set", field: "prio", value: "Low" }, task({ target: "database", database: tickets, text: "Ticket for {{Name}}" })],
      },
    ],
    owner,
    tasks,
  );
  const ticketsBefore = (await all("SELECT id FROM rows WHERE page_id=?", tickets)).length;
  const tasksBefore = (await taskRows()).length;
  await act({ action: "row.create", pageId: tickets, cells: { title: "Loop" } });
  assert.equal((await all("SELECT id FROM rows WHERE page_id=?", tickets)).length, ticketsBefore + 1);
  const made = await taskRows();
  assert.equal(made.length, tasksBefore + 1);
  // The task database's other actions did run.
  assert.equal(made.at(-1)!.cells.prio, "Low");
  await rules([], owner, tasks);
});

test("scheduled rules create task records once per date; a failure costs only that date and lands in the inbox", async () => {
  const schedule = { type: "schedule", freq: "daily", interval: 1, time: "00:00", timeZone: "UTC" };
  await rules([{ id: "daily", name: "Daily", trigger: schedule, actions: [task({ target: "database", database: tasks, text: "Standup {{Heute}}", assignee: "@actor", due: 1 })] }], editor);
  const since = Date.parse((await database(tickets)).settings!.automations![0].since!);
  const tomorrow = since + 86_400_000;
  const before = (await taskRows()).length;
  assert.equal(await transaction(async () => await processScheduledAutomations(tomorrow)), 1);
  assert.equal(await transaction(async () => await processScheduledAutomations(tomorrow)), 0);
  const made = (await taskRows()).at(-1)!;
  assert.equal((await taskRows()).length, before + 1);
  const day = new Date(tomorrow).toISOString().slice(0, 10);
  assert.equal(made.cells.who, editor.id);
  assert.equal(made.cells.deadline, plusDays(1, day));
  assert.match(made.cells.name, /^Standup \S+/);
  assert.equal(made.created_by, editor.id);
  // The creator can no longer write there: nothing made, the date is used, a notice.
  await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,'','viewer','page',?)", tasks, editor.id, wid);
  const next = tomorrow + 86_400_000;
  assert.equal(await transaction(async () => await processScheduledAutomations(next)), 0);
  assert.equal((await taskRows()).length, before + 1);
  assert.ok(await one("SELECT 1 FROM notifications WHERE user_id=? AND kind='automation' AND body LIKE ?", editor.id, "Regel „Daily“: Aufgabe nicht erstellt%"));
  assert.equal(await transaction(async () => await processScheduledAutomations(next)), 0);
  assert.equal((await all("SELECT 1 FROM notifications WHERE user_id=? AND kind='automation' AND body LIKE ?", editor.id, "Regel „Daily“%")).length, 1);
  await run("DELETE FROM grants WHERE resource_id=? AND user_id=?", tasks, editor.id);
  await rules([]);
});

test("rules with tasks: no graph node, and not opened in the canvas", async () => {
  const rule = { id: "g", name: "G", enabled: true, trigger: { type: "created" as const }, conditions: [], actions: [task({}) as never] };
  const graph = automationToGraph(rule, tickets, []);
  assert.deepEqual(graph.nodes.map((n) => n.type), ["trigger.record.created"]);
  await rules([{ id: "g", trigger: { type: "created" }, actions: [task({})] }]);
  await assert.rejects(act({ action: "workflow.fromRule", pageId: tickets, automationId: "g" }), /noch nicht im Canvas/);
  await rules([]);
});
