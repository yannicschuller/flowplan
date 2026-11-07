// The full-text index's storage and matching, for both databases
// (docs/architecture/database.md, §5a "Search"). lib/search-index.ts decides
// what goes into the index and how results are filtered; this module is
// the one place that knows how entries are kept and found.
//
// SQLite: the FTS5 table `search_index` (trigram tokenizer, diacritics
// removed), ranked by BM25 with the title ten times the body – unchanged.
//
// PostgreSQL: the same semantics with Postgres' own means.
//   - Each entry keeps its title and text folded (lower case, without
//     diacritics: foldText below, the one folding function of the query,
//     the stored text and the snippets).
//   - A phrase matches where the folded title or text contains it – what
//     FTS5's trigram tokenizer finds: parts of words (German compounds,
//     "plan" in "Projektplan"), Chinese and Japanese without spaces, any
//     language without stemming. pg_trgm's GIN indexes (gin_trgm_ops) serve
//     these LIKE '%…%' lookups; without the extension the same query scans.
//   - Ranked by BM25 as FTS5 computes it: per phrase its frequency (title
//     occurrences × 10 + text occurrences), saturated with k1 = 1.2 and
//     normalised by the entry's length against the average (b = 0.75),
//     weighted by the phrase's IDF when there are several phrases.
//   - Snippets: a window of the text around the first hit, cut and marked
//     in JavaScript (about 40 characters, as FTS5's snippet()).
// A word-based `tsvector` cannot do this (it finds neither parts of words
// nor words of scripts without spaces), so the decision of #127 to use one
// gave way to trigrams; see the design document.
import { all, inTransaction, one, run, sql } from "./db";
import { db } from "./db-driver";
import { createTableSql, columnDdl, quoteIdent } from "./db-driver/pg-ddl.mjs";
import schemaJson from "./db-driver/postgres-schema.json";
import type { PgSchema } from "./db-driver/pg-schema";
import { extensionSchema } from "./pg-extensions";

type Param = string | number | null;

// Lower case without diacritics, character by character: `map[i]` is the
// index in the original text of the folded text's character i.
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(i);
  return { folded, map };
}
export const foldText = (text: string) => foldWithMap(text).folded;
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const likePattern = (phrase: string) => `%${escapeLike(foldText(phrase))}%`;

// ---- PostgreSQL structures ----

const runtime = globalThis as typeof globalThis & {
  flowplanSearchStore?: { trigram: boolean; changed: number; stats: { entries: number; avgLength: number; at: number } };
};
const state = (runtime.flowplanSearchStore ??= { trigram: false, changed: 0, stats: { entries: 0, avgLength: 0, at: 0 } });

// What the search needs in PostgreSQL besides the translated schema, made
// when the database opens (lib/db.ts, dbContext.hooks.open) and after a
// restore: the table (a database made by an older version may lack it),
// the entry length BM25 normalises by (a generated column: filled for the
// entries of the stop-gap table of phase 2 as well), pg_trgm and its
// indexes. Idempotent; serialised between instances by an advisory lock.
// Returns whether the trigram indexes are there.
export async function ensureSearchStore(): Promise<boolean> {
  if (sql.name === "sqlite") return false;
  const table = (schemaJson as unknown as PgSchema).tables.find((t) => t.name === "search_index")!;
  await db.tx(
    async () => {
      await db.exec(createTableSql(table));
      const have = new Set(await db.columns("search_index"));
      for (const c of table.columns) if (!have.has(c.name)) await db.exec(`ALTER TABLE search_index ADD COLUMN ${columnDdl(c)}`);
      await db.exec("CREATE INDEX IF NOT EXISTS search_index_key ON search_index(page_id,row_id)");
      if (!have.has("doc_length"))
        await db.exec("ALTER TABLE search_index ADD COLUMN IF NOT EXISTS doc_length integer GENERATED ALWAYS AS (char_length(title_folded)+char_length(body_folded)) STORED");
      const ext = await extensionSchema("pg_trgm");
      state.trigram = !!ext;
      if (ext) {
        const ops = `${quoteIdent(ext)}.gin_trgm_ops`;
        await db.exec(`CREATE INDEX IF NOT EXISTS search_index_title_trgm ON search_index USING gin (title_folded ${ops})`);
        await db.exec(`CREATE INDEX IF NOT EXISTS search_index_body_trgm ON search_index USING gin (body_folded ${ops})`);
      } else console.warn("Search: pg_trgm is not available – the search works, but scans the index instead of using trigram indexes.");
    },
    { lock: "flowplan:search-store" },
  );
  return state.trigram;
}

// BM25 needs the number of entries and their average length. Counted by
// the indexer before it reads (refreshSearchStats, outside any transaction)
// every ten minutes, and sooner when a tenth of the index changed since (a
// rebuild); until the first count sensible defaults. Only the normalisation
// and the IDF of several phrases depend on them.
const STATS_TTL = 10 * 60_000;
export async function refreshSearchStats(force = false) {
  if (sql.name === "sqlite" || inTransaction()) return;
  const stale = state.stats.at <= Date.now() - STATS_TTL || state.changed > Math.max(20, state.stats.entries / 10);
  if (!force && !stale) return;
  state.stats.at = Date.now();
  state.changed = 0;
  const row = await one<{ n: number; len: number | null }>("SELECT count(*) n,avg(doc_length)::float8 len FROM search_index");
  state.stats.entries = Number(row?.n || 0);
  state.stats.avgLength = Number(row?.len || 0);
}
const stats = () => ({ entries: Math.max(1, state.stats.entries || 1000), avgLength: Math.max(1, state.stats.avgLength || 1000) });

// ---- Writing ----

// The entry of a page (key "") or of a record, comment, message or file.
export async function removeEntry(pageId: string, key: string) {
  if (sql.name === "sqlite")
    // Through the content table (c0 = page_id, c1 = row_id) and its index
    // (lib/db.ts) instead of `WHERE page_id=? AND row_id=?` on the index
    // itself, which reads every entry.
    await run("DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_content WHERE c0=? AND c1=?)", pageId, key); // sqlite-only
  else await run("DELETE FROM search_index WHERE page_id=? AND row_id=?", pageId, key);
}
export async function addEntry(pageId: string, key: string, title: string, body: string) {
  if (sql.name === "sqlite") await run("INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)", pageId, key, title, body);
  else {
    state.changed++;
    await run(
      "INSERT INTO search_index(page_id,row_id,title,body,title_folded,body_folded) VALUES(?,?,?,?,?,?)",
      pageId,
      key,
      title,
      body,
      foldText(title),
      foldText(body),
    );
  }
}
export async function clearIndex() {
  await run("DELETE FROM search_index");
}
export async function removePages(pageIds: string[]) {
  for (let i = 0; i < pageIds.length; i += 500) {
    const batch = pageIds.slice(i, i + 500);
    await run(`DELETE FROM search_index WHERE page_id IN (${batch.map(() => "?").join(",")})`, ...batch);
  }
}

// ---- Matching and ranking ----

// The last key of an ORDER BY over search_index (alias s), for equal
// ranks: the order the entries went in, as FTS5 returns them on SQLite.
export const entryOrder = () => (sql.name === "sqlite" ? "" : ",s.id");

// Entries (alias `s` of search_index) that contain one of the phrases
// (any of them; three characters or more each). Build the query as
//   SELECT … [snippet.sql] FROM search_index s … WHERE ${m.where} AND …
//   ORDER BY ${m.rank}
// with the arguments in that order: snippet.args, whereArgs, …, rankArgs.
export type TextMatch = { where: string; whereArgs: Param[]; rank: string; rankArgs: Param[] };
export function textMatch(phrases: string[], options: { titleOnly?: boolean } = {}): TextMatch {
  if (sql.name === "sqlite") {
    const query = phrases.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    return {
      where: "search_index MATCH ?",
      whereArgs: [options.titleOnly ? `title : (${query})` : query],
      rank: "bm25(search_index,0,0,10,1)",
      rankArgs: [],
    };
  }
  const titleOnly = !!options.titleOnly;
  const folded = phrases.map(foldText);
  const patterns = phrases.map(likePattern);
  const title = "s.title_folded LIKE ? ESCAPE '\\'";
  const body = "s.body_folded LIKE ? ESCAPE '\\'";
  const { entries, avgLength } = stats();
  // Occurrences of a phrase in a column: what replace() takes out of it.
  const occurrences = (column: string) => `(char_length(${column})-char_length(replace(${column},?,'')))/?::float8`;
  const frequency = titleOnly ? `10*${occurrences("s.title_folded")}` : `10*${occurrences("s.title_folded")}+${occurrences("s.body_folded")}`;
  // (Lengths in code points, as char_length counts.)
  const frequencyArgs = (f: string): Param[] => (titleOnly ? [f, [...f].length] : [f, [...f].length, f, [...f].length]);
  // FTS5's IDF, log((N - n + 0.5) / (n + 0.5)), at least 1e-6; n counted
  // up to 10,000 entries (an index scan, not the whole table). One phrase
  // alone: the same factor for every entry, left out.
  const several = phrases.length > 1;
  const idf = `(SELECT greatest(ln((?::float8-n+0.5)/(n+0.5)),1e-6) FROM (SELECT count(*) n FROM (SELECT 1 FROM search_index x WHERE x.title_folded LIKE ? ESCAPE '\\'${titleOnly ? "" : " OR x.body_folded LIKE ? ESCAPE '\\'"} LIMIT 10000) y) z)`;
  const idfArgs = (p: string): Param[] => (titleOnly ? [entries, p] : [entries, p, p]);
  // BM25 per phrase: f·(k1+1) / (f + k1·(1 − b + b·length/average)).
  // (Parameters in the order of the text: the average length, then the
  // frequency's.)
  const score = () =>
    `(SELECT CASE WHEN f>0 THEN f*2.2/(f+1.2*(0.25+0.75*s.doc_length/?::float8)) ELSE 0 END FROM (SELECT ${frequency} f) q)${several ? `*${idf}` : ""}`;
  return {
    where: `(${patterns.map(() => (titleOnly ? title : `${title} OR ${body}`)).join(" OR ")})`,
    whereArgs: patterns.flatMap((p) => (titleOnly ? [p] : [p, p])),
    // Ascending like bm25(): the best first.
    rank: `-(${phrases.map(() => score()).join("+")})`,
    rankArgs: phrases.flatMap((_, i) => [avgLength, ...frequencyArgs(folded[i]), ...(several ? idfArgs(patterns[i]) : [])]),
  };
}

// The snippet of the text around the first hit, the hits between `start`
// and `end` markers ("" when the text has none). `finish` turns the
// selected value into the snippet. PostgreSQL selects a window of the text
// around the first hit (not the whole text, up to 400,000 characters) with
// a mark for what was cut off on either side.
const CUT = "\u0001";
export function snippet(phrases: string[], start: string, end: string): { sql: string; args: Param[]; finish: (value: string) => string } {
  if (sql.name === "sqlite") return { sql: "snippet(search_index,3,?,?,'…',40)", args: [start, end], finish: (value) => value };
  const at = `COALESCE(LEAST(${phrases.map(() => "NULLIF(strpos(s.body_folded,?),0)").join(",")}),0)`;
  // The folded text can be a little shorter or longer than the text (a
  // decomposed accent, a letter whose lower case is two): the window has a
  // margin on both sides.
  return {
    sql: `(SELECT CASE WHEN p=0 THEN '' ELSE (CASE WHEN p>200 THEN chr(1) ELSE '' END)||substr(s.body,greatest(1,p-200),800)||(CASE WHEN char_length(s.body)>=p+600 THEN chr(1) ELSE '' END) END FROM (SELECT ${at} p) w)`,
    args: phrases.map(foldText),
    finish: (value) => {
      const text = value || "";
      const before = text.startsWith(CUT),
        after = text.length > 1 && text.endsWith(CUT);
      return cutSnippet(text.slice(before ? 1 : 0, after ? -1 : undefined), phrases, start, end, before, after);
    },
  };
}
// The window FTS5's snippet(…, 40) picks with the trigram tokenizer (one
// token per character position, three characters each), ported from
// fts5SnippetFunction: for each hit the 40 tokens centred on the hits they
// hold, or the window starting at the sentence before it (a bonus of 100,
// 120 at the start of the text); a window scores 1000 per phrase it holds
// and 1 per further hit; the best wins, the first of equals. Every hit
// inside it is marked; "…" where the text goes on.
const WINDOW_TOKENS = 40;
function cutSnippet(text: string, phrases: string[], start: string, end: string, cutBefore = false, cutAfter = false) {
  const { folded, map } = foldWithMap(text);
  const hits: { at: number; tokens: number; phrase: number }[] = [];
  phrases.forEach((p, phrase) => {
    const w = foldText(p);
    if (w) for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + 1)) hits.push({ at, tokens: Math.max(1, [...w].length - 2), phrase });
  });
  if (!hits.length) return "";
  hits.sort((a, b) => a.at - b.at);
  // (Cut off after the window: the text goes on.)
  const docTokens = cutAfter ? Number.MAX_SAFE_INTEGER : Math.max(0, folded.length - 2);
  const score = (from: number) => {
    const seen = new Set<number>();
    let total = 0,
      first = -1,
      last = -1;
    for (const h of hits)
      if (h.at >= from && h.at < from + WINDOW_TOKENS) {
        total += seen.has(h.phrase) ? 1 : 1000;
        seen.add(h.phrase);
        if (first < 0) first = h.at;
        last = h.at + h.tokens - 1;
      }
    let adjusted = first - Math.floor((WINDOW_TOKENS - (last - first)) / 2);
    if (adjusted + WINDOW_TOKENS > docTokens) adjusted = docTokens - WINDOW_TOKENS;
    return { total, adjusted: Math.max(0, adjusted) };
  };
  // Sentence starts: after ".", ":" and white space, and the text's start.
  const sentences = [0];
  for (let i = 1; i < folded.length; i++)
    if (/\s/.test(folded[i - 1]) && !/\s/.test(folded[i])) {
      let k = i - 1;
      while (k >= 0 && /\s/.test(folded[k])) k--;
      if (k >= 0 && (folded[k] === "." || folded[k] === ":")) sentences.push(i);
    }
  let best = 0,
    from = 0;
  for (const h of hits) {
    const centred = score(h.at);
    if (centred.total > best) [best, from] = [centred.total, centred.adjusted];
    let j = 0;
    while (j < sentences.length - 1 && sentences[j + 1] <= h.at) j++;
    if (sentences[j] < h.at) {
      const sentence = score(sentences[j]).total + (sentences[j] === 0 ? 120 : 100);
      if (sentence > best) [best, from] = [sentence, sentences[j]];
    }
  }
  const to = Math.min(folded.length, from + WINDOW_TOKENS + 2);
  let out = from > 0 || cutBefore ? "…" : "";
  let cursor = from;
  // A hit that crosses the window's edge is marked up to it (as FTS5 does).
  for (const h of hits) {
    const a = Math.max(h.at, cursor),
      b = Math.min(h.at + h.tokens + 2, to);
    if (a >= b) continue;
    out += text.slice(map[cursor], map[a]) + start + text.slice(map[a], map[b]) + end;
    cursor = b;
  }
  out += text.slice(map[cursor], map[to]) + (to < folded.length || cutAfter ? "…" : "");
  return out;
}

// For the administration and tests: how the PostgreSQL search runs.
export async function searchStoreInfo() {
  if (sql.name === "sqlite") return { backend: "sqlite" as const, trigram: false, entries: Number((await one<{ n: number }>("SELECT count(*) n FROM search_index"))?.n || 0) };
  const indexes = await all<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='search_index'");
  return {
    backend: "postgres" as const,
    trigram: indexes.some((i) => i.indexname === "search_index_body_trgm"),
    entries: Number((await one<{ n: number }>("SELECT count(*) n FROM search_index"))?.n || 0),
  };
}
