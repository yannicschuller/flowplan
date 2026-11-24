// "Aufgabe erstellen" of the database rules (#380, the action "task" in
// lib/database-settings-schema.ts): one task per record and rule, either as
// a task item in the triggering record's document (with person and due
// date, as the workflow node "Aufgabe erstellen" writes one, lib/task-
// append.ts) or as a new record in a task database (title, person, due
// date, select values, a relation back to the triggering record).
//
// It acts as the person who set the rule up (the rule's createdBy, as the
// scheduled rules do): their rights decide, never those of whoever
// triggered it – a form submitted by a guest creates tasks, a person
// without rights on the task database cannot make a rule write there.
// The writes go through command() as that person, so locks, journal PINs,
// field rights, the task index ("Meine Aufgaben"), mentions and open
// editors behave as for a click in the browser.
//
// Loops: records a rule creates in a task database run that database's
// rules once (as the records of scheduled rules do), but task actions of
// those rules create nothing further.
import { AsyncLocalStorage } from "node:async_hooks";
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { id, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { Temporal } from "./date-values";
import { isEncryptedPage } from "./e2ee-server";
import { databaseSettings } from "./database-settings";
import { type Automation, type TaskAction } from "./database-settings-schema";
import { taskFields } from "./task-database-fields";
import { ensureRowDocument, requireRow } from "./row-documents";
import { withPlaceholders } from "./record-template-apply";
import { mapPlaceholders } from "./record-placeholders";
import { appendTask, taskItemJson } from "./task-append";
import { rewriteSchema } from "./document-rewrite";
import { flushRelationChanges } from "./relation-sync";
import { runnerIdentity } from "./workflows/runner";
import type { Field, Identity, Page, Row } from "./types";

// lib/api.ts lazily (it imports nearly everything; see lib/workflows/nodes/records.ts).
const api = import("./api");

// How many task records deep the current change is (0: a person's own change).
const taskDepth = new AsyncLocalStorage<number>();

export type TaskRun = {
  rule: Automation;
  // The rule's database and its properties.
  page: Page;
  fields: Field[];
  // The triggering record; null for scheduled rules.
  rowId: string | null;
  // Who caused the event ("@actor"); for scheduled rules the rule's creator.
  actor: Identity | null;
  // The day the due date counts from (YYYY-MM-DD) and the time zone of
  // the placeholders; scheduled rules: the run's day and their zone.
  day?: string;
  zone?: string;
};

const ruleName = (rule: Automation) => rule.name || "Automation";
// A visible error: the change that triggered the rule is not saved.
const fail = (rule: Automation, message: string, status = 400) => new HttpError(status, `Regel „${ruleName(rule)}“: Aufgabe nicht erstellt – ${message}`);
const personName = (who: Pick<Identity, "name" | "email">) => who.name || who.email;

// The rule's task actions for one record (or one scheduled date). Returns
// how many tasks were made.
export async function runTaskActions(input: TaskRun): Promise<number> {
  const { rule } = input;
  const actions = rule.actions.map((action, index) => ({ action, index })).filter((x): x is { action: TaskAction; index: number } => x.action.type === "task");
  if (!actions.length) return 0;
  // A record made by a rule's task: no further tasks from its rules.
  if ((taskDepth.getStore() ?? 0) > 0) return 0;
  const owner = await runnerIdentity(rule.createdBy);
  if (!owner) throw fail(rule, "die Person, die die Regel eingerichtet hat, gibt es nicht mehr.", 409);
  const raw = input.rowId ? await one<Row & { cells: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", input.rowId, input.page.id) : undefined;
  if (input.rowId && !raw) return 0;
  const record = raw ? { ...raw, cells: JSON.parse(raw.cells) as Record<string, unknown> } : null;
  // The task carries the record's values: only for a record the rule's
  // creator may read (record access, journal PIN). Otherwise no task – the
  // change of whoever may see it is still saved (#489).
  if (record)
    try {
      await requireRow(owner, input.page.id, record.id);
    } catch (e) {
      if (e instanceof HttpError) return 0;
      throw e;
    }
  let made = 0;
  for (const { action, index } of actions) {
    if (action.target === "document" && !record) continue;
    // Once per record and rule (scheduled rules: once per date already).
    if (record) {
      const fresh = await run("INSERT INTO automation_runs(automation_id,row_id,key,at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", rule.id, record.id, `task:${index}`, Date.now());
      if (!fresh.changes) continue;
    }
    const text = (await taskText(input, owner, action, record)) || ruleName(rule);
    const assignee = await assigneeOf(input, action, record);
    const due = action.due === null ? null : Temporal.PlainDate.from(input.day || new Date().toISOString().slice(0, 10)).add({ days: action.due }).toString();
    if (action.target === "document") await intoDocument(input, owner, record!, text, assignee, due, await taskHeading(input, owner, action, record));
    else await intoDatabase(input, owner, action, text, assignee, due);
    made++;
  }
  return made;
}

// The text with the record's values for its placeholders ({{Titel}},
// {{Status}}, {{Heute}} …), as record templates fill them; one line.
// The heading the task goes below takes them as well (#413): "{{Status}}"
// files each task below the heading of the record's status.
// A heading without placeholders stays exactly as written.
const taskText = (input: TaskRun, owner: Identity, action: TaskAction, record: (Row & { cells: Record<string, unknown> }) | null) =>
  filled(input, owner, action.text, record, 300);
const taskHeading = async (input: TaskRun, owner: Identity, action: TaskAction, record: (Row & { cells: Record<string, unknown> }) | null) =>
  action.heading.includes("{{") ? await filled(input, owner, action.heading, record, 200) : action.heading;
// Related records' titles as the rule's creator may see them (#489);
// {{Ich}} stays the person who triggered it.
async function filled(input: TaskRun, owner: Identity, template: string, record: (Row & { cells: Record<string, unknown> }) | null, max: number) {
  if (!template.includes("{{")) return template.replace(/\s+/g, " ").trim();
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const source = record || { id: "", page_id: input.page.id, created_by: "", updated_by: "", created_at: now, updated_at: now, cells: {} };
  const text = await withPlaceholders(input.page, input.fields, source, input.actor, input.zone, (resolve) => mapPlaceholders(template, resolve), owner);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

// The task's person: a member of the workspace, or nobody.
async function assigneeOf(input: TaskRun, action: TaskAction, record: { created_by: string; cells: Record<string, unknown> } | null): Promise<Identity | null> {
  const to = action.assignee;
  let uid: string | null = null;
  if (to === "@actor") uid = input.actor?.id ?? null;
  else if (to === "@creator") uid = record?.created_by || null;
  else if (to.startsWith("field:")) {
    const value = record?.cells[to.slice(6)];
    uid = (Array.isArray(value) ? value : [value]).find((v): v is string => typeof v === "string" && !!v) ?? null;
  } else uid = to || null;
  if (!uid) return null;
  const member = await one<Identity>(
    "SELECT u.* FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=? AND COALESCE(u.disabled,0)=0",
    input.page.workspace_id,
    uid,
  );
  return member ? ({ ...member, groups: [], isAdmin: false } as Identity) : null;
}

// A command as the rule's creator inside the current transaction; its
// refusal is the rule's error.
async function asOwner(input: TaskRun, owner: Identity, body: Record<string, unknown>) {
  try {
    return await (await api).command(owner, body, true);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status && status < 500) throw fail(input.rule, (e as Error).message, status);
    throw e;
  }
}

// (a) A task item at the end of the record's document, or below `heading`
// (made at the end when there is none) – one change through
// "row.document.sync", like typing it.
async function intoDocument(input: TaskRun, owner: Identity, record: Row, text: string, assignee: Identity | null, due: string | null, heading: string) {
  const { rule, page } = input;
  if (await isEncryptedPage(page)) throw fail(rule, "der Eintrag liegt in einem verschlüsselten Bereich, dort kann der Server nichts schreiben.");
  try {
    await requireRow(owner, page.id, record.id, true);
  } catch (e) {
    if ((e as { status?: number }).status === 403) throw fail(rule, `${personName(owner)} darf den Eintrag nicht bearbeiten.`, 403);
    throw fail(rule, (e as Error).message, (e as { status?: number }).status || 400);
  }
  if (assignee && assignee.id !== owner.id)
    try {
      await requireRow(assignee, page.id, record.id);
    } catch {
      throw fail(rule, `${personName(assignee)} kann den Eintrag nicht öffnen.`);
    }
  const stored = await ensureRowDocument(record);
  const schema = rewriteSchema();
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state);
    const before = Y.encodeStateVector(ydoc);
    const doc = PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
    const item = taskItemJson([{ type: "text", text }], { due, assignee: assignee ? { id: assignee.id, name: personName(assignee) } : null });
    const next = appendTask(doc, schema, item, heading);
    ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment("default"), next, { mapping: new Map(), isOMark: new Map() }));
    const update = Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64");
    await asOwner(input, owner, { action: "row.document.sync", pageId: page.id, rowId: record.id, generation: stored.generation, update });
  } finally {
    ydoc.destroy();
  }
}

// (b) A new record in the task database.
async function intoDatabase(input: TaskRun, owner: Identity, action: TaskAction, text: string, assignee: Identity | null, due: string | null) {
  const { rule } = input;
  const stored = action.database ? await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", action.database) : undefined;
  if (!stored || stored.kind !== "database" || stored.workspace_id !== input.page.workspace_id) throw fail(rule, "die Datenbank für die Aufgabe gibt es nicht mehr.", 409);
  try {
    await requirePage(owner, stored.id, true);
  } catch {
    throw fail(rule, `${personName(owner)} darf in „${stored.title || "Ohne Titel"}“ nichts anlegen.`, 403);
  }
  if (stored.locked) throw fail(rule, `„${stored.title || "Ohne Titel"}“ ist gesperrt.`, 409);
  if (await isEncryptedPage(stored)) throw fail(rule, "die Datenbank liegt in einem verschlüsselten Bereich, dort kann der Server nichts schreiben.");
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", stored.id))?.fields || "[]") as Field[];
  const settings = await databaseSettings(stored.id);
  const cells: Record<string, unknown> = {};
  if (fields[0]) cells[fields[0].id] = text;
  // The chosen properties, else the task database's own (lib/task-database-fields.ts).
  const fallback = taskFields(fields, settings);
  const personField = fields.find((f) => f.id === action.personField && f.type === "person") || fallback.person;
  if (assignee && personField) cells[personField.id] = assignee.id;
  const dateField = fields.find((f) => f.id === action.dueField && f.type === "date") || fallback.due;
  if (due && dateField) cells[dateField.id] = due;
  for (const [fieldId, value] of Object.entries(action.values)) {
    const field = fields.find((f) => f.id === fieldId);
    if (!field || !value) continue;
    if (field.type === "select") cells[field.id] = value;
    else if (field.type === "multiselect") cells[field.id] = [value];
  }
  const relation = input.rowId ? fields.find((f) => f.id === action.relation && f.type === "relation" && f.relationPage === input.page.id) : undefined;
  if (relation) {
    // Pending relation changes of the person who triggered it, with their
    // rights (as at the commit); the new link with the rule's.
    await flushRelationChanges(input.actor ?? undefined);
    cells[relation.id] = [input.rowId];
  }
  const depth = (taskDepth.getStore() ?? 0) + 1;
  const created = (await taskDepth.run(depth, async () => await asOwner(input, owner, { action: "row.create", pageId: stored.id, cells }))) as { id: string };
  if (relation) await flushRelationChanges(owner);
  return created.id;
}

// A scheduled rule whose task failed: the date counts as done (no retry
// every five minutes), its creator finds the error in the inbox.
export async function reportTaskFailure(page: Page, userId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Automation task failed", message);
  await run("INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'automation')", id(), userId, message.slice(0, 500), page.id, null);
}
