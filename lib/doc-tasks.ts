// Tasks written in documents: a task with @person is assigned to that
// person, a due date can be set on it. They are collected per document on
// every save, so "Meine Aufgaben" lists them across the workspace; ticking
// one off there changes the document itself (live for open editors).
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { htmlState } from "./document-server";
import { rewriteDocument } from "./document-rewrite";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { journalLocked } from "./journal-extras";
import type { Identity, Page } from "./types";


type JsonNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
};
export type DocTask = {
  index: number;
  text: string;
  checked: boolean;
  assignees: string[];
  due: string | null;
};
// The task's own line: its first paragraph, with mentions as @Name.
function lineOf(item: JsonNode) {
  const first = item.content?.find((c) => c.type === "paragraph");
  const parts: string[] = [];
  const assignees: string[] = [];
  for (const child of first?.content || []) {
    if (child.type === "text") parts.push(child.text || "");
    else if (child.type === "mention") {
      parts.push(`@${String(child.attrs?.label || "")}`);
      const uid = String(child.attrs?.userId || "");
      if (uid && !assignees.includes(uid)) assignees.push(uid);
    } else if (child.type === "hardBreak") parts.push(" ");
  }
  return { text: parts.join("").replace(/\s+/g, " ").trim(), assignees };
}
export function extractTasks(json: JsonNode): DocTask[] {
  const tasks: DocTask[] = [];
  const walk = (node: JsonNode) => {
    if (node.type === "taskItem") {
      const { text, assignees } = lineOf(node);
      const due = typeof node.attrs?.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(node.attrs.due) ? node.attrs.due : null;
      tasks.push({ index: tasks.length, text, checked: !!node.attrs?.checked, assignees, due });
    }
    for (const child of node.content || []) walk(child);
  };
  walk(json);
  return tasks;
}

// Stores the tasks of a document; people newly assigned are told.
// Returns everyone a task is given to: their mention in the task is not
// reported again as a plain mention.
export function syncDocTasks(
  user: Identity,
  page: Page,
  rowId: string | null,
  ydoc: Y.Doc,
) {
  const tasks = extractTasks(yDocToProsemirrorJSON(ydoc, "default") as JsonNode);
  const previous = all<{ text: string; assignee: string | null }>(
    "SELECT text,assignee FROM doc_tasks WHERE page_id=? AND row_id=?",
    page.id,
    rowId || "",
  );
  const known = new Set(previous.map((t) => `${t.assignee}\u0000${t.text}`));
  run("DELETE FROM doc_tasks WHERE page_id=? AND row_id=?", page.id, rowId || "");
  const notified = new Set<string>();
  const assignees = new Set(tasks.flatMap((task) => task.assignees));
  for (const task of tasks.slice(0, 2000)) {
    const people = task.assignees.length ? task.assignees : [null];
    for (const assignee of people) {
      run(
        "INSERT INTO doc_tasks(id,page_id,row_id,idx,text,checked,assignee,due,workspace_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        id(),
        page.id,
        rowId || "",
        task.index,
        task.text.slice(0, 500),
        task.checked ? 1 : 0,
        assignee,
        task.due,
        page.workspace_id,
        user.id,
        Date.now(),
      );
      if (
        assignee &&
        assignee !== user.id &&
        !task.checked &&
        !known.has(`${assignee}\u0000${task.text}`) &&
        !notified.has(assignee)
      ) {
        const person = one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0", assignee);
        if (!person) continue;
        const groups = all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", assignee).map((g) => g.group_id);
        if (!pageRole({ ...person, groups, isAdmin: false }, page)) continue;
        notified.add(assignee);
        run(
          "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'mention')",
          id(),
          assignee,
          `${user.name} hat dir eine Aufgabe in „${page.title || "Ohne Titel"}“ gegeben: ${task.text.slice(0, 120)}`,
          page.id,
          rowId,
        );
      }
    }
  }
  return assignees;
}

// Tasks for "Meine Aufgaben": assigned to the person, or unassigned ones in
// pages they created (their own to-dos), in pages they may still read.
export function myTasks(user: Identity, workspaceId: string, includeDone = false) {
  const rows = all<{
    page_id: string;
    row_id: string;
    idx: number;
    text: string;
    checked: number;
    assignee: string | null;
    due: string | null;
    updated_at: number;
    title: string;
    icon: string;
  }>(
    `SELECT t.page_id,t.row_id,t.idx,t.text,t.checked,t.assignee,t.due,t.updated_at,p.title,p.icon
     FROM doc_tasks t JOIN pages p ON p.id=t.page_id
     WHERE t.workspace_id=? AND p.deleted_at IS NULL AND (t.assignee=? OR (t.assignee IS NULL AND p.created_by=? AND t.due IS NOT NULL))
     ${includeDone ? "" : "AND t.checked=0"}
     ORDER BY CASE WHEN t.due IS NULL THEN 1 ELSE 0 END, t.due, t.updated_at DESC LIMIT 500`,
    workspaceId,
    user.id,
    user.id,
  );
  const allowed = new Map<string, boolean>();
  return rows
    .filter((row) => {
      if (!allowed.has(row.page_id)) {
        const page = one<Page>("SELECT * FROM pages WHERE id=?", row.page_id);
        allowed.set(row.page_id, !!page && !!pageRole(user, page) && !journalLocked(user, page));
      }
      return allowed.get(row.page_id);
    })
    .map((row) => ({
      pageId: row.page_id,
      rowId: row.row_id || null,
      index: row.idx,
      text: row.text,
      checked: !!row.checked,
      due: row.due,
      assigned: row.assignee === user.id,
      title: row.title,
      icon: row.icon,
    }));
}

// Changes one task (checked, due date) in the stored document and sends the
// change to open editors.
export const taskChangeSchema = z.object({
  pageId: z.uuid(),
  rowId: z.uuid().nullable().optional(),
  index: z.number().int().min(0).max(5000),
  text: z.string().max(500),
  checked: z.boolean().optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export function changeDocTask(user: Identity, input: unknown) {
  const change = taskChangeSchema.parse(input);
  const page = requirePage(user, change.pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (journalLocked(user, page)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
  const rowId = change.rowId || null;
  if (rowId) requireRow(user, page.id, rowId, true);
  else if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  let found = false;
  const result = rewriteDocument(page.id, rowId, user.id, (doc) => {
    let index = -1;
    const edit = (node: PMNode): PMNode => {
      if (node.isText || node.isLeaf) return node;
      let attrs = node.attrs;
      if (node.type.name === "taskItem") {
        index++;
        if (index === change.index) {
          const json = node.toJSON() as JsonNode;
          if (lineOf(json).text !== change.text)
            throw new HttpError(409, "Die Aufgabe wurde inzwischen geändert. Bitte neu laden.");
          found = true;
          attrs = {
            ...node.attrs,
            ...(change.checked !== undefined ? { checked: change.checked } : {}),
            ...(change.due !== undefined ? { due: change.due } : {}),
          };
        }
      }
      const children: PMNode[] = [];
      node.forEach((child) => children.push(edit(child)));
      return node.type.create(attrs, children, node.marks);
    };
    const next = edit(doc);
    if (!found) throw new HttpError(409, "Die Aufgabe wurde inzwischen geändert. Bitte neu laden.");
    return next;
  })!;
  syncDocTasks(user, page, rowId, result.ydoc);
  return result.publish;
}

// Morning reminders: open tasks due today, once per task and person.
export function processDueTasks(today = localToday()) {
  const due = all<{ id: string; page_id: string; row_id: string; text: string; assignee: string; title: string }>(
    `SELECT t.id,t.page_id,t.row_id,t.text,t.assignee,p.title FROM doc_tasks t JOIN pages p ON p.id=t.page_id
     WHERE t.due=? AND t.checked=0 AND t.assignee IS NOT NULL AND p.deleted_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM task_reminders r WHERE r.user_id=t.assignee AND r.page_id=t.page_id AND r.text=t.text AND r.due=t.due)
     AND NOT EXISTS(SELECT 1 FROM notification_prefs n WHERE n.user_id=t.assignee AND n.kind='reminder' AND n.inbox=0)
     LIMIT 500`,
    today,
  );
  for (const task of due) {
    run(
      "INSERT OR IGNORE INTO task_reminders(user_id,page_id,text,due) VALUES(?,?,?,?)",
      task.assignee,
      task.page_id,
      task.text,
      today,
    );
    run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'reminder')",
      id(),
      task.assignee,
      `Heute fällig: ${task.text.slice(0, 120)} („${task.title || "Ohne Titel"}“)`,
      task.page_id,
      task.row_id || null,
    );
  }
  return due.length;
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Documents written before tasks were collected: indexed once.
export function backfillDocTasks() {
  if (one("SELECT 1 FROM instance_state WHERE key='doc_tasks_indexed'")) return;
  const index = (page: Page, rowId: string | null, state: Uint8Array | null, html: string) => {
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, state || htmlState(html));
      const tasks = extractTasks(yDocToProsemirrorJSON(ydoc, "default") as JsonNode);
      for (const task of tasks.slice(0, 2000))
        for (const assignee of task.assignees.length ? task.assignees : [null])
          run(
            "INSERT INTO doc_tasks(id,page_id,row_id,idx,text,checked,assignee,due,workspace_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            id(),
            page.id,
            rowId || "",
            task.index,
            task.text.slice(0, 500),
            task.checked ? 1 : 0,
            assignee,
            task.due,
            page.workspace_id,
            null,
            Date.now(),
          );
    } finally {
      ydoc.destroy();
    }
  };
  for (const doc of all<Page & { state: Uint8Array | null; html: string }>(
    `SELECT p.*,d.state,d.html FROM documents d JOIN pages p ON p.id=d.page_id
     WHERE d.html LIKE '%data-type="taskItem"%' AND NOT EXISTS(SELECT 1 FROM doc_tasks t WHERE t.page_id=p.id AND t.row_id='')`,
  ))
    index(doc, null, doc.state, doc.html);
  for (const doc of all<Page & { row_id: string; state: Uint8Array | null; html: string }>(
    `SELECT p.*,r.id row_id,d.state,d.html FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
     WHERE d.html LIKE '%data-type="taskItem"%' AND NOT EXISTS(SELECT 1 FROM doc_tasks t WHERE t.page_id=p.id AND t.row_id=r.id)`,
  ))
    index(doc, doc.row_id, doc.state, doc.html);
  run("INSERT OR REPLACE INTO instance_state(key,value) VALUES('doc_tasks_indexed','1')");
}
const runtime = globalThis as typeof globalThis & { flowplanTaskTimer?: ReturnType<typeof setInterval> };
export function startTaskWorker(onFired: () => void) {
  if (runtime.flowplanTaskTimer) return;
  try {
    backfillDocTasks();
  } catch (error) {
    console.error("Aufgaben konnten nicht erfasst werden", error);
  }
  const tick = () => {
    try {
      // From 8 o'clock on (server time), so reminders do not come at night.
      if (new Date().getHours() >= 8 && processDueTasks()) onFired();
    } catch (error) {
      console.error("Aufgaben-Erinnerungen fehlgeschlagen", error);
    }
  };
  runtime.flowplanTaskTimer = setInterval(tick, 5 * 60_000);
  runtime.flowplanTaskTimer.unref();
  tick();
}

// Badge in the sidebar: open tasks given to the person, due today or earlier.
export function dueTaskCount(user: Identity, workspaceId: string, today = localToday()) {
  return myTasks(user, workspaceId).filter((task) => task.assigned && task.due && task.due <= today).length;
}
