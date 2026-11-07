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
  // Scalar two-argument max/min.
  greatest(a: string, b: string): string;
  least(a: string, b: string): string;
  // LIKE ignoring ASCII case (SQLite's LIKE does, Postgres' does not).
  ilike(column: string, param?: string): string;
  // A string literal's position in another (instr).
  instr(haystack: string, needle: string): string;
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
  ieq: (c, p = "?") => `${c}=${p} COLLATE NOCASE`,
  nocase: (e) => `${e} COLLATE NOCASE`,
  insertIgnore: (rest) => `INSERT OR IGNORE INTO ${rest}`,
  upsert: (t, cols, keys) =>
    `INSERT INTO ${t}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")}) ON CONFLICT(${keys.join(",")}) DO ${
      cols.some((c) => !keys.includes(c))
        ? `UPDATE SET ${cols.filter((c) => !keys.includes(c)).map((c) => `${c}=excluded.${c}`).join(",")}`
        : "NOTHING"
    }`,
  isNot: (c, p = "?") => `${c} IS NOT ${p}`,
  jsonValues: (p = "?") => `(SELECT value FROM json_each(${p}))`,
  jsonText: (c, path) => `json_extract(${c},'${jsonPath(path)}')`,
  nowText: () => "CURRENT_TIMESTAMP",
  nowTextPlus: (m) => `datetime('now','${modifier(m)}')`,
  nowMs: () => "(unixepoch()*1000)",
  greatest: (a, b) => `max(${a},${b})`,
  least: (a, b) => `min(${a},${b})`,
  ilike: (c, p = "?") => `${c} LIKE ${p}`,
  instr: (h, n) => `instr(${h},${n})`,
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
  greatest: (a, b) => `greatest(${a},${b})`,
  least: (a, b) => `least(${a},${b})`,
  ilike: (c, p = "?") => `${c} ILIKE ${p}`,
  instr: (h, n) => `strpos(${h},${n})`,
};

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
  [/\binstr\s*\(/i, "instr → d.instr()"],
  [/\blast_insert_rowid\s*\(/i, "last_insert_rowid → RETURNING"],
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
