# Database layer: SQLite by default, PostgreSQL as an option

Status: **phase 1 done – every statement runs on both databases**
(issue #127). The spike (branch `pg-spike`) proved the pattern on one
vertical slice and measured the cost; phase 1 made all SQL of the code base
dialect-neutral, still synchronous, with the behaviour on SQLite unchanged
(§11). Phase 2 is the asynchronous sweep (§4). Nothing changes for SQLite
users: without `DATABASE_URL` every statement takes the same path as
before.

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
Since phase 1 it no longer rewrites anything: the SQL is written for both
databases, the bridge only numbers the placeholders and refuses SQLite-only
SQL with a hint (`sqliteOnly()`, the same check as the asynchronous driver).
`transaction()` takes the same steps on both (relation sync before the
commit, rollback hooks, the upload cleanup after it).

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
  (decided: not shipped as a product mode).

## 2. Dialect

**Rule since phase 1: SQL is written once, for both databases.** Where the
two need different text, the fragment comes from the dialect;
everything else is plain SQL both accept (SQLite ≥ 3.39 reads
`IS [NOT] DISTINCT FROM`, `ON CONFLICT … DO NOTHING`, row values).

- Asynchronous code: `db.dialect` (lib/db-driver).
- Synchronous code (`one/all/run`): `sql` from `lib/db.ts` – the dialect of
  this process (`sql.instr("d.html", "?")`), and `nowText()`/`daysAgoText()`.

Values that SQLite computed in SQL are now computed in JavaScript and
passed as parameters where that is simple: `CURRENT_TIMESTAMP` in a query
became `?` with `nowText()` (`'YYYY-MM-DD HH:MM:SS'`, UTC – the same text);
`datetime('now','-5 minutes')` became `nowText(Date.now() - 300_000)`,
`datetime('now',?)` with `-N days` `daysAgoText(N)`.

| SQLite | now (both) | Postgres side of a helper |
|---|---|---|
| `x=? COLLATE NOCASE`, `ORDER BY x COLLATE NOCASE` | `lower(x)=lower(?)`, `ORDER BY lower(x)` (also what `ieq`/`nocase` give on SQLite now) | – |
| `INSERT OR IGNORE INTO …` | `INSERT INTO … ON CONFLICT DO NOTHING` (`… SELECT … WHERE true ON CONFLICT …`: SQLite's parsing rule) | – |
| `INSERT OR REPLACE` | `ON CONFLICT(key) DO UPDATE SET` every other column `=excluded.…` (defaults included, as the replaced row had them); one case stays delete + insert because a trigger reacts to the insert (`file_texts`) | – |
| `UPDATE OR IGNORE` | `updateIgnoringConflicts()` (lib/db.ts: all rows in a savepoint, on a unique violation row by row) | – |
| `a IS ?`, `a IS NOT ?`, `a IS b` | `IS NOT DISTINCT FROM`, `IS DISTINCT FROM` | – |
| `CURRENT_TIMESTAMP`, `datetime('now',…)` in queries | parameter `nowText(…)` / `daysAgoText(n)` | – |
| `date(c,?)`, `date(ms/1000,'unixepoch',?)` | `sql.dayOf(c)`, `sql.dayOfMs(c)` | `to_char(c::timestamp+?::interval,'YYYY-MM-DD')` |
| `(SELECT value FROM json_each(?))` | `sql.jsonValues()` | `(SELECT json_array_elements_text(?::json))` |
| `json_extract(c,'$.a')`, `json_extract(c,?)` | `sql.jsonText(c,'$.a')`, `sql.jsonKey(c)` (the key as parameter) | `c::jsonb #>> '{a}'`, `c::jsonb->>?` |
| `json_group_array`, `json_object` | `sql.jsonGroupArray`, `sql.jsonObject` | `json_agg`/`json_build_object` |
| `GROUP_CONCAT` | `sql.groupConcat` (the one use was unused: dropped) | `string_agg` |
| `instr(h,n)` | `sql.instr(h,n)` | `strpos` |
| scalar `MAX(a,b)` | `sql.greatest(a,b)` | `greatest` |
| `length(CAST(x AS BLOB))` | `sql.byteLength(x)` | `octet_length` |
| `LIKE` meant case-insensitive | `sql.ilike(col)` (the title search of the app intents, the search's short queries) | `ILIKE` |
| `GLOB '*.docx'` on `lower(name)` | `LIKE '%.docx'` | – |
| `… LIMIT -1 OFFSET ?` | `NOT IN (… LIMIT ?)` | – |
| `char(10)` | `'\n'` literal | – |
| `SUM(a=b)`, `(x>0)*2` | `SUM(CASE WHEN a=b THEN 1 ELSE 0 END)` | – |
| bare columns of `GROUP BY` | `MAX(col)` | – |
| `HAVING n>=?` on an alias, `x day` | the expression; `AS day` (keywords need `AS`) | – |
| `SET n=n+1` in `ON CONFLICT … DO UPDATE` | `SET n=t.n+1` (ambiguous on Postgres) | – |
| `AS userId` | `AS "userId"` (Postgres folds unquoted names) | – |
| `?1` numbered parameters | one `?` per value | – |
| `.lastInsertRowid` | `INSERT … RETURNING id` (2 places) | – |
| `PRAGMA table_info` / `foreign_key_list`, `sqlite_master`, `dbstat` | `tableNames()`, `tableColumns()`, `tableKey()`, `foreignKeyColumns()`, `tableSizes()`, `databaseBytes()` (lib/db.ts) | `information_schema`, `pg_constraint`, `pg_total_relation_size` |
| `VACUUM INTO` | `snapshotDatabase()` (lib/db-snapshot.ts, §3) | – |
| `rowid` | `seq` or a key (§3) | – |
| `time_entries.end` | `"end"` | – |
| `? IS NULL` | as written; the Postgres driver casts such a parameter (`$1::text IS NULL`) – no type otherwise | – |

The Postgres driver and the bridge **refuse SQLite-only SQL** with the
helper to use (`sqliteOnly()`; strings are ignored): `INSERT/UPDATE OR …`,
`REPLACE INTO`, `COLLATE NOCASE`, `json_*`, `group_concat`, date
functions, `ifnull`, `instr`, `randomblob`, `last_insert_rowid`, `rowid`,
`PRAGMA`, `sqlite_master`, `IS NOT ?`, `GLOB`, `BEGIN IMMEDIATE`,
`VACUUM INTO`, `?NNN`.

Kept deliberately (decided): booleans as `INTEGER 0/1` (the type parser
turns Postgres' `true/false` from `EXISTS(…)` and comparisons into 1/0),
timestamps as the same `TEXT` (`'YYYY-MM-DD HH:MM:SS'`, UTC) and `INTEGER`
(ms) columns as in SQLite. Case-insensitive names: `lower()` on both sides,
no `citext` (Postgres' `lower()` folds every letter, SQLite's ASCII only –
a small widening).

**Writes whose failure is caught** inside a transaction (a delete of rows
of a table that may not have the column, an account row still referenced)
run in `inSavepoint()` (lib/db.ts): on Postgres a failed statement spoils
the whole transaction otherwise. Outside a transaction it just runs.

### Counts

`node scripts/db-dialect-scan.mjs [--list] [--tests]` reads the string and
template literals of `app lib components scripts integrations
instrumentation.ts proxy.ts`, keeps the SQL ones and counts the patterns
that do not run on Postgres as written. Not counted: `lib/db.ts`'s
migrations (the SQLite schema, translated), `lib/db-driver`, the
substitutions themselves (`${sql.instr(…)}`), lines marked `// sqlite-only`
(code that only touches SQLite files: backup checks, the SQLite branch of a
helper) and files marked `db-dialect-scan: sqlite-only file` (the AFFiNE
importer reads AFFiNE's own SQLite files; scripts that seed a SQLite
instance).

| Pattern | Before phase 1 | After |
|---|---:|---:|
| `INSERT OR IGNORE` | 54 (32 files) | 0 |
| `INSERT OR REPLACE` / `REPLACE INTO` | 11 (10) | 0 |
| `COLLATE NOCASE` | 17 (14) | 0 |
| `json_each`/`json_extract`/`json_*` | 19 (8) | 0 |
| `datetime()`/`date()`/`strftime()`/`julianday()`/`unixepoch()` | 25 (12) | 0 |
| `CURRENT_TIMESTAMP` in queries | 108 (48) | 0 |
| `rowid` | 35 (17) | 0 |
| `PRAGMA` | 14 (8) | 0 |
| `sqlite_master` / `sqlite_schema` | 3 (3) | 0 |
| `instr()` | 14 (6) | 0 |
| `group_concat()` | 1 | 0 |
| `IS ?` / `IS NOT ?` | 14 (10) | 0 |
| `GLOB` | 6 (1) | 0 |
| `LIMIT -1` | 1 | 0 |
| `BEGIN IMMEDIATE` | 2 (2) | 0 |
| scalar `MAX(a,b)` | 8 (6) | 0 |
| `char()` | 2 (1) | 0 |
| mixed-case alias without quotes | 1 | 0 |
| `?NNN` parameters | 2 (1) | 0 |
| `CAST(… AS BLOB)` | 1 | 0 |
| not visible to the scan (found by the Postgres run): `.lastInsertRowid` 2, `VACUUM INTO` 3, `UPDATE OR IGNORE` 2, `SUM(bool)`/bare `GROUP BY` columns 4, `SET n=n+1` in upserts 6, `x IS y` 2, `end` unquoted 13 | 32 | 0 |
| `LIKE` – reviewed, not SQLite-only | 74 (37) | 71 |

The 71 `LIKE`s left compare ids, fixed lower-case markers (`'%"git"%'`,
`'deleted:%'`) or links, where case does not matter; the ones that match
what people type use `sql.ilike` or `lower()` on both sides. With
`--tests`: the remaining hits are SQLite files the tests build themselves
(the AFFiNE fixture, an old schema for a migration test) and tests skipped
on Postgres (below).

## 3. Schema

**Decision: translate the SQLite schema; do not rewrite it in a neutral
DSL.** `lib/db-driver/pg-schema.ts` runs on the schema *after* all SQLite
migrations (`scripts/db-pg-schema.mjs` builds an empty database with
`lib/db.ts`) and reads it structurally – `PRAGMA table_info`,
`foreign_key_list`, `index_list`/`index_xinfo` (including the collation of
unique keys) and the `CREATE INDEX` texts – and writes
`lib/db-driver/postgres-schema.json`. `ensurePostgresSchema()` adds what is
missing (tables, columns, indexes, foreign keys, triggers, the seed rows;
never drops). A test checks that the JSON matches the current migrations.

- **Coverage:** 224 tables, 244 foreign keys, 103 indexes, 109 triggers (95
  translated, the 14 `seq` triggers of SQLite skipped – see below), the rows the
  migrations write into a new database (`seed`: relation sync control,
  notification defaults, counters, offline log start; a creation time is
  stored as `"now"`).
- **The SQLite schema stays as it is** – no risk for existing instances.
  New migrations stay one place: a column added in `lib/db.ts` shows up in
  the JSON and `ensurePostgresSchema` adds it.
- Tables that features used to create on first use (`background_jobs`,
  `caldav_profile_links`, `mobile_focus`, `widget_counter_days`,
  `widget_focus`, `notification_targets`, the storage queue) moved into the
  migrations, so the translated schema has them.
- Mapping: `INTEGER` → `bigint` (ms timestamps), `REAL` → `double
  precision`, `BLOB` → `bytea`, `TEXT`/untyped → `text`; `INTEGER PRIMARY
  KEY AUTOINCREMENT` and `seq` → identity; `DEFAULT CURRENT_TIMESTAMP` on
  text → the same text (the statement's time, as SQLite); reserved words
  quoted (`time_entries."end"`, also in queries); a `UNIQUE … COLLATE
  NOCASE` key → unique index on `lower()`; index expressions `ifnull` →
  `coalesce`, `x COLLATE NOCASE` → `lower(x)`.
- **No `rowid` any more (schema 93).** The spike gave every Postgres table
  an emulated `rowid`. Now no query uses SQLite's rowid: where insertion
  order matters (newest notification, version or message first, favourites
  in the order added, queues, spaces and pages as tie-breakers) the table
  has an explicit `seq` column – `snapshots`, `row_snapshots`,
  `notifications`, `favorites`, `row_favorites`, `capture_targets`,
  `inline_messages`, `files`, `collections`, `scim_users`, `scim_groups`,
  `mail_queue`, `webhook_deliveries`, `spaces`, `pages`. SQLite fills it
  with the rowid (existing rows once, new ones by a `<table>_seq` trigger;
  pages in the trigger that already sets `created_at`, so no extra
  statement); Postgres makes it an identity. Elsewhere a key or another
  column does: the embedding scan pages by its primary key, notification
  pruning by id, records by `number`, the first owner of a workspace is its
  creator. The unique scope-name indexes of tags and property definitions
  are on `lower(name)` on both databases now.
- **Search index.** FTS5 stays on SQLite. On Postgres `search_index` is a
  plain table (`page_id,row_id,title,body` plus `title_folded`,
  `body_folded`: lower case without diacritics), see §5a.

### Triggers (decided per group)

All SQLite triggers are inventoried in the translated schema: the 95 of
before phase 1 plus the 14 `seq` triggers of schema 93. **Decision:
translate them to PL/pgSQL** (lib/db-driver/pg-triggers.ts) rather than
port them into application code: the writes they react to are spread over
hundreds of statements (21 places insert notifications, every write of
`rows`, `pages`, `documents` …), so code would have to repeat them at each
place – nothing there is "simple and centralised". One implementation per
database, generated from the same SQLite text, keeps them identical. The
translator moves the `WHEN` into the function (Postgres' `WHEN` takes no
subqueries), turns `RAISE(IGNORE)` into `RETURN NULL` (row skipped, as in
SQLite), `RAISE(ABORT,'…')` into an exception with the same message,
`IS`/`IS NOT` into `IS [NOT] DISTINCT FROM`, `json_object` into
`jsonb_build_object`, `instr` into `strpos`, `unixepoch()*1000` into whole
seconds and `julianday('now')` arithmetic into milliseconds (as SQLite has
them), and adds `ON CONFLICT DO NOTHING` to queue inserts guarded by `NOT
EXISTS` (READ COMMITTED lets two transactions pass the guard).

| Group | Triggers | Decision |
|---|---:|---|
| Search queue (`search_*` → `search_dirty`) | 31 | PL/pgSQL; replaced together with the queue when search moves to `tsvector` (later phase) |
| Offline change log (`offline_*` → `offline_changes`) | 18 | PL/pgSQL |
| End-to-end encryption guards (`e2ee_*`: refuse plaintext, drop keys of removed members) | 17 | PL/pgSQL (a guard must hold for every write path) |
| AI queues (`ai_embed_*`, `ai_auto_*`) | 12 | PL/pgSQL |
| Insertion order (`<table>_seq`, schema 93) | 14 | SQLite only: `seq` is an identity on Postgres |
| Relation sync (`relation_row_*` → `relation_changes`) | 3 | PL/pgSQL (flushed by `transaction()` on both) |
| Notifications (`notification_inbox_pref` skips, `queue_notification_push`/`_messenger` queue) | 3 | PL/pgSQL |
| Space Git exports (`space_git_*` end exports on owner/trash/member changes) | 4 | PL/pgSQL |
| Record numbers (`rows_number_counter`: counter row update, serialises per database) | 1 | PL/pgSQL |
| Snapshot appearance, page `created_at` (+ `seq` on SQLite), space position, home layouts, document tasks | 6 | PL/pgSQL; `spaces_position_insert` and `pages_created_at` hand-written (no rowid) |
| Object storage queue (`storage_file_*`, only with S3) | 2 | SQLite: calls a JS function; Postgres: a PL/pgSQL trigger fills the queue, the worker polls it every 0.5 s (lib/storage.ts) |

### Backups, restores, instance moves

Backups stay **SQLite files on both databases**. `snapshotDatabase(path)`
(lib/db-snapshot.ts) is `VACUUM INTO` on SQLite; on Postgres it writes the
same file from the translated schema and the data (one `REPEATABLE READ`
transaction, key order). A restore or move on Postgres (lib/db-restore.ts)
keeps the current state as such a file (as SQLite keeps the swapped-out
file), brings the backup up to this schema with the SQLite migrations and
refills every table in one transaction (foreign keys dropped and re-added,
user triggers disabled meanwhile, identities moved on); the search index is
rebuilt. So a backup made on either database restores on either.
`pg_dump` remains the tool for Postgres-side backups in production.

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
2. **Dialect pass, synchronous – done (phase 1, §11).** All SQL runs on
   both databases; the whole suite passes on SQLite and on Postgres through
   the bridge. Search keeps a dialect seam (`lib/search-store.ts`) until its
   `tsvector` design.
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
- With `DATABASE_URL=postgres://…`, `tests/helpers/cleanup.mjs` (preloaded
  for every test file) calls `preparePostgres()`
  (`tests/helpers/postgres-backend.ts`): a schema of its own per test
  process, created from the JSON (tables, triggers, seed rows), dropped at
  exit (`--drop-all` cleans up after aborted runs). Synchronous test helpers
  (`run("INSERT …")`) reach it through the bridge. A test that switches to a
  fresh instance (`tests/setup-restore.test.ts`) gets a fresh schema, as it
  gets a fresh data folder on SQLite: `reopenDatabase()` connects anew when
  `FLOWPLAN_PG_SCHEMA` changed.
- `tests/helpers/backend.ts`: `onPostgres`, and `sqliteOnly` as a `skip`
  reason for the tests that check SQLite itself (see below).
- `tests/db-driver.test.ts`: the layer (placeholders, types, commit,
  rollback, savepoints, `afterTransaction`, locks, the refusal rules) and the
  slice end to end, on whichever backend is configured.
- Results: §11.

```sh
# a throwaway Postgres 16 (as the postgres user)
initdb -D /tmp/fp-pg/data -U postgres --auth=trust
pg_ctl -D /tmp/fp-pg/data -o "-p 55433 -k /tmp/fp-pg -c max_connections=400 -c max_locks_per_transaction=256 -c fsync=off" start
createdb -h localhost -p 55433 -U postgres flowplan_test
DATABASE_URL=postgres://postgres@localhost:55433/flowplan_test npm test
```

Each test schema has ~1,000 objects; dropping one locks them all, and a
snapshot or restore reads every table in one transaction: with the default
`max_locks_per_transaction=64` parallel test processes can run out of lock
slots ("out of shared memory"), hence 256 above.

## 5a. Search on Postgres (until `tsvector`)

`lib/search-store.ts` is the one place that stores and matches search
entries (lib/search-index.ts decides what goes in, lib/collections.ts and
lib/related-pages.ts query it). SQLite: FTS5 with the trigram tokenizer,
BM25 with the title ten times the text – unchanged. Postgres: the entries in
a plain table with their title and text folded (lower case, without
diacritics, in JavaScript); a phrase matches where the folded text contains
it – what the trigram index finds – ranked by where the phrases occur
(title 10, text 1); snippets are cut in JavaScript around the first hit
with the same markers. Good enough for correctness and the tests; the
`tsvector` design (per language, `pg_trgm` for substrings) replaces it and
the search queue triggers in a later phase.

## 6. Migration tool

`node scripts/db-migrate.mjs --from sqlite:<file> --to postgres://…` and
`--from postgres://… --to sqlite:<file>` (plain Node, no TypeScript loader;
`--tables slice|all|a,b`, `--batch`, `--schema`, `--verify-only`).

- Refuses a source whose schema version differs from this version's
  (`PRAGMA user_version` / `flowplan_meta`), a non-empty target table, an
  existing target file.
- Copies table by table in batches in primary-key order (`seq` values kept
  on both sides; the search index is not copied but rebuilt),
  values converted by the Postgres column type (refuses with the row when a
  value does not fit – SQLite keeps any value in any column; NUL in text).
- Into Postgres: foreign keys dropped for the copy and re-added afterwards
  (validated; no superuser needed), triggers created after the copy (and
  no seed rows: the copy brings its own), identity sequences continue after
  the copied values, `ANALYZE`.
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

## 10. Decisions (questions of the spike, answered)

1. **The bridge** is a development and CI aid only, not a product mode.
2. **Order:** dialect pass first (phase 1, done), then the asynchronous
   sweep by codemod (phase 2).
3. **Sweep shape:** a short freeze with a few large codemod PRs.
4. **Case-insensitive names:** `lower()` on both sides, with indexes on
   `lower(col)` where an index existed; no `citext`.
5. **Types:** `TEXT` timestamps (`'YYYY-MM-DD HH:MM:SS'`, UTC) and `INTEGER`
   0/1 booleans on Postgres too.
6. **`rowid`:** gone; explicit `seq` columns where insertion order matters
   (§3).
7. **Schema source:** the SQLite migrations plus the translator; data steps
   must work on both (see §11, phase 2).
8. **Isolation:** `READ COMMITTED` plus explicit locks at critical sections
   (`tx(fn,{lock})`, `lockFor(key)`, `FOR UPDATE`).
9. **Async SQLite transactions** keep the one connection across awaits
   during the transition (rule: bodies await database calls only).
10. **Triggers:** per group, §3 – all translated to PL/pgSQL, as the writes
    they react to are not centralised.
11. **Bundling:** verified with `next build`, §11.

## 11. Phase 1: the dialect pass (done)

What changed, beyond the rules of §2 and §3:

- **Codemods and scans.** `scripts/codemod-dialect.mjs` rewrote the
  mechanical cases (`CURRENT_TIMESTAMP`/`datetime('now',…)` → a `nowText()`
  parameter at the right position, `INSERT OR IGNORE` → `ON CONFLICT DO
  NOTHING`): about 190 literals in `lib`, `app` and tests. Everything else by
  hand, file group by file group, driven by the Postgres test run.
  `scripts/db-dialect-scan.mjs` counts what is left (§2).
- **Driver.** The bridge no longer rewrites SQL; `? IS NULL` parameters get
  a type on Postgres; `transaction()` takes SQLite's steps on Postgres too;
  `inSavepoint`, `updateIgnoringConflicts`, `lockFor` and the schema
  helpers in `lib/db.ts` work on both.
- **Things that wrote into the SQLite file in Postgres mode** – the object
  storage queue (lib/storage.ts), the conversion of formatted text values,
  the upload cleanup – go through `one/all/run` now.
- **Isolation.** Postgres runs `READ COMMITTED`. The synchronous path has
  one bridge connection per process, so its transactions are serialised as
  SQLite's are; the explicit locks matter once phase 2 makes them
  concurrent and for cluster mode. In place: the first account
  (`tx(…,{lock})`, spike), `lockFor()` (advisory, transaction-scoped) before
  tag and property creation (names, limit, position), issue connections,
  SSO mappings and rack templates (limits), the row positions of a
  transfer, the collection order; record numbers serialise on their counter
  row; unique names have unique indexes (`lower(name)`) as the last word.
- **Schema 93** (SQLite): `seq` columns, the lazily created tables, the
  scope-name indexes on `lower(name)`.

### Results

- **SQLite** (`npm test`): 2,045 of 2,045 pass (about 6 minutes on 4 cores).
- **PostgreSQL 16 through the bridge** (`DATABASE_URL=…`, a schema per test
  process): 2,036 pass, 0 fail, 9 skipped of 2,045 (about 11½ minutes).
  Before phase 1 the same run counted 1,232 pass and 541 fail of 1,774
  (some files did not load, one hung).
- The 9 skipped tests are about SQLite itself: 8 listed in the phase 2
  notes below and the spike's SQLite-only driver test.
- Migration tool: SQLite → Postgres → SQLite of an instance with five
  workspaces, every table verified by count and checksum both ways.
- **`next build`** with `pg` and the bridge: the standalone output has `pg`
  in `node_modules` and the worker (`lib/db-driver/pg-sync-worker.mjs` with
  `pg-types.mjs`, traced by `outputFileTracingIncludes`; Turbopack also
  emits a hashed copy as an asset). `scripts/check-standalone-postgres.mjs`
  starts it against a fresh schema: health through the bridge, the first
  sign-up through the pool and the bridge, bootstrap – all ok; the SQLite
  check (`npm run check:standalone`) passes as before.

### What phase 2 (the asynchronous sweep) must know

- Write new SQL for both databases (`sql.*`/`db.dialect.*`); run the suite
  with `DATABASE_URL` in CI – the refusal list catches most slips, the rest
  shows as Postgres errors (`GROUP BY` bare columns, `x=x+1` in upserts,
  mixed-case aliases, `? IS NULL` without the driver's cast in hand-written
  `$n` SQL).
- `sql` (lib/db.ts) picks the dialect per call from `DATABASE_URL`; in
  async code use `db.dialect`. `nowText()` is the timestamp parameter on
  both.
- Caught failures inside transactions need a savepoint (`inSavepoint` now,
  a nested `db.tx` later); the async driver has no `updateIgnoringConflicts`
  or `lockFor` twin yet – port them with the code that uses them
  (`tx(fn,{lock})` covers `lockFor`).
- The data steps of the SQLite migrations (`migrateFormattedText`,
  `migrateSealedSecrets`, `migrateIdentities`, `migrateSavedSearches`, the
  emoji normalisation) still take the SQLite connection: a Postgres
  database is created at the current version from the JSON (seed rows
  included), so they have nothing to do there today; the first data step
  after phase 1 must be written against `one/all/run` (or `Db`) and run on
  both, with a version marker in `flowplan_meta`.
- `lib/db-restore.ts` and `lib/db-snapshot.ts` use the bridge (sync,
  whole tables per batch); make them async and streaming for large
  instances. The Postgres search store is a stop-gap (§5a).
- `storage.ts` polls the queue every 0.5 s on Postgres (no JS trigger);
  replace with a `LISTEN/NOTIFY` connection or the job queue of cluster
  mode.
- Tests skipped on Postgres (they test SQLite itself): the migrations of
  schemas 89, 90, 92, saved searches → collections, the incident
  channel upgrade, the reaction emoji normalisation, FTS5's content table,
  the read memo against a second SQLite connection.
