// Personal tasks (#208): "Aufgabe hinzufügen …" at the top of My tasks
// writes a normal task into the person's own page "Aufgaben" – a document
// in their private space of the workspace, made on first use. Because it is
// a normal document task, everything tasks can do keeps working: states and
// Ctrl/Cmd+L (#201), reminders, the widgets, Siri and Spotlight. The page is
// a normal page (in the sidebar, renamed or moved at will); My tasks
// remembers it by id (personal_task_pages) and makes a new one on the next
// task when it was deleted or the person can no longer edit it.
//
// Where the page goes: the person's first private space of the workspace
// (not an encrypted one: the server writes the task); without one, a new
// private space "Privat" – exactly what "Neuer Bereich → Privat" makes.
// Guests and readers have no such space and cannot add tasks here.
//
// The shorthand of quick capture (lib/capture-parse.ts) applies to the
// text: "Steuer morgen" gets tomorrow as its due date. "@name" gives the
// task to that member only when they may open the page – a private page is
// theirs to read only after it was shared or moved; otherwise the name
// stays in the text and the answer says why.
//
// #457: the person may send these tasks to a task database instead
// (lib/my-task-target.ts); then the task is a record – see addToDatabase.
import { z } from "zod";
import { all, lockFor, one, run } from "./db";
import { pageRole, requireMember } from "./permissions";
import { ct } from "./content-locale";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { isEncryptedPage } from "./e2ee-server";
import { journalLocked } from "./journal-extras";
import { findMember, parseCapture, type CaptureMember } from "./capture-parse";
import { syncDocTasks } from "./doc-tasks";
import { TASK_TEXT_MAX } from "./task-text-max";
import { recordPageEdit } from "./page-activity";
import { appendTask, taskItemJson } from "./task-append";
import { SPACE_ORDER } from "./space-order";
import { myTaskTarget, type TaskTargetProblem } from "./my-task-target";
import { selectedRowTemplate } from "./row-documents";
import { databaseSettings } from "./database-settings";
import { taskFields } from "./task-database-fields";
import type { Field, Identity, Page } from "./types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const api = import("./api");

// The page, when it still exists and the person may write into it.
export async function personalTaskPage(user: Identity, workspaceId: string): Promise<Page | null> {
  const row = await one<{ page_id: string }>("SELECT page_id FROM personal_task_pages WHERE user_id=? AND workspace_id=?", user.id, workspaceId);
  if (!row) return null;
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", row.page_id);
  if (!page || page.workspace_id !== workspaceId || page.kind !== "document" || page.locked) return null;
  const role = await pageRole(user, page);
  if (role !== "editor" && role !== "owner") return null;
  if ((await isEncryptedPage(page)) || (await journalLocked(user, page))) return null;
  return page;
}

// The person's private space for it: the first one they own that the
// server can write into, else a new one.
async function privateSpace(user: Identity, workspaceId: string) {
  const own = await one<{ id: string }>(
    `SELECT id FROM spaces WHERE workspace_id=? AND owner_id=? AND visibility='private' AND deleted_at IS NULL AND COALESCE(encrypted,0)=0
     ORDER BY ${SPACE_ORDER} LIMIT 1`,
    workspaceId,
    user.id,
  );
  if (own) return { id: own.id, created: false };
  const made = (await (await api).command(user, { action: "space.create", workspaceId, name: ct("Privat", "Private"), private: true }, true)) as { id: string };
  return { id: made.id, created: true };
}

// The page, made when there is none. Inside a command's transaction.
export async function ensurePersonalTaskPage(user: Identity, workspaceId: string) {
  // Two quick adds at once make one page (PostgreSQL; SQLite writes one at a time).
  await lockFor(`personal-tasks:${user.id}:${workspaceId}`);
  const existing = await personalTaskPage(user, workspaceId);
  if (existing) return { page: existing, created: false, spaceCreated: false };
  await requireMember(user, workspaceId, "editor");
  const space = await privateSpace(user, workspaceId);
  const made = (await (await api).command(user, { action: "page.create", workspaceId, spaceId: space.id, title: ct("Aufgaben", "Tasks"), kind: "document" }, true)) as { id: string };
  await run("UPDATE pages SET icon=? WHERE id=?", "✅", made.id);
  await run(
    `INSERT INTO personal_task_pages(user_id,workspace_id,page_id,created_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id,workspace_id) DO UPDATE SET page_id=excluded.page_id,created_at=excluded.created_at`,
    user.id,
    workspaceId,
    made.id,
    Date.now(),
  );
  return { page: (await one<Page>("SELECT * FROM pages WHERE id=?", made.id))!, created: true, spaceCreated: space.created };
}

// Whether the person can add tasks here (the field in My tasks): a full
// member who may write (guests and readers cannot).
export async function canAddPersonalTask(user: Identity, workspaceId: string) {
  try {
    await requireMember(user, workspaceId, "editor");
    return true;
  } catch {
    return false;
  }
}

async function members(workspaceId: string): Promise<CaptureMember[]> {
  return await all<CaptureMember>(
    "SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND COALESCE(u.disabled,0)=0 ORDER BY u.name LIMIT 500",
    workspaceId,
  );
}

export const personalTaskInput = z.object({
  workspaceId: z.uuid(),
  text: z.string().trim().min(1).max(TASK_TEXT_MAX),
  // The person's today, for "morgen", "Freitag" … in the text.
  today: z.string().regex(DAY),
  locale: z.enum(["de", "en", "fr"]).optional(),
  // A date picked next to the field wins over one in the text.
  due: z.string().regex(DAY).nullable().optional(),
});

type TaskInput = z.infer<typeof personalTaskInput>;
const asIdentity = (person: CaptureMember) => ({ id: person.id, name: person.name, groups: [], isAdmin: false }) as unknown as Identity;

// The command `task.add`: into the chosen task database (#457), else – also
// when that database can no longer take it (`fallback` says why) – into the
// own page.
export async function addPersonalTask(user: Identity, raw: unknown, afterCommit: (() => unknown)[]) {
  const input = personalTaskInput.parse(raw);
  await requireMember(user, input.workspaceId, "editor");
  const target = await myTaskTarget(user, input.workspaceId);
  if (target.kind === "database" && !target.problem) return await addToDatabase(user, target.id, input);
  return { ...(await addToPage(user, input, afterCommit)), fallback: target.kind === "database" ? target.problem : null };
}

// A record of the task database, mapped like "Aufgaben in Datenbank
// verschieben" (#420) and quick capture: the text without the shorthand is
// the title, its date goes into the due date property, "@name" into the
// person property (only someone who may open the database, else the name
// stays in the text), #tag and !priority into their properties; without
// "@name" the person property gets the person adding it, so the task shows
// in their My tasks. A select status gets the database's "open" value
// unless a default value or the default record template sets it. The
// record is made through row.create: field rights, default values, the
// default record template and the database's automations apply.
async function addToDatabase(user: Identity, databaseId: string, input: TaskInput) {
  const { command } = await api;
  const { captureProperties } = await import("./desktop-capture");
  const db = (await one<Page>("SELECT * FROM pages WHERE id=?", databaseId))!;
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db.id))!.fields) as Field[];
  const properties = await captureProperties(user, db);
  const people = await members(input.workspaceId);
  const context = { today: input.today, locale: input.locale, properties, members: people };
  let parsed = parseCapture(input.text, context);
  let unassigned: string | null = null;
  let unassignedReason: "access" | "property" | null = null;
  const personToken = parsed.chips.find((c) => c.kind === "person");
  // The person property "@name" goes into (the capture shorthand's choice), else the first.
  const personField = properties.find((p) => p.id === personToken?.field?.id) || properties.find((p) => p.type === "person");
  if (personToken?.field && personToken.cell !== user.id) {
    const person = people.find((m) => m.id === personToken.cell)!;
    if (!(await pageRole(asIdentity(person), db))) {
      // The name stays as typed: the record would be invisible to them.
      parsed = parseCapture(input.text, { ...context, literal: [personToken.id] });
      unassigned = person.name || person.email;
      unassignedReason = "access";
    }
  } else if (personToken && !personToken.field) {
    // "@name" of a member, but no person property they could go into.
    const member = findMember(people, personToken.value as string);
    if (member) {
      unassigned = member.name || member.email;
      unassignedReason = "property";
    }
  }
  const cells: Record<string, unknown> = { ...parsed.cells };
  if (personField && cells[personField.id] === undefined) cells[personField.id] = user.id;
  const due = properties.find((p) => p.type === "date" && p.due);
  if (due && input.due !== undefined) {
    if (input.due) cells[due.id] = input.due;
    else delete cells[due.id];
  }
  const found = taskFields(fields, await databaseSettings(db.id), db.id);
  const status = found.status;
  if (status?.type === "select" && found.openValue && cells[status.id] === undefined && status.defaultValue === undefined && properties.some((p) => p.id === status.id)) {
    const template = await selectedRowTemplate(db.id, undefined);
    const preset = template ? (JSON.parse(template.cells) as Record<string, unknown>)[status.id] : undefined;
    if (preset === undefined || preset === null || preset === "") cells[status.id] = found.openValue;
  }
  const text = (parsed.title || input.text).slice(0, TASK_TEXT_MAX);
  if (fields[0]) cells[fields[0].id] = text;
  const row = (await command(user, { action: "row.create", pageId: db.id, cells }, true)) as { id: string };
  const assignee = personField && typeof cells[personField.id] === "string" ? (cells[personField.id] as string) : null;
  const dueValue = due && typeof cells[due.id] === "string" ? String(cells[due.id]).slice(0, 10) : null;
  return {
    pageId: db.id,
    title: db.title,
    created: false,
    spaceCreated: false,
    target: "database" as const,
    rowId: row.id,
    task: { text, due: dueValue, assignee },
    unassigned,
    unassignedReason,
    fallback: null as TaskTargetProblem | null,
  };
}

// Into the own page "Aufgaben".
async function addToPage(user: Identity, input: TaskInput, afterCommit: (() => unknown)[]) {
  const { page, created, spaceCreated } = await ensurePersonalTaskPage(user, input.workspaceId);
  const people = await members(input.workspaceId);
  const context = { today: input.today, locale: input.locale, task: true, members: people };
  let parsed = parseCapture(input.text, context);
  // The member "@name" could not be given the task to (the client says why).
  let unassigned: string | null = null;
  let assignee: CaptureMember | null = null;
  if (parsed.assignee && parsed.assignee !== user.id) {
    const person = people.find((m) => m.id === parsed.assignee)!;
    if (await pageRole(asIdentity(person), page)) assignee = person;
    else {
      // The name stays as typed: the task would be invisible to them.
      const chip = parsed.chips.find((c) => c.kind === "person" && c.field);
      parsed = parseCapture(input.text, { ...context, literal: chip ? [chip.id] : [] });
      unassigned = person.name || person.email;
    }
  }
  const text = (parsed.title || input.text).slice(0, TASK_TEXT_MAX);
  const due = input.due !== undefined ? input.due : parsed.due ? parsed.due.slice(0, 10) : null;
  const item = taskItemJson(text ? [{ type: "text", text }] : [], { due, assignee: assignee ? { id: assignee.id, name: assignee.name || assignee.email } : null });
  const changed = (await rewriteDocument(page.id, null, user.id, (doc) => appendTask(doc, rewriteSchema(), item)))!;
  await syncDocTasks(user, page, null, changed.ydoc);
  await recordPageEdit(user, page.id);
  afterCommit.push(changed.publish);
  return {
    pageId: page.id,
    title: page.title,
    created,
    spaceCreated,
    target: "page" as const,
    rowId: null,
    task: { text, due, assignee: assignee?.id ?? null },
    unassigned,
    unassignedReason: unassigned ? ("access" as const) : null,
  };
}
