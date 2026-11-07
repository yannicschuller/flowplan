// Rebuilds Flowplan's full-text index (docs/architecture/database.md §5a):
// marks it as not built, and the instance indexes every page, record,
// comment, message and file again in the background – within seconds when
// it runs (the search worker looks every 5 s), else at its next start.
// Searches work meanwhile and find more as the index fills.
//
//   node scripts/db-search-rebuild.mjs                       # DATABASE_URL, or ./data/flowplan.sqlite
//   node scripts/db-search-rebuild.mjs --sqlite /app/data/flowplan.sqlite
//   DATABASE_URL=postgres://… FLOWPLAN_PG_SCHEMA=flowplan node scripts/db-search-rebuild.mjs
//
// In the Docker image: docker exec flowplan node /app/scripts/db-search-rebuild.mjs
// On PostgreSQL it also rebuilds the trigram indexes (REINDEX), e.g. after
// pg_trgm was installed or upgraded.
// db-dialect-scan: sqlite-only file – the SQLite branch edits the file directly.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const sqliteArg = args.includes("--sqlite") ? args[args.indexOf("--sqlite") + 1] : null;
const url = process.env.DATABASE_URL?.trim() || "";
if (!sqliteArg && /^postgres(ql)?:\/\//i.test(url)) {
  const { default: pg } = await import("pg");
  const schema = process.env.FLOWPLAN_PG_SCHEMA?.trim() || "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`FLOWPLAN_PG_SCHEMA is not a plain identifier: ${schema}`);
  const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='search_index' AND indexname LIKE '%_trgm'");
    for (const r of rows) await client.query(`REINDEX INDEX ${r.indexname}`);
    await client.query("DELETE FROM search_state");
    console.log(`PostgreSQL (${schema}): search index marked for a rebuild${rows.length ? `, ${rows.length} trigram indexes rebuilt` : ""}.`);
  } finally {
    await client.end();
  }
} else {
  const file = resolve(sqliteArg || `${process.env.FLOWPLAN_DATA_DIR || "./data"}/flowplan.sqlite`);
  if (!existsSync(file)) throw new Error(`${file} does not exist (--sqlite <file>, or DATABASE_URL=postgres://…)`);
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(file);
  d.exec("PRAGMA busy_timeout=5000");
  d.exec("DELETE FROM search_state");
  d.close();
  console.log(`SQLite (${file}): search index marked for a rebuild.`);
}
