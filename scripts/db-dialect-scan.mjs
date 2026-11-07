// SQLite-only SQL left in the code base (docs/architecture/database.md,
// "Dialect"). Reads the string and template literals of the source files,
// keeps the ones that are SQL, and counts the patterns that do not run on
// PostgreSQL as written. Fragments built with the dialect helpers
// (lib/db-driver/dialect.ts) are not counted: the scan sees `${d.ieq(…)}`,
// not what it expands to on SQLite.
//
//   node scripts/db-dialect-scan.mjs            counts per pattern
//   node scripts/db-dialect-scan.mjs --list     every occurrence, file:line
//   node scripts/db-dialect-scan.mjs --tests    include tests/
//   node scripts/db-dialect-scan.mjs --json
//
// Not counted on purpose: lib/db.ts migrations (SQLite schema, translated by
// lib/db-driver/pg-schema.ts), lib/db-driver itself (the dialect seam), and
// code that only ever runs on SQLite (marked `// sqlite-only` on the line or
// the line above, e.g. PRAGMA behind a backend check; a whole file with
// `// db-dialect-scan: sqlite-only file` near its top).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const withTests = args.includes("--tests");
const list = args.includes("--list");
const json = args.includes("--json");
const dirs = ["app", "lib", "components", "scripts", "integrations", "instrumentation.ts", "proxy.ts", ...(withTests ? ["tests"] : [])];
const SKIP = [/^lib\/db-driver\//, /^scripts\/db-dialect-scan\.mjs$/, /^scripts\/codemod-dialect\.mjs$/, /^scripts\/db-migrate\.mjs$/, /^scripts\/db-pg-schema\.mjs$/];

// Patterns: [name, regex, onlyInSql]. onlyInSql: the string must look like
// SQL (a keyword), else the word is too common (rowid, GLOB, max()).
const PATTERNS = [
  ["INSERT OR IGNORE", /\bINSERT\s+OR\s+IGNORE\b/gi, false],
  ["INSERT OR REPLACE / REPLACE INTO", /\b(INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/gi, false],
  ["COLLATE NOCASE", /\bCOLLATE\s+NOCASE\b/gi, false],
  ["json_each/json_extract/json_*", /\bjson_(each|extract|object|array|group_array|set|insert|remove|type|valid)\s*\(/gi, true],
  ["datetime()/date()/strftime()/julianday()/unixepoch()", /\b(datetime|strftime|julianday|unixepoch|date|time)\s*\(/g, true],
  ["CURRENT_TIMESTAMP (in queries)", /\bCURRENT_TIMESTAMP\b/g, true],
  ["last_insert_rowid / lastInsertRowid", /\b(last_insert_rowid\s*\(|lastInsertRowid\b)/g, false],
  ["rowid", /\browid\b/g, false],
  ["PRAGMA", /\bPRAGMA\b/g, true],
  ["sqlite_master / sqlite_schema", /\bsqlite_(master|schema|sequence)\b/g, false],
  ["ifnull()", /\bifnull\s*\(/gi, true],
  ["instr()", /\binstr\s*\(/gi, true],
  ["group_concat()", /\bgroup_concat\s*\(/gi, true],
  ["IS [NOT] ? (null-safe compare)", /\bIS\s+(NOT\s+)?\?/gi, true],
  ["GLOB", /\bGLOB\b/g, true],
  ["LIMIT -1", /\bLIMIT\s+-1\b/gi, true],
  ["randomblob()/hex()", /\b(randomblob|hex)\s*\(/gi, true],
  ["BEGIN IMMEDIATE", /\bBEGIN\s+IMMEDIATE\b/gi, false],
  // MAX(a,b): a comma at the top level of the call's parentheses.
  ["scalar max(a,b)/min(a,b)", /\b(max|min|MAX|MIN)\s*\((?:[^(),]|\((?:[^()]|\([^()]*\))*\))*,/g, true],
  ["LIKE (case semantics: lower() or d.ilike)", /\bLIKE\b/g, true],
  ["typeof()", /\btypeof\s*\(/g, true],
  ["char() (Postgres: chr)", /\bchar\s*\(\d/gi, true],
  // Postgres folds unquoted names to lower case: `AS "userId"`.
  ["mixed-case alias without quotes", /(\bAS\s+|[\w)]\s+)(?!(?:[A-Z]+|[a-z]+)\b)[a-z]+[A-Z][A-Za-z0-9]*\b(?=\s*(,|\bFROM\b|$))/g, true],
  ["?NNN numbered parameter", /\?\d/g, true],
  ["CAST(… AS BLOB)", /\bAS\s+BLOB\b/gi, true],
  ["VACUUM / ATTACH", /\b(VACUUM|ATTACH\s+DATABASE)\b/g, true],
  ["printf()/format()", /\bprintf\s*\(/gi, true],
];
const SQLISH = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WHERE|ORDER BY|GROUP BY|JOIN|ON CONFLICT|VALUES|FROM)\b/;

function files(path, out = []) {
  const full = join(root, path);
  let s;
  try {
    s = statSync(full);
  } catch {
    return out;
  }
  if (s.isDirectory()) {
    for (const name of readdirSync(full)) if (name !== "node_modules" && !name.startsWith(".")) files(join(path, name), out);
  } else if (/\.(ts|tsx|mjs|js)$/.test(path) && !/\.d\.ts$/.test(path)) out.push(path);
  return out;
}

// String and template literals with their line numbers. Template
// substitutions become `${…}`; strings inside them are reported separately.
function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = "";
  const regexAllowed = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of|new|delete|void|throw)$/.test(prev);
  function skipSpace() {
    for (;;) {
      const c = src[i];
      if (c === "\n") line++;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? src.length : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === "\n") line++;
        i = stop;
      } else return;
    }
  }
  function quoted(q) {
    const start = line;
    let text = "";
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        text += src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === "\n") break;
      text += src[i++];
    }
    i++;
    out.push({ line: start, text });
  }
  function template() {
    const start = line;
    let text = "";
    i++;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") {
        text += src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        const exprStart = i;
        code("}");
        // The substitution itself is code (dialect helpers): not counted.
        void exprStart;
        text += "${}";
        i++;
        continue;
      }
      if (src[i] === "\n") line++;
      text += src[i++];
    }
    i++;
    out.push({ line: start, text });
  }
  function regex() {
    i++;
    let cls = false;
    while (i < src.length && src[i] !== "\n") {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "[") (cls = true), i++;
      else if (c === "]") (cls = false), i++;
      else if (c === "/" && !cls) {
        i++;
        while (/[a-z]/.test(src[i] || "")) i++;
        return;
      } else i++;
    }
  }
  // Code until the closing `stop` at depth 0.
  function code(stop) {
    let depth = 0;
    while (i < src.length) {
      skipSpace();
      const c = src[i];
      if (c === undefined) return;
      if (c === "'" || c === '"') {
        quoted(c);
        prev = "x";
      } else if (c === "`") {
        template();
        prev = "x";
      } else if (c === "/" && regexAllowed()) {
        regex();
        prev = "x";
      } else if (c === "{" || c === "(" || c === "[") {
        depth++;
        prev = c;
        i++;
      } else if (c === "}" || c === ")" || c === "]") {
        if (depth === 0 && c === stop) return;
        depth--;
        prev = c;
        i++;
      } else {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
        if (m) {
          prev = m[0];
          i += m[0].length;
        } else {
          prev = c;
          i++;
        }
      }
    }
  }
  code(null);
  return out;
}

const counts = new Map(PATTERNS.map(([name]) => [name, { n: 0, files: new Set(), where: [] }]));
let scanned = 0;
for (const path of dirs.flatMap((d) => files(d))) {
  if (SKIP.some((re) => re.test(path))) continue;
  scanned++;
  const src = readFileSync(join(root, path), "utf8");
  const lines = src.split("\n");
  // A file that only reads or writes SQLite files of its own (an import
  // format, a check of the standalone build) says so near its top.
  if (lines.slice(0, 40).some((l) => /db-dialect-scan: sqlite-only file/.test(l))) continue;
  const migrations = path === "lib/db.ts";
  for (const lit of literals(src)) {
    const sqlish = SQLISH.test(lit.text);
    // lib/db.ts: the SQLite schema and its migrations stay SQLite; only its
    // query helpers are scanned (none carry SQL of their own).
    if (migrations) continue;
    const marked = /sqlite-only/.test(lines[lit.line - 1] || "") || /sqlite-only/.test(lines[lit.line - 2] || "");
    if (marked) continue;
    for (const [name, re, onlyInSql] of PATTERNS) {
      if (onlyInSql && !sqlish) continue;
      const hits = lit.text.match(re);
      if (!hits) continue;
      const c = counts.get(name);
      c.n += hits.length;
      c.files.add(path);
      c.where.push(`${relative(root, join(root, path))}:${lit.line}  ${lit.text.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
}

if (json) {
  console.log(JSON.stringify(Object.fromEntries([...counts].map(([k, v]) => [k, { occurrences: v.n, files: v.files.size }])), null, 2));
} else {
  console.log(`${scanned} files scanned (${dirs.join(", ")})\n`);
  console.log("| Pattern | Occurrences | Files |\n|---|---:|---:|");
  for (const [name, c] of counts) console.log(`| ${name} | ${c.n} | ${c.files.size} |`);
  if (list)
    for (const [name, c] of counts) {
      if (!c.n) continue;
      console.log(`\n## ${name}`);
      for (const w of c.where) console.log(w);
    }
}
