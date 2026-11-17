// The test files that reach the database layer: the ones the PostgreSQL job
// of CI runs (ci.yml). A file counts when it imports – directly or through
// any chain of the repository's own modules, static or `await import()` –
// lib/db.ts, lib/db-driver/*, the test backends, node:sqlite or pg, or uses
// the cluster tests' Redis (FLOWPLAN_TEST_REDIS_URL), or
// carries the marker comment `// db-test` (for a file that needs Postgres
// without such an import, e.g. one that only talks to a spawned server).
// So a new test that touches the database is picked up without a list to
// keep. Everything else behaves the same on either database and runs in the
// SQLite job only.
//
//   node scripts/db-tests.mjs            the files, one per line
//   node scripts/db-tests.mjs --stats    how many of how many, and why not
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];
// Where the database is: the layer itself, its drivers and the test
// helpers that set up a Postgres schema or open SQLite directly.
const DATABASE = [/^lib\/db\.ts$/, /^lib\/db-driver\//, /^tests\/helpers\/(postgres-)?backend\.ts$/];
const SPECIFIER = /(?:\bimport\s[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\bexport\s[^'"]*?\bfrom\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function resolveImport(from, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of EXTENSIONS) {
    const file = base + ext;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  // `./x.js` written for `./x.ts`.
  const stripped = base.replace(/\.(m?js)$/, "");
  for (const ext of [".ts", ".tsx", ".mts"]) if (existsSync(stripped + ext)) return stripped + ext;
  return null;
}

const imports = new Map();
function importsOf(file) {
  if (imports.has(file)) return imports.get(file);
  const text = readFileSync(file, "utf8");
  const found = {
    files: [],
    // SQLite or PostgreSQL directly; the cluster's real Redis, which only
    // the PostgreSQL job has (FLOWPLAN_TEST_REDIS_URL).
    sqlite: /["'](node:sqlite|pg)["']|FLOWPLAN_TEST_REDIS_URL/.test(text),
    marker: /^\s*\/\/\s*db-test\b/m.test(text),
  };
  imports.set(file, found);
  for (const match of text.matchAll(SPECIFIER)) {
    const target = resolveImport(file, match[1]);
    if (target) found.files.push(target);
  }
  return found;
}

const verdict = new Map();
function reachesDatabase(file, stack = new Set()) {
  if (verdict.has(file)) return verdict.get(file);
  if (stack.has(file)) return false;
  stack.add(file);
  const rel = relative(root, file);
  const own = importsOf(file);
  let result = DATABASE.some((re) => re.test(rel)) || own.sqlite || own.marker;
  for (const next of own.files) {
    if (result) break;
    result = reachesDatabase(next, stack);
  }
  stack.delete(file);
  // Only a final answer is remembered: inside a cycle a "no" may be early.
  if (result || stack.size === 0) verdict.set(file, result);
  return result;
}

const tests = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(root, "tests", name));
const chosen = tests.filter((file) => reachesDatabase(file));
if (process.argv.includes("--stats")) {
  console.log(`${chosen.length} of ${tests.length} test files reach the database.`);
  for (const file of tests) if (!chosen.includes(file)) console.log(`  not: ${relative(root, file)}`);
} else {
  for (const file of chosen) console.log(relative(root, file));
}
