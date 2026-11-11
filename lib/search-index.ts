import { isEncryptedPage } from "./e2ee-server";
import { lockedPageIds } from "./journal-extras";
import { publicHiddenFieldIds } from "./field-access";
import { hiddenFileIds } from "./row-files";
import { all, one, run, sql, transaction } from "./db";
import { addEntry, clearIndex, entryOrder, refreshSearchStats, removeEntry, snippet, textMatch } from "./search-store";
import { isGuest, pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { ticketId } from "./ticket-ids";
import { isFormattedText, toPlain } from "./inline-markdown";
import type { Field, Identity, Page } from "./types";
import { footnoteTexts } from "./footnotes";
import { matchedAlias, pageAliases, recordAliases } from "./aliases";
import { pageInkSearchText } from "./page-ink-store";
import { parseRecognizedMap } from "./ink/recognized";
import { filteredPageIds, pageMetaSearchText, visibleScopes, workspaceProperties, workspaceTags } from "./page-properties-server";
import { parseSearchTokens, tagFilterIds } from "./page-properties";
import { taggedRecords } from "./tag-fields";
import { isClassicQuery, parseQuery, type ItemType } from "./collection-query";
import { evaluateQuery } from "./collections";
import { isShortTerm } from "./ai/chunks";
import { isLeader } from "./cluster/leader";

// Full-text index over page titles, document text, record cells and record
// documents. Triggers (see db.ts) only mark changed pages/rows as dirty; the
// index is refreshed lazily before each search and by a background worker, so
// no write path needs to know about searching.
export const SEARCH_LIMIT = 50;
// Entries per transaction. The background drain yields to the event loop
// between batches, so a large backlog (an import of thousands of records)
// never holds up requests for more than one batch.
const BATCH = 100;
// What a search (or another reader of the index) refreshes itself before
// it runs; the rest is left to the background drain it starts.
const INLINE_LIMIT = 1000;
const IGNORED: Field["type"][] = [
  "relation",
  "person",
  "created_by",
  "updated_by",
  "formula",
  "rollup",
  "sprint",
];

// Aliases share the title column (and its weight), after this separator; a
// query never contains it (control characters are removed).
const ALIAS_SEPARATOR = "\u001f";
const titleColumn = (title: string, aliases: string[]) => [title, ...aliases].join(ALIAS_SEPARATOR);
const splitTitle = (column: string) => {
  const [title, ...aliases] = column.split(ALIAS_SEPARATOR);
  return { title, aliases };
};

// Marks inside a word ("<strong>Pro</strong>jektmappe", "H<sub>2</sub>O")
// leave it whole; every other tag separates words.
const INLINE_TAG = /<\/?(?:a|b|i|u|s|em|strong|span|mark|sub|sup|code)(?:\s[^>]*)?>/gi;
export function htmlText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(INLINE_TAG, "")
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
// The text of a document with its footnotes (kept in the markers).
export function documentText(html: string) {
  return [htmlText(html), ...footnoteTexts(html)].join(" ");
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

async function indexPage(pageId: string) {
  await removeEntry(pageId, "");
  const page = await one<{ title: string; aliases: string | null; html: string | null; deleted_at: string; kind: string }>(
    "SELECT p.title,p.aliases,p.deleted_at,p.kind,d.html FROM pages p LEFT JOIN documents d ON d.page_id=p.id WHERE p.id=?",
    pageId,
  );
  if (!page || page.deleted_at) return;
  // End-to-end encrypted pages stay out of the index (lib/e2ee-server.ts).
  if (await isEncryptedPage(await one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", pageId))) return;
  await addEntry(
    pageId,
    "",
    titleColumn(page.title, pageAliases(page)),
    // Handwriting: typed text and what the device recognised (notebook
    // sheets, drawing blocks still in the document).
    // Tags and property values (#70) as words of the page.
    [documentText(page.html || ""), await pageInkSearchText(pageId, page.kind, page.html || ""), await pageMetaSearchText(pageId)].filter(Boolean).join("\n").slice(0, 400000),
  );
}
async function indexRow(pageId: string, rowId: string, fields: Field[]) {
  await removeEntry(pageId, rowId);
  const row = await one<{ cells: string; content: string; html: string | null; number: number | null }>(
    "SELECT r.cells,r.content,r.number,d.html FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id WHERE r.id=? AND r.page_id=?",
    rowId,
    pageId,
  );
  if (!row) return;
  const cells = JSON.parse(row.cells) as Record<string, unknown>;
  // One index serves everyone: properties with a read rule (and what is
  // derived from them) are not indexed (lib/field-access.ts).
  const hidden = publicHiddenFieldIds(fields);
  const [titleField, ...rest] = fields.filter((f) => !hidden.has(f.id));
  const title = titleField ? cellWords(cells[titleField.id]) : "";
  const values = rest
    .filter((f) => !IGNORED.includes(f.type) && f.type !== "aliases")
    // Formatted text (#126) as the words people read, without "**" or "\\_".
    .map((f) => (f.type === "id" ? ticketId(f, row.number) : isFormattedText(f, fields) ? toPlain(cells[f.id]) : cellWords(cells[f.id])))
    .filter(Boolean);
  const content = row.html ?? row.content ?? "";
  await addEntry(
    pageId,
    rowId,
    titleColumn(title || "Ohne Titel", recordAliases(fields, cells)),
    [...values, content.startsWith("<") ? documentText(content) : content]
      .join(" · ")
      .slice(0, 400000),
  );
}

// Comments, text comment messages and attachments are indexed under
// prefixed keys (c:, m:, f:) next to pages and records.
async function indexExtra(pageId: string, key: string) {
  await removeEntry(pageId, key);
  if (await isEncryptedPage(await one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", pageId))) return;
  const [prefix, id] = [key.slice(0, 1), key.slice(2)];
  const entry =
    prefix === "c"
      ? (await one<{ title: string; body: string }>(
          "SELECT 'Kommentar von '||COALESCE(u.name,'Unbekannt') title,c.body FROM comments c LEFT JOIN users u ON u.id=c.author_id WHERE c.id=? AND c.page_id=?",
          id,
          pageId,
        ))
      : prefix === "m"
        ? (await one<{ title: string; body: string }>(
            "SELECT 'Textkommentar von '||m.author_name title,m.body FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE m.id=? AND t.page_id=? AND m.deleted=0",
            id,
            pageId,
          ))
        : (await one<{ title: string; body: string }>(
            "SELECT f.name title,f.name||' '||f.mime||COALESCE('\n'||t.text,'')||COALESCE('\n'||NULLIF(i.text,''),'') body FROM files f LEFT JOIN file_texts t ON t.file_id=f.id LEFT JOIN file_ink i ON i.file_id=f.id WHERE f.id=? AND f.page_id=? AND f.deleted_at IS NULL",
            id,
            pageId,
          ));
  if (!entry) return;
  // Handwriting on a PDF the device recognised (JSON: page → text).
  const recognized =
    prefix === "f" ? Object.values(parseRecognizedMap((await one<{ recognized: string }>("SELECT recognized FROM file_ink WHERE file_id=?", id))?.recognized)).join("\n") : "";
  await addEntry(
    pageId,
    key,
    entry.title.slice(0, 300),
    (recognized ? `${entry.body}\n${recognized}` : entry.body).slice(0, 100000),
  );
}
export async function ensureSearchIndex() {
  if (!(await one("SELECT 1 FROM search_meta WHERE key='extras'"))) {
    await transaction(async () => {
      await run(
        "INSERT INTO search_dirty SELECT page_id,'c:'||id FROM comments WHERE true ON CONFLICT DO NOTHING",
      );
      await run(
        "INSERT INTO search_dirty SELECT t.page_id,'m:'||m.id FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE true ON CONFLICT DO NOTHING",
      );
      await run(
        "INSERT INTO search_dirty SELECT page_id,'f:'||id FROM files WHERE page_id IS NOT NULL ON CONFLICT DO NOTHING",
      );
      await run("INSERT INTO search_meta(key) VALUES('extras')");
    });
  }
  if (!(await one("SELECT 1 FROM search_meta WHERE key='inline-marks'"))) {
    // Once: pages and records indexed while formatting split words
    // ("<strong>Pro</strong>jekt", htmlText) are indexed again.
    await transaction(async () => {
      await run("INSERT INTO search_dirty SELECT id,'' FROM pages WHERE true ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_dirty SELECT page_id,id FROM rows WHERE true ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_meta(key) VALUES('inline-marks')");
    });
  }
  if (!(await one("SELECT 1 FROM search_state WHERE id=1"))) {
    // A rebuild (a new database, a restore, a migrated or moved instance:
    // search_state emptied) indexes everything again – comments, messages
    // and files too, whose marker (search_meta) came along with the data.
    await transaction(async () => {
      await clearIndex();
      await run("INSERT INTO search_dirty SELECT id,'' FROM pages WHERE true ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_dirty SELECT page_id,id FROM rows WHERE true ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_dirty SELECT page_id,'c:'||id FROM comments WHERE true ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_dirty SELECT t.page_id,'m:'||m.id FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE true ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_dirty SELECT page_id,'f:'||id FROM files WHERE page_id IS NOT NULL ON CONFLICT DO NOTHING");
      await run("INSERT INTO search_state(id,built) VALUES(1,?)", Date.now());
    });
  }
}
// Returns the number of processed entries; call repeatedly until 0.
export async function processSearchIndex(limit = BATCH) {
  await ensureSearchIndex();
  // PostgreSQL's BM25 statistics, every few minutes (lib/search-store.ts).
  await refreshSearchStats();
  const dirty = await all<{ page_id: string; row_id: string }>(
    // In key order: a rebuild fills the index in the same order on both
    // databases (equal ranks keep that order).
    "SELECT page_id,row_id FROM search_dirty ORDER BY page_id,row_id LIMIT ?",
    limit,
  );
  if (!dirty.length) return 0;
  const fields = new Map<string, Field[]>();
  await transaction(async () => {
    for (const entry of dirty) {
      if (!entry.row_id) await indexPage(entry.page_id);
      else if (/^[cmf]:/.test(entry.row_id))
        await indexExtra(entry.page_id, entry.row_id);
      else {
        if (!fields.has(entry.page_id)) {
          const stored = await one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            entry.page_id,
          );
          fields.set(entry.page_id, stored ? JSON.parse(stored.fields) : []);
        }
        await indexRow(entry.page_id, entry.row_id, fields.get(entry.page_id)!);
      }
      // Handwriting and file texts (OCR, PDFs) are part of what the AI
      // reads of a page (lib/ai/sources.ts): its meaning search embeds the
      // page again (unchanged chunks keep their vectors).
      if (!entry.row_id || entry.row_id.startsWith("f:"))
        await run("INSERT INTO ai_embed_dirty(page_id,row_id) VALUES(?,'') ON CONFLICT DO NOTHING", entry.page_id);
      await run(
        "DELETE FROM search_dirty WHERE page_id=? AND row_id=?",
        entry.page_id,
        entry.row_id,
      );
    }
  });
  return dirty.length;
}

// At most this many short terms per scan: each one is an instr() over the
// titles and texts of the workspace's index.
const SHORT_TERMS = 4;

// Index entries (pages, records, comments, files) of a workspace that
// contain any of the terms (lib/ai/chunks.ts questionTerms), best first.
// Terms of three characters or more go through the trigram index, ranked by
// BM25; shorter ones (two-character Chinese, Japanese, Korean or Thai
// words, which MATCH cannot find) through a scan like the short search
// above, ranked by how many of them occur (in the title or the text), and follow the index's hits.
// `journalDays`: only journal days and the pages directly below one (a
// notebook of the day), with their files, newest day first – for "the last
// …" questions (lib/ai/ask.ts); only terms of three characters or more.
export const JOURNAL_DAY_SQL = "COALESCE(p.journal_date,(SELECT d.journal_date FROM pages d WHERE d.id=p.parent_id))";
export async function termMatches(
  workspaceId: string,
  terms: string[],
  options: { spaceId?: string; limit: number; journalDays?: boolean },
): Promise<{ page_id: string; row_id: string }[]> {
  const days = options.journalDays ? ` AND (s.row_id='' OR s.row_id LIKE 'f:%') AND ${JOURNAL_DAY_SQL} IS NOT NULL` : "";
  const scope = `p.workspace_id=? AND p.deleted_at IS NULL${options.spaceId ? " AND p.space_id=?" : ""}${days}`;
  const scopeArgs = [workspaceId, ...(options.spaceId ? [options.spaceId] : [])];
  const long = terms.filter((t) => !isShortTerm(t)),
    short = terms.filter(isShortTerm).slice(0, SHORT_TERMS);
  const match = textMatch(long);
  // Equal ranks (entries with the same text, as weekly journal days often
  // have): the newer day, then the newer edit first – not the order of the
  // random ids, which decided before which of them the AI got to read.
  const rows = long.length
    ? (await all<{ page_id: string; row_id: string }>(
        `SELECT s.page_id,s.row_id FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE ${match.where} AND ${scope}
         ORDER BY ${options.journalDays ? `${JOURNAL_DAY_SQL} DESC,` : ""}${match.rank},COALESCE(${JOURNAL_DAY_SQL},'') DESC,p.updated_at DESC${entryOrder()} LIMIT ${options.limit}`,
        ...match.whereArgs,
        ...scopeArgs,
        ...match.rankArgs,
      ))
    : [];
  if (short.length && rows.length < options.limit && !options.journalDays) {
    const seen = new Set(rows.map((r) => `${r.page_id}:${r.row_id}`));
    // A term in the title counts twice, as in BM25 above.
    const hits = short.map(() => `(CASE WHEN ${sql.instr("s.title", "?")}>0 THEN 2 ELSE 0 END)+(CASE WHEN ${sql.instr("s.body", "?")}>0 THEN 1 ELSE 0 END)`).join("+");
    for (const r of await all<{ page_id: string; row_id: string }>(
      `SELECT page_id,row_id FROM (SELECT s.page_id,s.row_id,${hits} n,p.updated_at FROM search_index s JOIN pages p ON p.id=s.page_id WHERE ${scope})
       WHERE n>0 ORDER BY n DESC,updated_at DESC LIMIT ${options.limit}`,
      ...short.flatMap((t) => [t, t]),
      ...scopeArgs,
    )) {
      if (rows.length >= options.limit) break;
      if (!seen.has(`${r.page_id}:${r.row_id}`)) rows.push(r);
    }
  }
  return rows;
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
  // The alias the query matched when the title did not ("Title · alias").
  alias?: string;
  // A hit on a journal day (its date): ranked after other pages.
  journalDate?: string;
};
// Snippet markers; the client renders text between them highlighted.
export const MARK_START = "\u0002",
  MARK_END = "\u0003";

export async function searchWorkspace(
  user: Identity,
  workspaceId: string,
  rawQuery: string,
  // excludeDays: "Ohne Journaltage" – no hits on journal days at all.
  options: { kind?: SearchKind; spaceId?: string; excludeDays?: boolean; timeZone?: string } = {},
): Promise<SearchResult[]> {
  // Keep the index current for this request; a large backlog is also
  // drained by the background worker.
  await refreshSearchIndex();
  // OR, NOT, parentheses, created_by:, created:, type:, in:, title: (#86,
  // lib/collection-query.ts): the pages and records that match, as a
  // collection finds them, latest change first. Queries the search knew
  // before keep their ranking and snippets below.
  const parsed = parseQuery(rawQuery.slice(0, 1000));
  if (!isClassicQuery(parsed.node)) return await queryResults(user, workspaceId, parsed.node, options);
  // `#tag`, `-#tag` and `name:value` keep the pages with these tags and
  // values (lib/page-properties.ts); the rest is searched as text.
  // A #name names the tags of that name the person may know, one per
  // space (#136).
  const visibleScope = await visibleScopes(user, workspaceId);
  const tokens = parseSearchTokens(rawQuery.replace(/[\u0000-\u001f]/g, " ").slice(0, 400), {
    tags: (await workspaceTags(workspaceId)).filter((t) => visibleScope(t.spaceId)),
    properties: (await workspaceProperties(workspaceId)).filter((p) => visibleScope(p.spaceId)),
  });
  const only = await filteredPageIds(user, workspaceId, tokens);
  // Records carry the tags of their tag-backed properties (#79) and those
  // of their database: #tag finds them, -#tag leaves them out.
  const records = tokens.tags.length ? (await taggedRecords(user, workspaceId)) : [];
  const recordTags = new Map(records.map((r) => [`${r.pageId}:${r.rowId}`, r.tags]));
  const pageTags = new Map<string, Set<string>>();
  if (tokens.tags.length)
    for (const link of await all<{ page_id: string; tag_id: string }>(
      "SELECT l.page_id,l.tag_id FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE t.workspace_id=?",
      workspaceId,
    ))
      (pageTags.get(link.page_id) ?? pageTags.set(link.page_id, new Set()).get(link.page_id)!).add(link.tag_id);
  const recordPasses = (pageId: string, rowId: string) => {
    if (!only) return true;
    if (tokens.properties.length && !only.has(pageId)) return false;
    const own = recordTags.get(`${pageId}:${rowId}`) ?? [];
    return tokens.tags.every((f) => tagFilterIds(f).some((tagId) => own.includes(tagId) || !!pageTags.get(pageId)?.has(tagId)) !== f.exclude);
  };
  const isRecordKey = (key: string) => !!key && !/^[cmf]:/.test(key);
  const tagged = records.filter((r) => recordPasses(r.pageId, r.rowId));
  // Databases whose records may pass, besides the pages that pass.
  const scoped = only ? new Set([...only, ...tagged.map((r) => r.pageId)]) : null;
  const query = tokens.text.trim().slice(0, 200);
  const kind = options.kind || "all";
  const roles = new Map<string, boolean>();
  // Journals behind a PIN stay out of the results until unlocked.
  const locked = await lockedPageIds(user, workspaceId);
  // Workflow pages are not for guests (#168).
  const guest = await isGuest(user, workspaceId);
  const allowed = async (page: Page) => {
    if (!roles.has(page.id))
      roles.set(page.id, !locked.has(page.id) && !(guest && page.kind === "workflow") && !!(await pageRole(user, page)));
    return roles.get(page.id)!;
  };
  const hitKind = (page: Page, key: string) =>
    key.startsWith("c:") || key.startsWith("m:")
      ? ("comment" as const)
      : key.startsWith("f:")
        ? ("file" as const)
        : key
          ? ("row" as const)
          : page.kind === "journal" || page.kind === "dashboard" || page.kind === "notebook" || page.kind === "workflow"
            ? ("document" as const)
            : page.kind;
  const matchesKind = (page: Page, key: string) =>
    kind === "all" || hitKind(page, key) === kind;
  // Comments on records open the record.
  const recordOf = async (key: string) =>
    key.startsWith("c:")
      ? (await one<{ row_id: string | null }>(
          "SELECT row_id FROM comments WHERE id=?",
          key.slice(2),
        ))?.row_id || undefined
      : key.startsWith("m:")
        ? (await one<{ row_id: string | null }>(
            "SELECT t.row_id FROM inline_messages m JOIN inline_threads t ON t.id=m.thread_id WHERE m.id=?",
            key.slice(2),
          ))?.row_id || undefined
        : key.startsWith("f:")
          ? undefined
          : key || undefined;
  // Journal days come after everything else (a journal has hundreds).
  const results: SearchResult[] = [],
    days: SearchResult[] = [];
  const done = () => results.length >= SEARCH_LIMIT;
  const finish = () => [...results, ...days].slice(0, SEARCH_LIMIT);
  const hidden = new Map<string, Set<string>>(),
    hiddenFiles = new Map<string, Set<string>>();
  const push = async (hit: Page, key: string, column: string, snippet: string) => {
    let page = hit;
    let { title, aliases } = splitTitle(column);
    if (!key) aliases = pageAliases(hit);
    // Text of a synced block leads to the page it was created on.
    if (page.synced) {
      const origin = page.parent_id
        ? (await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", page.parent_id))
        : undefined;
      if (!origin || !(await allowed(origin)) || results.some((r) => r.id === origin.id && !r.rowId)) return;
      page = origin;
      title = origin.title;
      aliases = [];
    }
    const rowId = await recordOf(key),
      type = hitKind(page, key);
    // With tag or property tokens: pages (and their comments and files)
    // that pass, records whose own or database tags pass.
    if (only && (isRecordKey(key) ? !recordPasses(page.id, key) : !only.has(page.id))) return;
    // Records hidden by their own permissions do not appear, nor files
    // used only by them.
    if (rowId && page.kind === "database") {
      if (!hidden.has(page.id)) hidden.set(page.id, await hiddenRowIds(user, page));
      if (hidden.get(page.id)!.has(rowId)) return;
    }
    if (key.startsWith("f:") && page.kind === "database") {
      if (!hiddenFiles.has(page.id)) hiddenFiles.set(page.id, await hiddenFileIds(user, page));
      if (hiddenFiles.get(page.id)!.has(key.slice(2))) return;
    }
    const alias = matchedAlias(key ? title : page.title, aliases, query);
    const day = page.journal_date || null;
    if (day && options.excludeDays) return;
    if (day && days.length >= SEARCH_LIMIT) return;
    (day ? days : results).push({
      id: page.id,
      ...(rowId ? { rowId } : {}),
      ...(key ? { pageTitle: page.title } : {}),
      title: key ? title : page.title,
      // Records their own icon (#96); empty: the client's record symbol.
      icon: type === "row" && rowId ? (await one<{ icon: string | null }>("SELECT icon FROM rows WHERE id=?", rowId))?.icon || "" : page.icon,
      space_id: page.space_id,
      kind: type,
      snippet,
      ...(alias ? { alias } : {}),
      ...(day ? { journalDate: day } : {}),
    });
  };
  const scope =
    "p.workspace_id=? AND p.deleted_at IS NULL" +
    (options.spaceId ? " AND p.space_id=?" : "") +
    (scoped ? ` AND p.id IN ${sql.jsonValues()}` : "");
  const scopeArgs = [workspaceId, ...(options.spaceId ? [options.spaceId] : []), ...(scoped ? [JSON.stringify([...scoped])] : [])];
  if (!query) {
    if (!["all", "document", "database", ...(only ? ["whiteboard", "row"] : [])].includes(kind)) return [];
    for (const page of await all<Page>(
      `SELECT p.* FROM pages p WHERE ${scope} ORDER BY p.updated_at DESC LIMIT 500`,
      ...scopeArgs,
    )) {
      if (page.synced || !(await allowed(page)) || !matchesKind(page, "") || (only && !only.has(page.id))) continue;
      await push(page, "", page.title, "");
      if (done()) break;
    }
    // #tag alone: the records with the tag follow the pages.
    if ((kind === "all" || kind === "row") && tokens.tags.some((f) => !f.exclude)) {
      const databases = new Map<string, Page>();
      for (const r of tagged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        if (done()) break;
        if (options.spaceId && r.spaceId !== options.spaceId) continue;
        if (!databases.has(r.pageId)) databases.set(r.pageId, (await one<Page>("SELECT * FROM pages WHERE id=?", r.pageId))!);
        const page = databases.get(r.pageId)!;
        if (!(await allowed(page))) continue;
        await push(page, r.rowId, r.title || "Ohne Titel", "");
      }
    }
    return finish();
  }
  // Trigram matching finds parts of compound words and ignores case and
  // diacritics; shorter queries fall back to a title/body scan.
  const short = [...query].length < 3;
  const match = textMatch([query]);
  const snip = snippet([query], MARK_START, MARK_END);
  // SQLite's LIKE ignores the case of ASCII letters only: a short query (at
  // most two letters, so at most four spellings) is looked up in every mix
  // of lower and upper case, as ILIKE on PostgreSQL finds it.
  // Only for a short query: they double with every letter.
  const spellings = sql.name === "postgres" || !short
    ? [query]
    : [...new Set([...query].reduce((found, c) => {
        const cases = new Set([c, c.toLowerCase(), c.toUpperCase()].filter((v) => [...v].length === 1));
        return found.flatMap((start) => [...cases].map((v) => start + v));
      }, [""]))];
  const anyLike = (column: string) => `(${spellings.map(() => `${sql.ilike(column, "?")} ESCAPE '\\'`).join(" OR ")})`;
  const titleLike = anyLike("s.title");
  const candidates = (await all<
    Page & { row_id: string; hit_title: string; snippet: string }
  >(
    short
      ? `SELECT p.*,s.row_id,s.title hit_title,'' snippet FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE ${scope} AND (${titleLike} OR ${anyLike("s.body")})
         ORDER BY (CASE WHEN ${titleLike} THEN 1 ELSE 0 END) DESC,p.updated_at DESC${entryOrder()} LIMIT 1000`
      : `SELECT p.*,s.row_id,s.title hit_title,${snip.sql} snippet
         FROM search_index s JOIN pages p ON p.id=s.page_id
         WHERE ${match.where} AND ${scope}
         ORDER BY ${match.rank},p.updated_at DESC${entryOrder()} LIMIT 1000`,
    ...(short
      ? (() => {
          const like = spellings.map((v) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
          return [...scopeArgs, ...like, ...like, ...like];
        })()
      : [...snip.args, ...match.whereArgs, ...scopeArgs, ...match.rankArgs]),
  )).map((hit) => (short ? hit : { ...hit, snippet: snip.finish(hit.snippet) }));
  for (const hit of candidates) {
    if (!matchesKind(hit, hit.row_id) || !(await allowed(hit))) continue;
    await push(
      hit,
      hit.row_id,
      hit.hit_title,
      hit.snippet.includes(MARK_START) ? hit.snippet : "",
    );
    if (done()) break;
  }
  return finish();
}

async function queryResults(
  user: Identity,
  workspaceId: string,
  node: Awaited<ReturnType<typeof parseQuery>>["node"],
  options: { kind?: SearchKind; spaceId?: string; excludeDays?: boolean; timeZone?: string },
): Promise<SearchResult[]> {
  const kind = options.kind || "all";
  if (kind === "comment" || kind === "file") return [];
  const types: ItemType[] | undefined = kind === "all" ? undefined : [kind === "row" ? "record" : kind];
  const { items } = await evaluateQuery(user, workspaceId, node, {
    types,
    spaceId: options.spaceId,
    timeZone: options.timeZone,
    excludeDays: options.excludeDays,
    limit: SEARCH_LIMIT,
  });
  return items.map((item) => ({
    id: item.pageId,
    ...(item.rowId ? { rowId: item.rowId, pageTitle: item.database ?? "" } : {}),
    title: item.title,
    icon: item.icon,
    space_id: item.spaceId,
    kind: item.type === "record" ? "row" : item.type === "database" || item.type === "whiteboard" ? item.type : "document",
    snippet: "",
    ...(item.journalDate ? { journalDate: item.journalDate } : {}),
  }));
}

const runtime = globalThis as typeof globalThis & {
  flowplanSearchTimer?: ReturnType<typeof setInterval>;
  flowplanSearchDrain?: Promise<void>;
};
// Works through the whole backlog in batches, letting other work run in
// between. One drain at a time; a call during a drain joins it.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
export function drainSearchIndex(): Promise<void> {
  if (runtime.flowplanSearchDrain) return runtime.flowplanSearchDrain;
  const drain = (async () => {
    await nextTurn();
    try {
      while (await processSearchIndex()) await nextTurn();
    } catch (error) {
      console.error("Search indexing failed", error);
    }
  })().finally(() => {
    runtime.flowplanSearchDrain = undefined;
  });
  runtime.flowplanSearchDrain = drain;
  return drain;
}
// Brings the index up to date before it is read: right away for what a
// few edits leave behind, a large backlog only in part (INLINE_LIMIT) – the
// background drain takes over the rest instead of one request stalling the
// server for seconds.
export async function refreshSearchIndex() {
  for (let done = 0; done < INLINE_LIMIT; ) {
    const n = await processSearchIndex(Math.min(BATCH, INLINE_LIMIT - done));
    if (!n) return;
    done += n;
  }
  void drainSearchIndex();
}
export function startSearchWorker() {
  if (runtime.flowplanSearchTimer) return;
  // Cluster mode: the leader only (lib/cluster/leader.ts).
  const tick = () => void (isLeader() && drainSearchIndex());
  runtime.flowplanSearchTimer = setInterval(tick, 5000);
  runtime.flowplanSearchTimer.unref();
  tick();
}
