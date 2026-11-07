import { postgresUrl } from "./context";

// What differs between SQLite and PostgreSQL SQL, as small helpers that
// return SQL fragments. Code that runs on both writes
//   `SELECT id FROM page_tags WHERE ${d.ieq("name")}`
// instead of `name=? COLLATE NOCASE`. Only identifiers and fixed SQL go
// into these helpers, never values: values stay `?` parameters.

export type Dialect = {
  name: "sqlite" | "postgres";
  // `col = ?` ignoring case. SQLite NOCASE folds ASCII only; lower() in
  // Postgres folds every letter (Ä = ä), a small widening.
  ieq(column: string, param?: string): string;
  // ORDER BY … ignoring case.
  nocase(expr: string): string;
  // `INSERT OR IGNORE INTO <rest>` → `INSERT INTO <rest> ON CONFLICT DO NOTHING`.
  insertIgnore(rest: string): string;
  // `INSERT OR REPLACE INTO t(cols) VALUES(?…)` → an upsert on `keys`.
  // Postgres updates the row in place, SQLite deletes and re-inserts it
  // (ON DELETE CASCADE children go!) – so prefer this upsert on both.
  upsert(table: string, columns: string[], keys: string[]): string;
  // `a IS NOT ?` (null-safe inequality).
  isNot(column: string, param?: string): string;
  // The values of a JSON array parameter, as a subquery: `id IN ${d.jsonValues()}`.
  jsonValues(param?: string): string;
  // A text value at a JSON path ('$.a.b').
  jsonText(column: string, path: string): string;
  // The current time as SQLite's CURRENT_TIMESTAMP text ('YYYY-MM-DD HH:MM:SS', UTC).
  nowText(): string;
  // Current time + a modifier ('-7 days', '+1 hour') in that text form.
  nowTextPlus(modifier: string): string;
  // Milliseconds since 1970 (unixepoch()*1000).
  nowMs(): string;
  // Milliseconds since 1970 of a 'YYYY-MM-DD HH:MM:SS' text column (UTC).
  // An unreadable text gives NULL on SQLite and an error on Postgres.
  textMs(column: string): string;
  // Scalar max/min of several values (SQLite's multi-argument max()).
  greatest(...values: string[]): string;
  least(...values: string[]): string;
  // 32 random hex digits (SQLite: lower(hex(randomblob(16)))).
  randomHex(): string;
  // LIKE ignoring ASCII case (SQLite's LIKE does, Postgres' does not).
  ilike(column: string, param?: string): string;
  // A string literal's position in another (instr).
  instr(haystack: string, needle: string): string;
  // The text value of a top-level key of a JSON text column, the key a
  // parameter (`json_extract(c,'$."key"')`).
  jsonKey(column: string, param?: string): string;
  // A JSON array text of the values of a group (json_group_array; '[]'
  // for none).
  jsonGroupArray(expr: string): string;
  // A JSON object text from key/value pairs (json_object).
  jsonObject(...pairs: string[]): string;
  // The values of a group joined by commas (GROUP_CONCAT).
  groupConcat(expr: string, distinct?: boolean): string;
  // The day ('YYYY-MM-DD') of a 'YYYY-MM-DD HH:MM:SS' text, moved by a
  // modifier parameter ('+3600 seconds').
  dayOf(column: string, modifier?: string): string;
  // The same for milliseconds since 1970.
  dayOfMs(column: string, modifier?: string): string;
};

const modifier = (m: string) => {
  if (!/^[+-]?\d+(\.\d+)? (second|minute|hour|day|month|year)s?$/.test(m)) throw new Error(`Unsupported time modifier: ${m}`);
  return m;
};
const jsonPath = (path: string) => {
  if (!/^\$(\.[A-Za-z0-9_]+)+$/.test(path)) throw new Error(`Unsupported JSON path: ${path}`);
  return path;
};

export const sqliteDialect: Dialect = {
  name: "sqlite",
  // lower() on both sides on both databases (decided for #127): SQLite's
  // lower() folds ASCII only, exactly what NOCASE compared.
  ieq: (c, p = "?") => `lower(${c})=lower(${p})`,
  nocase: (e) => `lower(${e})`,
  insertIgnore: (rest) => `INSERT OR IGNORE INTO ${rest}`,
  upsert: (t, cols, keys) =>
    `INSERT INTO ${t}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")}) ON CONFLICT(${keys.join(",")}) DO ${
      cols.some((c) => !keys.includes(c))
        ? `UPDATE SET ${cols.filter((c) => !keys.includes(c)).map((c) => `${c}=excluded.${c}`).join(",")}`
        : "NOTHING"
    }`,
  // SQLite reads IS DISTINCT FROM since 3.39 (an alias of IS NOT).
  isNot: (c, p = "?") => `${c} IS DISTINCT FROM ${p}`,
  jsonValues: (p = "?") => `(SELECT value FROM json_each(${p}))`,
  jsonText: (c, path) => `json_extract(${c},'${jsonPath(path)}')`,
  nowText: () => "CURRENT_TIMESTAMP",
  nowTextPlus: (m) => `datetime('now','${modifier(m)}')`,
  nowMs: () => "(unixepoch()*1000)",
  textMs: (c) => `CAST(strftime('%s', ${c}) AS INTEGER) * 1000`,
  greatest: (...v) => `MAX(${v.join(",")})`,
  least: (...v) => `MIN(${v.join(",")})`,
  randomHex: () => "lower(hex(randomblob(16)))",
  ilike: (c, p = "?") => `${c} LIKE ${p}`,
  instr: (h, n) => `instr(${h},${n})`,
  jsonKey: (c, p = "?") => `json_extract(${c},'$."'||${p}||'"')`,
  jsonGroupArray: (e) => `json_group_array(${e})`,
  jsonObject: (...pairs) => `json_object(${pairs.join(",")})`,
  groupConcat: (e, distinct) => `GROUP_CONCAT(${distinct ? "DISTINCT " : ""}${e})`,
  dayOf: (c, m = "?") => `date(${c},${m})`,
  dayOfMs: (c, m = "?") => `date(${c}/1000,'unixepoch',${m})`,
};

const PG_TEXT_TIME = "'YYYY-MM-DD HH24:MI:SS'";
export const postgresDialect: Dialect = {
  name: "postgres",
  ieq: (c, p = "?") => `lower(${c})=lower(${p})`,
  nocase: (e) => `lower(${e})`,
  insertIgnore: (rest) => `INSERT INTO ${rest} ON CONFLICT DO NOTHING`,
  upsert: sqliteDialect.upsert,
  isNot: (c, p = "?") => `${c} IS DISTINCT FROM ${p}`,
  jsonValues: (p = "?") => `(SELECT json_array_elements_text(${p}::json))`,
  jsonText: (c, path) => `(${c}::jsonb #>> '{${jsonPath(path).slice(2).replace(/\./g, ",")}}')`,
  nowText: () => `to_char(now() AT TIME ZONE 'UTC',${PG_TEXT_TIME})`,
  nowTextPlus: (m) => `to_char(now() AT TIME ZONE 'UTC' + interval '${modifier(m)}',${PG_TEXT_TIME})`,
  nowMs: () => "(extract(epoch from clock_timestamp())*1000)::bigint",
  textMs: (c) => `(extract(epoch from (${c})::timestamp)*1000)::bigint`,
  greatest: (...v) => `greatest(${v.join(",")})`,
  least: (...v) => `least(${v.join(",")})`,
  randomHex: () => "replace(gen_random_uuid()::text,'-','')",
  ilike: (c, p = "?") => `${c} ILIKE ${p}`,
  instr: (h, n) => `strpos(${h},${n})`,
  jsonKey: (c, p = "?") => `(${c}::jsonb->>${p})`,
  jsonGroupArray: (e) => `coalesce(json_agg(${e}),'[]'::json)::text`,
  jsonObject: (...pairs) => `json_build_object(${pairs.join(",")})`,
  groupConcat: (e, distinct) => `string_agg(${distinct ? "DISTINCT " : ""}(${e})::text,',')`,
  dayOf: (c, m = "?") => `to_char((${c})::timestamp+(${m})::interval,'YYYY-MM-DD')`,
  dayOfMs: (c, m = "?") => `to_char(to_timestamp((${c})/1000.0) AT TIME ZONE 'UTC'+(${m})::interval,'YYYY-MM-DD')`,
};

// The dialect of the database this process uses, for code that builds SQL
// for the synchronous helpers of lib/db.ts (`one/all/run`): SQLite unless
// DATABASE_URL=postgres://… is set. `sql.ieq("name")` etc.
const active = (): Dialect => (postgresUrl() ? postgresDialect : sqliteDialect);
export const sql = Object.fromEntries(
  (Object.keys(sqliteDialect) as (keyof Dialect)[]).map((key) => [key, key === "name" ? undefined : (...args: string[]) => (active()[key] as (...a: string[]) => string)(...args)]),
) as unknown as Dialect;
Object.defineProperty(sql, "name", { get: () => active().name, enumerable: true });

// SQLite's CURRENT_TIMESTAMP as computed in JavaScript: 'YYYY-MM-DD HH:MM:SS'
// (UTC) for now or for a moment in milliseconds. Timestamps stay this text
// on both databases; queries take it as a parameter instead of calling a
// database function.
export const nowText = (ms: number = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
// The same text `days` days ago (SQLite: datetime('now','-N days')).
export const daysAgoText = (days: number) => nowText(Date.now() - days * 86_400_000);

// A write refused by a unique key (SQLite: "UNIQUE constraint failed";
// Postgres: SQLSTATE 23505). Under SQLite a check-then-insert never races
// (one writer at a time); under Postgres the key is the last word.
export function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; errcode?: number; message?: string } | null;
  return !!e && (e.code === "23505" || (typeof e.message === "string" && /UNIQUE constraint failed/.test(e.message)));
}

// `?` → `$1, $2, …`, leaving strings, quoted identifiers and comments alone.
// (Postgres' jsonb operators ? ?| ?& cannot be written then: use
// jsonb_exists() and friends.)
export function numberPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = closing(sql, i, c);
      out += sql.slice(i, end + 1);
      i = end;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length - 1 : end;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end < 0 ? sql.length - 1 : end + 1;
      out += sql.slice(i, stop + 1);
      i = stop;
    } else if (c === "?") out += `$${++n}`;
    else out += c;
  }
  return out;
}
function closing(sql: string, start: number, quote: string) {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) continue;
    if (sql[i + 1] === quote) {
      i++;
      continue;
    }
    return i;
  }
  return sql.length - 1;
}

// SQLite-only SQL that must not reach Postgres unported: the Postgres
// driver refuses it with a clear message instead of a syntax error deep in
// a request (a cheap safety net for the file-by-file refactor).
const SQLITE_ONLY: [RegExp, string][] = [
  [/\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i, "INSERT OR … → d.insertIgnore()/d.upsert()"],
  [/\bREPLACE\s+INTO\b/i, "REPLACE INTO → d.upsert()"],
  [/\bCOLLATE\s+NOCASE\b/i, "COLLATE NOCASE → d.ieq()/d.nocase()"],
  [/\bjson_(each|extract)\s*\(/i, "json_each/json_extract → d.jsonValues()/d.jsonText()"],
  [/\b(datetime|strftime|julianday|unixepoch)\s*\(/i, "date functions → d.nowText()/d.nowTextPlus()/d.nowMs()"],
  [/\bifnull\s*\(/i, "ifnull → coalesce"],
  [/\brandomblob\s*\(/i, "randomblob → d.randomHex()"],
  [/\binstr\s*\(/i, "instr → d.instr()"],
  [/\blast_insert_rowid\s*\(/i, "last_insert_rowid → RETURNING"],
  [/\browid\b/i, "rowid → seq (schema 93) or a key"],
  [/\bPRAGMA\b/i, "PRAGMA → db.columns() / information_schema"],
  [/\bsqlite_(master|schema)\b/i, "sqlite_master → information_schema"],
  [/\bIS\s+NOT\s+\?/i, "IS NOT ? → d.isNot()"],
  [/\bBEGIN\s+IMMEDIATE\b/i, "BEGIN IMMEDIATE → db.tx()"],
];
export function sqliteOnly(sql: string): string | null {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  for (const [pattern, hint] of SQLITE_ONLY) if (pattern.test(code)) return hint;
  return null;
}
