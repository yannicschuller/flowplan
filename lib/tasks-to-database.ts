// "Aufgaben in Datenbank verschieben" (#420): the task items of a document
// become records of a task database – title, done/open, due date and
// person mapped to its properties – and the document either links each
// task to its record, loses the tasks, or keeps them as they are.
//
// - Every task item is a record of its own, sub-tasks included (in
//   document order, so a parent exists before its sub-tasks). When the
//   database has a property for the parent record (subtasks, #-relation
//   with `parent`), a sub-task's record links to its parent's record;
//   otherwise the records stand side by side (flat).
// - The title is the task's own line (its first paragraph) as plain text;
//   the @mention of the person who becomes the record's person is left
//   out. Further blocks of the task (notes, a list below it – not its
//   sub-tasks) become the record's document.
// - Closed tasks (done, cancelled) take the "done" value, all others
//   (open, in progress, deferred) the "open" value; a checkbox is ticked or
//   not. Empty tasks without sub-tasks are left out (and go from the
//   document unless it is kept).
// - The records go through row.create (rights, field rights, field
//   defaults #411, the default record template, automations), the document
//   through rewriteDocument (a diff merged into its Yjs state, sent to open
//   editors) – all in the command's one transaction.
// - Undo ("Rückgängig" in the toast, lib/undo.ts): the command answers
//   where each removed or replaced task list was (the block that took its
//   place, else its neighbour); page.tasksToDatabase.undo puts the lists
//   back there – edits made elsewhere in the meantime stay – and moves the
//   records it created to the database's trash.
// Encrypted spaces: the server cannot read or write their documents, so
// both commands are refused there (lib/e2ee-server.ts guards them too).
import { isPageChipHref, pageChipContent } from "./page-chip";
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { HttpError } from "./auth";
import { one, sql } from "./db";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { stateHtml } from "./document-server";
import { replaceRowDocument } from "./row-documents";
import { validateCellPatch } from "./database-operations";
import { rowRoleResolver } from "./row-access";
import { trashRow } from "./row-trash";
import { maintainRowOrders } from "./row-order-server";
import { syncDocTasks } from "./doc-tasks";
import { captureTargets } from "./capture";
import { newBlockId, validBlockId } from "./block-ids";
import { taskStatusOf, isClosedStatus } from "./task-status";
import { ct } from "./content-locale";
import type { Field, Identity } from "./types";
import {
  TASKS_TO_DATABASE_MAX,
  tasksToDatabaseInput,
  tasksToDatabaseUndoInput,
  type DocumentMode,
  type JsonNode,
  type RestoreEntry,
} from "./tasks-to-database-schema";

export { TASKS_TO_DATABASE_MAX, type DocumentMode, type JsonNode, type RestoreEntry };

// lib/api.ts lazily (it imports this module).
const api = () => import("./api");


const TITLE_MAX = 1000;

export type MovedTask = {
  // Position in document order (the index of its record).
  index: number;
  title: string;
  // The people @mentioned in its line (user ids, in order).
  assignees: string[];
  due: string | null;
  closed: boolean;
  blockId: string | null;
  // Blocks of the task besides its line and its sub-tasks.
  notes: JsonNode[];
  // The index of the parent task, null at the top.
  parent: number | null;
  // Left out: no text, no notes and no sub-tasks.
  empty: boolean;
};

// The task's line: text and mentions (a mention of `skip` is left out,
// it becomes the person).
function lineText(paragraph: JsonNode | undefined, skip: string | null) {
  const parts: string[] = [];
  const walk = (node: JsonNode) => {
    if (node.type === "text") parts.push(node.text || "");
    else if (node.type === "mention") {
      if (String(node.attrs?.userId || "") !== skip) parts.push(`@${String(node.attrs?.label || "")}`);
    } else if (node.type === "hardBreak") parts.push(" ");
    else for (const child of node.content || []) walk(child);
  };
  for (const child of paragraph?.content || []) walk(child);
  return parts.join("").replace(/\s+/g, " ").trim();
}
function mentionsOf(paragraph: JsonNode | undefined) {
  const ids: string[] = [];
  for (const child of paragraph?.content || []) {
    const uid = child.type === "mention" ? String(child.attrs?.userId || "") : "";
    if (uid && !ids.includes(uid)) ids.push(uid);
  }
  return ids;
}

// The tasks of a document in document order. A task list counts where task
// lists stand (anywhere in the document) and as a task's sub-tasks
// (directly in the task); a task list further inside a task's notes stays
// part of those notes. `person`: whether the first @mention becomes the
// record's person (and leaves the title).
export function collectTasks(doc: JsonNode, person = true): MovedTask[] {
  const tasks: MovedTask[] = [];
  const item = (node: JsonNode, parent: number | null) => {
    const content = node.content || [];
    const first = content[0]?.type === "paragraph" ? content[0] : undefined;
    const assignees = mentionsOf(first);
    const status = taskStatusOf(node.attrs);
    const task: MovedTask = {
      index: tasks.length,
      title: lineText(first, person ? assignees[0] ?? null : null).slice(0, TITLE_MAX),
      assignees,
      due: typeof node.attrs?.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(node.attrs.due) ? node.attrs.due : null,
      closed: isClosedStatus(status),
      blockId: validBlockId(node.attrs?.blockId),
      notes: content.filter((child, i) => !(i === 0 && first) && child.type !== "taskList"),
      parent,
      empty: false,
    };
    tasks.push(task);
    let children = 0;
    for (const child of content) if (child.type === "taskList") for (const sub of child.content || []) if (sub.type === "taskItem") (item(sub, task.index), children++);
    task.empty = !lineText(first, null) && !task.notes.length && !children;
  };
  const walk = (node: JsonNode) => {
    for (const child of node.content || []) {
      if (child.type === "taskList") {
        for (const sub of child.content || []) if (sub.type === "taskItem") item(sub, null);
      } else walk(child);
    }
  };
  walk(doc);
  // An empty task's sub-tasks move up to its parent.
  const skipped = new Map(tasks.filter((t) => t.empty).map((t) => [t.index, t.parent]));
  for (const t of tasks) while (t.parent !== null && skipped.has(t.parent)) t.parent = skipped.get(t.parent)!;
  return tasks;
}

// What the dialog shows: how many tasks, how many done, what they carry.
export function taskSummary(tasks: MovedTask[]) {
  const kept = tasks.filter((t) => !t.empty);
  return {
    tasks: kept.length,
    done: kept.filter((t) => t.closed).length,
    due: kept.filter((t) => t.due).length,
    assigned: kept.filter((t) => t.assignees.length).length,
    nested: kept.filter((t) => t.parent !== null).length,
  };
}


// The document without its task lists: each replaced by a list of links to
// the records (`link`: the href and title of task i), or removed. Returns
// the new document and where the lists were.
export function replaceTasks(
  doc: JsonNode,
  mode: Exclude<DocumentMode, "keep">,
  link: (index: number) => { href: string; title: string } | null,
  untitled: string,
): { doc: JsonNode; restore: RestoreEntry[] } {
  const restore: RestoreEntry[] = [];
  let index = 0;
  // A task's item of links (and its sub-tasks below it).
  const linkItems = (list: JsonNode): JsonNode[] => {
    const items: JsonNode[] = [];
    for (const sub of list.content || []) {
      if (sub.type !== "taskItem") continue;
      const target = link(index++);
      const below = (sub.content || []).filter((c) => c.type === "taskList").flatMap(linkItems);
      if (!target) {
        // Left out: its sub-tasks take its place.
        items.push(...below);
        continue;
      }
      const paragraph: JsonNode = {
        type: "paragraph",
        // A page link chip (#466) where the address is one.
        content: [
          isPageChipHref(target.href)
            ? pageChipContent(target.href, target.title || untitled)
            : { type: "text", text: target.title || untitled, marks: [{ type: "link", attrs: { href: target.href } }] },
        ],
      };
      items.push({
        type: "listItem",
        attrs: { blockId: validBlockId(sub.attrs?.blockId) || newBlockId() },
        content: below.length ? [paragraph, { type: "bulletList", attrs: { blockId: newBlockId() }, content: below }] : [paragraph],
      });
    }
    return items;
  };
  // Counts the tasks of a removed list (keeps `index` in step).
  const skip = (list: JsonNode) => {
    for (const sub of list.content || []) {
      if (sub.type !== "taskItem") continue;
      index++;
      for (const c of sub.content || []) if (c.type === "taskList") skip(c);
    }
  };
  const rebuild = (node: JsonNode): JsonNode => {
    if (!node.content) return node;
    const out: JsonNode[] = [];
    // Removed lists waiting for the next block that stays.
    let pending: { entry: RestoreEntry; at: number } | null = null;
    for (const child of node.content) {
      if (child.type !== "taskList") {
        const next = rebuild(child);
        if (pending) {
          const id = validBlockId(next.attrs?.blockId);
          if (id) pending.entry.before = id;
          pending = null;
        }
        out.push(next);
        continue;
      }
      if (mode === "link") {
        const items = linkItems(child);
        const after = validBlockId(out[out.length - 1]?.attrs?.blockId) || undefined;
        if (!items.length) {
          const entry: RestoreEntry = { nodes: [child], ...(after ? { after } : {}) };
          restore.push(entry);
          pending = { entry, at: out.length };
          continue;
        }
        const blockId = validBlockId(child.attrs?.blockId) || newBlockId();
        out.push({ type: "bulletList", attrs: { blockId }, content: items });
        restore.push({ replace: blockId, ...(after ? { after } : {}), nodes: [child] });
        continue;
      }
      skip(child);
      if (pending && pending.at === out.length) {
        pending.entry.nodes.push(child);
        continue;
      }
      const after = validBlockId(out[out.length - 1]?.attrs?.blockId) || undefined;
      const entry: RestoreEntry = { nodes: [child], ...(after ? { after } : {}) };
      restore.push(entry);
      pending = { entry, at: out.length };
    }
    // A container (or the document) may not be empty: an empty paragraph
    // keeps the place.
    if (!out.length) {
      const blockId = newBlockId();
      out.push({ type: "paragraph", attrs: { blockId } });
      if (pending) Object.assign(pending.entry, { replace: blockId, empty: true });
    }
    return { ...node, content: out };
  };
  return { doc: rebuild(doc), restore };
}

// The task lists back where they were (see RestoreAnchor).
export function restoreTasks(doc: JsonNode, entries: RestoreEntry[]): JsonNode {
  const root: JsonNode = structuredClone(doc);
  root.content ||= [];
  const find = (blockId: string | undefined): { parent: JsonNode; at: number } | null => {
    if (!blockId) return null;
    let found: { parent: JsonNode; at: number } | null = null;
    const walk = (node: JsonNode) => {
      (node.content || []).forEach((child, at) => {
        if (found) return;
        if (child.attrs?.blockId === blockId) found = { parent: node, at };
        else walk(child);
      });
    };
    walk(root);
    return found;
  };
  const isEmpty = (node: JsonNode) => node.type === "paragraph" && !(node.content || []).length;
  for (const entry of entries) {
    const nodes = structuredClone(entry.nodes);
    const replaced = find(entry.replace);
    if (replaced && (!entry.empty || isEmpty(replaced.parent.content![replaced.at]))) {
      replaced.parent.content!.splice(replaced.at, 1, ...nodes);
      continue;
    }
    const after = find(entry.after);
    if (after) {
      after.parent.content!.splice(after.at + 1, 0, ...nodes);
      continue;
    }
    const before = find(entry.before);
    if (before) {
      before.parent.content!.splice(before.at, 0, ...nodes);
      continue;
    }
    root.content.push(...nodes);
  }
  return root;
}

export type TasksToDatabaseResult = {
  databaseId: string;
  rowIds: string[];
  done: number;
  document: DocumentMode;
  restore: RestoreEntry[];
};

// The document and the database, with the checks both commands share.
async function targets(user: Identity, pageId: string, databaseId: string) {
  const page = await requirePage(user, pageId, true);
  await requireUnlocked(user, page);
  if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (await isEncryptedPage(page))
    throw new HttpError(409, "Aufgaben aus verschlüsselten Bereichen lassen sich nicht in eine Datenbank verschieben – der Server kann ihren Inhalt nicht lesen.");
  const db = await requirePage(user, databaseId, true);
  if (db.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  if (db.workspace_id !== page.workspace_id) throw new HttpError(404, "Seite nicht gefunden.");
  if (db.locked) throw new HttpError(409, "Datenbank ist gesperrt.");
  await requireUnlocked(user, db);
  if (await isEncryptedPage(db))
    throw new HttpError(409, "Die Datenbank liegt in einem verschlüsselten Bereich, dort kann der Server nichts schreiben.");
  return { page, db };
}

// `lock`: kept until the transaction ends (the rewrite below reads the same).
async function documentJson(pageId: string, lock = false) {
  const stored = await one<{ state: Uint8Array | null; html: string }>(`SELECT state,html FROM documents WHERE page_id=?${lock ? sql.forUpdate() : ""}`, pageId);
  if (!stored) throw new HttpError(404, "Dokument nicht gefunden.");
  const { htmlState } = await import("./document-server");
  const { yDocToProsemirrorJSON } = await import("y-prosemirror");
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    return yDocToProsemirrorJSON(ydoc, "default") as JsonNode;
  } finally {
    ydoc.destroy();
  }
}

// The dialog's plan: the tasks of the document and the databases to choose.
export async function tasksToDatabasePlan(user: Identity, pageId: string) {
  const page = await requirePage(user, pageId, true);
  await requireUnlocked(user, page);
  if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  const summary = taskSummary(collectTasks(await documentJson(page.id)));
  const { databases } = await captureTargets(user, page.workspace_id);
  // Plaintext databases only (encrypted spaces have none yet).
  const plain: typeof databases = [];
  for (const d of databases) if (!(await isEncryptedPage({ space_id: (await one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", d.id))!.space_id }))) plain.push(d);
  return { ...summary, databases: plain };
}

// The record's document from a task's notes (HTML, sanitized on storing).
function notesHtml(notes: JsonNode[]) {
  const ydoc = prosemirrorJSONToYDoc(rewriteSchema(), { type: "doc", content: notes }, "default");
  try {
    return stateHtml(ydoc);
  } finally {
    ydoc.destroy();
  }
}

export async function tasksToDatabase(user: Identity, raw: unknown, afterCommit: (() => unknown)[]): Promise<TasksToDatabaseResult> {
  const b = tasksToDatabaseInput.parse(raw);
  const { page, db } = await targets(user, b.pageId, b.databaseId);
  const { command, database } = await api();
  const fields = (await database(db.id)).fields as Field[];
  const title = fields[0];
  if (!title) throw new HttpError(400, "Eigenschaft fehlt.");
  const pick = (fid: string, types: Field["type"][]) => {
    if (!fid) return undefined;
    const field = fields.find((f) => f.id === fid && types.includes(f.type));
    if (!field) throw new HttpError(400, "Eigenschaft fehlt.");
    return field;
  };
  const status = pick(b.statusField, ["select", "checkbox"]);
  const due = pick(b.dueField, ["date"]);
  const person = pick(b.personField, ["person"]);
  const parent = pick(b.parentField, ["relation"]);
  if (parent && !(parent.parent && parent.relationPage === db.id)) throw new HttpError(400, "Eigenschaft fehlt.");
  if (status?.type === "select")
    for (const value of [b.doneValue, b.openValue]) if (value && !status.options?.includes(value)) throw new HttpError(400, "Unbekannte Auswahl.");

  const json = await documentJson(page.id, true);
  const tasks = collectTasks(json, !!person);
  const moving = tasks.filter((t) => !t.empty);
  if (!moving.length) throw new HttpError(400, "Das Dokument enthält keine Aufgaben.");
  if (moving.length > TASKS_TO_DATABASE_MAX)
    throw new HttpError(413, "Zu viele Aufgaben auf einmal (höchstens 1.000).");
  const members = new Set<string>();
  if (person)
    for (const uid of new Set(moving.flatMap((t) => t.assignees.slice(0, 1))))
      if (await one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", db.workspace_id, uid)) members.add(uid);

  const rowIds = new Map<number, string>();
  const created: string[] = [];
  for (const task of moving) {
    const given: Record<string, unknown> = {};
    if (status) given[status.id] = status.type === "checkbox" ? task.closed : task.closed ? b.doneValue : b.openValue;
    if (status?.type === "select" && !given[status.id]) delete given[status.id];
    if (due && task.due) given[due.id] = task.due;
    const assignee = task.assignees[0];
    if (person && assignee && members.has(assignee)) given[person.id] = assignee;
    if (parent && task.parent !== null && rowIds.has(task.parent)) given[parent.id] = [rowIds.get(task.parent)!];
    // Checked like every edit (field rights, options, members, dates).
    const checked = Object.keys(given).length ? await validateCellPatch(user, db, fields, given) : {};
    const row = (await command(user, { action: "row.create", pageId: db.id, cells: { ...checked, [title.id]: task.title } }, true)) as { id: string };
    rowIds.set(task.index, row.id);
    created.push(row.id);
    if (task.notes.length) await replaceRowDocument(row.id, notesHtml(task.notes), user.id);
  }

  let restore: RestoreEntry[] = [];
  if (b.document !== "keep") {
    const rewritten = await rewriteDocument(page.id, null, user.id, (doc) => {
      const current = doc.toJSON() as JsonNode;
      // The document as read above (one transaction: nobody wrote since).
      const result = replaceTasks(
        current,
        b.document as "link" | "remove",
        (index) => {
          const rid = rowIds.get(index);
          return rid ? { href: `/#page=${db.id}&row=${rid}`, title: tasks[index].title } : null;
        },
        ct("Ohne Titel", "Untitled"),
      );
      restore = result.restore;
      return checkedDocument(result.doc);
    });
    if (rewritten) {
      await syncDocTasks(user, page, null, rewritten.ydoc, false);
      afterCommit.push(rewritten.publish);
    }
  }
  return { databaseId: db.id, rowIds: created, done: moving.filter((t) => t.closed).length, document: b.document, restore };
}

function checkedDocument(json: JsonNode) {
  try {
    const node = PMNode.fromJSON(rewriteSchema(), json);
    node.check();
    return node;
  } catch {
    throw new HttpError(409, "Das Dokument lässt sich so nicht ändern.");
  }
}

// "Rückgängig": the task lists back into the document, the records it
// created (and that still are there) into the database's trash.
export async function undoTasksToDatabase(user: Identity, raw: unknown, afterCommit: (() => unknown)[]) {
  const b = tasksToDatabaseUndoInput.parse(raw);
  const { page, db } = await targets(user, b.pageId, b.databaseId);
  const access = await rowRoleResolver(user, db);
  let removed = 0;
  for (const rid of b.rowIds) {
    const row = await one<{ id: string; access: string; created_by: string | null }>("SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?", rid, db.id);
    // Only records this person created (and may still change).
    if (!row || row.created_by !== user.id) continue;
    const role = access(row);
    if (!role || role === "viewer") throw new HttpError(403, "Mindestens ein Eintrag ist für dich schreibgeschützt.");
    await trashRow(user, db, rid);
    removed++;
  }
  if (removed) await maintainRowOrders(db.id);
  if (b.restore.length) {
    const rewritten = await rewriteDocument(page.id, null, user.id, (doc) => checkedDocument(restoreTasks(doc.toJSON() as JsonNode, b.restore)));
    if (rewritten) {
      await syncDocTasks(user, page, null, rewritten.ydoc, false);
      afterCommit.push(rewritten.publish);
    }
  }
  return { removed };
}

