// Tasks written in documents: a task with @person is assigned to that
// person, a due date can be set on it. They are collected per document on
// every save, so "Meine Aufgaben" lists them across the workspace; ticking
// one off there changes the document itself (live for open editors).
import { TASK_TEXT_MAX } from "./task-text-max";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { hiddenRowIds } from "./row-access";
import { Node as PMNode } from "@tiptap/pm/model";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { htmlState } from "./document-server";
import { rewriteDocument } from "./document-rewrite";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { ensureRowDocument, requireRow } from "./row-documents";
import { journalLocked } from "./journal-extras";
import { notificationOn } from "./notification-kinds";
import { rememberTaskTarget } from "./notification-targets";
import { mayHear } from "./comment-recipients";
import type { Identity, Page, Row } from "./types";
import { filterAsync } from "./each-async";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import { validBlockId } from "./block-ids";
import { TASK_STATUSES, isClosedStatus, isStoredStatus, statusAttrs, taskStatusOf, type TaskStatus } from "./task-status";

// The state as doc_tasks keeps it: NULL for open and done (`checked` says which).
const storedStatus = (status: TaskStatus) => (isStoredStatus(status) ? status : null);


type JsonNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
};
export type DocTask = {
  index: number;
  text: string;
  // Done or cancelled (closed); in progress, deferred and other symbols are open.
  checked: boolean;
  // The state (lib/task-status.ts), shown in My tasks.
  status: TaskStatus;
  assignees: string[];
  due: string | null;
  // Its block id (lib/block-ids.ts), when it has one: its identity across
  // edits (#249).
  blockId: string | null;
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
// The longest task text that is stored (and compared): longer lines are cut.
export { TASK_TEXT_MAX };
// A task's identity for clients that only show it shortened (the widgets of
// the mobile apps): a hash of its stored text, checked together with its
// position like the text itself.
export const taskKey = (text: string) => createHash("sha256").update(text.slice(0, TASK_TEXT_MAX)).digest("base64url").slice(0, 22);
// Is this still the task the client saw? Its key, or its text: whole, or (app
// builds before the key) as the widget showed it – cut and ending in "…".
function sameTask(line: string, change: { text?: string; key?: string }) {
  const stored = line.slice(0, TASK_TEXT_MAX);
  if (change.key !== undefined) return taskKey(stored) === change.key;
  const text = change.text ?? "";
  if (text === stored) return true;
  return text.length > 1 && text.endsWith("…") && stored.length >= text.length && stored.startsWith(text.slice(0, -1));
}
export function extractTasks(json: JsonNode): DocTask[] {
  const tasks: DocTask[] = [];
  const walk = (node: JsonNode) => {
    if (node.type === "taskItem") {
      const { text, assignees } = lineOf(node);
      const due = typeof node.attrs?.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(node.attrs.due) ? node.attrs.due : null;
      const status = taskStatusOf(node.attrs);
      tasks.push({ index: tasks.length, text, checked: isClosedStatus(status), status, assignees, due, blockId: validBlockId(node.attrs?.blockId) });
    }
    for (const child of node.content || []) walk(child);
  };
  walk(json);
  return tasks;
}

// Stores the tasks of a document; people newly assigned are told.
// Returns everyone a task is given to: their mention in the task is not
// reported again as a plain mention.
export async function syncDocTasks(
  user: Identity,
  page: Page,
  rowId: string | null,
  ydoc: Y.Doc,
  notify = true,
) {
  const tasks = extractTasks(yDocToProsemirrorJSON(ydoc, "default") as JsonNode);
  const previous = await all<{ idx: number; text: string; assignee: string | null; checked: number; status: string | null; assigned_at: number | null; block_id: string | null }>(
    "SELECT idx,text,assignee,checked,status,assigned_at,block_id FROM doc_tasks WHERE page_id=? AND row_id=?",
    page.id,
    rowId || "",
  );
  // When each task was given to its person (kept while it stays, #208).
  const known = new Map(previous.map((t) => [`${t.assignee}\u0000${t.text}`, t.assigned_at === null || t.assigned_at === undefined ? null : Number(t.assigned_at)]));
  // Tasks that were there and not done: ticked off now when they are done.
  const wasOpen = new Set(previous.filter((t) => !(Number(t.checked) && !t.status)).map((t) => t.text));
  const wasDone = new Set(previous.filter((t) => Number(t.checked) && !t.status).map((t) => t.text));
  const previousOf = taskBefore(previous, tasks);
  await followDoneLog(page, rowId, previousOf, tasks, wasDone);
  await run("DELETE FROM doc_tasks WHERE page_id=? AND row_id=?", page.id, rowId || "");
  const notified = new Set<string>();
  const logged = new Set<string>();
  const assignees = new Set(tasks.flatMap((task) => task.assignees));
  const now = Date.now();
  for (const task of tasks.slice(0, 2000)) {
    const people = task.assignees.length ? task.assignees : [null];
    const text = task.text.slice(0, TASK_TEXT_MAX);
    // Ticked off in this change (not a task moved or written already done):
    // "An diesem Tag erledigt" below a journal day (lib/journal-completed.ts).
    // Open before: by its text, or as the same task (block id, position)
    // whose last letters came with the tick in one save (#249).
    const before = previousOf(task);
    const wasOpenTask = wasOpen.has(text) || (!!before && !(Number(before.checked) && !before.status));
    if (notify && task.status === "done" && text && wasOpenTask && !wasDone.has(text) && !logged.has(text)) {
      logged.add(text);
      await run(
        "INSERT INTO task_done_log(id,page_id,row_id,text,user_id,workspace_id,at) VALUES(?,?,?,?,?,?,?)",
        id(),
        page.id,
        rowId || "",
        text,
        user.id,
        page.workspace_id,
        now,
      );
    }
    for (const assignee of people) {
      const key = `${assignee}\u0000${task.text}`;
      // New for its person when someone else gave it to them now (as the
      // notice below); "Neu" in My tasks until they open it.
      const assignedAt = known.has(key) ? known.get(key)! : notify && assignee && assignee !== user.id && !task.checked ? now : null;
      await run(
        "INSERT INTO doc_tasks(id,page_id,row_id,idx,text,checked,status,assignee,due,workspace_id,updated_by,updated_at,assigned_at,block_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id(),
        page.id,
        rowId || "",
        task.index,
        text,
        task.checked ? 1 : 0,
        storedStatus(task.status),
        assignee,
        task.due,
        page.workspace_id,
        user.id,
        now,
        assignedAt,
        task.blockId,
      );
      if (
        notify &&
        assignee &&
        assignee !== user.id &&
        !task.checked &&
        !known.has(key) &&
        !notified.has(assignee)
      ) {
        // Only who may read the page and, in a record, the record (a
        // private record stays private): like My tasks and mentions.
        if (!(await mayHear(assignee, page, rowId))) continue;
        notified.add(assignee);
        await run(
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

type StoredTask = { idx: number; text: string; checked: number; status: string | null; block_id: string | null };
// The stored row of a task before this save (#249): the one with the same
// block id; without ids on either side, the one at the same position – and
// only when its text is gone from the document (else that task is still
// there and this one is another). Null when there is none.
function taskBefore(previous: StoredTask[], tasks: DocTask[]) {
  const texts = new Set(tasks.map((t) => t.text.slice(0, TASK_TEXT_MAX)));
  return (task: DocTask): StoredTask | null =>
    (task.blockId && previous.find((t) => t.block_id === task.blockId)) ||
    previous.find((t) => Number(t.idx) === task.index && !(task.blockId && t.block_id) && !texts.has(t.text)) ||
    null;
}
// A done task reworded (#249): its entries in task_done_log take the new
// text, so it stays in "An diesem Tag erledigt" (matched by text, lib/
// journal-completed.ts).
async function followDoneLog(
  page: Page,
  rowId: string | null,
  previousOf: (task: DocTask) => StoredTask | null,
  tasks: DocTask[],
  wasDone: Set<string>,
) {
  const renamed = new Map<string, string>();
  for (const task of tasks.slice(0, 2000)) {
    const text = task.text.slice(0, TASK_TEXT_MAX);
    if (task.status !== "done" || !text || wasDone.has(text)) continue;
    const old = previousOf(task);
    if (!old || !(Number(old.checked) && !old.status) || old.text === text || renamed.has(old.text)) continue;
    renamed.set(old.text, text);
  }
  for (const [from, to] of renamed)
    await run("UPDATE task_done_log SET text=? WHERE page_id=? AND row_id=? AND text=?", to, page.id, rowId || "", from);
}

// Tasks for "Meine Aufgaben": assigned to the person, unassigned ones with
// a date in pages they created (their own to-dos), and every unassigned
// task in the days of their journals – in pages they may still read.
// `workspaceId` null: all workspaces the person belongs to.
type TaskRow = {
  page_id: string;
  row_id: string;
  idx: number;
  text: string;
  checked: number;
  status: string | null;
  assignee: string | null;
  due: string | null;
  updated_at: number;
  title: string;
  icon: string;
  workspace_id: string;
  journal: number;
  own: number;
  assigned_at: number | null;
};
async function taskRows(user: Identity, workspaceId: string | null, includeDone: boolean) {
  const rows = await all<TaskRow>(
    `SELECT t.page_id,t.row_id,t.idx,t.text,t.checked,t.status,t.assignee,t.due,t.updated_at,t.assigned_at,p.title,p.icon,t.workspace_id,
       (j.id IS NOT NULL) AS journal,(o.page_id IS NOT NULL) AS own
     FROM doc_tasks t JOIN pages p ON p.id=t.page_id
     LEFT JOIN pages j ON j.id=p.parent_id AND j.kind='journal' AND p.journal_date IS NOT NULL
       AND t.row_id='' AND (j.created_by=? OR p.created_by=?)
     LEFT JOIN personal_task_pages o ON o.page_id=t.page_id AND o.user_id=? AND t.row_id=''
     WHERE ${workspaceId ? "t.workspace_id=?" : "t.workspace_id IN (SELECT workspace_id FROM members WHERE user_id=?)"}
       AND p.deleted_at IS NULL
       AND (t.row_id='' OR EXISTS (SELECT 1 FROM rows r WHERE r.id=t.row_id AND r.page_id=t.page_id))
       AND (t.assignee=?
         OR (t.assignee IS NULL AND p.created_by=? AND t.due IS NOT NULL)
         OR (t.assignee IS NULL AND j.id IS NOT NULL)
         OR (t.assignee IS NULL AND o.page_id IS NOT NULL))
     ${includeDone ? "" : "AND t.checked=0"}
     ORDER BY CASE WHEN t.due IS NULL THEN 1 ELSE 0 END, t.due, t.updated_at DESC LIMIT 1000`,
    user.id,
    user.id,
    user.id,
    workspaceId || user.id,
    user.id,
    user.id,
  );
  // Given to the person by someone else since they last opened My tasks (#208).
  const seen = Number((await one<{ tasks_seen_at: number | null }>("SELECT tasks_seen_at FROM users WHERE id=?", user.id))?.tasks_seen_at || 0);
  const allowed = new Map<string, boolean>(),
    hidden = new Map<string, Set<string>>();
  return (await filterAsync(rows, async (row) => {
      if (!allowed.has(row.page_id)) {
        const page = await one<Page>("SELECT * FROM pages WHERE id=?", row.page_id);
        allowed.set(row.page_id, !!page && !!(await pageRole(user, page)) && !(await journalLocked(user, page)));
        // Tasks in records hidden from the person (private records) stay hidden.
        hidden.set(row.page_id, page?.kind === "database" && allowed.get(row.page_id) ? (await hiddenRowIds(user, page)) : new Set());
      }
      return allowed.get(row.page_id) && !(row.row_id && hidden.get(row.page_id)!.has(row.row_id));
    }))
    .map((row) => ({
      pageId: row.page_id,
      rowId: row.row_id || null,
      index: row.idx,
      text: row.text,
      checked: !!row.checked,
      status: taskStatusOf({ checked: !!row.checked, status: row.status }),
      due: row.due,
      assigned: row.assignee === user.id,
      journal: !!row.journal,
      // In the person's own task page (#208): "Eigene" in My tasks.
      own: !!Number(row.own),
      // Given by someone else since My tasks was last opened: "Neu".
      fresh: row.assignee === user.id && !row.checked && !!row.assigned_at && Number(row.assigned_at) > seen,
      title: row.title,
      icon: row.icon,
      workspaceId: row.workspace_id,
    }));
}
export async function myTasks(user: Identity, workspaceId: string, includeDone = false) {
  return (await taskRows(user, workspaceId, includeDone)).slice(0, 500);
}
// Open tasks across all of the person's workspaces (widgets of the mobile app).
export async function openTasksEverywhere(user: Identity) {
  return await taskRows(user, null, false);
}
// The person's tasks in their other workspaces, per workspace.
export async function otherWorkspaceTasks(user: Identity, workspaceId: string, includeDone = false) {
  const names = new Map(
    (await all<{ id: string; name: string }>(
      "SELECT w.id,w.name FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=? AND w.id<>? ORDER BY lower(w.name)",
      user.id,
      workspaceId,
    )).map((w) => [w.id, w.name]),
  );
  if (!names.size) return [];
  const tasks = (await taskRows(user, null, includeDone)).filter((t) => names.has(t.workspaceId));
  return [...names]
    .map(([id, name]) => ({ workspaceId: id, name, tasks: tasks.filter((t) => t.workspaceId === id).slice(0, 200) }))
    .filter((w) => w.tasks.length);
}

// Changes one task (checked, due date) in the stored document and sends the
// change to open editors. The task is found by its position and checked by
// its text (or key): a document changed meanwhile gives 409, never the
// wrong task.
export const taskChangeSchema = z
  .object({
    pageId: z.uuid(),
    rowId: z.uuid().nullable().optional(),
    index: z.number().int().min(0).max(5000),
    text: z.string().max(TASK_TEXT_MAX).optional(),
    key: z.string().min(1).max(64).optional(),
    checked: z.boolean().optional(),
    // One of the five states (#201); wins over `checked`.
    status: z.enum(TASK_STATUSES).optional(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .refine((change) => change.text !== undefined || change.key !== undefined, { message: "text or key" });
export async function changeDocTask(user: Identity, input: unknown) {
  const change = taskChangeSchema.parse(input);
  const page = await requirePage(user, change.pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (await journalLocked(user, page)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
  const rowId = change.rowId || null;
  if (rowId) await requireRow(user, page.id, rowId, true);
  else if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  let found = false;
  const result = (await rewriteDocument(page.id, rowId, user.id, (doc) => {
    let index = -1;
    // Ticking a task off ticks off its subtasks too.
    const edit = (node: PMNode, tickAll: boolean | "cancelled" = false): PMNode => {
      if (node.isText || node.isLeaf) return node;
      let attrs = node.attrs;
      let tick: boolean | "cancelled" = tickAll;
      if (node.type.name === "taskItem") {
        index++;
        if (tickAll && !node.attrs.checked) attrs = { ...node.attrs, ...statusAttrs(tickAll === "cancelled" ? "cancelled" : "done") };
        if (index === change.index) {
          const json = node.toJSON() as JsonNode;
          if (!sameTask(lineOf(json).text, change))
            throw new HttpError(409, "Die Aufgabe wurde inzwischen geändert. Bitte neu laden.");
          found = true;
          // Ticked off from My tasks or a widget: done (also a task in
          // progress); unticked: open. A state given wins.
          const status = change.status ?? (change.checked === undefined ? undefined : change.checked ? "done" : "open");
          const before = taskStatusOf(node.attrs);
          attrs = {
            ...node.attrs,
            ...(status !== undefined && status !== before ? statusAttrs(status) : {}),
            ...(change.due !== undefined ? { due: change.due } : {}),
          };
          if (status !== undefined && isClosedStatus(status)) tick = status === "cancelled" ? "cancelled" : true;
        }
      }
      const children: PMNode[] = [];
      node.forEach((child) => children.push(edit(child, tick)));
      return node.type.create(attrs, children, node.marks);
    };
    const next = edit(doc);
    if (!found) throw new HttpError(409, "Die Aufgabe wurde inzwischen geändert. Bitte neu laden.");
    return next;
  }))!;
  await syncDocTasks(user, page, rowId, result.ydoc);
  return result.publish;
}

// Morning reminders: open tasks due today, once per task and person.
export async function processDueTasks(today = localToday()) {
  const due = await all<{ id: string; page_id: string; row_id: string; text: string; assignee: string; title: string }>(
    `SELECT t.id,t.page_id,t.row_id,t.text,t.assignee,p.title FROM doc_tasks t JOIN pages p ON p.id=t.page_id
     WHERE t.due=? AND t.checked=0 AND t.assignee IS NOT NULL AND p.deleted_at IS NULL
     AND (t.row_id='' OR EXISTS (SELECT 1 FROM rows r WHERE r.id=t.row_id AND r.page_id=t.page_id))
     AND NOT EXISTS(SELECT 1 FROM task_reminders r WHERE r.user_id=t.assignee AND r.page_id=t.page_id AND r.text=t.text AND r.due=t.due)
     AND ${notificationOn("inbox", "t.assignee", "'reminder'")}
     LIMIT 500`,
    today,
  );
  let sent = 0;
  for (const task of due) {
    await run(
      "INSERT INTO task_reminders(user_id,page_id,text,due) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      task.assignee,
      task.page_id,
      task.text,
      today,
    );
    // Nobody hears of a task they may not read (a page they cannot open, a
    // private record): the same check as My tasks and the assignment notice.
    const page = await one<Page>("SELECT * FROM pages WHERE id=?", task.page_id);
    if (!page || !(await mayHear(task.assignee, page, task.row_id || null))) continue;
    sent++;
    const notificationId = id();
    await run(
      "INSERT INTO notifications(id,user_id,body,page_id,row_id,kind) VALUES(?,?,?,?,?,'reminder')",
      notificationId,
      task.assignee,
      `Heute fällig: ${task.text.slice(0, 120)} („${task.title || "Ohne Titel"}“)`,
      task.page_id,
      task.row_id || null,
    );
    // "Done" and "Tomorrow" on the app's notification (lib/notification-actions.ts).
    await rememberTaskTarget(notificationId, { type: "doc", pageId: task.page_id, rowId: task.row_id || null, key: taskKey(task.text) });
  }
  return sent;
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// Tasks of a document written directly (seeded content, imports, journal
// days). `notify` false: only the list is updated (tasks moved between
// journal days are not new).
export async function indexPageTasks(pageId: string, notify = true) {
  const page = await one<Page & { state: Uint8Array | null; html: string }>(
    "SELECT p.*,d.state,d.html FROM pages p JOIN documents d ON d.page_id=p.id WHERE p.id=?",
    pageId,
  );
  if (!page) return;
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, page.state || htmlState(page.html));
    const system = { id: page.created_by, name: "", groups: [], isAdmin: false } as unknown as Identity;
    await syncDocTasks(system, page, null, ydoc, notify);
  } finally {
    ydoc.destroy();
  }
}
// The tasks of a record's document written without the editor (quick
// capture of the desktop app, share and clipper as a record): collected at
// once, so they show under "My tasks" before anyone opens the record.
export async function indexRowTasks(user: Identity, page: Page, rowId: string) {
  const doc = await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM row_documents WHERE row_id=?", rowId);
  if (!doc) return;
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, doc.state || htmlState(doc.html));
    await syncDocTasks(user, page, rowId, ydoc);
  } finally {
    ydoc.destroy();
  }
}
// Records that come back (from the trash, an older version of the
// database): their tasks were removed with them and are indexed again.
export async function reindexRowTasks(user: Identity, page: Page, rowIds: Iterable<string>) {
  for (const rowId of rowIds) {
    const row = await one<Row>("SELECT * FROM rows WHERE id=? AND page_id=?", rowId, page.id);
    if (!row) continue;
    const stored = await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId);
    if (!(stored?.html ?? row.content ?? "").includes('data-type="taskItem"')) continue;
    if (!stored) await ensureRowDocument(row);
    await indexRowTasks(user, page, rowId);
  }
}
// Documents written before tasks were collected: indexed once.
export async function backfillDocTasks() {
  if (await one("SELECT 1 FROM instance_state WHERE key='doc_tasks_indexed'")) return;
  const index = async (page: Page, rowId: string | null, state: Uint8Array | null, html: string) => {
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, state || htmlState(html));
      const tasks = extractTasks(yDocToProsemirrorJSON(ydoc, "default") as JsonNode);
      for (const task of tasks.slice(0, 2000))
        for (const assignee of task.assignees.length ? task.assignees : [null])
          await run(
            "INSERT INTO doc_tasks(id,page_id,row_id,idx,text,checked,status,assignee,due,workspace_id,updated_by,updated_at,block_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            id(),
            page.id,
            rowId || "",
            task.index,
            task.text.slice(0, TASK_TEXT_MAX),
            task.checked ? 1 : 0,
            storedStatus(task.status),
            assignee,
            task.due,
            page.workspace_id,
            null,
            Date.now(),
            task.blockId,
          );
    } finally {
      ydoc.destroy();
    }
  };
  for (const doc of await all<Page & { state: Uint8Array | null; html: string }>(
    `SELECT p.*,d.state,d.html FROM documents d JOIN pages p ON p.id=d.page_id
     WHERE d.html LIKE '%data-type="taskItem"%' AND NOT EXISTS(SELECT 1 FROM doc_tasks t WHERE t.page_id=p.id AND t.row_id='')`,
  ))
    await index(doc, null, doc.state, doc.html);
  for (const doc of await all<Page & { row_id: string; state: Uint8Array | null; html: string }>(
    `SELECT p.*,r.id row_id,d.state,d.html FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
     WHERE d.html LIKE '%data-type="taskItem"%' AND NOT EXISTS(SELECT 1 FROM doc_tasks t WHERE t.page_id=p.id AND t.row_id=r.id)`,
  ))
    await index(doc, doc.row_id, doc.state, doc.html);
  await run("INSERT INTO instance_state(key,value) VALUES('doc_tasks_indexed','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
}
const runtime = globalThis as typeof globalThis & { flowplanTaskTimer?: ReturnType<typeof setInterval> };
export async function startTaskWorker(onFired: () => void) {
  if (runtime.flowplanTaskTimer) return;
  try {
    await backfillDocTasks();
  } catch (error) {
    console.error("Aufgaben konnten nicht erfasst werden", error);
  }
  const tick = async () => {
    // Cluster mode: the leader only (lib/cluster/leader.ts).
    if (!isLeader() || (await workersPaused())) return;
    try {
      // From 8 o'clock on (server time), so reminders do not come at night.
      if (new Date().getHours() >= 8 && await processDueTasks()) onFired();
    } catch (error) {
      console.error("Aufgaben-Erinnerungen fehlgeschlagen", error);
    }
  };
  runtime.flowplanTaskTimer = setInterval(tick, 5 * 60_000);
  runtime.flowplanTaskTimer.unref();
  await tick();
}

// Badge in the sidebar: open tasks given to the person or in their journal,
// due today or earlier.
export async function dueTaskCount(user: Identity, workspaceId: string, today = localToday()) {
  return (await taskBadges(user, workspaceId, today)).due;
}
// Both numbers of the sidebar entry at once: due (today or earlier) and new
// (given to the person by others since they last opened My tasks, #208).
export async function taskBadges(user: Identity, workspaceId: string, today = localToday()) {
  const tasks = await myTasks(user, workspaceId);
  return {
    due: tasks.filter((task) => (task.assigned || task.journal || task.own) && task.due && task.due <= today).length,
    fresh: tasks.filter((task) => task.fresh).length,
  };
}
// Opening My tasks: what was new is seen now (the badge and "Neu" go).
export async function markTasksSeen(user: Identity, at = Date.now()) {
  await run("UPDATE users SET tasks_seen_at=? WHERE id=?", at, user.id);
  return { seenAt: at };
}
