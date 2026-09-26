// Journals: a page that keeps one sub page per day. When a new day starts,
// its page is created and the open tasks of the last day move over to it.
// A day that got no entry of its own (only carried tasks) is removed again,
// so the journal holds only days on which something happened.
import * as Y from "yjs";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import {
  prosemirrorJSONToYDoc,
  updateYFragment,
  yDocToProsemirrorJSON,
} from "y-prosemirror";
import { z } from "zod";
import { all, one, run } from "./db";
import { documentSchema } from "./document-schema";
import { htmlState, stateHtml } from "./document-server";
import { createPage } from "./seed";
import { pageRole } from "./permissions";
import { HttpError } from "./auth";
import type { Identity, Page } from "./types";

// One schema instance: nodes of different instances cannot be combined.
let cachedSchema: ReturnType<typeof documentSchema> | undefined;
const schema = () => (cachedSchema ??= documentSchema());

export const journalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    "Ungültiges Datum.",
  );
export function dayTitle(date: string) {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
function shiftDay(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Unchecked tasks; nested tasks travel with their parent task.
export function openTasks(doc: PMNode) {
  const tasks: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "taskItem") return true;
    if (node.attrs.checked) return true;
    tasks.push(node);
    return false;
  });
  return tasks;
}
// The document without its open tasks; lists and containers that end up
// empty are dropped or refilled so the document stays valid.
export function withoutOpenTasks(doc: PMNode): PMNode {
  const strip = (node: PMNode): PMNode | null => {
    if (node.type.name === "taskItem" && !node.attrs.checked) return null;
    if (node.isLeaf || node.isTextblock) return node;
    const children: PMNode[] = [];
    node.forEach((child) => {
      const kept = strip(child);
      if (kept) children.push(kept);
    });
    if (node.type.name === "taskList" && !children.length) return null;
    const content = Fragment.fromArray(children);
    if (node.type.validContent(content)) return node.copy(content);
    return node.type.createAndFill(node.attrs, content, node.marks);
  };
  return (
    strip(doc) || doc.type.createAndFill() || doc.type.schema.node("doc")
  );
}
// Whether anything was written on that day: text, media, new or completed
// tasks. Tasks carried over from an earlier day and still open do not count.
export function hasOwnEntry(doc: PMNode, date: string) {
  let own = false;
  doc.descendants((node) => {
    if (own) return false;
    if (node.type.name === "taskItem") {
      const carried =
        !node.attrs.checked &&
        typeof node.attrs.journalSince === "string" &&
        node.attrs.journalSince < date;
      if (!carried) own = true;
      return false;
    }
    if (node.isText) {
      if (node.text?.trim()) own = true;
    } else if (node.isAtom && node.type.name !== "hardBreak") own = true;
    return true;
  });
  return own;
}
// Open tasks prepared for the next day, marked with the day they are from.
export function carryTasks(tasks: PMNode[], from: string) {
  return tasks.map((task) =>
    task.type.create(
      { ...task.attrs, journalSince: task.attrs.journalSince || from },
      task.content,
      task.marks,
    ),
  );
}
export function dayDocument(tasks: PMNode[]) {
  const s = schema();
  return s.node("doc", null, [
    ...(tasks.length ? [s.node("taskList", null, tasks)] : []),
    s.node("paragraph"),
  ]);
}

function loadDocument(pageId: string) {
  const row = one<{ state: Uint8Array | null; html: string }>(
    "SELECT state,html FROM documents WHERE page_id=?",
    pageId,
  );
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row?.state || htmlState(row?.html || ""));
  const doc = PMNode.fromJSON(schema(), yDocToProsemirrorJSON(ydoc, "default"));
  return { ydoc, doc };
}
// Changes the stored Yjs document in place (a diff, no new generation), so
// editors that have the page open merge the change on their next sync.
function storeDocument(pageId: string, ydoc: Y.Doc, doc: PMNode) {
  ydoc.transact(() =>
    updateYFragment(ydoc, ydoc.getXmlFragment("default"), doc, {
      mapping: new Map(),
      isOMark: new Map(),
    }),
  );
  run(
    "UPDATE documents SET state=?,html=?,updated_at=CURRENT_TIMESTAMP WHERE page_id=?",
    Y.encodeStateAsUpdate(ydoc),
    stateHtml(ydoc),
    pageId,
  );
  run("UPDATE pages SET updated_at=CURRENT_TIMESTAMP WHERE id=?", pageId);
}
// A page nobody touched: no own text, same title, no icon or cover set, no
// comments, no sub pages and no files.
function untouched(page: Page, doc: PMNode) {
  if (hasOwnEntry(doc, page.journal_date!)) return false;
  if (page.title !== dayTitle(page.journal_date!)) return false;
  if (page.icon !== "day" || page.cover) return false;
  const used = (sql: string) => !!one(sql, page.id);
  return !(
    used("SELECT 1 FROM pages WHERE parent_id=? LIMIT 1") ||
    used("SELECT 1 FROM comments WHERE page_id=? LIMIT 1") ||
    used("SELECT 1 FROM files WHERE page_id=? LIMIT 1") ||
    used(
      "SELECT 1 FROM inline_threads WHERE page_id=? LIMIT 1",
    )
  );
}
function removeDay(page: Page) {
  run("DELETE FROM notifications WHERE page_id=?", page.id);
  run("DELETE FROM presence WHERE page_id=?", page.id);
  run("DELETE FROM editor_presence WHERE page_id=?", page.id);
  run("DELETE FROM favorites WHERE page_id=?", page.id);
  try {
    run("DELETE FROM pages WHERE id=?", page.id);
  } catch {
    // Still referenced somewhere: move it to the trash instead.
    run(
      "UPDATE pages SET deleted_at=CURRENT_TIMESTAMP,public_token=NULL WHERE id=?",
      page.id,
    );
  }
}

export function journalDays(journalId: string) {
  return all<Pick<Page, "id" | "title" | "icon" | "journal_date" | "updated_at">>(
    "SELECT id,title,icon,journal_date,updated_at FROM pages WHERE parent_id=? AND journal_date IS NOT NULL AND deleted_at IS NULL ORDER BY journal_date DESC",
    journalId,
  );
}

// Makes sure the journal has a page for `today`. Runs inside the command
// transaction; returns the id of today's page and whether anything changed.
export function rollJournal(
  user: Identity,
  journal: Page,
  today: string,
  now = new Date().toISOString().slice(0, 10),
) {
  if (journal.kind !== "journal")
    throw new HttpError(400, "Diese Seite ist kein Journal.");
  // A client clock far off the server's would create the wrong days.
  if (today < shiftDay(now, -1) || today > shiftDay(now, 1))
    throw new HttpError(400, "Das Datum passt nicht zur Serverzeit.");
  const existing = one<Page>(
    // Also a day moved to the trash: that was a decision, not a gap.
    "SELECT * FROM pages WHERE parent_id=? AND journal_date=?",
    journal.id,
    today,
  );
  if (existing) return { dayId: existing.id, changed: false };
  const previous = one<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date<? AND deleted_at IS NULL ORDER BY journal_date DESC LIMIT 1",
    journal.id,
    today,
  );
  let carried: PMNode[] = [];
  if (previous) {
    const { ydoc, doc } = loadDocument(previous.id);
    carried = carryTasks(openTasks(doc), previous.journal_date!);
    if (untouched(previous, doc)) removeDay(previous);
    else if (carried.length)
      storeDocument(previous.id, ydoc, withoutOpenTasks(doc));
    ydoc.destroy();
  }
  const dayId = createPage(
    journal.workspace_id,
    journal.space_id,
    user.id,
    dayTitle(today),
    "document",
    journal.id,
  );
  const doc = dayDocument(carried);
  const ydoc = prosemirrorJSONToYDoc(schema(), doc.toJSON(), "default");
  // Newest day first in the page tree.
  run(
    "UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?",
    today,
    -Number(today.replaceAll("-", "")),
    dayId,
  );
  run(
    "UPDATE documents SET state=?,html=? WHERE page_id=?",
    Y.encodeStateAsUpdate(ydoc),
    stateHtml(ydoc),
    dayId,
  );
  ydoc.destroy();
  return { dayId, changed: true };
}
// All journals of a workspace the user may edit.
export function rollJournals(user: Identity, workspaceId: string, today: string) {
  let changed = false;
  for (const journal of all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND kind='journal' AND deleted_at IS NULL",
    workspaceId,
  )) {
    const role = pageRole(user, journal);
    if (role !== "editor" && role !== "owner") continue;
    if (rollJournal(user, journal, today).changed) changed = true;
  }
  return changed;
}
