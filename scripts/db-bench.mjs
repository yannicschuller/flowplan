// Micro-benchmark of the database layer (docs/architecture/database.md):
// 20,000 point queries (a user by primary key) through
//   - the synchronous helper one() of lib/db.ts (SQLite, statement cache),
//   - the asynchronous Db on SQLite (lib/db-driver/sqlite.ts),
//   - the asynchronous Db on Postgres, one query at a time and 16 at once,
//     with and without named prepared statements,
//   - the transitional blocking bridge to Postgres (lib/db-driver/pg-sync.ts).
//
//   node --import tsx scripts/db-bench.mjs [postgres://…/db] [--n 20000]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const url = process.argv.slice(2).find((a) => a.startsWith("postgres"));
const nIndex = process.argv.indexOf("--n");
const N = nIndex > 0 ? Number(process.argv[nIndex + 1]) : 20_000;
const USERS = 10_000;
const ROUNDS = 3;

const dir = mkdtempSync(join(tmpdir(), "flowplan-bench-"));
process.env.FLOWPLAN_DATA_DIR = dir;
delete process.env.DATABASE_URL;
const legacy = await import("../lib/db.ts");
const { createSqliteDb } = await import("../lib/db-driver/sqlite.ts");

const ids = Array.from({ length: USERS }, () => randomUUID());
legacy.transaction(() => {
  for (const id of ids) legacy.run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `bench:${id}`, "Bench", "bench@example.test");
});
const SQL = "SELECT * FROM users WHERE id=?";
const pick = (i) => ids[(i * 7919) % USERS];

async function measure(name, fn) {
  const times = [];
  for (let r = 0; r < ROUNDS; r++) {
    await fn(2000); // warm-up
    const start = process.hrtime.bigint();
    await fn(N);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const ms = times[Math.floor(ROUNDS / 2)];
  const row = { name, ms: Math.round(ms), usPerQuery: +((ms * 1000) / N).toFixed(2), perSecond: Math.round(N / (ms / 1000)) };
  console.log(`${name.padEnd(46)} ${String(row.ms).padStart(6)} ms  ${String(row.usPerQuery).padStart(7)} µs/query  ${String(row.perSecond).padStart(8)} /s`);
  return row;
}

console.log(`${N} point queries (median of ${ROUNDS}), ${USERS} users, Node ${process.version}`);
const results = [];
results.push(
  await measure("SQLite sync one() (today)", (n) => {
    for (let i = 0; i < n; i++) if (!legacy.one(SQL, pick(i))) throw new Error("missing");
  }),
);
const sqlite = createSqliteDb();
results.push(
  await measure("SQLite async db.one(), awaited one by one", async (n) => {
    for (let i = 0; i < n; i++) if (!(await sqlite.one(SQL, pick(i)))) throw new Error("missing");
  }),
);
results.push(
  await measure("SQLite async db.one() inside one db.tx()", (n) =>
    sqlite.tx(async () => {
      for (let i = 0; i < n; i++) if (!(await sqlite.one(SQL, pick(i)))) throw new Error("missing");
    }),
  ),
);

if (url) {
  const { createPostgresDb } = await import("../lib/db-driver/postgres.ts");
  const { ensurePostgresSchema } = await import("../lib/db-driver/pg-schema.ts");
  const { readFileSync } = await import("node:fs");
  const schemaName = `flowplan_bench_${process.pid}`;
  const setup = createPostgresDb(url, { max: 1 });
  await setup.exec(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE; CREATE SCHEMA ${schemaName}`);
  await setup.close();
  const schema = JSON.parse(readFileSync(new URL("../lib/db-driver/postgres-schema.json", import.meta.url), "utf8"));
  const pg = createPostgresDb(url, { schema: schemaName, max: 16 });
  await ensurePostgresSchema(pg, schema, ["users"]);
  await pg.tx(async () => {
    for (let i = 0; i < USERS; i += 500)
      await pg.run(
        `INSERT INTO users(id,subject,name,email) VALUES ${ids
          .slice(i, i + 500)
          .map(() => "(?,?,'Bench','bench@example.test')")
          .join(",")}`,
        ...ids.slice(i, i + 500).flatMap((id) => [id, `bench:${id}`]),
      );
  });
  await pg.exec("ANALYZE users");
  results.push(
    await measure("Postgres async db.one(), one by one", async (n) => {
      for (let i = 0; i < n; i++) if (!(await pg.one(SQL, pick(i)))) throw new Error("missing");
    }),
  );
  results.push(
    await measure("Postgres async db.one(), 16 in flight", async (n) => {
      let next = 0;
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          while (next < n) if (!(await pg.one(SQL, pick(next++)))) throw new Error("missing");
        }),
      );
    }),
  );
  results.push(
    await measure("Postgres async db.one() inside one db.tx()", (n) =>
      pg.tx(async () => {
        for (let i = 0; i < n; i++) if (!(await pg.one(SQL, pick(i)))) throw new Error("missing");
      }),
    ),
  );
  const unprepared = createPostgresDb(url, { schema: schemaName, max: 16, prepare: false });
  results.push(
    await measure("Postgres async, unnamed statements, one by one", async (n) => {
      for (let i = 0; i < n; i++) if (!(await unprepared.one(SQL, pick(i)))) throw new Error("missing");
    }),
  );
  process.env.DATABASE_URL = url;
  process.env.FLOWPLAN_PG_SCHEMA = schemaName;
  const { legacyPostgres } = await import("../lib/db-driver/pg-sync.ts");
  const bridge = legacyPostgres();
  results.push(
    await measure("Postgres sync bridge (blocking), one by one", (n) => {
      for (let i = 0; i < n; i++) if (!bridge.one(SQL, [pick(i)])) throw new Error("missing");
    }),
  );
  await unprepared.close();
  await pg.exec(`DROP SCHEMA ${schemaName} CASCADE`);
  await pg.close();
}
rmSync(dir, { recursive: true, force: true });
if (process.argv.includes("--json")) console.log(JSON.stringify(results));
process.exit(0);
