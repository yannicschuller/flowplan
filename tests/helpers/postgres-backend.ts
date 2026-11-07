// The database backend of a test run, from the environment: SQLite (the
// default, nothing to do) or, with DATABASE_URL=postgres://…, a schema of
// its own in that database for this test process – created with every
// table of lib/db-driver/postgres-schema.json, dropped when the process
// ends. Loaded by tests/helpers/cleanup.mjs before each test file:
//
//   DATABASE_URL=postgres://postgres@localhost:55432/flowplan_test npm test
//
// Leftovers of aborted runs: node --import tsx tests/helpers/postgres-backend.ts --drop-all
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createPostgresDb } from "../../lib/db-driver/postgres";
import { ensurePostgresSchema, type PgSchema } from "../../lib/db-driver/pg-schema";

const SCHEMA_PREFIX = "flowplan_test_";
const created: string[] = [];

export async function preparePostgres(url: string) {
  const schema = `${SCHEMA_PREFIX}${process.pid}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  process.env.FLOWPLAN_PG_SCHEMA = schema;
  const tables = JSON.parse(readFileSync(new URL("../../lib/db-driver/postgres-schema.json", import.meta.url), "utf8")) as PgSchema;
  const setup = createPostgresDb(url, { schema, max: 1 });
  await ensurePostgresSchema(setup, tables);
  await setup.close();
  // Dropped at exit, one after the other: a process that made several
  // (tests/setup-restore.test.ts) would otherwise take the locks of all
  // their tables at once (each DROP SCHEMA … CASCADE locks every object).
  created.push(schema);
  if (created.length === 1)
    process.on("beforeExit", async () => {
      // (beforeExit comes again once this has finished: nothing left then.)
      if (!created.length) return;
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        while (created.length) await client.query(`DROP SCHEMA IF EXISTS ${created.shift()} CASCADE`);
      } finally {
        await client.end().catch(() => {});
      }
    });
  return schema;
}

if (process.argv.includes("--drop-all")) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname LIKE $1", [`${SCHEMA_PREFIX}%`]);
  for (const r of rows) await client.query(`DROP SCHEMA ${r.nspname} CASCADE`);
  console.log(`dropped ${rows.length} test schemas`);
  await client.end();
}
