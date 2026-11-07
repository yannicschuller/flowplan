// Writes lib/db-driver/postgres-schema.json: the PostgreSQL schema
// translated from the SQLite schema of this version (lib/db-driver/pg-schema.ts).
// Run after adding a migration to lib/db.ts:
//   node --import tsx scripts/db-pg-schema.mjs [--check]
// --check only compares (tests/db-driver.test.ts does the same).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = new URL("../lib/db-driver/postgres-schema.json", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "flowplan-pgschema-"));
process.env.FLOWPLAN_DATA_DIR = dir;
delete process.env.DATABASE_URL;
const { db } = await import("../lib/db.ts");
const { translateSqliteSchema } = await import("../lib/db-driver/pg-schema.ts");
// One table, index or skipped object per line: readable diffs.
const schema = translateSqliteSchema(db());
const list = (items) => `[\n${items.map((i) => `  ${JSON.stringify(i)}`).join(",\n")}\n ]`;
const text = `{\n "sqliteVersion": ${schema.sqliteVersion},\n "tables": ${list(schema.tables)},\n "indexes": ${list(schema.indexes)},\n "skipped": ${list(schema.skipped)}\n}\n`;
rmSync(dir, { recursive: true, force: true });
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== text) {
    console.error("lib/db-driver/postgres-schema.json is outdated: node --import tsx scripts/db-pg-schema.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
  console.log(`${schema.tables.length} tables, ${schema.indexes.length} indexes, ${schema.tables.reduce((n, t) => n + t.foreignKeys.length, 0)} foreign keys; skipped: ${schema.skipped.length}`);
}
process.exit(0);
