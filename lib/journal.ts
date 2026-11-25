import { journalDayEvent } from "./workflows/hooks";
import { dayTitle as localDayTitle, automaticDayTitle } from "./journal-title";
import { contentLocale } from "./content-locale";
// Journals: a page that keeps one sub page per day. When a new day starts,
// its page is created and the open tasks of the last day move over to it –
// or, with the journal option "Offene Aufgaben: kopieren" (#469), are
// copied there, the originals staying on their day marked as carried over
// (closed, lib/task-status.ts isContinuedTask), so they are neither open
// nor counted twice nor carried again.
// A day that got no entry of its own (only carried tasks) and under which
// "An diesem Tag erledigt" lists nothing goes to the trash, so the journal
// holds only days on which something happened; opening its date again
// brings it back from there.
import * as Y from "yjs";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { z } from "zod";
import { all, audit, one, run, nowText } from "./db";
import { validZone } from "./date-values";
import { documentSchema } from "./document-schema";
import { htmlState, stateHtml } from "./document-server";
import { createPage } from "./seed";
import { pageRole } from "./permissions";
import { HttpError } from "./auth";
import type { Identity, Page } from "./types";
import { documentChanged } from "./document-live";
import { placeBlocks, type BlockPlace } from "./journal-place";
import { indexPageTasks } from "./doc-tasks";
import { isContinuedTask, statusAttrs, taskStatusOf } from "./task-status";
import {
  contentLines,
  readableText,
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
    (value) => {
      // zod runs the refine even after the regex failed: no toISOString on an invalid date.
      const d = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
    },
    "Ungültiges Datum.",
  );
export const dayTitle = (date: string) => localDayTitle(date, contentLocale());
function shiftDay(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A task without anything in it (nor in its subtasks): not carried over.
const emptyTask = (task: PMNode) => {
  if (task.textContent.trim()) return false;
  let atom = false;
  task.descendants((node) => {
    if (node.isAtom && node.type.name !== "hardBreak") atom = true;
    return !atom;
  });
  return !atom;
};
// Open tasks – unchecked: also in progress, deferred and with another
// Obsidian symbol, not done or cancelled (lib/task-status.ts); nested
// tasks travel with their parent task. Empty tasks stay where they are.
export function openTasks(doc: PMNode) {
  const tasks: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "taskItem") return true;
    if (node.attrs.checked) return true;
    if (!emptyTask(node)) tasks.push(node);
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
    if (node.type.name === "taskItem" && !node.attrs.checked && !keep(node) && !emptyTask(node))
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
// The document with its open tasks marked as copied on to the day `to`
// (#469, "Offene Aufgaben: kopieren"): the tasks withoutOpenTasks would
// take out (and their open subtasks, which travelled with them) are closed
// as continued – not open any more, not carried again. Each keeps the state
// it had (open, in progress, deferred) to show on its day (#536).
export function withContinuedTasks(
  doc: PMNode,
  to: string,
  keep: (task: PMNode) => boolean = () => false,
): PMNode {
  // `copied`: inside a task that was copied (its open subtasks went along).
  // Outside, the same tasks as openTasks finds: the topmost open ones; one
  // kept (the template's own) or empty stays as it is, subtasks included.
  const mark = (node: PMNode, copied: boolean): PMNode => {
    if (node.isLeaf || node.isTextblock) return node;
    let attrs = node.attrs;
    let inside = copied;
    if (node.type.name === "taskItem" && !node.attrs.checked) {
      if (!copied && (emptyTask(node) || keep(node))) return node;
      attrs = { ...node.attrs, ...statusAttrs("cancelled"), journalContinued: to, journalWas: taskStatusOf(node.attrs) };
      inside = true;
    }
    const children: PMNode[] = [];
    node.forEach((child) => children.push(mark(child, inside)));
    return node.type.create(attrs, children, node.marks);
  };
  return mark(doc, false);
}
// Whether anything was written on that day: text, media, new or completed
// tasks. Tasks carried over from an earlier day and still open – or copied
// on to a later day from there (#469) – do not count; a task written on
// that day and copied on does. Spaces, empty lines and empty open tasks do
// not count either (lib/journal-extras.ts contentLines, #547).
export function hasOwnEntry(doc: PMNode, date: string) {
  return contentLines(doc, date).length > 0;
}
// Open tasks prepared for the next day, marked with the day they are from.
export function carryTasks(tasks: PMNode[], from: string) {
  return tasks.map((task) =>
    task.type.create(
      { ...task.attrs, journalSince: task.attrs.journalSince || from, journalContinued: null, journalWas: null },
      task.content,
      task.marks,
    ),
  );
}
// The journal's template (if any) with the carried tasks as one list: at
// the top (the default), after the template, or directly below one of its
// headings (#247; after the template when it has no such heading).
export function dayDocument(tasks: PMNode[], template: PMNode[] = [], place: BlockPlace = { at: "top" }) {
  // The nodes' own schema (nodes of different instances cannot be combined).
  const s = (tasks[0] || template[0])?.type.schema || schema();
  const body = template.length ? template : [s.node("paragraph")];
  // No template: the tasks come before the empty line to write in, wherever they go.
  const where = template.length ? place : { at: "top" as const };
  return s.node("doc", null, placeBlocks(body, tasks.length ? [s.node("taskList", null, tasks)] : [], where));
}
// The journal option "Offene Aufgaben" (#469): move (the default) or copy.
export const carryMode = (options: { carry?: "move" | "copy" }) => options.carry || "move";
// The journal option "Übernommene Aufgaben" (#247) as a place.
export const carriedPlace = (options: { carried?: "top" | "end" | "heading"; carriedHeading?: string }): BlockPlace => ({
  at: options.carried || "top",
  heading: options.carriedHeading || "",
});

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
// A page nobody touched: no own text, same title (spaces and capitals
// aside), no icon or cover set, no comments, no sub pages, no files and not
// shared or published.
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
  if (!automaticDayTitle(page.title, page.journal_date!)) return false;
  if (page.icon !== "day" || page.cover) return false;
  const used = async (sql: string) => !!(await one(sql, page.id));
  return !(
    await used("SELECT 1 FROM pages WHERE parent_id=? LIMIT 1") ||
    await used("SELECT 1 FROM comments WHERE page_id=? LIMIT 1") ||
    await used("SELECT 1 FROM files WHERE page_id=? LIMIT 1") ||
    await used(
      "SELECT 1 FROM inline_threads WHERE page_id=? LIMIT 1",
    ) ||
    await used("SELECT 1 FROM share_links WHERE root_id=? LIMIT 1") ||
    await used("SELECT 1 FROM share_link_pages WHERE page_id=? LIMIT 1") ||
    await used("SELECT 1 FROM publications WHERE page_id=? LIMIT 1") ||
    await used("SELECT 1 FROM publication_pages WHERE page_id=? LIMIT 1")
  );
}
// Whether "An diesem Tag erledigt" lists something below the day (tasks
// ticked off and records done that day in other pages, lib/journal-
// completed.ts) – the list as the person opening the journal sees it: by
// their choice "Nur meine" / "Alle" for the journal, "Nur meine" until
// they chose. Nothing when the journal switched the list off. The day in
// the person's time zone; without one, in any time zone (from 14 hours
// before UTC midnight to 12 hours after the next), so it rather stays.
async function completedThatDay(user: Identity, day: Page, zone?: string) {
  if (!(await journalSettings(day.parent_id!)).options.completed) return false;
  const { completedOn, completedMineChoice } = await import("./journal-completed");
  const mine = (await completedMineChoice(user, day.parent_id!)) ?? true;
  const midnight = Date.parse(`${day.journal_date}T00:00:00Z`);
  const known = !!zone && validZone(zone);
  const list = await completedOn(user, day.workspace_id, day.journal_date!, known ? zone! : "UTC", {
    dayId: day.id,
    mine,
    limit: 1,
    ...(known ? {} : { window: { start: midnight - 14 * 3600e3, end: midnight + 36 * 3600e3 } }),
  });
  return list.items.length > 0;
}
// A day that goes to the trash when a later day begins: untouched, and
// nothing under "An diesem Tag erledigt".
async function emptyDay(user: Identity, day: Page, doc: PMNode, zone?: string) {
  return (await untouched(day, doc)) && !(await completedThatDay(user, day, zone));
}
// How far back a new day looks at the days before it again (#547).
export const TIDY_DAYS = 7;
// The other days of the last week (besides the newest one before today,
// which rollJournal judges as it hands on its tasks), judged by the same
// rule once more: a day that was not judged when the next one began – one
// made from the day picker or by a workflow, one brought back from the
// trash by opening its date, one that held something then and was emptied
// since, one judged without the person's time zone – would otherwise stay
// for good (#547). A day that holds an open task of its own or carried
// over (and not handed on) stays: the task would get lost; so does one
// whose own tasks moved on to a later day, and one a person took back out
// of the trash.
async function tidyEarlierDays(user: Identity, journal: Page, today: string, judged: string | undefined, zone?: string) {
  const days = await all<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date>=? AND journal_date<? AND deleted_at IS NULL ORDER BY journal_date",
    journal.id,
    shiftDay(today, -TIDY_DAYS),
    today,
  );
  for (const day of days) {
    if (day.id === judged) continue;
    // Taken back out of the trash by a person: kept on purpose.
    if (await one("SELECT 1 FROM audit WHERE action='page.restore' AND resource_id=? LIMIT 1", day.id)) continue;
    const doc = await dayDoc(day.id);
    const created = await dayTemplateHtml(day.id);
    const daily = new Set([
      ...(await templateTaskTexts(journal.id)),
      ...(created ? await templateTaskTexts(journal.id, templateNodesOf(created)) : []),
    ].map(readableText));
    if (openTasks(doc).some((task) => !daily.has(readableText(task.textContent)))) continue;
    // Tasks written on that day and moved on since: something happened.
    if (await one(
      "SELECT 1 FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.parent_id=? AND p.id<>? AND d.html LIKE ? LIMIT 1",
      journal.id,
      day.id,
      `%data-journal-since="${day.journal_date}"%`,
    ))
      continue;
    if (await emptyDay(user, day, doc, zone)) await trashDay(user, day);
  }
}
// The audit entry that marks a day the journal moved to the trash by itself
// (detail: its deleted_at). Only such a day comes back when its date is
// opened again; one a person deleted stays in the trash.
const AUTO_TRASH = "journal.dayTrashed";
async function trashDay(user: Identity, day: Page) {
  const at = nowText();
  await run("UPDATE pages SET deleted_at=?,public_token=NULL WHERE id=?", at, day.id);
  await audit(user.id, AUTO_TRASH, day.id, at);
}
// A day of the date in the trash that the journal put there itself: back
// out of the trash (its open tasks had moved on before – or, copied, were
// marked as carried over (#469) – so nothing doubles).
async function restoreAutoTrashed(day: Page | undefined) {
  if (!day?.deleted_at) return false;
  if (!(await one("SELECT 1 FROM audit WHERE action=? AND resource_id=? AND detail=? LIMIT 1", AUTO_TRASH, day.id, day.deleted_at)))
    return false;
  await run("UPDATE pages SET deleted_at=NULL WHERE id=?", day.id);
  day.deleted_at = null;
  return true;
}

// What a new day starts with: the open tasks of the last day before it
// (without the template's own tasks, which come back by themselves) and
// the template. Reads only; rollJournal moves (or copies) the tasks.
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
  const { options } = await journalSettings(journal.id);
  const doc = dayDocument(carried, await templateNodes(journal.id, schema()), carriedPlace(options));
  return { previous, before, carried, daily, doc, mode: carryMode(options) };
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
  // `keep`: the day before stays even when nobody wrote in it (the
  // workflow step "An Journaltag anhängen", ensureJournalDay) – only a
  // person opening the journal tidies an empty day away. `zone`: that
  // person's time zone, for "An diesem Tag erledigt" (completedThatDay).
  options: { write?: boolean; keep?: boolean; zone?: string } = {},
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
  // Tidied away by the journal itself (another device a day ahead): back.
  if (await restoreAutoTrashed(existing))
    return {
      dayId: existing!.id,
      changed: true,
      ...(options.write ? { generation: await generationOf(existing!.id) } : {}),
    };
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
  const { previous, before, carried, daily, doc, mode } = await dayStart(journal, today);
  if (previous && before) {
    const { ydoc, doc: previousDoc } = before;
    const empty = !options.keep && (await emptyDay(user, previous, previousDoc, options.zone));
    if (carried.length) {
      const isDaily = (task: PMNode) => daily.has(task.textContent.trim());
      await storeDocument(
        previous.id,
        ydoc,
        // Copied (#469): the originals stay, marked as carried over to today.
        mode === "copy" ? withContinuedTasks(previousDoc, today, isDaily) : withoutOpenTasks(previousDoc, isDaily),
      );
      // The moved tasks now live in the new day ("Meine Aufgaben"); copied
      // ones are only there (continued originals are not indexed).
      await indexPageTasks(previous.id, false);
    }
    // An empty day goes to the trash (restorable like any page, never
    // deleted for good here) – without the tasks that moved on. Judged
    // before the copy marks its originals: a day that only held carried
    // tasks and passed them on is empty in both modes.
    if (empty) await trashDay(user, previous);
    ydoc.destroy();
  }
  const { dayId, generation } = await storeNewDay(user, journal, today, doc);
  // After the new day is stored: the tasks it took over are there.
  if (!options.keep) await tidyEarlierDays(user, journal, today, previous?.id, options.zone);
  return { dayId, changed: true, ...(options.write ? { generation } : {}) };
}
// Stores a new day page with `doc` and announces it (page tree, My tasks,
// workflows with a journal-day trigger).
async function storeNewDay(user: Identity, journal: Page, today: string, doc: PMNode) {
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
  // Workflows with a journal-day trigger (lib/workflows/hooks.ts).
  await journalDayEvent(dayId, journal, today, user.id);
  return { dayId, generation: seeded.generation };
}
// The day of a journal for a date, made when it is missing (#250, the
// workflow step "An Journaltag anhängen"). The newest day is made as
// opening the journal makes it (rollJournal: the open tasks of the day
// before, placed by the journal's setting, and the template; "create on
// first write" counts as written). A day before an existing later one gets
// the template only: open tasks have moved past it already. A day in the
// trash stays there – unless the journal put it there itself (an empty day,
// rollJournal): that one comes back. Days after `today` are not made. It never removes,
// moves or renames another day: the day before keeps its page even when it
// only held carried tasks (they move on – or are copied – as usual) – a workflow running
// just after midnight must not make yesterday disappear.
export async function ensureJournalDay(user: Identity, journal: Page, date: string, today: string): Promise<{ dayId: string; created: boolean }> {
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  journalDate.parse(date);
  const existing = await one<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date=?", journal.id, date);
  if (await restoreAutoTrashed(existing)) return { dayId: existing!.id, created: true };
  if (existing?.deleted_at) throw new HttpError(409, "Dieser Tag liegt im Papierkorb.");
  if (existing) return { dayId: existing.id, created: false };
  if (date > today) throw new HttpError(400, "Ein künftiger Tag lässt sich noch nicht anlegen.");
  const later = await one("SELECT 1 FROM pages WHERE parent_id=? AND journal_date>? AND deleted_at IS NULL LIMIT 1", journal.id, date);
  if (!later) {
    const rolled = await rollJournal(user, journal, date, date, false, { write: true, keep: true });
    return { dayId: rolled.dayId, created: rolled.changed };
  }
  const { dayId } = await storeNewDay(user, journal, date, dayDocument([], await templateNodes(journal.id, schema())));
  return { dayId, created: true };
}
// A day chosen in the day picker (#288, journal.roll with `day`): the page
// of that date when there is one, else a new one with the journal's
// template only – no open tasks are carried over, they belong to the newest
// day. Today goes the usual way (rollJournal); days after `today` (the
// client's local day, checked against the server clock) are refused, and a
// day in the trash stays there – one the journal put there itself (an empty
// day, rollJournal) comes back.
export async function openJournalDay(
  user: Identity,
  journal: Page,
  date: string,
  today: string,
  now = new Date().toISOString().slice(0, 10),
  zone?: string,
): Promise<{ dayId: string; changed: boolean; trashed?: boolean; draft?: boolean }> {
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  journalDate.parse(date);
  if (today < shiftDay(now, -1) || today > shiftDay(now, 1))
    throw new HttpError(400, "Das Datum passt nicht zur Serverzeit.");
  if (date > today) throw new HttpError(400, "Ein künftiger Tag lässt sich noch nicht anlegen.");
  if (date === today) return await rollJournal(user, journal, today, now, false, { zone });
  const existing = await one<Page>("SELECT * FROM pages WHERE parent_id=? AND journal_date=?", journal.id, date);
  if (await restoreAutoTrashed(existing)) return { dayId: existing!.id, changed: true };
  if (existing?.deleted_at) throw new HttpError(409, "Dieser Tag liegt im Papierkorb.");
  if (existing) return { dayId: existing.id, changed: false };
  const { dayId } = await storeNewDay(user, journal, date, dayDocument([], await templateNodes(journal.id, schema())));
  return { dayId, changed: true };
}
// All journals of a workspace the user may edit.
export async function rollJournals(user: Identity, workspaceId: string, today: string, zone?: string) {
  let changed = false;
  for (const journal of await all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND kind='journal' AND deleted_at IS NULL",
    workspaceId,
  )) {
    const role = await pageRole(user, journal);
    if (role !== "editor" && role !== "owner") continue;
    // Journals that create a day on the first write wait for it.
    if ((await rollJournal(user, journal, today, undefined, false, { zone })).changed) changed = true;
  }
  return changed;
}
