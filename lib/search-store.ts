// The full-text index's storage and matching, for both databases
// (docs/architecture/database.md, "Search"). lib/search-index.ts decides
// what goes into the index and how results are filtered; this module is
// the one place that knows how entries are kept and found.
//
// SQLite: the FTS5 table `search_index` (trigram tokenizer, diacritics
// removed), ranked by BM25 with the title ten times the body – unchanged.
// PostgreSQL (until the tsvector design): a plain table with each entry's
// title and text also folded (lower case, without diacritics); a phrase
// matches where the folded text contains it, as the trigram index does;
// ranked by where the phrases occur (title 10, text 1); snippets are cut
// in JavaScript.
import { run, sql } from "./db";

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
const likePattern = (phrase: string) => `%${foldText(phrase).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// The entry of a page (key "") or of a record, comment, message or file.
export function removeEntry(pageId: string, key: string) {
  if (sql.name === "sqlite")
    // Through the content table (c0 = page_id, c1 = row_id) and its index
    // (lib/db.ts) instead of `WHERE page_id=? AND row_id=?` on the index
    // itself, which reads every entry.
    run("DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_content WHERE c0=? AND c1=?)", pageId, key); // sqlite-only
  else run("DELETE FROM search_index WHERE page_id=? AND row_id=?", pageId, key);
}
export function addEntry(pageId: string, key: string, title: string, body: string) {
  if (sql.name === "sqlite") run("INSERT INTO search_index(page_id,row_id,title,body) VALUES(?,?,?,?)", pageId, key, title, body);
  else
    run(
      "INSERT INTO search_index(page_id,row_id,title,body,title_folded,body_folded) VALUES(?,?,?,?,?,?)",
      pageId,
      key,
      title,
      body,
      foldText(title),
      foldText(body),
    );
}
export function clearIndex() {
  run("DELETE FROM search_index");
}
export function removePages(pageIds: string[]) {
  for (let i = 0; i < pageIds.length; i += 500) {
    const batch = pageIds.slice(i, i + 500);
    run(`DELETE FROM search_index WHERE page_id IN (${batch.map(() => "?").join(",")})`, ...batch);
  }
}

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
  const patterns = phrases.map(likePattern);
  const title = "s.title_folded LIKE ? ESCAPE '\\'";
  const body = "s.body_folded LIKE ? ESCAPE '\\'";
  return {
    where: `(${patterns.map(() => (options.titleOnly ? title : `${title} OR ${body}`)).join(" OR ")})`,
    whereArgs: patterns.flatMap((p) => (options.titleOnly ? [p] : [p, p])),
    // Ascending like bm25: the best first.
    rank: `-(${patterns.map(() => `(CASE WHEN ${title} THEN 10 ELSE 0 END)+(CASE WHEN ${body} THEN 1 ELSE 0 END)`).join("+")})`,
    rankArgs: patterns.flatMap((p) => [p, p]),
  };
}

// The snippet of the text around the first hit, the hits between `start`
// and `end` markers ("" when the text has none). `finish` turns the
// selected value into the snippet (Postgres selects the text).
export function snippet(phrases: string[], start: string, end: string): { sql: string; args: Param[]; finish: (value: string) => string } {
  if (sql.name === "sqlite") return { sql: "snippet(search_index,3,?,?,'…',40)", args: [start, end], finish: (value) => value };
  return { sql: "s.body", args: [], finish: (value) => cutSnippet(value || "", phrases, start, end) };
}
// About 40 characters around the first hit (FTS5's snippet counts trigram
// tokens, about one per character), with every hit inside it marked.
function cutSnippet(text: string, phrases: string[], start: string, end: string) {
  const { folded, map } = foldWithMap(text);
  const wanted = phrases.map(foldText).filter(Boolean);
  const hits: [number, number][] = [];
  for (const w of wanted)
    for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) hits.push([at, at + w.length]);
  if (!hits.length) return "";
  hits.sort((a, b) => a[0] - b[0]);
  const first = hits[0][0];
  const from = Math.max(0, first - 15);
  const to = Math.min(folded.length, Math.max(from + 40, hits[0][1]));
  let out = from > 0 ? "…" : "";
  let cursor = from;
  for (const [a, b] of hits) {
    if (a < cursor || b > to) continue;
    out += text.slice(map[cursor], map[a]) + start + text.slice(map[a], map[b]) + end;
    cursor = b;
  }
  out += text.slice(map[cursor], map[to]) + (to < folded.length ? "…" : "");
  return out;
}
