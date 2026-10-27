// Journal days beyond "one page per day" (#49): a day that is only created
// when somebody writes in it, which template a day was created from, the
// "@heute" / "@2026-10-27" links and removing empty days by hand.
//
// "Seite des Tages anlegen: beim ersten Schreiben" (journal option
// `create: "write"`): opening today shows a draft – the template and the
// tasks the last day would hand over – that is not stored. The draft has an
// id of its own (one per journal and date, the same on every device), and
// its document state is built deterministically from what it shows (Yjs
// client id and generation derived from the content, seededDayState). The
// first keystroke, ticked task, tracker value or file sends "journal.roll"
// with `write: true`: the server creates the day under the draft's id with
// exactly that state (lib/journal.ts rollJournal), so what was typed in the
// draft merges like any other edit. A second device starting at the same
// moment gets the same page; if what the day starts with changed meanwhile
// (another generation), it opens the stored day instead of merging.
import { createHash } from "node:crypto";
import * as Y from "yjs";
import type { Node as PMNode } from "@tiptap/pm/model";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole } from "./permissions";
import { isEncryptedPage } from "./e2ee-server";
import {
  hasEntryData,
  journalLocked,
  lockedPageIds,
  journalSettings,
  onlyTemplate,
  templateNodesOf,
  templateTaskTexts,
} from "./journal-extras";
import { dayDoc, dayStart, dayTitle, hasOwnEntry, journalDate, rollJournal } from "./journal";
import { dayTitle as localDayTitle } from "./journal-title";
import type { Identity, Page, PageCounts } from "./types";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// ---- Drafts ----

// The id a day has before it exists; the same for everyone who opens it.
export function ensureDraft(journalId: string, date: string) {
  run(
    "INSERT OR IGNORE INTO journal_drafts(id,journal_id,date,created_at) VALUES(?,?,?,?)",
    id(),
    journalId,
    date,
    Date.now(),
  );
  // Drafts of days long gone are of no use any more.
  run("DELETE FROM journal_drafts WHERE journal_id=? AND date<?", journalId, shiftDay(date, -7));
  return one<{ id: string }>("SELECT id FROM journal_drafts WHERE journal_id=? AND date=?", journalId, date)!.id;
}
export function draftId(journalId: string, date: string) {
  return one<{ id: string }>("SELECT id FROM journal_drafts WHERE journal_id=? AND date=?", journalId, date)?.id || null;
}
function shiftDay(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The Yjs state of a new day, the same for the same page and content: the
// client id comes from both, the generation from the content. A draft and
// the day created from it therefore share every Yjs item.
export function seededDayState(pageId: string, doc: PMNode) {
  const hash = sha(JSON.stringify(doc.toJSON())).slice(0, 16);
  const ydoc = new Y.Doc();
  ydoc.clientID = parseInt(sha(`${pageId}:${hash}`).slice(0, 8), 16) || 1;
  prosemirrorToYXmlFragment(doc, ydoc.getXmlFragment("default"));
  return { ydoc, hash, generation: `d-${hash}` };
}

// ---- Template versions ----

// The current template, kept by its hash; "" without a template.
export function rememberTemplate(journalId: string) {
  const html = journalSettings(journalId).template;
  if (!html) return "";
  const hash = sha(html).slice(0, 16);
  run(
    "INSERT OR IGNORE INTO journal_templates(journal_id,hash,html,created_at) VALUES(?,?,?,?)",
    journalId,
    hash,
    html,
    Date.now(),
  );
  return hash;
}
export function rememberDay(pageId: string, journalId: string, templateHash: string, baseHash: string) {
  run(
    "INSERT OR REPLACE INTO journal_day_meta(page_id,journal_id,template_hash,base_hash,created_at) VALUES(?,?,?,?,?)",
    pageId,
    journalId,
    templateHash,
    baseHash,
    Date.now(),
  );
}
// The template HTML a day was created from: "" for none, null when unknown
// (days from before this was recorded).
export function dayTemplateHtml(pageId: string): string | null {
  const meta = one<{ journal_id: string; template_hash: string }>(
    "SELECT journal_id,template_hash FROM journal_day_meta WHERE page_id=?",
    pageId,
  );
  if (!meta) return null;
  if (!meta.template_hash) return "";
  return (
    one<{ html: string }>(
      "SELECT html FROM journal_templates WHERE journal_id=? AND hash=?",
      meta.journal_id,
      meta.template_hash,
    )?.html ?? null
  );
}

// ---- The draft as a page (GET /api/pages/<draft id>) ----

export type DraftResult =
  | { existing: string }
  | { data: Record<string, unknown> };
export function journalDraftPage(user: Identity, pageId: string, now = new Date().toISOString().slice(0, 10)): DraftResult | null {
  const row = one<{ id: string; journal_id: string; date: string }>("SELECT * FROM journal_drafts WHERE id=?", pageId);
  if (!row) return null;
  const journal = one<Page>("SELECT * FROM pages WHERE id=? AND kind='journal' AND deleted_at IS NULL", row.journal_id);
  const role = journal ? pageRole(user, journal) : null;
  if (!journal || !role) throw new HttpError(404, "Seite nicht gefunden.");
  const day = one<{ id: string }>(
    "SELECT id FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL",
    journal.id,
    row.date,
  );
  if (day) return { existing: day.id };
  // A draft only stands in for today (as the client's clock may see it).
  if (row.date < shiftDay(now, -1) || row.date > shiftDay(now, 1))
    throw new HttpError(404, "Für diesen Tag gibt es keinen Eintrag.");
  const page: Page = {
    id: row.id,
    workspace_id: journal.workspace_id,
    space_id: journal.space_id,
    parent_id: journal.id,
    title: dayTitle(row.date),
    icon: "day",
    cover: "",
    kind: "document",
    position: -Number(row.date.replaceAll("-", "")),
    deleted_at: null,
    created_by: user.id,
    updated_at: new Date().toISOString(),
    locked: 0,
    public_token: null,
    full_width: journal.full_width || 0,
    font: journal.font || "sans",
    journal_date: row.date,
    synced: 0,
  };
  const empty = { comments: [], snapshots: [], present: [], backlinks: [], images: [], shareLinks: [] };
  if (journalLocked(user, journal))
    return { data: { page, role, locked: { journalId: journal.id }, ...empty, html: "", state: null, generation: "1" } };
  if (isEncryptedPage(journal)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  const { before, doc } = dayStart(journal, row.date);
  before?.ydoc.destroy();
  const seeded = seededDayState(row.id, doc);
  const state = Buffer.from(Y.encodeStateAsUpdate(seeded.ydoc)).toString("base64");
  seeded.ydoc.destroy();
  const settings = journalSettings(journal.id);
  return {
    data: {
      page,
      role,
      ...empty,
      draft: { journalId: journal.id, date: row.date },
      journalDay: {
        journalId: journal.id,
        date: row.date,
        trackers: settings.trackers,
        options: settings.options,
        entry: { values: {}, place: "", lat: null, lon: null },
      },
      state,
      // The editor renders the state; the HTML only fills a first paint.
      html: "",
      generation: seeded.generation,
    },
  };
}
// The journal and date behind a page id: a day, or a draft of one.
export function dayOrDraft(user: Identity, pageId: string) {
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (page) return null;
  const row = one<{ journal_id: string; date: string }>("SELECT journal_id,date FROM journal_drafts WHERE id=?", pageId);
  if (!row) return null;
  const journal = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", row.journal_id);
  if (!journal || !pageRole(user, journal)) return null;
  return { journal, date: row.date };
}

// ---- "@heute", "@gestern", "@2026-10-27" ----

// The journal such a link goes to: the readable, unlocked journal in the
// space of the page being written in, else the one written in last.
export function linkJournal(user: Identity, workspaceId: string, fromPageId?: string | null) {
  const from = fromPageId ? one<Page>("SELECT * FROM pages WHERE id=?", fromPageId) : undefined;
  const journals = all<Page & { last: string | null }>(
    `SELECT p.*,(SELECT MAX(journal_date) FROM pages d WHERE d.parent_id=p.id AND d.deleted_at IS NULL) last
     FROM pages p WHERE p.workspace_id=? AND p.kind='journal' AND p.deleted_at IS NULL`,
    workspaceId,
  ).filter((j) => pageRole(user, j) && !journalLocked(user, j) && !isEncryptedPage(j));
  if (from?.kind === "journal" && journals.some((j) => j.id === from.id)) return journals.find((j) => j.id === from.id)!;
  if (from?.journal_date && from.parent_id && journals.some((j) => j.id === from.parent_id))
    return journals.find((j) => j.id === from.parent_id)!;
  const recent = (list: typeof journals) =>
    [...list].sort((a, b) => (b.last || "").localeCompare(a.last || "") || b.updated_at.localeCompare(a.updated_at))[0];
  return (from && recent(journals.filter((j) => j.space_id === from.space_id))) || recent(journals) || null;
}
// What "@heute" and friends insert: the day's page, today's draft (a
// journal set to "beim ersten Schreiben") or nothing for a day without an
// entry. Today follows what opening the journal does: it may create the day.
export function journalDayLink(
  user: Identity,
  workspaceId: string,
  input: { date: string; today: string; fromPageId?: string | null },
  now = new Date().toISOString().slice(0, 10),
) {
  const date = journalDate.parse(input.date);
  const today = journalDate.parse(input.today);
  const journal = linkJournal(user, workspaceId, input.fromPageId);
  if (!journal) throw new HttpError(404, "Kein Journal gefunden.");
  const day = one<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL",
    journal.id,
    date,
  );
  const answer = (dayId: string, title: string, draft = false) => ({
    journalId: journal.id,
    journalTitle: journal.title,
    dayId,
    date,
    title,
    draft,
  });
  if (day && pageRole(user, day)) return answer(day.id, day.title);
  const role = pageRole(user, journal);
  if (date !== today || (role !== "editor" && role !== "owner"))
    throw new HttpError(404, "Für diesen Tag gibt es keinen Eintrag.");
  const rolled = rollJournal(user, journal, today, now);
  if (rolled.draft) return answer(rolled.dayId, dayTitle(date), true);
  if (rolled.trashed) throw new HttpError(404, "Für diesen Tag gibt es keinen Eintrag.");
  return answer(rolled.dayId, String(one<{ title: string }>("SELECT title FROM pages WHERE id=?", rolled.dayId)?.title || dayTitle(date)));
}

// ---- "Leere Tage entfernen" ----

const plain = (title: string) => title.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
// The title the day got automatically, in any language, or that title with
// only spaces or capitals changed.
function automaticTitle(title: string, date: string) {
  const own = plain(title);
  if (!own) return true;
  return (["de", "en", "fr"] as const).some((locale) => plain(localDayTitle(date, locale)) === own);
}
const like = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// A day nobody wrote in, as conservatively as possible: nothing beyond the
// template (the one it was created from or today's), no open task of its
// own, no tracker value or place, title and icon as created, no cover,
// files, comments, sub pages, links to it, favourites or sharing.
function emptyDay(day: Page, today: string) {
  if (!day.journal_date || day.journal_date >= today || day.deleted_at) return false;
  if (day.locked || day.public_token || day.cover || day.icon !== "day") return false;
  if (!automaticTitle(day.title, day.journal_date)) return false;
  if (hasEntryData(day.id)) return false;
  const used = (sql: string, ...args: string[]) => !!one(sql, ...args);
  if (
    used("SELECT 1 FROM pages WHERE parent_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM comments WHERE page_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM inline_threads WHERE page_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM files WHERE page_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM favorites WHERE page_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM share_links WHERE root_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM share_link_pages WHERE page_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM publications WHERE page_id=? LIMIT 1", day.id) ||
    used("SELECT 1 FROM publication_pages WHERE page_id=? LIMIT 1", day.id)
  )
    return false;
  // Linked from anywhere in the workspace (whatever the person may read).
  const needle = like(`#page=${day.id}`);
  if (
    used(
      "SELECT 1 FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=? AND p.id!=? AND d.html LIKE ? ESCAPE '\\' LIMIT 1",
      day.workspace_id,
      day.id,
      needle,
    ) ||
    used(
      "SELECT 1 FROM rows r JOIN pages p ON p.id=r.page_id LEFT JOIN row_documents rd ON rd.row_id=r.id WHERE p.workspace_id=? AND (COALESCE(rd.html,'') LIKE ? ESCAPE '\\' OR COALESCE(r.content,'') LIKE ? ESCAPE '\\' OR r.cells LIKE ? ESCAPE '\\') LIMIT 1",
      day.workspace_id,
      needle,
      needle,
      like(day.id),
    )
  )
    return false;
  const doc = dayDoc(day.id);
  const created = dayTemplateHtml(day.id);
  const templates = [templateNodesOf(journalSettings(day.parent_id!).template), ...(created ? [templateNodesOf(created)] : [])];
  // Open tasks that are not the template's own would get lost.
  const daily = new Set(templates.flatMap((nodes) => [...templateTaskTexts(day.parent_id!, nodes)]));
  let openTask = false;
  doc.descendants((node) => {
    if (node.type.name === "taskItem" && !node.attrs.checked && !daily.has(node.textContent.trim())) openTask = true;
    return !openTask;
  });
  if (openTask) return false;
  return !hasOwnEntry(doc, day.journal_date) || templates.some((nodes) => onlyTemplate(day.parent_id!, doc, day.journal_date!, nodes));
}
export function emptyJournalDays(journal: Page, today: string) {
  if (journal.kind !== "journal") throw new HttpError(400, "Diese Seite ist kein Journal.");
  journalDate.parse(today);
  return all<Page>(
    "SELECT * FROM pages WHERE parent_id=? AND journal_date IS NOT NULL AND deleted_at IS NULL ORDER BY journal_date DESC",
    journal.id,
  )
    .filter((day) => emptyDay(day, today))
    .map((day) => ({ id: day.id, date: day.journal_date!, title: day.title }));
}
// Moves the chosen days to the trash – only those still empty; never
// automatically, always from the preview a person confirmed.
export function removeEmptyJournalDays(user: Identity, journal: Page, ids: string[], today: string) {
  const wanted = new Set(ids);
  const removed = emptyJournalDays(journal, today).filter((day) => wanted.has(day.id));
  for (const day of removed) {
    run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP,public_token=NULL WHERE id=?", day.id);
  }
  if (removed.length) audit(user.id, "journal.removeEmpty", journal.id, String(removed.length));
  return { removed: removed.length, ids: removed.map((day) => day.id) };
}

// ---- Counting ----

// Pages and journal days apart, of the pages a person sees (bootstrap);
// days behind a PIN that was not entered stay out of the count.
export function pageCounts(user: Identity, workspaceId: string, pages: Page[]): PageCounts {
  const locked = lockedPageIds(user, workspaceId);
  const counts: PageCounts = { pages: 0, days: 0, spaces: {} };
  for (const page of pages) {
    if (page.deleted_at || page.synced) continue;
    const day = !!page.journal_date;
    if (day && locked.has(page.id)) continue;
    const space = (counts.spaces[page.space_id] ||= { pages: 0, days: 0 });
    if (day) {
      counts.days++;
      space.days++;
    } else {
      counts.pages++;
      space.pages++;
    }
  }
  return counts;
}
