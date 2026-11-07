import { dayTitle as localDayTitle, isAutoDayTitle } from "./journal-title";
import { contentLocale } from "./content-locale";
// Journals: a page that keeps one sub page per day. When a new day starts,
// its page is created and the open tasks of the last day move over to it.
// A day that got no entry of its own (only carried tasks) is removed again,
// so the journal holds only days on which something happened.
import * as Y from "yjs";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { z } from "zod";
import { all, one, run, nowText, inSavepoint } from "./db";
import { documentSchema } from "./document-schema";
import { htmlState, stateHtml } from "./document-server";
import { createPage } from "./seed";
import { pageRole } from "./permissions";
import { HttpError } from "./auth";
import type { Identity, Page } from "./types";
import { documentChanged } from "./document-live";
import { indexPageTasks } from "./doc-tasks";
import {
  hasEntryData,
  journalSettings,
  onlyTemplate,
  templateNodes,
  templateNodesOf,
  templateTaskTexts,
} from "./journal-extras";
import {
  dayTemplateHtml,
  draftId as journalDraftId,
  ensureDraft,
  rememberDay,
  rememberTemplate,
  seededDayState,
} from "./journal-days";

// One schema instance: nodes of different instances cannot be combined.
let cachedSchema: Awaited<ReturnType<typeof documentSchema>> | undefined;
const schema = () => (cachedSchema ??= documentSchema());

export const journalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    "Ungültiges Datum.",
  );
export const dayTitle = (date: string) => localDayTitle(date, contentLocale());
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
export function withoutOpenTasks(
  doc: PMNode,
  keep: (task: PMNode) => boolean = () => false,
): PMNode {
  const strip = (node: PMNode): PMNode | null => {
    if (node.type.name === "taskItem" && !node.attrs.checked && !keep(node))
      return null;
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
// Carried tasks first, then the journal's template (if any).
export function dayDocument(tasks: PMNode[], template: PMNode[] = []) {
  const s = schema();
  return s.node("doc", null, [
    ...(tasks.length ? [s.node("taskList", null, tasks)] : []),
    ...(template.length ? template : [s.node("paragraph")]),
  ]);
}

async function loadDocument(pageId: string) {
  const row = await one<{ state: Uint8Array | null; html: string }>(
    "SELECT state,html FROM documents WHERE page_id=?",
    pageId,
  );
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, row?.state || htmlState(row?.html || ""));
  const doc = PMNode.fromJSON(schema(), yDocToProsemirrorJSON(ydoc, "default"));
  return { ydoc, doc };
}
// A day's document (read only).
export async function dayDoc(pageId: string) {
  const { ydoc, doc } = await loadDocument(pageId);
  ydoc.destroy();
  return doc;
}
// Changes the stored Yjs document in place (a diff, no new generation), so
// editors that have the page open merge the change on their next sync.
async function storeDocument(pageId: string, ydoc: Y.Doc, doc: PMNode) {
  ydoc.transact(() =>
    updateYFragment(ydoc, ydoc.getXmlFragment("default"), doc, {
      mapping: new Map(),
      isOMark: new Map(),
    }),
  );
  await run(
    "UPDATE documents SET state=?,html=?,updated_at=? WHERE page_id=?",
    Y.encodeStateAsUpdate(ydoc),
    stateHtml(ydoc), nowText(),
    pageId,
  );
  documentChanged(pageId);
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), pageId);
}
// A page nobody touched: no own text, same title, no icon or cover set, no
// comments, no sub pages and no files.
async function untouched(page: Page, doc: PMNode) {
  // Compared with the template the day was created from, so a later change
  // of the template does not keep untouched days (and with today's one).
  const created = await dayTemplateHtml(page.id);
  if (
    hasOwnEntry(doc, page.journal_date!) &&
    !(await onlyTemplate(page.parent_id!, doc, page.journal_date!)) &&
    !(created !== null && await onlyTemplate(page.parent_id!, doc, page.journal_date!, templateNodesOf(created)))
  )
    return false;
  if (await hasEntryData(page.id)) return false;
  if (!isAutoDayTitle(page.title, page.journal_date!)) return false;
  if (page.icon !== "day" || page.cover) return false;
  const used = async (sql: string) => !!(await one(sql, page.id));
  return !(
    await used("SELECT 1 FROM pages WHERE parent_id=? LIMIT 1") ||
    await used("SELECT 1 FROM comments WHERE page_id=? LIMIT 1") ||
    await used("SELECT 1 FROM files WHERE page_id=? LIMIT 1") ||
    await used(
      "SELECT 1 FROM inline_threads WHERE page_id=? LIMIT 1",
    )
  );
}
async function removeDay(page: Page) {
  await run("DELETE FROM notifications WHERE page_id=?", page.id);
  await run("DELETE FROM presence WHERE page_id=?", page.id);
  await run("DELETE FROM editor_presence WHERE page_id=?", page.id);
  await run("DELETE FROM favorites WHERE page_id=?", page.id);
  try {
    await inSavepoint(async () => await run("DELETE FROM pages WHERE id=?", page.id));
  } catch {
    // Still referenced somewhere: move it to the trash instead.
    await run(
      "UPDATE pages SET deleted_at=?,public_token=NULL WHERE id=?", nowText(),
      page.id,
    );
  }
}

// What a new day starts with: the open tasks of the last day before it
// (without the template's own tasks, which come back by themselves) and
// the template. Reads only; rollJournal moves the tasks.
export async function dayStart(journal: Page, today: string) {
  const previous = await one<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date<? AND deleted_at IS NULL ORDER BY journal_date DESC LIMIT 1",
    journal.id,
    today,
  );
  const daily = await templateTaskTexts(journal.id);
  let carried: PMNode[] = [];
  let before: { ydoc: Y.Doc; doc: PMNode } | null = null;
  if (previous) {
    before = await loadDocument(previous.id);
    carried = carryTasks(
      openTasks(before.doc).filter((task) => !daily.has(task.textContent.trim())),
      previous.journal_date!,
    );
  }
  const doc = dayDocument(carried, await templateNodes(journal.id, schema()));
  return { previous, before, carried, daily, doc };
}

// Makes sure the journal has a page for `today`. Runs inside the command
// transaction; returns the id of today's page and whether anything changed.
// A journal set to "beim ersten Schreiben" (lib/journal-days.ts) only gets
// the page with `write` (the first keystroke, task, tracker value or file);
// until then the answer names the draft that stands in for it.
export async function rollJournal(
  user: Identity,
  journal: Page,
  today: string,
  now = new Date().toISOString().slice(0, 10),
  // Today's page is in the trash and a fresh one is wanted.
  recreate = false,
  options: { write?: boolean } = {},
): Promise<{
  // Today's page – or, while it is a draft, the draft's id (it opens like
  // a page, GET /api/pages/<id>).
  dayId: string;
  changed: boolean;
  trashed?: boolean;
  draft?: boolean;
  generation?: string;
}> {
  if (journal.kind !== "journal")
    throw new HttpError(400, "Diese Seite ist kein Journal.");
  // A client clock far off the server's would create the wrong days.
  if (today < shiftDay(now, -1) || today > shiftDay(now, 1))
    throw new HttpError(400, "Das Datum passt nicht zur Serverzeit.");
  const existing = await one<Page>(
    // Also a day moved to the trash: that was a decision, not a gap.
    "SELECT * FROM pages WHERE parent_id=? AND journal_date=?",
    journal.id,
    today,
  );
  const generationOf = async (pageId: string) =>
    String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))?.generation || "1");
  if (existing && existing.deleted_at && recreate) {
    // The deleted page stays in the trash as an ordinary page.
    await run("UPDATE pages SET journal_date=NULL WHERE id=?", existing.id);
  } else if (existing)
    return {
      dayId: existing.id,
      changed: false,
      trashed: !!existing.deleted_at,
      ...(options.write ? { generation: await generationOf(existing.id) } : {}),
    };
  // Created on the first write: nothing is stored yet, carried tasks stay
  // where they are; the draft id is the same for every device.
  if (!options.write && (await journalSettings(journal.id)).options.create === "write")
    return { dayId: await ensureDraft(journal.id, today), changed: false, draft: true };
  const { previous, before, carried, daily, doc } = await dayStart(journal, today);
  if (previous && before) {
    const { ydoc, doc: previousDoc } = before;
    if (await untouched(previous, previousDoc)) await removeDay(previous);
    else if (carried.length) {
      await storeDocument(
        previous.id,
        ydoc,
        withoutOpenTasks(previousDoc, (task) => daily.has(task.textContent.trim())),
      );
      // The moved tasks now live in the new day ("Meine Aufgaben").
      await indexPageTasks(previous.id, false);
    }
    ydoc.destroy();
  }
  // A day that was a draft keeps its id and gets exactly the state the
  // draft showed (lib/journal-days.ts), so what was typed there merges.
  const draft = await journalDraftId(journal.id, today);
  const dayId = await createPage(
    journal.workspace_id,
    journal.space_id,
    user.id,
    dayTitle(today),
    "document",
    journal.id,
    undefined,
    ...(draft && !(await one("SELECT 1 FROM pages WHERE id=?", draft)) ? [draft] : []),
  );
  const seeded = seededDayState(dayId, doc);
  // Newest day first in the page tree.
  await run(
    "UPDATE pages SET journal_date=?,icon='day',position=? WHERE id=?",
    today,
    -Number(today.replaceAll("-", "")),
    dayId,
  );
  await run(
    "UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?",
    Y.encodeStateAsUpdate(seeded.ydoc),
    stateHtml(seeded.ydoc),
    seeded.generation,
    dayId,
  );
  if (draft) await run("DELETE FROM journal_drafts WHERE journal_id=? AND date=?", journal.id, today);
  await rememberDay(dayId, journal.id, await rememberTemplate(journal.id), seeded.hash);
  documentChanged(dayId);
  seeded.ydoc.destroy();
  await indexPageTasks(dayId, false);
  return { dayId, changed: true, ...(options.write ? { generation: seeded.generation } : {}) };
}
// All journals of a workspace the user may edit.
export async function rollJournals(user: Identity, workspaceId: string, today: string) {
  let changed = false;
  for (const journal of await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND kind='journal' AND deleted_at IS NULL",
    workspaceId,
  )) {
    const role = await pageRole(user, journal);
    if (role !== "editor" && role !== "owner") continue;
    // Journals that create a day on the first write wait for it.
    if ((await rollJournal(user, journal, today)).changed) changed = true;
  }
  return changed;
}
