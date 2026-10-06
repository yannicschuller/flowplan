import { lockedPageIds } from "./journal-extras";
import { all, one, run, transaction } from "./db";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { ticketId } from "./ticket-ids";
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
  "sprint",
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
  const row = one<{ cells: string; content: string; html: string | null; number: number | null }>(
    "SELECT r.cells,r.content,r.number,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=? AND r.page_id=?",
    rowId,
    pageId,
  );
  if (!row) return;
  const cells = JSON.parse(row.cells) as Record<string, unknown>;
  const [titleField, ...rest] = fields;
  const title = titleField ? cellWords(cells[titleField.id]) : "";
  const values = rest
    .filter((f) => !IGNORED.includes(f.type))
    .map((f) => (f.type === "id" ? ticketId(f, row.number) : cellWords(cells[f.id])))
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

// Comments, text comment messages and attachments are indexed under
// prefixed keys (c:, m:, f:) next to pages and records.
function indexExtra(pageId: string, key: string) {
  run("DELETE FROM search_index WHERE page_id=? AND row_id=?", pageId, key);
  const [prefix, id] = [key.slice(0, 1), key.slice(2)];
  const entry =
    prefix === "c"
      ? one<{ title: string; body: string }>(
          "SELECT 'Kommentar von '||COALESCE(u.name,'Unbekannt') title,c.body FROM comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.id=? AND c.page_id=?",
          id,
          pageId,
        )
      : prefix === "m"
        ? one<{ title: string; body: string }>(
            "SELECT 'Textkommentar von '||m.author_name title,m.body FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE m.id=? AND t.page_id=? AND m.deleted=0",
            id,
            pageId,
          )
        : one<{ title: string; body: string }>(
            "SELECT f.name title,f.name||' '||f.mime||COALESCE(char(10)||t.text,'') body FROM files f LEFT JOIN file_texts t ON t.file_id=f.id WHERE f.id=? AND f.page_id=?",
            id,
            pageId,
          );
  if (!entry) return;
  run(
    "INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)",
    pageId,
    key,
    entry.title.slice(0, 300),
    entry.body.slice(0, 100000),
  );
}
export function ensureSearchIndex() {
  if (!one("SELECT 1 FROM search_meta WHERE key='extras'")) {
    transaction(() => {
      run(
        "INSERT OR IGNORE INTO search_dirty SELECT page_id,'c:'||id FROM comments",
      );
      run(
        "INSERT OR IGNORE INTO search_dirty SELECT t.page_id,'m:'||m.id FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id",
      );
      run(
        "INSERT OR IGNORE INTO search_dirty SELECT page_id,'f:'||id FROM files WHERE page_id IS NOT NULL",
      );
      run("INSERT INTO search_meta(key) VALUES('extras')");
    });
  }
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
      else if (/^[cmf]:/.test(entry.row_id))
        indexExtra(entry.page_id, entry.row_id);
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

export type SearchKind =
  "all" | "document" | "database" | "whiteboard" | "row" | "comment" | "file";
export type SearchResult = {
  id: string;
  rowId?: string;
  title: string;
  pageTitle?: string;
  icon: string;
  space_id: string;
  kind: "document" | "database" | "whiteboard" | "row" | "comment" | "file";
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
  // Journals behind a PIN stay out of the results until unlocked.
  const locked = lockedPageIds(user, workspaceId);
  const allowed = (page: Page) => {
    if (!roles.has(page.id))
      roles.set(page.id, !locked.has(page.id) && !!pageRole(user, page));
    return roles.get(page.id)!;
  };
  const hitKind = (page: Page, key: string) =>
    key.startsWith("c:") || key.startsWith("m:")
      ? ("comment" as const)
      : key.startsWith("f:")
        ? ("file" as const)
        : key
          ? ("row" as const)
          : page.kind === "journal"
            ? ("document" as const)
            : page.kind;
  const matchesKind = (page: Page, key: string) =>
    kind === "all" || hitKind(page, key) === kind;
  // Comments on records open the record.
  const recordOf = (key: string) =>
    key.startsWith("c:")
      ? one<{ row_id: string | null }>(
          "SELECT row_id FROM comments WHERE id=?",
          key.slice(2),
        )?.row_id || undefined
      : key.startsWith("m:")
        ? one<{ row_id: string | null }>(
            "SELECT t.row_id FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE m.id=?",
            key.slice(2),
          )?.row_id || undefined
        : key.startsWith("f:")
          ? undefined
          : key || undefined;
  const results: SearchResult[] = [];
  const hidden = new Map<string, Set<string>>();
  const push = (hit: Page, key: string, title: string, snippet: string) => {
    let page = hit;
    // Text of a synced block leads to the page it was created on.
    if (page.synced) {
      const origin = page.parent_id
        ? one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", page.parent_id)
        : undefined;
      if (!origin || !allowed(origin) || results.some((r) => r.id === origin.id && !r.rowId)) return;
      page = origin;
      title = origin.title;
    }
    const rowId = recordOf(key),
      type = hitKind(page, key);
    // Records hidden by their own permissions do not appear.
    if (rowId && page.kind === "database") {
      if (!hidden.has(page.id)) hidden.set(page.id, hiddenRowIds(user, page));
      if (hidden.get(page.id)!.has(rowId)) return;
    }
    results.push({
      id: page.id,
      ...(rowId ? { rowId } : {}),
      ...(key ? { pageTitle: page.title } : {}),
      title: key ? title : page.title,
      icon: page.icon,
      space_id: page.space_id,
      kind: type,
      snippet,
    });
  };
  const scope =
    "p.workspace_id=? AND p.deleted_at IS NULL" +
    (options.spaceId ? " AND p.space_id=?" : "");
  const scopeArgs = options.spaceId
    ? [workspaceId, options.spaceId]
    : [workspaceId];
  if (!query) {
    if (!["all", "document", "database"].includes(kind)) return [];
    for (const page of all<Page>(
      `SELECT p.* FROM pages p WHERE ${scope} ORDER BY p.updated_at DESC LIMIT 500`,
      ...scopeArgs,
    )) {
      if (page.synced || !allowed(page) || !matchesKind(page, "")) continue;
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
