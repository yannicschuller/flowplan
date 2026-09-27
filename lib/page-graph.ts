// How pages hang together: links between documents (and embedded boards and
// databases) as a graph, and pages that name a page without linking it
// ("unlinked mentions"), which can be turned into a link with one click.
import { Transform } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { all, one } from "./db";
import { pageRole, requirePage } from "./permissions";
import { journalLocked } from "./journal-extras";
import { htmlParagraphs } from "./version-history";
import { rewriteDocument } from "./document-rewrite";
import { HttpError } from "./auth";
import type { Identity, Page } from "./types";

const reference = /(?:#page=|data-whiteboard="|data-linked-source="|data-synced-block=")([0-9a-f-]{36})/gi;

export function pageGraph(user: Identity, workspaceId: string) {
  const pages = all<Page & { html: string | null }>(
    `SELECT p.*,d.html FROM pages p LEFT JOIN documents d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL`,
    workspaceId,
  ).filter((page) => pageRole(user, page) && !journalLocked(user, page));
  const visible = new Map(pages.map((page) => [page.id, page]));
  // A synced block counts as part of the page it was created on.
  const owner = (id: string) => {
    const page = visible.get(id);
    return page?.synced && page.parent_id && visible.has(page.parent_id) ? page.parent_id : id;
  };
  const edges = new Map<string, { from: string; to: string; kind: "link" | "parent" }>();
  for (const page of pages) {
    const from = owner(page.id);
    for (const match of (page.html || "").matchAll(reference)) {
      const to = owner(match[1]);
      if (to === from || !visible.has(to)) continue;
      edges.set(`${from}>${to}`, { from, to, kind: "link" });
    }
    if (!page.synced && page.parent_id && visible.has(page.parent_id) && !page.journal_date)
      edges.set(`${page.parent_id}>${page.id}:p`, { from: page.parent_id, to: page.id, kind: "parent" });
  }
  const degree = new Map<string, number>();
  for (const edge of edges.values())
    if (edge.kind === "link")
      for (const id of [edge.from, edge.to]) degree.set(id, (degree.get(id) || 0) + 1);
  return {
    nodes: pages
      .filter((page) => !page.synced && !page.journal_date)
      .map((page) => ({
        id: page.id,
        title: page.title || "Ohne Titel",
        icon: page.icon,
        kind: page.kind,
        links: degree.get(page.id) || 0,
      })),
    edges: [...edges.values()].filter((e) => visible.has(e.from) && visible.has(e.to) && !visible.get(e.to)!.journal_date),
  };
}

const lower = (text: string) => text.toLocaleLowerCase("de");
function usableTitle(title: string) {
  const t = title.trim();
  return t.length >= 4 && t.length <= 120 && t !== "Ohne Titel" ? t : "";
}
// Documents that contain the page's title as text but do not link to it.
export function unlinkedMentions(user: Identity, page: Page) {
  const title = usableTitle(page.title);
  if (!title) return [];
  const needle = lower(title);
  const found: { id: string; title: string; icon: string; snippet: string }[] = [];
  for (const doc of all<Page & { html: string }>(
    `SELECT p.*,d.html FROM pages p JOIN documents d ON d.page_id=p.id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND p.id!=? AND p.kind='document'
     AND instr(lower(d.html), lower(?))>0 AND instr(d.html, ?)=0 LIMIT 200`,
    page.workspace_id,
    page.id,
    title,
    page.id,
  )) {
    if (!pageRole(user, doc) || journalLocked(user, doc)) continue;
    const paragraph = htmlParagraphs(doc.html).find((p) => lower(p).includes(needle));
    if (!paragraph) continue;
    const at = lower(paragraph).indexOf(needle);
    const start = Math.max(0, at - 50);
    const host = doc.synced && doc.parent_id ? one<Page>("SELECT * FROM pages WHERE id=?", doc.parent_id) : null;
    found.push({
      id: doc.id,
      title: host ? `${host.title} (synchronisierter Block)` : doc.title,
      icon: host?.icon || doc.icon,
      snippet: `${start ? "…" : ""}${paragraph.slice(start, at + title.length + 60)}${at + title.length + 60 < paragraph.length ? "…" : ""}`,
    });
    if (found.length >= 20) break;
  }
  return found;
}

// Turns the first unlinked mention of the target's title in a document into
// a link to the target.
export function linkMention(user: Identity, sourceId: string, targetId: string) {
  const source = requirePage(user, sourceId, true);
  const target = requirePage(user, targetId);
  if (source.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  if (source.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  const title = usableTitle(target.title);
  if (!title) throw new HttpError(400, "Der Titel ist zu kurz zum Verlinken.");
  const needle = lower(title);
  const result = rewriteDocument(source.id, null, user.id, (doc) => {
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
    const link = doc.type.schema.marks.link.create({ href: `/#page=${target.id}` });
    return new Transform(doc).addMark(from, to, link).doc;
  });
  if (!result) throw new HttpError(409, "Die Erwähnung ist nicht mehr im Text.");
  return result.publish;
}
