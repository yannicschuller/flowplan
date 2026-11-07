// The schema of this version on PostgreSQL, applied at the first use of the
// database (lib/db.ts opening steps) when the database is new or older: a
// fresh PostgreSQL needs no separate step. Several instances starting at
// once take turns (advisory lock; the limits of lib/db-driver/postgres.ts
// lifted for it). FLOWPLAN_PG_SCHEMA_AUTO=off leaves it to
// scripts/db-schema.mjs (the Helm chart's migration Job).
import schemaJson from "./postgres-schema.json";
import { ensureSchemaVersion } from "./pg-ddl.mjs";
import { postgresSchema } from "./context";
import type { Db } from "./types";

export async function ensureCurrentPostgresSchema(db: Db) {
  if (process.env.FLOWPLAN_PG_SCHEMA_AUTO?.trim().toLowerCase() === "off") return null;
  const schema = postgresSchema();
  if (schema !== "public" && !(await db.one<{ ok: number }>("SELECT 1 AS ok FROM pg_namespace WHERE nspname=?", schema)))
    await db.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  const result = await db.tx(async () => {
    await db.run("SET LOCAL statement_timeout=0");
    await db.run("SET LOCAL lock_timeout=0");
    await db.one("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", `flowplan:schema:${schema}`);
    return await ensureSchemaVersion(db, schemaJson);
  });
  if (result.applied) console.log(`PostgreSQL: schema ${result.from || "(new)"} → ${result.to}`);
  return result;
}
