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
import { aliasIndex, MIN_ALIAS_MENTION, pageAliases, recordAliases } from "./aliases";
import { contentLocale } from "./content-locale";
import { localeTag } from "./i18n";
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

// Journal days in the graph: left out ("hide", one journal has hundreds),
// one dot per journal and month ("month") or each day ("show").
export type GraphDays = "hide" | "month" | "show";
type GraphNode = {
  id: string;
  title: string;
  icon: string;
  kind: string;
  links: number;
  // Records: their database.
  pageId?: string;
  pageTitle?: string;
  // A month of a journal: the journal to open and the month (YYYY-MM).
  journalId?: string;
  month?: string;
  days?: number;
};
const monthName = (month: string) =>
  new Intl.DateTimeFormat(localeTag(contentLocale()), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
export function pageGraph(user: Identity, workspaceId: string, options: { days?: GraphDays } = {}) {
  const mode = options.days || "hide";
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
  // A journal day (readable, below a readable journal): where it shows up.
  const dayOf = (page: Page | undefined) =>
    page?.journal_date && page.parent_id && visible.get(page.parent_id)?.kind === "journal" ? page : null;
  const months = new Map<string, GraphNode>();
  const place = (id: string): string | null => {
    const day = dayOf(visible.get(id));
    if (!day) return id;
    if (mode === "show") return id;
    if (mode === "hide") return null;
    const month = day.journal_date!.slice(0, 7);
    const key = `month:${day.parent_id}:${month}`;
    const journal = visible.get(day.parent_id!)!;
    const node = months.get(key) || {
      id: key,
      title: `${monthName(month)} · ${journal.title || "Ohne Titel"}`,
      icon: "day",
      kind: "journal-month",
      links: 0,
      journalId: journal.id,
      month,
      days: 0,
    };
    months.set(key, node);
    return key;
  };
  const edges = new Map<string, { from: string; to: string; kind: "link" | "parent" }>();
  const addEdge = (rawFrom: string, rawTo: string, kind: "link" | "parent") => {
    const from = place(rawFrom),
      to = place(rawTo);
    if (!from || !to || from === to) return;
    edges.set(`${from}>${to}${kind === "parent" ? ":p" : ""}`, { from, to, kind });
  };
  // Links from one text: to a record when it names one, else to the page.
  const linksFrom = (from: string, html: string) => {
    for (const match of html.matchAll(reference)) {
      const to = match[2] && records.has(match[2]) ? match[2] : owner(match[1]);
      if (to === from || (!visible.has(to) && !records.has(to))) continue;
      addEdge(from, to, "link");
    }
  };
  for (const page of pages) {
    linksFrom(owner(page.id), page.html || "");
    if (!page.synced && page.parent_id && visible.has(page.parent_id)) addEdge(page.parent_id, page.id, "parent");
  }
  for (const record of records.values()) if (record.html.includes("=")) linksFrom(record.id, record.html);
  const degree = new Map<string, number>();
  for (const edge of edges.values())
    if (edge.kind === "link")
      for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) || 0) + 1);
  for (const page of pages) {
    const key = dayOf(page) && mode === "month" ? place(page.id) : null;
    if (key) months.get(key)!.days! += 1;
  }
  const nodes: GraphNode[] = [
    ...pages
      .filter((page) => !page.synced && (!dayOf(page) || mode === "show"))
      .map((page) => ({
        id: page.id,
        title: page.title || "Ohne Titel",
        icon: page.icon,
        kind: page.kind,
        links: degree.get(page.id) || 0,
      })),
    ...[...months.values()].map((node) => ({ ...node, links: degree.get(node.id) || 0 })),
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
  ];
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: [...edges.values()].filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

const lower = (text: string) => text.toLocaleLowerCase("de");
function usableTitle(title: string) {
  const t = title.trim();
  return t.length >= 4 && t.length <= 120 && t !== "Ohne Titel" ? t : "";
}
type Target = { page: Page; rowId?: string };
// The matched alias is set when the text names the item by an alias.
type Mention = { id: string; rowId?: string; pageTitle?: string; title: string; icon: string; snippet: string; alias?: string };
function recordInfo(page: Page, rowId: string) {
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  if (!row) return { title: "", aliases: [] as string[] };
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]") as Field[];
  const cells = JSON.parse(row.cells) as Record<string, unknown>;
  return { title: cellText(cells[fields[0]?.id || "title"]), aliases: recordAliases(fields, cells) };
}
const recordTitle = (page: Page, rowId: string) => recordInfo(page, rowId).title;
// The names an item is mentioned by: its title (found anywhere in a word,
// from four characters) and its aliases (as whole words, from two).
type Name = { text: string; alias: boolean };
function namesOf(target: Target): Name[] {
  const info = target.rowId ? recordInfo(target.page, target.rowId) : { title: target.page.title, aliases: pageAliases(target.page) };
  const title = usableTitle(info.title);
  return [
    ...(title ? [{ text: title, alias: false }] : []),
    ...info.aliases
      .filter((alias) => [...alias].length >= MIN_ALIAS_MENTION && lower(alias) !== lower(title))
      .map((text) => ({ text, alias: true })),
  ];
}
const nameIndex = (text: string, name: Name) => (name.alias ? aliasIndex(text, name.text) : lower(text).indexOf(lower(name.text)));
function snippetOf(html: string, name: Name) {
  const paragraph = htmlParagraphs(html).find((p) => nameIndex(p, name) >= 0);
  if (!paragraph) return null;
  const at = nameIndex(paragraph, name),
    length = name.text.length;
  const start = Math.max(0, at - 50);
  return `${start ? "…" : ""}${paragraph.slice(start, at + length + 60)}${at + length + 60 < paragraph.length ? "…" : ""}`;
}
// Documents and record texts that contain the title or an alias of a page
// or record as text but do not link to it.
export function unlinkedMentions(user: Identity, page: Page, rowId?: string) {
  const names = namesOf({ page, rowId });
  const targetId = rowId || page.id;
  const found: Mention[] = [];
  const seen = new Set<string>();
  const resolvers = new Map<string, ReturnType<typeof rowRoleResolver> | null>();
  for (const name of names) {
    const alias = name.alias ? { alias: name.text } : {};
    for (const doc of all<Page & { html: string }>(
      `SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.id!=? AND p.kind='document'
       AND instr(lower(d.html), lower(?))>0 AND instr(d.html, ?)=0 LIMIT 200`,
      page.workspace_id,
      page.id,
      name.text,
      targetId,
    )) {
      if (seen.has(doc.id) || !pageRole(user, doc) || journalLocked(user, doc)) continue;
      const snippet = snippetOf(doc.html, name);
      if (!snippet) continue;
      seen.add(doc.id);
      const host = doc.synced && doc.parent_id ? one<Page>("SELECT * FROM pages WHERE id=?", doc.parent_id) : null;
      found.push({
        id: doc.id,
        title: host ? `${host.title} (synchronisierter Block)` : doc.title,
        icon: host?.icon || doc.icon,
        snippet,
        ...alias,
      });
      if (found.length >= 20) return found;
    }
    // Record texts, as far as the person may read the record.
    for (const row of all<RecordSource & { db_title: string; db_icon: string }>(
      `SELECT r.id,r.page_id,r.cells,r.access,r.created_by,d.html,p.title db_title,p.icon db_icon
       FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND r.id!=?
       AND instr(lower(d.html), lower(?))>0 AND instr(d.html, ?)=0 LIMIT 200`,
      page.workspace_id,
      targetId,
      name.text,
      targetId,
    )) {
      if (seen.has(row.id)) continue;
      if (!resolvers.has(row.page_id)) {
        const database = one<Page>("SELECT * FROM pages WHERE id=?", row.page_id)!;
        resolvers.set(row.page_id, pageRole(user, database) && !journalLocked(user, database) ? rowRoleResolver(user, database) : null);
      }
      const visible = resolvers.get(row.page_id);
      if (!visible || !visible(row)) continue;
      const snippet = snippetOf(row.html, name);
      if (!snippet) continue;
      seen.add(row.id);
      const source = one<Page>("SELECT * FROM pages WHERE id=?", row.page_id)!;
      found.push({ id: row.page_id, rowId: row.id, pageTitle: row.db_title, title: recordTitle(source, row.id) || "Ohne Titel", icon: row.db_icon, snippet, ...alias });
      if (found.length >= 20) return found;
    }
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
  const names = namesOf({ page: targetPage, rowId: target.rowId });
  if (!names.length) throw new HttpError(400, "Der Titel ist zu kurz zum Verlinken.");
  const href = target.rowId ? `/#page=${targetPage.id}&row=${target.rowId}` : `/#page=${targetPage.id}`;
  // The first mention by the title, else by an alias; the text stays as
  // written ("PAC" links to "Chauffage" and still reads "PAC").
  const result = rewriteDocument(sourcePage.id, source.rowId ?? null, user.id, (doc) => {
    let range: { from: number; to: number } | null = null;
    for (const name of names) {
      doc.descendants((node: PMNode, pos: number) => {
        if (range) return false;
        if (!node.isText || !node.text) return true;
        if (node.marks.some((mark) => mark.type.name === "link" || mark.type.name === "code")) return false;
        const at = nameIndex(node.text, name);
        if (at >= 0) range = { from: pos + at, to: pos + at + name.text.length };
        return false;
      });
      if (range) break;
    }
    if (!range) return null;
    const { from, to } = range as { from: number; to: number };
    const link = doc.type.schema.marks.link.create({ href });
    return new Transform(doc).addMark(from, to, link).doc;
  });
  if (!result) throw new HttpError(409, "Die Erwähnung ist nicht mehr im Text.");
  return result.publish;
}
