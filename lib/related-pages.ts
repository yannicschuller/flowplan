// "Verwandte Seiten": pages and records that belong with the one that is
// open, and "Ähnliche Einträge gibt es schon" when creating a page or a
// record.
//
// Related pages come from two sources:
//   - the semantic index (lib/ai/semantic.ts) when an administrator switched
//     on meaning search and "ask" resolves to the instance provider for the
//     person: the mean of the page's stored vectors against the workspace.
//     No provider is called, nothing leaves the server; the open page must
//     be readable for the AI and every hit passes aiFilter (personal AI
//     rules, "Für KI gesperrt", PIN journals, …).
//   - without it (or to fill up): links from the page, backlinks, pages
//     that link to the same targets, records sharing tags (multi-select
//     values) and title similarity over the full-text index (BM25).
// Everything passes the person's permissions: page roles, hidden records,
// the trash and locked journals.
//
// Duplicate detection is a cheap title comparison: candidates from the
// full-text index (title column), scored by character bigram similarity.
import { all, one } from "./db";
import { pageRole, requireMember, requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { journalLocked } from "./journal-extras";
import { requireRow } from "./row-documents";
import { processSearchIndex } from "./search-index";
import { ftsQuery, questionTerms } from "./ai/chunks";
import { aiFilter, aiMayRead } from "./ai/access";
import { semanticNeighbours } from "./ai/semantic";
import { recordTitle } from "./ai/sources";
import type { Field, Identity, Page } from "./types";

export type RelatedReason = "meaning" | "link" | "backlink" | "shared-links" | "tags" | "title";
export type RelatedItem = {
  pageId: string;
  rowId?: string;
  title: string;
  // Records: their database.
  pageTitle?: string;
  icon: string;
  kind: string;
  reasons: RelatedReason[];
  score: number;
};

export const RELATED_LIMIT = 8;
// A link to a page or record in stored HTML (as in lib/page-graph.ts).
const reference = /(?:#page=|data-linked-source="|data-whiteboard=")([0-9a-f-]{36})(?:&(?:amp;)?row=([0-9a-f-]{36}))?/gi;
const key = (pageId: string, rowId?: string | null) => `${pageId}/${rowId || ""}`;

// Who may see what: one cache per request.
function visibility(user: Identity) {
  const pages = new Map<string, Page | null>();
  const hidden = new Map<string, Set<string>>();
  const page = (id: string) => {
    if (!pages.has(id)) {
      const p = one<Page>("SELECT * FROM pages WHERE id=?", id) || null;
      pages.set(id, p && !p.deleted_at && !p.synced && pageRole(user, p) && !journalLocked(user, p) ? p : null);
    }
    return pages.get(id) || null;
  };
  return {
    page,
    visible(pageId: string, rowId?: string | null) {
      const p = page(pageId);
      if (!p) return false;
      if (!rowId) return true;
      if (p.kind !== "database" || !one("SELECT 1 FROM rows WHERE id=? AND page_id=?", rowId, pageId)) return false;
      if (!hidden.has(pageId)) hidden.set(pageId, hiddenRowIds(user, p));
      return !hidden.get(pageId)!.has(rowId);
    },
  };
}

function fieldsOf(pageId: string): Field[] {
  try {
    return JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]");
  } catch {
    return [];
  }
}
function cellsOf(rowId: string): Record<string, unknown> {
  try {
    return JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId)?.cells || "{}");
  } catch {
    return {};
  }
}
const indexReady = () => {
  for (let i = 0; i < 10 && processSearchIndex(); i++);
};

// The text of a page or record as stored HTML (for its links).
function storedHtml(pageId: string, rowId: string | null) {
  if (!rowId) return one<{ html: string | null }>("SELECT html FROM documents WHERE page_id=?", pageId)?.html || "";
  const row = one<{ html: string | null; content: string | null }>("SELECT d.html,r.content FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=?", rowId);
  return row?.html ?? row?.content ?? "";
}
// Documents and record texts of the workspace that contain a link.
function linkingTo(workspaceId: string, needle: string, limit = 40) {
  const like = `%${needle.replace(/[%_\\]/g, "\\$&")}%`;
  return [
    ...all<{ page_id: string; row_id: string }>(
      "SELECT d.page_id,'' row_id FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.html LIKE ? ESCAPE '\\' LIMIT ?",
      workspaceId,
      like,
      limit,
    ),
    ...all<{ page_id: string; row_id: string }>(
      "SELECT r.page_id,r.id row_id FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.html LIKE ? ESCAPE '\\' LIMIT ?",
      workspaceId,
      like,
      limit,
    ),
  ];
}
const linkNeedle = (pageId: string, rowId?: string | null) => (rowId ? `row=${rowId}` : `#page=${pageId}`);

export function relatedPages(user: Identity, pageId: string, rowId: string | null = null, limit = RELATED_LIMIT): { items: RelatedItem[]; semantic: boolean } {
  const page = rowId ? requireRow(user, pageId, rowId).page : requirePage(user, pageId);
  if (journalLocked(user, page)) return { items: [], semantic: false };
  const self = key(pageId, rowId);
  const found = new Map<string, { pageId: string; rowId: string | null; score: number; reasons: Set<RelatedReason> }>();
  const add = (p: string, r: string | null | undefined, score: number, reason: RelatedReason) => {
    const k = key(p, r);
    // Not the page itself, nor – for a record – its own database.
    if (k === self || (!r && p === pageId)) return;
    const entry = found.get(k) || { pageId: p, rowId: r || null, score: 0, reasons: new Set<RelatedReason>() };
    entry.score += score;
    entry.reasons.add(reason);
    found.set(k, entry);
  };

  // Meaning: only when the AI may read the open page; hits through aiFilter.
  let semantic = false;
  if (aiMayRead(user, pageId, rowId)) {
    const hits = semanticNeighbours(user, page.workspace_id, pageId, rowId || "");
    const allowed = new Set(aiFilter(user, hits.map((h) => ({ pageId: h.pageId, rowId: h.rowId || null }))).map((h) => key(h.pageId, h.rowId)));
    for (const hit of hits)
      if (allowed.has(key(hit.pageId, hit.rowId)) && hit.score > 0.2) {
        add(hit.pageId, hit.rowId, 4 * hit.score, "meaning");
        semantic = true;
      }
  }

  // Links from the page, backlinks and pages linking to the same targets.
  const targets: { pageId: string; rowId: string | null }[] = [];
  for (const match of storedHtml(pageId, rowId).matchAll(reference)) {
    const target = { pageId: match[1].toLowerCase(), rowId: match[2]?.toLowerCase() || null };
    if (!targets.some((t) => t.pageId === target.pageId && t.rowId === target.rowId)) targets.push(target);
  }
  for (const target of targets.slice(0, 40)) add(target.pageId, target.rowId, 3, "link");
  for (const source of linkingTo(page.workspace_id, linkNeedle(pageId, rowId))) add(source.page_id, source.row_id || null, 3, "backlink");
  for (const target of targets.slice(0, 8))
    for (const source of linkingTo(page.workspace_id, linkNeedle(target.pageId, target.rowId), 20)) add(source.page_id, source.row_id || null, 1.5, "shared-links");

  // Records: others in the same database with the same tags.
  const fields = rowId ? fieldsOf(pageId) : [];
  const own = rowId ? cellsOf(rowId) : {};
  const tagFields = fields.filter((f) => f.type === "multiselect" && Array.isArray(own[f.id]) && (own[f.id] as unknown[]).length);
  if (tagFields.length)
    for (const row of all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=? AND id<>? LIMIT 3000", pageId, rowId!)) {
      let cells: Record<string, unknown> = {};
      try {
        cells = JSON.parse(row.cells);
      } catch {}
      let shared = 0;
      for (const f of tagFields) {
        const mine = own[f.id] as unknown[];
        if (Array.isArray(cells[f.id])) shared += (cells[f.id] as unknown[]).filter((v) => mine.includes(v)).length;
      }
      if (shared) add(pageId, row.id, Math.min(3, shared), "tags");
    }

  // Title similarity: the title's words against the full-text index (BM25).
  const title = rowId ? recordTitle(fields, own) : page.title;
  const terms = questionTerms(title || "");
  if (terms.length) {
    indexReady();
    all<{ page_id: string; row_id: string }>(
      `SELECT s.page_id,s.row_id FROM search_index s JOIN pages p ON p.id=s.page_id
       WHERE search_index MATCH ? AND p.workspace_id=? AND p.deleted_at IS NULL
       ORDER BY bm25(search_index,0,0,10,1) LIMIT 30`,
      ftsQuery(terms),
      page.workspace_id,
    )
      .filter((r) => !/^[cmf]:/.test(r.row_id))
      .forEach((r, rank) => add(r.page_id, r.row_id || null, 2 / (1 + rank * 0.4), "title"));
  }

  // What the person may see, best first.
  const seen = visibility(user);
  const items: RelatedItem[] = [];
  for (const entry of [...found.values()].sort((a, b) => b.score - a.score)) {
    if (items.length >= limit) break;
    if (!seen.visible(entry.pageId, entry.rowId)) continue;
    const target = seen.page(entry.pageId)!;
    items.push({
      pageId: entry.pageId,
      ...(entry.rowId ? { rowId: entry.rowId, pageTitle: target.title } : {}),
      title: entry.rowId ? recordTitle(fieldsOf(entry.pageId), cellsOf(entry.rowId)) : target.title,
      icon: target.icon || "file",
      kind: entry.rowId ? "row" : target.kind,
      reasons: [...entry.reasons],
      score: Math.round(entry.score * 100) / 100,
    });
  }
  return { items, semantic };
}

// ---- Duplicates ----

// Lower case, without accents and punctuation.
export function normalizeTitle(title: string) {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("de")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
const bigrams = (text: string) => {
  const padded = ` ${text} `;
  const list: string[] = [];
  for (let i = 0; i < padded.length - 1; i++) list.push(padded.slice(i, i + 2));
  return list;
};
// Dice coefficient of character bigrams: 1 for equal titles.
export function titleSimilarity(a: string, b: string) {
  const x = normalizeTitle(a),
    y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const left = bigrams(x),
    counts = new Map<string, number>();
  for (const g of bigrams(y)) counts.set(g, (counts.get(g) || 0) + 1);
  let shared = 0;
  for (const g of left) {
    const n = counts.get(g) || 0;
    if (n) {
      shared++;
      counts.set(g, n - 1);
    }
  }
  return (2 * shared) / (left.length + bigrams(y).length);
}
export const DUPLICATE_THRESHOLD = 0.72;

export type SimilarItem = { pageId: string; rowId?: string; title: string; pageTitle?: string; score: number };
export function similarTitles(
  user: Identity,
  input: { workspaceId: string; title: string; databaseId?: string | null; excludePageId?: string | null; excludeRowId?: string | null },
  limit = 5,
): SimilarItem[] {
  requireMember(user, input.workspaceId);
  const wanted = normalizeTitle(input.title);
  if (wanted.length < 4) return [];
  const terms = [...new Set(wanted.split(" ").filter((w) => [...w].length >= 3))].slice(0, 8);
  if (!terms.length) return [];
  if (input.databaseId) {
    const database = requirePage(user, input.databaseId);
    if (database.kind !== "database" || database.workspace_id !== input.workspaceId) return [];
  }
  indexReady();
  const rows = all<{ page_id: string; row_id: string; title: string }>(
    `SELECT s.page_id,s.row_id,s.title FROM search_index s JOIN pages p ON p.id=s.page_id
     WHERE search_index MATCH ? AND p.workspace_id=? AND p.deleted_at IS NULL AND COALESCE(p.synced,0)=0
       ${input.databaseId ? "AND s.page_id=? AND s.row_id<>''" : "AND s.row_id=''"}
     ORDER BY bm25(search_index,0,0,10,1) LIMIT 60`,
    `title : (${ftsQuery(terms)})`,
    input.workspaceId,
    ...(input.databaseId ? [input.databaseId] : []),
  ).filter((r) => !/^[cmf]:/.test(r.row_id) && !(r.row_id ? r.row_id === input.excludeRowId : r.page_id === input.excludePageId));
  const seen = visibility(user);
  return rows
    .map((r) => ({ ...r, score: titleSimilarity(input.title, r.title) }))
    .filter((r) => r.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .filter((r) => seen.visible(r.page_id, r.row_id || null))
    .slice(0, limit)
    .map((r) => ({
      pageId: r.page_id,
      ...(r.row_id ? { rowId: r.row_id, pageTitle: seen.page(r.page_id)!.title } : {}),
      title: r.title,
      score: Math.round(r.score * 100) / 100,
    }));
}
