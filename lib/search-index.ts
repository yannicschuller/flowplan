import { all, one, run, transaction } from "./db";
import { pageRole } from "./permissions";
import type { Field, Identity, Page } from "./types";

// Full-text index over page titles, document text, record cells and record
// documents. Triggers (see db.ts) only mark changed pages/rows as dirty; the
// index is refreshed lazily before each search and by a background worker, so
// no write path needs to know about searching.
export const SEARCH_LIMIT = 50;
const BATCH = 2000;
const IGNORED: Field["type"][] = [
  "relation",
  "person",
  "created_by",
  "updated_by",
  "formula",
  "rollup",
];

export function htmlText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
// Text people see in a cell: nested strings of checklists or files, but no
// identifiers of people or related records.
function cellWords(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(cellWords).join(" ");
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["id", "fileId", "url"].includes(key))
      .map(([, v]) => cellWords(v))
      .join(" ");
  return value === true ? "" : String(value);
}

function indexPage(pageId: string) {
  run("DELETE FROM search_index WHERE page_id=? AND row_id=''", pageId);
  const page = one<{ title: string; html: string | null; deleted_at: string }>(
    "SELECT p.title,p.deleted_at,d.html FROM pages p LEFT JOIN documents d ON d.page_id=p.id WHERE p.id=?",
    pageId,
  );
  if (!page || page.deleted_at) return;
  run(
    "INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)",
    pageId,
    "",
    page.title,
    htmlText(page.html || "").slice(0, 400000),
  );
}
function indexRow(pageId: string, rowId: string, fields: Field[]) {
  run("DELETE FROM search_index WHERE page_id=? AND row_id=?", pageId, rowId);
  const row = one<{ cells: string; content: string; html: string | null }>(
    "SELECT r.cells,r.content,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=? AND r.page_id=?",
    rowId,
    pageId,
  );
  if (!row) return;
  const cells = JSON.parse(row.cells) as Record<string, unknown>;
  const [titleField, ...rest] = fields;
  const title = titleField ? cellWords(cells[titleField.id]) : "";
  const values = rest
    .filter((f) => !IGNORED.includes(f.type))
    .map((f) => cellWords(cells[f.id]))
    .filter(Boolean);
  const content = row.html ?? row.content ?? "";
  run(
    "INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)",
    pageId,
    rowId,
    title || "Ohne Titel",
    [...values, content.startsWith("<") ? htmlText(content) : content]
      .join(" · ")
      .slice(0, 400000),
  );
}

export function ensureSearchIndex() {
  if (!one("SELECT 1 FROM search_state WHERE id=1")) {
    transaction(() => {
      run("DELETE FROM search_index");
      run("INSERT OR IGNORE INTO search_dirty SELECT id,'' FROM pages");
      run("INSERT OR IGNORE INTO search_dirty SELECT page_id,id FROM rows");
      run("INSERT INTO search_state(id,built) VALUES(1,?)", Date.now());
    });
  }
}
// Returns the number of processed entries; call repeatedly until 0.
export function processSearchIndex(limit = BATCH) {
  ensureSearchIndex();
  const dirty = all<{ page_id: string; row_id: string }>(
    "SELECT page_id,row_id FROM search_dirty LIMIT ?",
    limit,
  );
  if (!dirty.length) return 0;
  const fields = new Map<string, Field[]>();
  transaction(() => {
    for (const entry of dirty) {
      if (!entry.row_id) indexPage(entry.page_id);
      else {
        if (!fields.has(entry.page_id)) {
          const stored = one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            entry.page_id,
          );
          fields.set(entry.page_id, stored ? JSON.parse(stored.fields) : []);
        }
        indexRow(entry.page_id, entry.row_id, fields.get(entry.page_id)!);
      }
      run(
        "DELETE FROM search_dirty WHERE page_id=? AND row_id=?",
        entry.page_id,
        entry.row_id,
      );
    }
  });
  return dirty.length;
}

export type SearchKind = "all" | "document" | "database" | "row";
export type SearchResult = {
  id: string;
  rowId?: string;
  title: string;
  pageTitle?: string;
  icon: string;
  space_id: string;
  kind: "document" | "database" | "row";
  snippet: string;
};
// Snippet markers; the client renders text between them highlighted.
export const MARK_START = "\u0002",
  MARK_END = "\u0003";

export function searchWorkspace(
  user: Identity,
  workspaceId: string,
  rawQuery: string,
  options: { kind?: SearchKind; spaceId?: string } = {},
): SearchResult[] {
  // Keep the index current for this request; a large backlog is also
  // drained by the background worker.
  for (let i = 0; i < 10 && processSearchIndex(); i++);
  const query = rawQuery
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 200);
  const kind = options.kind || "all";
  const roles = new Map<string, boolean>();
  const allowed = (page: Page) => {
    if (!roles.has(page.id)) roles.set(page.id, !!pageRole(user, page));
    return roles.get(page.id)!;
  };
  const matchesKind = (page: Page, rowId: string) =>
    kind === "all" || (kind === "row" ? !!rowId : !rowId && page.kind === kind);
  const results: SearchResult[] = [];
  const push = (page: Page, rowId: string, title: string, snippet: string) =>
    results.push({
      id: page.id,
      ...(rowId ? { rowId, pageTitle: page.title } : {}),
      title: rowId ? title : page.title,
      icon: page.icon,
      space_id: page.space_id,
      kind: rowId ? "row" : page.kind,
      snippet,
    });
  const scope =
    "p.workspace_id=? AND p.deleted_at IS NULL" +
    (options.spaceId ? " AND p.space_id=?" : "");
  const scopeArgs = options.spaceId
    ? [workspaceId, options.spaceId]
    : [workspaceId];
  if (!query) {
    if (kind === "row") return [];
    for (const page of all<Page>(
      `SELECT p.* FROM pages p WHERE ${scope} ORDER BY p.updated_at DESC LIMIT 500`,
      ...scopeArgs,
    )) {
      if (!allowed(page) || !matchesKind(page, "")) continue;
      push(page, "", page.title, "");
      if (results.length >= SEARCH_LIMIT) break;
    }
    return results;
  }
  // Trigram matching finds parts of compound words and ignores case and
  // diacritics; shorter queries fall back to a title/body scan.
  const short = [...query].length < 3;
  const candidates = all<
    Page & { row_id: string; hit_title: string; snippet: string }
  >(
    short
      ? `SELECT p.*,s.row_id,s.title hit_title,'' snippet FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE ${scope} AND (s.title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\')
         ORDER BY (s.title LIKE ? ESCAPE '\\') DESC,p.updated_at DESC LIMIT 1000`
      : `SELECT p.*,s.row_id,s.title hit_title,snippet(search_index,3,?,?,'…',40) snippet
         FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE search_index MATCH ? AND ${scope}
         ORDER BY bm25(search_index,0,0,10,1),p.updated_at DESC LIMIT 1000`,
    ...(short
      ? (() => {
          const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          return [...scopeArgs, like, like, like];
        })()
      : [MARK_START, MARK_END, `"${query.replace(/"/g, '""')}"`, ...scopeArgs]),
  );
  for (const hit of candidates) {
    if (!matchesKind(hit, hit.row_id) || !allowed(hit)) continue;
    push(
      hit,
      hit.row_id,
      hit.hit_title,
      hit.snippet.includes(MARK_START) ? hit.snippet : "",
    );
    if (results.length >= SEARCH_LIMIT) break;
  }
  return results;
}

const runtime = globalThis as typeof globalThis & {
  flowplanSearchTimer?: ReturnType<typeof setInterval>;
};
export function startSearchWorker() {
  if (runtime.flowplanSearchTimer) return;
  const tick = () => {
    try {
      processSearchIndex();
    } catch (error) {
      console.error("Search indexing failed", error);
    }
  };
  runtime.flowplanSearchTimer = setInterval(tick, 5000);
  runtime.flowplanSearchTimer.unref();
  tick();
}
