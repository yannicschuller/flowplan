// How pages and records hang together: links between documents (and
// embedded boards and databases) as a graph, and documents that name a page
// or record without linking it ("unlinked mentions"), which can be turned
// into a link with one click.
import { Transform } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { all, one } from "./db";
import { pageRole, requirePage } from "./permissions";
import { journalLocked, lockedPageIds } from "./journal-extras";
import { htmlParagraphs } from "./version-history";
import { rewriteDocument } from "./document-rewrite";
import { assertRowAccess, rowRoleResolver } from "./row-access";
import { requireRow } from "./row-documents";
import { cellText } from "./cell-text";
import { HttpError } from "./auth";
import type { Field, Identity, Page } from "./types";

// A link to a page, a record (#page=…&row=…) or an embedded board, database
// or synced block. In stored HTML the "&" before row= is "&amp;".
const reference =
  /(?:#page=|data-whiteboard="|data-linked-source="|data-synced-block=")([0-9a-f-]{36})(?:&(?:amp;)?row=([0-9a-f-]{36}))?/gi;

type RecordSource = { id: string; page_id: string; html: string; cells: string; access: string; created_by: string | null };
// The records of the workspace this person may read, with their text.
function readableRecords(user: Identity, workspaceId: string, readable: (page: Page) => boolean) {
  const databases = new Map<string, { page: Page; fields: Field[]; visible: ReturnType<typeof rowRoleResolver> } | null>();
  const records = new Map<string, RecordSource & { title: string; database: Page }>();
  for (const row of all<RecordSource>(
    `SELECT r.id,r.page_id,r.cells,r.access,r.created_by,COALESCE(d.html,r.content,'') html
     FROM rows r JOIN pages p ON p.id=r.page_id LEFT JOIN row_documents d ON d.row_id=r.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL`,
    workspaceId,
  )) {
    if (!databases.has(row.page_id)) {
      const page = one<Page>("SELECT * FROM pages WHERE id=?", row.page_id)!;
      const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]") as Field[];
      databases.set(page.id, readable(page) ? { page, fields, visible: rowRoleResolver(user, page) } : null);
    }
    const database = databases.get(row.page_id);
    if (!database || !database.visible(row)) continue;
    const cells = JSON.parse(row.cells) as Record<string, unknown>;
    records.set(row.id, { ...row, database: database.page, title: cellText(cells[database.fields[0]?.id || "title"]) });
  }
  return records;
}

export function pageGraph(user: Identity, workspaceId: string) {
  const locked = lockedPageIds(user, workspaceId);
  const readable = (page: Page) => !locked.has(page.id) && !!pageRole(user, page);
  const pages = all<Page & { html: string | null }>(
    `SELECT p.*,d.html FROM pages p LEFT JOIN documents d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL`,
    workspaceId,
  ).filter(readable);
  const visible = new Map(pages.map((page) => [page.id, page]));
  const records = readableRecords(user, workspaceId, readable);
  // A synced block counts as part of the page it was created on.
  const owner = (id: string) => {
    const page = visible.get(id);
    return page?.synced && page.parent_id && visible.has(page.parent_id) ? page.parent_id : id;
  };
  const edges = new Map<string, { from: string; to: string; kind: "link" | "parent" }>();
  // Links from one text: to a record when it names one, else to the page.
  const linksFrom = (from: string, html: string) => {
    for (const match of html.matchAll(reference)) {
      const to = match[2] && records.has(match[2]) ? match[2] : owner(match[1]);
      if (to === from || (!visible.has(to) && !records.has(to))) continue;
      edges.set(`${from}>${to}`, { from, to, kind: "link" });
    }
  };
  for (const page of pages) {
    linksFrom(owner(page.id), page.html || "");
    if (!page.synced && page.parent_id && visible.has(page.parent_id) && !page.journal_date)
      edges.set(`${page.parent_id}>${page.id}:p`, { from: page.parent_id, to: page.id, kind: "parent" });
  }
  for (const record of records.values()) if (record.html.includes("=")) linksFrom(record.id, record.html);
  const degree = new Map<string, number>();
  for (const edge of edges.values())
    if (edge.kind === "link")
      for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) || 0) + 1);
  return {
    nodes: [
      ...pages
        .filter((page) => !page.synced && !page.journal_date)
        .map((page) => ({
          id: page.id,
          title: page.title || "Ohne Titel",
          icon: page.icon,
          kind: page.kind,
          links: degree.get(page.id) || 0,
        })),
      // Records only when they link or are linked; a database has many.
      ...[...records.values()]
        .filter((record) => degree.has(record.id))
        .map((record) => ({
          id: record.id,
          title: record.title || "Ohne Titel",
          icon: "",
          kind: "record",
          pageId: record.page_id,
          pageTitle: record.database.title,
          links: degree.get(record.id) || 0,
        })),
    ],
    edges: [...edges.values()].filter(
      (e) =>
        (visible.has(e.from) || records.has(e.from)) &&
        (records.has(e.to) || (visible.has(e.to) && !visible.get(e.to)!.journal_date)),
    ),
  };
}

const lower = (text: string) => text.toLocaleLowerCase("de");
function usableTitle(title: string) {
  const t = title.trim();
  return t.length >= 4 && t.length <= 120 && t !== "Ohne Titel" ? t : "";
}
type Target = { page: Page; rowId?: string };
type Mention = { id: string; rowId?: string; pageTitle?: string; title: string; icon: string; snippet: string };
function recordTitle(page: Page, rowId: string) {
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  if (!row) return "";
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]") as Field[];
  return cellText((JSON.parse(row.cells) as Record<string, unknown>)[fields[0]?.id || "title"]);
}
const titleOf = (target: Target) => (target.rowId ? recordTitle(target.page, target.rowId) : target.page.title);
function snippetOf(html: string, title: string) {
  const needle = lower(title);
  const paragraph = htmlParagraphs(html).find((p) => lower(p).includes(needle));
  if (!paragraph) return null;
  const at = lower(paragraph).indexOf(needle);
  const start = Math.max(0, at - 50);
  return `${start ? "…" : ""}${paragraph.slice(start, at + title.length + 60)}${at + title.length + 60 < paragraph.length ? "…" : ""}`;
}
// Documents and record texts that contain the title of a page or record as
// text but do not link to it.
export function unlinkedMentions(user: Identity, page: Page, rowId?: string) {
  const title = usableTitle(titleOf({ page, rowId }));
  if (!title) return [];
  const targetId = rowId || page.id;
  const found: Mention[] = [];
  for (const doc of all<Page & { html: string }>(
    `SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.id!=? AND p.kind='document'
     AND instr(lower(d.html), lower(?))>0 AND instr(d.html, ?)=0 LIMIT 200`,
    page.workspace_id,
    page.id,
    title,
    targetId,
  )) {
    if (!pageRole(user, doc) || journalLocked(user, doc)) continue;
    const snippet = snippetOf(doc.html, title);
    if (!snippet) continue;
    const host = doc.synced && doc.parent_id ? one<Page>("SELECT * FROM pages WHERE id=?", doc.parent_id) : null;
    found.push({
      id: doc.id,
      title: host ? `${host.title} (synchronisierter Block)` : doc.title,
      icon: host?.icon || doc.icon,
      snippet,
    });
    if (found.length >= 20) return found;
  }
  // Record texts, as far as the person may read the record.
  const resolvers = new Map<string, ReturnType<typeof rowRoleResolver> | null>();
  for (const row of all<RecordSource & { db_title: string; db_icon: string }>(
    `SELECT r.id,r.page_id,r.cells,r.access,r.created_by,d.html,p.title db_title,p.icon db_icon
     FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND r.id!=?
     AND instr(lower(d.html), lower(?))>0 AND instr(d.html, ?)=0 LIMIT 200`,
    page.workspace_id,
    targetId,
    title,
    targetId,
  )) {
    if (!resolvers.has(row.page_id)) {
      const database = one<Page>("SELECT * FROM pages WHERE id=?", row.page_id)!;
      resolvers.set(row.page_id, pageRole(user, database) && !journalLocked(user, database) ? rowRoleResolver(user, database) : null);
    }
    const visible = resolvers.get(row.page_id);
    if (!visible || !visible(row)) continue;
    const snippet = snippetOf(row.html, title);
    if (!snippet) continue;
    const source = one<Page>("SELECT * FROM pages WHERE id=?", row.page_id)!;
    found.push({ id: row.page_id, rowId: row.id, pageTitle: row.db_title, title: recordTitle(source, row.id) || "Ohne Titel", icon: row.db_icon, snippet });
    if (found.length >= 20) break;
  }
  return found;
}

// Turns the first unlinked mention of the target's title in a document or a
// record's text into a link to the target (a page or a record).
export function linkMention(
  user: Identity,
  source: { pageId: string; rowId?: string },
  target: { pageId: string; rowId?: string },
) {
  const sourcePage = requirePage(user, source.pageId, true);
  const targetPage = requirePage(user, target.pageId);
  if (target.rowId) requireRow(user, targetPage.id, target.rowId);
  if (sourcePage.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (source.rowId) {
    const row = one<{ id: string; access: string; created_by: string }>(
      "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
      source.rowId,
      sourcePage.id,
    );
    if (!row) throw new HttpError(404, "Datensatz fehlt.");
    assertRowAccess(user, sourcePage, row, true);
  } else if (sourcePage.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  const title = usableTitle(titleOf({ page: targetPage, rowId: target.rowId }));
  if (!title) throw new HttpError(400, "Der Titel ist zu kurz zum Verlinken.");
  const needle = lower(title);
  const href = target.rowId ? `/#page=${targetPage.id}&row=${target.rowId}` : `/#page=${targetPage.id}`;
  const result = rewriteDocument(sourcePage.id, source.rowId ?? null, user.id, (doc) => {
    let range: { from: number; to: number } | null = null;
    doc.descendants((node: PMNode, pos: number) => {
      if (range) return false;
      if (!node.isText || !node.text) return true;
      if (node.marks.some((mark) => mark.type.name === "link" || mark.type.name === "code")) return false;
      const at = lower(node.text).indexOf(needle);
      if (at >= 0) range = { from: pos + at, to: pos + at + title.length };
      return false;
    });
    if (!range) return null;
    const { from, to } = range as { from: number; to: number };
    const link = doc.type.schema.marks.link.create({ href });
    return new Transform(doc).addMark(from, to, link).doc;
  });
  if (!result) throw new HttpError(409, "Die Erwähnung ist nicht mehr im Text.");
  return result.publish;
}
