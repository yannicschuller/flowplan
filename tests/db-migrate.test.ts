// The migration tool (scripts/db-migrate.mjs) on a realistic instance –
// example pages, documents in four languages, records, comments, files and
// embeddings of two models – SQLite → PostgreSQL → SQLite: every table
// verified by the tool, and the instance on each database finds the same
// (full-text search, semantic search, counts). This is also the parity
// check of the search on identical data. Needs PostgreSQL (DATABASE_URL).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { onPostgres } from "./helpers/backend";

const url = process.env.DATABASE_URL || "";
const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "flowplan-migrate-"));
const schema = `flowplan_test_migrate_${process.pid}_${randomBytes(3).toString("hex")}`;
after(async () => {
  rmSync(work, { recursive: true, force: true });
  if (!onPostgres) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
});

// A process of its own per instance: the backend is chosen once per process.
function fixture(mode: "seed" | "query", env: Record<string, string | undefined>) {
  const clean = { ...process.env };
  delete clean.DATABASE_URL;
  delete clean.FLOWPLAN_PG_SCHEMA;
  const out = execFileSync(process.execPath, ["--import", "tsx", join(root, "tests/helpers/migrate-fixture.ts"), mode], {
    cwd: root,
    env: { ...clean, ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = out.trim().split("\n");
  return mode === "query" ? JSON.parse(lines[lines.length - 1]) : null;
}
const migrate = (from: string, to: string) =>
  execFileSync(process.execPath, [join(root, "scripts/db-migrate.mjs"), "--from", from, "--to", to, "--schema", schema, "--quiet"], { cwd: root, encoding: "utf8" });

test("SQLite → PostgreSQL → SQLite: verified, and each finds the same", { skip: !onPostgres && "needs PostgreSQL (DATABASE_URL)", timeout: 600_000 }, async () => {
  const sqliteDir = join(work, "sqlite");
  fixture("seed", { FLOWPLAN_DATA_DIR: sqliteDir });
  const onSqlite = fixture("query", { FLOWPLAN_DATA_DIR: sqliteDir });
  assert.ok(onSqlite.counts.ai_embeddings >= 160 && onSqlite.counts.rows >= 60, JSON.stringify(onSqlite.counts));

  const there = migrate(`sqlite:${join(sqliteDir, "flowplan.sqlite")}`, url);
  assert.match(there, /verified: every table has the same rows/);
  const onPostgresDb = fixture("query", { FLOWPLAN_DATA_DIR: join(work, "pg-data"), DATABASE_URL: url, FLOWPLAN_PG_SCHEMA: schema });

  const back = join(work, "back");
  const returned = migrate(url, `sqlite:${join(back, "flowplan.sqlite")}`);
  assert.match(returned, /verified: every table has the same rows/);
  const onSqliteAgain = fixture("query", { FLOWPLAN_DATA_DIR: back });

  const { pgvector, ...pgResults } = onPostgresDb;
  delete onSqlite.pgvector;
  delete onSqliteAgain.pgvector;
  // pgvector (when the server has it) answered on PostgreSQL, completely filled in.
  assert.notEqual(pgvector, false);
  assert.deepEqual(pgResults, onSqlite, "PostgreSQL finds what SQLite finds");
  assert.deepEqual(onSqliteAgain, onSqlite, "and so does SQLite after the way back");
});
