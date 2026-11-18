// PostgreSQL behind one address that can fail over (lib/db-driver/postgres.ts,
// docs/architecture/database.md §14c): which failures drop a connection,
// which statements are tried once more, and how a read-only server (the old
// primary after a failover) empties the pool – with a stand-in for pg.Pool,
// so no server is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { onPostgres } from "./helpers/backend";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-pg-failover-"));
const { createPostgresDb, isConnectionError, isReadOnlyError, postgresConnectionOptions, retrySafe } = await import("../lib/db-driver/postgres");
const { dbContext, postgresSchema } = await import("../lib/db-driver/context");
// The app's hook before each commit (two-way relations, lib/db.ts) would
// run its own statements on the stand-in.
dbContext.hooks.beforeCommit = undefined;

type Sent = { client: number; text: string; query_timeout?: number };
type Answer = (text: string, client: FakeClient) => unknown;
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });

class FakeClient {
  constructor(
    readonly id: number,
    private pool: FakePool,
  ) {}
  released: (Error | undefined)[] = [];
  async query(config: string | { text: string; query_timeout?: number }) {
    const text = typeof config === "string" ? config : config.text;
    this.pool.sent.push({ client: this.id, text, query_timeout: typeof config === "string" ? undefined : config.query_timeout });
    const answer = this.pool.answer(text, this);
    if (answer instanceof Error) throw answer;
    return (answer as pg.QueryResult) ?? { rows: [{ ok: 1 }], rowCount: 1 };
  }
  release(error?: Error) {
    this.released.push(error);
    this.pool.idle = this.pool.idle.filter((c) => c !== this);
    if (error) this.pool.dropped.push(this.id);
    else this.pool.idle.push(this);
  }
}
class FakePool extends EventEmitter {
  idle: FakeClient[] = [];
  created: FakeClient[] = [];
  dropped: number[] = [];
  sent: Sent[] = [];
  config: pg.PoolConfig | null = null;
  answer: Answer = () => undefined;
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  async connect() {
    const reused = this.idle.pop();
    if (reused) return reused;
    const client = new FakeClient(this.created.length + 1, this);
    this.created.push(client);
    this.emit("connect", client);
    return client;
  }
  async end() {}
}
function fakeDb(options: Parameters<typeof createPostgresDb>[1] = {}) {
  const pool = new FakePool();
  const db = createPostgresDb("postgres://fake/db", {
    prepare: false,
    queryTimeout: 125_000,
    ...options,
    createPool: (config) => {
      pool.config = config;
      return pool as unknown as pg.Pool;
    },
  });
  return { db, pool };
}

test("which statements may run a second time: read-only, outside a transaction", () => {
  for (const sql of [
    "SELECT * FROM pages WHERE id=?",
    "  select 1",
    "(SELECT a FROM t) UNION (SELECT b FROM u)",
    "-- the sidebar\nSELECT id FROM spaces",
    "WITH RECURSIVE tree(id) AS (SELECT id FROM pages WHERE parent_id IS NULL UNION ALL SELECT p.id FROM pages p JOIN tree ON p.parent_id=tree.id) SELECT * FROM tree",
  ])
    assert.equal(retrySafe(sql), true, sql);
  for (const sql of [
    "INSERT INTO pages(id) VALUES(?)",
    "UPDATE pages SET title=? WHERE id=?",
    "DELETE FROM pages",
    "WITH gone AS (DELETE FROM pages RETURNING id) SELECT count(*) FROM gone",
    "WITH x AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM x",
    "SELECT * FROM storage_queue FOR UPDATE SKIP LOCKED",
    "SELECT id FROM t FOR SHARE",
    "SELECT nextval('s')",
    "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok",
    "SELECT set_config('x','1',false)",
    "SELECT * INTO copy FROM pages",
    "BEGIN",
    "COMMIT",
    "SET LOCAL statement_timeout=0",
    "CREATE TABLE x(a int)",
  ])
    assert.equal(retrySafe(sql), false, sql);
});

test("which failures are the connection's (and drop it) and which mean a read-only server", () => {
  for (const error of [
    failure("ECONNRESET"),
    failure("ECONNREFUSED"),
    failure("EPIPE"),
    failure("57P01", "terminating connection due to administrator command"),
    failure("57P02"),
    failure("57P03", "the database system is starting up"),
    failure("08006"),
    failure("08003"),
    new Error("Connection terminated unexpectedly"),
    new Error("Connection terminated"),
    new Error("Query read timeout"),
  ])
    assert.equal(isConnectionError(error), true, String(error.message));
  for (const error of [failure("23505", "duplicate key"), failure("57014", "canceling statement due to statement timeout"), failure("40P01"), failure("25006"), new Error("timeout exceeded when trying to connect")])
    assert.equal(isConnectionError(error), false, String(error.message));
  assert.equal(isReadOnlyError(failure("25006", "cannot execute INSERT in a read-only transaction")), true);
  assert.equal(isReadOnlyError(failure("23505")), false);
});

test("pool settings: keepalive, a client-side limit above statement_timeout, idle connections closed", () => {
  assert.deepEqual(postgresConnectionOptions({}), { keepAlive: 10_000, queryTimeout: 125_000, idleTimeout: 30_000 });
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_STATEMENT_TIMEOUT: "60000" }).queryTimeout, 65_000);
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_STATEMENT_TIMEOUT: "0" }).queryTimeout, 0, "no server limit: none on the client either");
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_QUERY_TIMEOUT: "0" }).queryTimeout, 0);
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_QUERY_TIMEOUT: "200000" }).queryTimeout, 200_000);
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_KEEPALIVE: "off" }).keepAlive, 0);
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_KEEPALIVE: "5000" }).keepAlive, 5_000);
  assert.equal(postgresConnectionOptions({ FLOWPLAN_PG_IDLE_TIMEOUT: "60000" }).idleTimeout, 60_000);
  assert.throws(() => postgresConnectionOptions({ FLOWPLAN_PG_KEEPALIVE: "soon" }), /milliseconds/);
  const { pool } = fakeDb({ keepAlive: 10_000, idleTimeout: 30_000 });
  assert.equal(pool.config?.keepAlive, true);
  assert.equal(pool.config?.keepAliveInitialDelayMillis, 10_000);
  assert.equal(pool.config?.idleTimeoutMillis, 30_000);
  assert.equal(fakeDb({ keepAlive: 0 }).pool.config?.keepAlive, undefined);
});

test("a read-only statement whose connection broke runs once more on a new one; the broken one leaves the pool", async () => {
  const { db, pool } = fakeDb();
  let calls = 0;
  pool.answer = (text) => (text.startsWith("SELECT") && calls++ === 0 ? failure("ECONNRESET", "read ECONNRESET") : { rows: [{ n: 7 }], rowCount: 1 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await db.one("SELECT 7 AS n"), { n: 7 });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(pool.sent.map((s) => s.client), [1, 2], "the second try on a new connection");
  assert.deepEqual(pool.dropped, [1]);
  assert.equal(pool.sent[0].query_timeout, 125_000, "each query has the client-side limit");
  // Only once: a second failure reaches the caller.
  pool.answer = () => failure("57P01", "terminating connection due to administrator command");
  pool.sent = [];
  console.warn = () => {};
  try {
    await assert.rejects(db.one("SELECT 1"), /administrator command/);
  } finally {
    console.warn = warn;
  }
  assert.equal(pool.sent.length, 2);
});

test("writes are never repeated; an ordinary error keeps the connection", async () => {
  const { db, pool } = fakeDb();
  pool.answer = (text) => (text.startsWith("INSERT") ? failure("ECONNRESET") : undefined);
  await assert.rejects(db.run("INSERT INTO t(a) VALUES(?)", 1), /ECONNRESET/);
  assert.equal(pool.sent.length, 1, "not sent again");
  assert.deepEqual(pool.dropped, [1], "the connection left the pool");
  pool.answer = () => failure("23505", "duplicate key value");
  await assert.rejects(db.run("INSERT INTO t(a) VALUES(?)", 1), /duplicate key/);
  assert.deepEqual(pool.dropped, [1], "a unique violation is the statement's, not the connection's");
  assert.equal(pool.idle.length, 1);
  await assert.rejects(db.one("SELECT * FROM t FOR UPDATE"), /duplicate key/);
});

test("inside a transaction nothing is repeated; a broken connection is dropped when it ends", async () => {
  const { db, pool } = fakeDb();
  pool.answer = (text) => (text.startsWith("SELECT") ? failure("ECONNRESET") : undefined);
  await assert.rejects(
    db.tx(async () => {
      await db.one("SELECT 1");
    }),
    /ECONNRESET/,
  );
  assert.deepEqual(
    pool.sent.map((s) => s.text),
    ["BEGIN", "SELECT 1", "ROLLBACK"],
  );
  assert.deepEqual(pool.dropped, [1]);
});

test("a transaction whose BEGIN meets a dead connection starts on a fresh one", async () => {
  const { db, pool } = fakeDb();
  // A connection from before a server restart, idle in the pool.
  await db.one("SELECT 1");
  let first = true;
  pool.answer = (text) => {
    if (text === "BEGIN" && first) {
      first = false;
      return new Error("Connection terminated unexpectedly");
    }
    return { rows: [{ ok: 1 }], rowCount: 1 };
  };
  assert.equal(await db.tx(async () => (await db.one<{ ok: number }>("SELECT 1 AS ok"))?.ok), 1);
  assert.deepEqual(pool.dropped, [1]);
  assert.deepEqual(
    pool.sent.slice(1).map((s) => `${s.client}:${s.text}`),
    ["1:BEGIN", "2:BEGIN", "2:SELECT 1 AS ok", "2:COMMIT"],
  );
});

test("after a failover (25006 on the old primary) every older connection is dropped at its next use", async () => {
  const { db, pool } = fakeDb();
  // Three connections open to the server that will turn read-only.
  await Promise.all([
    db.tx(async () => {
      await db.one("SELECT 1");
      await new Promise((r) => setTimeout(r, 5));
    }),
    db.tx(async () => {
      await db.one("SELECT 2");
      await new Promise((r) => setTimeout(r, 5));
    }),
    db.tx(async () => {
      await db.one("SELECT 3");
      await new Promise((r) => setTimeout(r, 5));
    }),
  ]);
  assert.equal(pool.created.length, 3);
  const old = new Set(pool.created.map((c) => c.id));
  pool.answer = (text, client) => (old.has(client.id) && text.startsWith("UPDATE") ? failure("25006", "cannot execute UPDATE in a read-only transaction") : undefined);
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (line: string) => void warned.push(line);
  try {
    await assert.rejects(db.run("UPDATE t SET a=1"), /read-only/);
  } finally {
    console.warn = warn;
  }
  assert.equal(pool.sent.filter((s) => s.text.startsWith("UPDATE")).length, 1, "a write is not repeated");
  assert.match(warned.join("\n"), /read-only \(25006/);
  pool.sent = [];
  // The next statements: the remaining old connections are dropped unused,
  // new ones (to the address, now the new primary) answer.
  await db.run("UPDATE t SET a=2");
  await db.tx(async () => {
    await db.run("UPDATE t SET a=3");
  });
  assert.deepEqual([...pool.dropped].sort(), [...old].sort(), "all three old connections went");
  assert.ok(pool.sent.every((s) => !old.has(s.client)), "nothing more on the old server");
  // Inside a transaction too: the connection goes, the failover is noted.
  const { db: db2, pool: pool2 } = fakeDb();
  pool2.answer = (text) => (text.startsWith("INSERT") ? failure("25006") : undefined);
  console.warn = () => {};
  try {
    await assert.rejects(db2.tx(async () => void (await db2.run("INSERT INTO t(a) VALUES(1)"))));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(pool2.dropped, [1]);
});

test("untimed transactions lift the client-side limit with the server's", async () => {
  const { db, pool } = fakeDb();
  await db.tx(async () => {
    await db.run("SELECT 1");
    await db.run("SET LOCAL statement_timeout=0");
    await db.run("SELECT pg_sleep(600)");
  });
  await db.one("SELECT 2");
  const limits = Object.fromEntries(pool.sent.map((s) => [s.text, s.query_timeout]));
  assert.equal(limits["SELECT 1"], 125_000);
  assert.equal(limits["SELECT pg_sleep(600)"], undefined, "no client-side limit after untimed()");
  assert.equal(limits["COMMIT"], undefined);
  assert.equal(limits["SELECT 2"], 125_000, "the next transaction has it again");
});

// The same against a real server (CI's PostgreSQL job): an idle connection
// the server ended (57P01, as on a restart or failover) and a read-only
// transaction (25006, as on a standby).
test("PostgreSQL: a connection the server ended is replaced, a SELECT on it runs once more", { skip: !onPostgres && "needs PostgreSQL" }, async () => {
  const real = createPostgresDb(process.env.DATABASE_URL!, { schema: postgresSchema(), max: 2, queryTimeout: 30_000, keepAlive: 10_000 });
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const warn = console.warn;
  try {
    const before = await real.one<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await admin.query("SELECT pg_terminate_backend($1)", [before!.pid]);
    // Whether the pool noticed already or the read meets the dead
    // connection (and runs again): it answers.
    console.warn = () => {};
    const after = await real.one<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    assert.notEqual(after!.pid, before!.pid);
    // A read-only transaction (a standby) answers 25006: the connection goes.
    const pid = await real
      .tx(async () => {
        await real.run("SET LOCAL transaction_read_only = on");
        const own = await real.one<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await real.run("CREATE TEMP TABLE failover_write(a int)").catch(async (error) => {
          assert.equal((error as { code?: string }).code, "25006");
          throw Object.assign(error, { pid: own!.pid });
        });
        return own!.pid;
      })
      .catch((error) => (error as { pid: number }).pid);
    const next = await real.one<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    assert.notEqual(next!.pid, pid, "not the read-only connection again");
  } finally {
    console.warn = warn;
    await admin.end();
    await real.close();
  }
});
