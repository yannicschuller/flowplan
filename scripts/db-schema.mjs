// Brings a PostgreSQL database to this version's schema before the app
// starts – the migration step of a deployment (the Helm chart's Job, or by
// hand). Adds what is missing (tables, columns, indexes, foreign keys,
// triggers, seed rows), never drops; does nothing when the database is
// current or newer. Instances apply the same at their first start anyway
// (FLOWPLAN_PG_SCHEMA_AUTO, default on); this makes it a separate step
// that fails loudly. Takes the same advisory lock as the app.
//
//   DATABASE_URL=postgres://… node scripts/db-schema.mjs          (from the repository)
//   DATABASE_URL=postgres://… node /app/scripts/db-schema.mjs     (in the image)
//
// FLOWPLAN_PG_SCHEMA picks the schema (namespace; default public).
// First: started as root (docker exec, the cluster compose's schema
// service), continue as PUID:PGID (#193).
import "./drop-root.mjs";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!/^postgres(ql)?:\/\//i.test(url || "")) {
  console.error("DATABASE_URL=postgres://… is needed.");
  process.exit(2);
}
const schemaName = process.env.FLOWPLAN_PG_SCHEMA?.trim() || "public";
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schemaName)) {
  console.error(`FLOWPLAN_PG_SCHEMA is not a plain identifier: ${schemaName}`);
  process.exit(2);
}
// The repository (scripts/ next to lib/) or the image (/app/db-driver/).
const here = new URL(".", import.meta.url);
const driver = [new URL("../lib/db-driver/", here), new URL("./db-driver/", here)].find((dir) => existsSync(new URL("pg-ddl.mjs", dir)));
if (!driver) {
  console.error("pg-ddl.mjs and postgres-schema.json not found next to this script.");
  process.exit(2);
}
const { ensureSchemaVersion } = await import(new URL("pg-ddl.mjs", driver).href);
const schema = JSON.parse(readFileSync(new URL("postgres-schema.json", driver), "utf8"));

const client = new pg.Client({ connectionString: url, application_name: "flowplan-schema" });
await client.connect();
const numbered = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const db = {
  exec: (sql) => client.query(sql).then(() => {}),
  all: (sql, ...p) => client.query(numbered(sql), p).then((r) => r.rows),
  run: (sql, ...p) => client.query(numbered(sql), p),
  columns: async (t) => (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1", [t])).rows.map((r) => r.column_name),
};
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await client.query(`SET search_path TO "${schemaName}"`);
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout=0");
  await client.query("SET LOCAL lock_timeout=0");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`flowplan:schema:${schemaName}`]);
  const result = await ensureSchemaVersion(db, schema);
  await client.query("COMMIT");
  console.log(result.applied ? `Schema ${schemaName}: ${result.from || "(new)"} → ${result.to}` : `Schema ${schemaName}: ${result.from} is current (this version: ${schema.sqliteVersion})`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Schema update failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
