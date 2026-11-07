# Database layer: SQLite by default, PostgreSQL as an option

Status: **spike** (branch `pg-spike`). It proves the pattern on one vertical
slice – accounts and sessions (`lib/auth.ts`), sign-up and sign-in
(`lib/local-auth.ts`), personal API tokens (`lib/api-tokens.ts`) and tags
(`lib/page-properties-server.ts`) – on both databases, and measures what the
full refactor costs. Nothing changes for SQLite users: without
`DATABASE_URL` every statement takes the same path as before.

Roadmap this serves (decided): SQLite stays the default (one container).
PostgreSQL is optional (`DATABASE_URL=postgres://…`); later multi-instance
("cluster mode") with Redis (pub/sub for Yjs updates and presence, rate
limits, locks) and S3 both mandatory, a Postgres job queue (`FOR UPDATE SKIP
LOCKED`) with a leader for timed triggers, a documented migration tool in
both directions, Postgres full-text search (`tsvector`, per language) and
pgvector when available, backups with `pg_dump` in Postgres mode, Litestream
only in SQLite mode.

## 1. The interface

`lib/db-driver/index.ts` exports `db` (and `database()`), one object for the
whole process:

```ts
import { db } from "./db-driver";

const user = await db.one<User>("SELECT * FROM users WHERE id=?", id);
const rows = await db.all<Tag>(`SELECT * FROM page_tags WHERE workspace_id=? ORDER BY position,${db.dialect.nocase("name")}`, wid);
const { changes } = await db.run("UPDATE sessions SET last_seen=? WHERE token=?", now, token);
await db.exec("CREATE TABLE …; CREATE INDEX …");           // no parameters
await db.tx(async () => { await db.run(…); await helper(); }, { lock: "first-account" });
db.inTransaction(); await db.columns("users"); db.backend; // "sqlite" | "postgres"
```

| Method | SQLite (`lib/db-driver/sqlite.ts`) | Postgres (`lib/db-driver/postgres.ts`) |
|---|---|---|
| `one/all/run` | the existing synchronous helpers of `lib/db.ts` (statement cache, write generation for `read-memo`, runtime metrics), result wrapped in a promise | `pg` pool; `?` numbered to `$1…`; each distinct SQL text a named prepared statement per connection |
| `tx(fn)` | `BEGIN IMMEDIATE` … `COMMIT` through the same steps as `transaction()` (relation sync, upload cleanup, rollback hooks) | `BEGIN` on one pooled connection … `COMMIT` |
| nested `tx` | `SAVEPOINT` | `SAVEPOINT` |
| `tx(fn, { lock })` | nothing to do (one writer at a time) | `pg_advisory_xact_lock(hashtextextended(key))` |
| values | as today | `bigint`/`numeric` → number (exact to 2^53, as node:sqlite), `boolean` → 1/0, `bytea` → Buffer |

Selection: `DATABASE_URL=postgres://…` or `postgresql://…` → Postgres
(`FLOWPLAN_PG_SCHEMA` picks a schema, default `public`); anything else →
SQLite. `pg` is a plain dependency (added by the spike, no ORM); it is in
`serverExternalPackages`.

### Transaction semantics

- **Scope through AsyncLocalStorage.** `db.tx()` stores the transaction
  (Postgres: its connection) in an `AsyncLocalStorage`; every `db.*` call made
  inside – also in helpers that know nothing of it – runs in it. No handle is
  passed around, so ported helpers keep their signatures.
- **Nested = savepoint**, on both. On Postgres a failed statement spoils the
  whole transaction; code that catches an error and carries on must run the
  statement in a nested `db.tx()` (see `createTag()`: a unique violation in a
  savepoint becomes a 409, the outer transaction goes on). SQLite does not
  need this, so it is easy to miss: grep for `try` around writes inside
  transactions during the port.
- **Isolation.** SQLite serialises writers (`BEGIN IMMEDIATE`); Postgres runs
  `READ COMMITTED`. Every "check, then write" that relies on SQLite's
  serialisation needs an explicit lock on Postgres: `tx(fn, { lock })`
  (advisory lock; cluster-safe), `SELECT … FOR UPDATE`, or a unique key whose
  violation is mapped (`uniqueViolation(error)` knows both backends). Known
  places: the first account (ported, with a test of three simultaneous
  sign-ups), Yjs document merges (generation check → `FOR UPDATE` on the
  document row), row numbers (trigger), relation sync, quotas, tag/property
  names (unique indexes, ported: 409).
- **After the transaction.** `afterTransaction(fn)` (`lib/db-driver/context.ts`)
  runs `fn` once the caller's transaction has committed or rolled back,
  outside of it. Security events and refusal counters used
  `queueMicrotask`/`setImmediate` on the assumption "transactions never span an
  await"; inside an async transaction that microtask would still run inside it
  (rolled back with it on SQLite, refused on Postgres). Both now go through
  `afterTransaction`. It is also the hook for cluster mode (publish to Redis
  after commit).
- **One SQLite connection.** An async transaction holds it from `BEGIN` to
  `COMMIT`, also while it awaits. Async calls from outside wait for it
  (taken without an await between check and `BEGIN`; the spike found and
  fixed that race). Synchronous *writes* from outside are refused with a clear
  error (they would otherwise land in, and be rolled back with, someone else's
  transaction); synchronous reads are allowed. `afterTransaction` callbacks of
  other flows wait for the open transaction. Development builds warn when an
  async SQLite transaction spans I/O (a `setImmediate` fires while it is
  open): bodies of SQLite transactions should await database calls only,
  which resolve in microtasks.

### The transitional bridge

With `DATABASE_URL` set, the **synchronous** helpers of `lib/db.ts`
(`one/all/run/transaction`) go to Postgres through a blocking bridge
(`lib/db-driver/pg-sync.ts`): a worker thread owns one connection; the caller
posts the statement and waits on `Atomics.wait` until the answer is there.
It translates the mechanical SQLite-isms (`INSERT OR IGNORE`, `IS NOT ?`,
`ifnull`, `CURRENT_TIMESTAMP`, `LIMIT -1`) and refuses the rest with a hint.

This is what lets the refactor proceed on **two independent axes**:

1. **Dialect** – SQL that runs on both (helpers below). Can be done for any
   file, synchronously, without touching callers. On SQLite the helpers emit
   byte-identical SQL.
2. **Async** – `one(` → `await db.one(` and the `async` that spreads upwards.

With the bridge, axis 1 alone makes a code path work on Postgres. Axis 2 is
needed for throughput (the bridge blocks the event loop for every round trip)
and for cluster mode. Rules while both exist:

- Inside an async Postgres transaction, synchronous reads are allowed (they
  see what was committed before – fine for permission checks), synchronous
  writes are refused (the bridge's own connection could wait forever for the
  transaction's row locks while the event loop is blocked).
- Each bridge connection has `lock_timeout=10s` as a safety net.
- Not for production load: it is a development and CI aid while porting
  (open question 1).

## 2. Dialect

`lib/db-driver/dialect.ts` – fragments, never values:

| SQLite | helper | Postgres |
|---|---|---|
| `col=? COLLATE NOCASE` | `ieq(col)` | `lower(col)=lower(?)` |
| `ORDER BY name COLLATE NOCASE` | `nocase(expr)` | `lower(expr)` |
| `INSERT OR IGNORE INTO …` | `insertIgnore(rest)` | `INSERT INTO … ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | `upsert(t, cols, keys)` | `ON CONFLICT(keys) DO UPDATE` (note: REPLACE deletes the row – cascades! – the upsert does not; use the upsert on both) |
| `id IS NOT ?` | `isNot(col)` | `IS DISTINCT FROM` |
| `(SELECT value FROM json_each(?))` | `jsonValues()` | `(SELECT json_array_elements_text(?::json))` |
| `json_extract(c,'$.a.b')` | `jsonText(c, path)` | `(c::jsonb #>> '{a,b}')` |
| `CURRENT_TIMESTAMP` (text) | `nowText()` | `to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')` |
| `datetime('now','-7 days')` | `nowTextPlus('-7 days')` | `to_char(… + interval '-7 days', …)` |
| `unixepoch()*1000` | `nowMs()` | `(extract(epoch from clock_timestamp())*1000)::bigint` |
| `CAST(strftime('%s',c) AS INTEGER)*1000` | `textMs(c)` | `(extract(epoch from c::timestamp)*1000)::bigint` |
| `max(a,b,…)` / `min(a,b,…)` | `greatest(…)` / `least(…)` | `greatest` / `least` |
| `instr(h,n)` | `instr(h,n)` | `strpos(h,n)` |
| `LIKE` (ASCII case-insensitive) | `ilike(col)` | `ILIKE` |
| `lower(hex(randomblob(16)))` | `randomHex()` | `replace(gen_random_uuid()::text,'-','')` |
| `rowid` | – (emulated column, see Schema) | `rowid` |
| `last_insert_rowid()` / `.lastInsertRowid` | – | `RETURNING` (2 places) |
| `PRAGMA table_info` | `db.columns(t)` | `information_schema.columns` |

The Postgres driver (and the bridge) **refuses SQLite-only SQL** with the
helper to use (`sqliteOnly()`; strings are ignored), so an unported statement
fails loudly at its first run in CI instead of as a syntax error deep in a
request.

Kept deliberately: booleans as `INTEGER 0/1` (the type parser turns
Postgres' `true/false` from `EXISTS(…)` and comparisons into 1/0), timestamps
as the same `TEXT`/`INTEGER` columns as in SQLite. Both keep the code and the
migration tool simple (open question 5).

### Counts (whole code base, before the spike)

`app lib components scripts instrumentation.ts proxy.ts`, plus tests where
noted. "SQL lines" counts only lines that contain SQL keywords.

| Pattern | Occurrences | Files | Notes |
|---|---:|---:|---|
| `one(` | 1,150 | 208 | + 1,133 in tests |
| `all(` | 552 | 161 | + 218 in tests |
| `run(` | 1,538 | 228 | + 1,343 in tests |
| `transaction(` | 103 | 54 | + 29 in tests |
| `db()` direct / `.prepare(` | 15 / 157 | 8 / 16 | mostly migrations in `lib/db.ts` |
| `INSERT OR IGNORE` | 63 | 34 | mechanical (`insertIgnore`, bridge rewrites it) |
| `INSERT OR REPLACE` / `REPLACE INTO` | 11 | 10 | semantic review (delete+insert vs update) |
| `ON CONFLICT … DO` | 118 | 67 | portable as written (`excluded.` works) |
| `COLLATE NOCASE` | 33 | 17 | `ieq`/`nocase`; NOCASE folds ASCII only, `lower()` all letters |
| `json_each(` | 13 | 4 | `jsonValues` |
| `json_extract(` | 6 | 4 | `jsonText` |
| other `json_*(` | 4 | 2 | `json_object` in a trigger |
| `datetime(` | 48 | 16 | 22 outside `lib/db.ts` |
| `strftime(` | 2 | 1 | `textMs` |
| `unixepoch(`/`julianday(` | 25 | 1 | triggers in `lib/db.ts` |
| `CURRENT_TIMESTAMP` | 139 | 54 | 117 outside `lib/db.ts` (mostly `SET updated_at=CURRENT_TIMESTAMP`) |
| `last_insert_rowid` / `.lastInsertRowid` | 2 | 2 | `RETURNING` |
| `rowid` (SQL lines) | 32 | 11 | emulated column |
| `PRAGMA` | 79 | 9 | 18 outside `lib/db.ts` (account merge, importers, backup, move) |
| `sqlite_master` | 6 | 4 | |
| `ifnull(` / `instr(` / `group_concat(` | 2 / 23 / 1 | 1 / 10 / 1 | |
| `IS NOT ?` / `IS ?` | 15 | 11 | `isNot` |
| `LIKE` (SQL lines) | 79 | 37 | case semantics differ: review each |
| `GLOB` | 6 | 1 | |
| scalar `max(a,b)`/`min(a,b)` (SQL lines) | 7 | 5 | `greatest`/`least` |
| `LIMIT -1` / `randomblob` | 1 / 2 | 1 / 2 | |
| `BEGIN IMMEDIATE` / `SAVEPOINT` | 7 | 5 | `db.tx` |
| FTS5 (`MATCH`, `bm25`, `search_index`) | 4 + 24 refs | 3 + 5 | redesign: `tsvector` |
| `CREATE TRIGGER` | 95 triggers | `lib/db.ts` | search queue ~30, notifications, relation sync, row numbers, snapshots |
| `COUNT(*)` (bigint in Postgres) | 201 | 53 | handled by the type parser |
| `EXISTS(` as a value | 93 | 20 | handled by the type parser (1/0) |
| `SELECT *` / `t.*` | 459 | 128 | fine; `t.*` inside `UNION` with explicit columns breaks with the emulated rowid (1 place, fixed) |
| `INSERT INTO t VALUES` (no column list) | 45 | 11 | works (rowid is the last column) |

## 3. Schema

**Decision: translate the SQLite schema; do not rewrite it in a neutral
DSL.** `lib/db-driver/pg-schema.ts` runs on the schema *after* all SQLite
migrations (`scripts/db-pg-schema.mjs` builds an empty database with
`lib/db.ts`) and reads it structurally – `PRAGMA table_info`,
`foreign_key_list`, `index_list`/`index_xinfo` (including the collation of
unique keys) and the `CREATE INDEX` texts – and writes
`lib/db-driver/postgres-schema.json`. `ensurePostgresSchema()` adds what is
missing (tables, columns, indexes, foreign keys; never drops). A test checks
that the JSON matches the current migrations.

Why this is less work for ~all tables:

- **It already covers all of them.** 217 tables, 238 foreign keys, 100
  indexes, 22 CHECK constraints apply cleanly to Postgres 16 in ~1.4 s,
  idempotently. Left out on purpose: 95 triggers and the FTS5 table.
- **The SQLite schema stays exactly as it is** – no risk for existing
  instances. A DSL would mean rewriting 92 schema versions' worth of
  `CREATE`/`ALTER` (and their data steps) for both backends, re-deriving
  SQLite's own schema from it, and proving it identical.
- **New migrations stay one place.** A column added in `lib/db.ts` shows up
  in the JSON (`npm`-script / test reminds) and `ensurePostgresSchema` adds it.
  Data steps of migrations (backfills) must be written once against `Db` with
  dialect helpers (rule for the refactor).
- Mapping: `INTEGER` → `bigint` (ms timestamps), `REAL` → `double precision`,
  `BLOB` → `bytea`, `TEXT`/untyped → `text`; `INTEGER PRIMARY KEY
  AUTOINCREMENT` → identity; `DEFAULT CURRENT_TIMESTAMP` on text → the same
  text format; reserved words quoted (`time_entries.end` must be quoted in
  queries too); a `UNIQUE … COLLATE NOCASE` key → unique index on `lower()`;
  index expressions `ifnull` → `coalesce`, `x COLLATE NOCASE` → `lower(x)`;
  foreign keys to non-key columns (allowed by SQLite until a row is written)
  are reported and left out (none today).
- **`rowid`.** 32 queries order by SQLite's implicit `rowid` (insertion
  order as tiebreaker), a few delete by it. Each Postgres table gets a real
  `rowid bigint` identity column, last; the drivers drop it from results
  unless the statement names it. Cost found: `t.*` in a `UNION` with explicit
  columns (1 place). The migration tool keeps rowid values both ways.

Not covered by the translator, by design: triggers (port the ~15 that carry
logic to plpgsql or into the code – open question 10 – and replace the ~30
search-queue triggers with the Postgres search design), FTS5 (`tsvector` per
language), sqlite-specific maintenance (`PRAGMA optimize`, `VACUUM`,
Litestream).

## 4. Porting, and how async spreads

### What the spike ported

- `lib/auth.ts`: `identityFromToken`, `touchSession`, `identityFromRequest`,
  `sessionIdentityFromRequest`, `carryOverSession` (now one transaction),
  `upsertUser`; `issueSession`, `currentUser`, `endOtherSessions` use `db`.
- `lib/api-tokens.ts`: `identityFromApiToken`, `listApiTokens`.
  `createApiToken`/`revokeApiToken` stay synchronous: they run inside
  `command()`.
- `lib/local-auth.ts`: `register` (transaction with `lock`), `passwordLogin`,
  `firstAccount` and its callers (`loginOptions`, `signupOpen`,
  `invitedEmail`, `setupWarning`, setup restore, scheduled backup),
  `resendVerification`, `requestPasswordReset`.
- Tags: `listTags`, `saveTag` (+ `syncTagFieldOptionsAsync`, `auditAsync`)
  as **async twins** next to the synchronous `workspaceTags`/`contextTags`/
  `tag.save` case of `command()`. The synchronous tag SQL went through the
  dialect helpers, so the old path runs on Postgres through the bridge.
- `read-memo` stays correct on Postgres: writes and rollbacks through the
  bridge and the Postgres driver move `writeGeneration()` as SQLite writes do
  (`noteWriteOf`).
- Out of the slice but on its way: `lib/inactive-accounts.ts` (dialect), one
  `UNION` in `lib/api.ts`, `securityEvent`/`recordOpsEvent`
  (`afterTransaction`).

Two patterns, both needed:

- **In place** when the cone is small: the identity path (7 functions, 28
  call sites, exactly as `scripts/db-async-impact.mjs` predicted), the
  first-account path (6 functions, 23 sites).
- **Async twin** when the cone is large: `workspaceTags`/`contextTags` reach
  121 functions; `tag.save` lives in `command()`. The twin shares the SQL
  fragments and is deleted when the last synchronous caller is gone. Twins
  duplicate control flow – keep them few and short-lived.

### How far `async` spreads (measured)

`scripts/db-async-impact.mjs` builds the call graph with the TypeScript
compiler (TypeScript 7 has no JS API yet: set `TS_API` to a typescript@5
package) and follows it upwards: every synchronous function that calls one
of the given ones becomes async, and so on. "Callbacks" are calls inside a
function passed to something else (`arr.map(x => …)`): they need a
`Promise.all`/loop rewrite, not just `await`. Callbacks of `transaction` are
the transaction bodies – they become `db.tx(async () => …)` mechanically.

| Starting point | Functions → async | Call sites needing `await` | Files | Callbacks (of which `transaction`) | Direct test calls |
|---|---:|---:|---:|---:|---:|
| `requirePage` | 384 | 933 | 159 | 95 (26) | 135 |
| `pageRole` | 705 | 1,706 | 196 | 221 (63) | 156 |
| `command` | 47 | 95 | 22 | 26 (16) | 16 |
| `workspaceTags`+`contextTags` | 121 | 232 | 44 | 42 (25) | 18 |
| `identityFromToken` | 6 | 11 | 6 | 2 | 6 |
| `firstAccount` | 10 | 23 | 8 | 1 (1) | 39 |
| **`one`+`all`+`run`+`transaction` (everything)** | **2,111** | **8,506** | **317** | **1,066 (521)** | **626** |

The full conversion by area: `lib` 7,869 call sites, `app/api` 584, app
pages/RSC 25, components 28. Non-transaction callbacks: `map` 218, `filter`
95 (a filter cannot be async: becomes a loop), `withRequestLocale` 71,
`forEach` 45, `flatMap` 18, `quietly` 17, others ~100. Places where async is
impossible: 2 constructors and 1 module top level (`lib/ai/access.ts`).
`permissions.ts` is the hub: almost every path reaches `pageRole`.

### Order and tooling for the full refactor

1. **Foundation** (this spike, hardened): CI job running the whole suite with
   `DATABASE_URL` (one Postgres service, a schema per test file –
   `tests/helpers/postgres-backend.ts` does that already), the JSON schema
   check, the SQLite-only refusal.
2. **Dialect pass, file by file, synchronous** – no callers change. Order by
   dependency: `lib/db.ts` data steps of migrations → `permissions.ts`,
   `read-memo` → `api.ts` (command, bootstrap, pageData) → features. Each file
   is "done" when its tests pass on Postgres through the bridge. Triggers and
   search redesign run in parallel. Result: Postgres works (single instance,
   bridge), SQLite unchanged.
3. **Async sweep** with `scripts/codemod-await.mjs`: it wraps calls of the
   given functions in `await`, marks the enclosing functions `async` (return
   types `Promise<…>`), follows file-local helpers to a fixpoint, turns
   `assert.throws` into `assert.rejects`, and removes redundant parentheses.
   Applied to the spike's slice: 530 edits in 42 test files and ~20 app/lib
   files, type-clean afterwards. Plan it per layer, from the leaves up:
   `one/all/run` → `db.one/…` in a file, then the impact tool's list for that
   file's exports, codemod across the cone, `tsc`, tests. Because the cones
   overlap so much (`pageRole` touches 196 files), the realistic shape is a
   short freeze with a few large, mechanical PRs (permissions+api, then
   features, then workers/integrations), not hundreds of small ones.
4. **Callbacks by hand**: `map` → `Promise.all(map(async …))` only where
   order and concurrency do not matter (inside a transaction: a `for` loop –
   statements of one connection run one after another anyway); `filter`,
   `sort` comparators, `some/every/find` → loops.
5. **Delete the bridge and the sync helpers**; `lib/db.ts` keeps the SQLite
   connection and migrations only.

Pitfalls the spike hit (all caught by tests or `tsc`, except the first):

- `assert.ok(promise)`, `if (!!promise)`, `promise ? a : b` are always truthy
  and `tsc` does not flag all of them (it does flag `if (promise)`: TS2801).
  The codemod awaits every call of a target, so it closes the gap where it
  runs; elsewhere add a lint rule (`no-misused-promises` with type info) for
  the sweep.
- Microtask deferrals that assumed "transactions never span an await"
  (security events, ops counters; webhooks dispatch uses one too) –
  `afterTransaction`.
- A check-then-act gap in the SQLite driver itself (two transactions both
  `BEGIN`) – fixed; a test covers it.
- Name clashes in a codemod across files (`session()`, `person()` test
  helpers) – the codemod tracks discovered names per file.

## 5. Tests

- Without `DATABASE_URL`: unchanged, SQLite.
- With `DATABASE_URL=postgres://…`, `tests/helpers/cleanup.mjs` (already
  preloaded for every test file) calls `preparePostgres()`
  (`tests/helpers/postgres-backend.ts`): a schema of its own per test
  process, created from the JSON, dropped at exit (`--drop-all` cleans up
  after aborted runs). Synchronous test helpers (`run("INSERT …")`) reach it
  through the bridge.
- `tests/db-driver.test.ts`: the layer (placeholders, types, commit,
  rollback, savepoints, `afterTransaction`, locks, the refusal rules) and the
  slice end to end, on whichever backend is configured.
- Results of the spike, Postgres 16:
  `sessions` 9/9, `app-devices` 7/7, `local-auth` 10/10, `first-account` 2/2
  (three simultaneous sign-ups, one admin), `db-driver` 10/10 (+1 SQLite-only),
  `read-memo` 15/16 (the 16th opens the SQLite file directly).
  `page-properties`, `meta-scope`, `tag-fields` do **not** pass on Postgres
  yet, for reasons outside the slice that show the next work: the FTS5
  `search_index`, `datetime()` in snapshots, `COLLATE NOCASE` in
  `meta-scope-server.ts`, and two tests that check SQLite migrations with
  `PRAGMA`/`sqlite_master`.

## 6. Migration tool

`node scripts/db-migrate.mjs --from sqlite:<file> --to postgres://…` and
`--from postgres://… --to sqlite:<file>` (plain Node, no TypeScript loader;
`--tables slice|all|a,b`, `--batch`, `--schema`, `--verify-only`).

- Refuses a source whose schema version differs from this version's
  (`PRAGMA user_version` / `flowplan_meta`), a non-empty target table, an
  existing target file.
- Copies table by table in batches ordered by `rowid` (kept on both sides),
  values converted by the Postgres column type (refuses with the row when a
  value does not fit – SQLite keeps any value in any column; NUL in text).
- Into Postgres: foreign keys dropped for the copy and re-added afterwards
  (validated; no superuser needed), identity sequences continue after the
  copied values, `ANALYZE`.
- Into SQLite: the schema exactly as SQLite had it (tables, then after the
  copy indexes, triggers and the FTS table from the JSON), `PRAGMA
  foreign_key_check`, `user_version`, the search index rebuilt by Flowplan on
  start.
- Verifies every table: row count and an order-independent checksum (sum of
  64-bit SHA-256 prefixes of each row's canonical values, typed by the
  Postgres column type).
- Tried on a seeded instance (41 accounts, 123 sessions, 14 tokens, 60 tags,
  example pages): SQLite → Postgres (all 217 tables, 1.1 s) → SQLite, same
  checksums everywhere; Flowplan opens the result (integrity and foreign keys
  OK, sign-in works) and runs on the Postgres copy (sign-in, tags, the next
  identity value continues).
- Missing for production: progress for large tables, files/uploads (they stay
  where they are; S3 in cluster mode), resumability, a maintenance-mode
  switch, `pg_dump`-based backups in Postgres mode.

## 7. Performance

`node --import tsx scripts/db-bench.mjs postgres://…` – 20,000 point queries
(user by primary key, `SELECT *`, 10,000 users), median of 3, one Node
process, Postgres 16 on the same machine over TCP:

Two runs (µs per query; run-to-run noise is about ±15 %):

| Path | run 1 | run 2 |
|---|---:|---:|
| SQLite, synchronous `one()` (today) | 10.8 | 11.7 |
| SQLite, async `db.one()` awaited one by one | 12.3 | 9.7 |
| SQLite, async `db.one()` inside one `db.tx()` | 10.1 | 10.8 |
| Postgres, async, one by one | 91.8 | 89.5 |
| Postgres, async, 16 in flight | 54.0 | 51.2 |
| Postgres, async, inside one `db.tx()` | 84.9 | 88.1 |
| Postgres, async, unnamed statements | 145.0 | 132.1 |
| Postgres, synchronous bridge | 185.2 | 173.9 |

Reading: the async wrapper's cost on SQLite is below the noise of this
benchmark (at most ~1.5 µs per statement, i.e. well under 0.1 ms for a
request with 50 statements). Postgres is ~8× slower per round trip locally
(about 90 µs; a separate host adds network latency), about 20,000 point
queries/s from one Node process with 16 in flight. Requests that issue many
small sequential queries (permission checks per page) will feel it, which
argues for batching those lookups (`read-memo` already helps) before cluster
mode. Named prepared statements are worth 1.5×. The bridge costs 2× the
async driver and blocks the event loop – acceptable for development, not for
load.

## 8. What Redis/cluster mode needs from this layer

- **Commit hooks:** `afterTransaction` is where Yjs updates, presence and
  invalidations get published (Redis pub/sub) – only after the data is
  committed. For delivery guarantees: write an outbox row in the transaction,
  publish after commit, let the leader re-publish stragglers.
- **Locks:** `tx(fn, { lock })` is an advisory lock in Postgres – already
  cluster-wide. Yjs document merges need `FOR UPDATE` (or an advisory lock
  per document) instead of SQLite's single writer.
- **Job queue and leader:** a dialect-level `claim(n)` with `FOR UPDATE SKIP
  LOCKED` (SQLite: the single process claims); the leader holds
  `pg_try_advisory_lock` on a dedicated session connection (released when the
  instance dies) – no Redis needed for leadership. The 33 background workers
  with timers in `lib/` must run on the leader only or claim their work.
- **No process-local truth:** `action-limits.ts` counts in memory (→ Redis);
  presence tables (`editor_presence`, `whiteboard_presence`) are written at
  high frequency (→ Redis); `read-memo` and the statement cache are per
  request/connection and stay. The write generation (`writeGeneration()`) is
  per process – fine as long as memos stay request-scoped.
- **Connections:** pool size × instances ≤ `max_connections` (or PgBouncer;
  named statements need PgBouncer ≥ 1.21 with `max_prepared_statements`, or
  `prepare: false`); `statement_timeout`/`lock_timeout` per connection.
- **No synchronous paths:** the bridge and every remaining synchronous helper
  must be gone – cluster mode starts after step 5 above.

## 9. Effort estimate

Person-days for one developer who knows the code, with the tooling of the
spike; ranges reflect the review effort the codemod cannot remove.

| Area | Basis | Days |
|---|---|---:|
| Foundation: harden driver, CI with Postgres, compose example, docs | spike | 3–5 |
| Dialect pass (sync, bridge): ~350 SQL sites + 117 `CURRENT_TIMESTAMP` | counts in §2 | 8–12 |
| Triggers: ~15 with logic (notifications, relation sync, row numbers, snapshots) | 95 triggers | 3–5 |
| Search on Postgres (`tsvector` per language, ranking parity), queue without triggers | 24 refs, ~30 triggers | 6–10 |
| Async sweep, core: `permissions` + `api.ts` (command, bootstrap, pageData) | 705 fns / 1,706 sites | 10–15 |
| Async sweep, rest of `lib`, routes, RSC; callbacks by hand (~550 non-transaction) | 2,111 fns / 8,506 sites | 12–18 |
| Tests: codemod + fixes (626 direct calls, helper cascades) | 227 files | 5–8 |
| Isolation review: check-then-act sections, Yjs merges, retries | §1 | 3–5 |
| Migration tool to production quality, `pg_dump` backups, upgrade docs | §6 | 4–6 |
| **Database part total** | | **54–84** |
| pgvector (when available) | | 3–5 |
| Cluster mode (Redis pub/sub, rate limits, presence, S3 mandatory, queue + leader) | §8 | 15–25 |

## 10. Open questions for the maintainer

1. **The bridge:** a development/CI aid only (Postgres unsupported until the
   async sweep is done), or ship "Postgres, single instance, experimental"
   on top of it earlier?
2. **Order:** dialect pass first (Postgres usable early, refactor risk later)
   or async sweep first (one big mechanical change, then dialect)?
3. **Sweep shape:** a short code freeze with a few large codemod PRs, or
   long-lived twins for big cones? The measured cones favour the freeze.
4. **Case-insensitive names:** `lower()` (no extension, folds every letter –
   Ä = ä, slightly wider than SQLite's ASCII NOCASE) or `citext` (extension
   needed; managed Postgres usually has it)?
5. **Types:** keep SQLite's `TEXT` timestamps and `INTEGER` booleans on
   Postgres (as the spike does: least change, simple migration tool) or move
   to `timestamptz`/`boolean` later?
6. **`rowid`:** keep the emulated column, or rewrite the 32 queries to order
   by explicit columns (`created_at, id`) and drop it?
7. **Schema source:** SQLite migrations + translator (proposed), with the
   rule that data steps are written against `Db`?
8. **Isolation:** `READ COMMITTED` + explicit locks per critical section
   (proposed) or `SERIALIZABLE` with automatic retries?
9. **Async SQLite transactions** hold the only connection across their
   awaits; synchronous writes from other requests are refused meanwhile.
   Acceptable during the transition with the rule "bodies await database
   calls only" (warned in development), or should async transactions on
   SQLite be deferred until the sweep is complete?
10. **Triggers:** port to plpgsql (parity) or move their logic into the code
    (one implementation for both)?
11. **Bundling:** the bridge worker (`new Worker(new URL(…))`) and `pg` in
    the standalone build are configured but not verified with `next build`
    in the spike.
