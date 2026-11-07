# Database layer: SQLite by default, PostgreSQL as an option

Status: **phase 3a done – cluster mode: several instances against one
PostgreSQL, with Redis and S3** (§14, sizing §15). Phase 2 made all data
access asynchronous, PostgreSQL running through the `pg` pool alone (issue
#127). Phase 3 (in parts, §13): the search on PostgreSQL (trigram indexes,
BM25 as FTS5 ranks, §5a), pgvector for semantic search (§5b), `pg_dump`
backups (§3), the migration procedure in both directions (§6). The spike (branch `pg-spike`)
proved the pattern on one vertical slice and measured the cost; phase 1
made all SQL of the code base dialect-neutral, still synchronous (§11);
phase 2 converted every caller to the asynchronous API and removed the
blocking bridge (§12). SQLite stays the default and behaves as before: the
same statements on the same connection, wrapped in promises.

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

The helpers of `lib/db.ts` – `one`, `all`, `run`, `transaction(fn, actor)`,
`inSavepoint`, `lockFor`, `updateIgnoringConflicts`, `tableNames` … – are
the same calls, asynchronous since phase 2, and what most code uses
(`await one(…)`); `db` is the interface underneath:

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
| `one/all/run` | the synchronous SQLite statements of `lib/db.ts` (`sqliteOne/sqliteAll/sqliteRun`: statement cache, write generation for `read-memo`, runtime metrics), run when called, result wrapped in a promise | `pg` pool; `?` numbered to `$1…`; each distinct SQL text a named prepared statement per connection (prepared anew after DDL) |
| `tx(fn)` | `BEGIN IMMEDIATE` … `COMMIT` | `BEGIN` on one pooled connection … `COMMIT` |
| both | relation sync before the commit (with the actor), upload cleanup after it, `onTransactionRollback` callbacks per transaction (`dbContext.hooks`, registered by `lib/db.ts`) | |
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
- **Limits on secrets.** Counting wrong attempts, checking the secret and then
  writing the failure is a check-then-write across awaits: on Postgres
  parallel requests all passed the count (300 wrong codes at once, none
  refused). Sign-in passwords, codes, passkeys, step-up confirmations and
  share passwords reserve the attempt first (`reserveAttempt`/`beginAttempt`
  in `lib/local-auth.ts`: a row `<key>#<nonce>` written outside any
  transaction, then counted with every running attempt), so no more than the
  limit get checked. Checks inside a command (journal PINs) cannot write
  outside its transaction, and a throw would roll the count back: they refuse
  with `refuseKeeping(error, writes)`, and the command runs in
  `transactionKeepingRefusals` (savepoint undone, the writes committed under
  the check's advisory lock, then the error) – `KEEPS_REFUSALS` in
  `lib/api.ts`. Tests: `tests/attempt-limits-parallel.test.ts`,
  `tests/journal-pin-limits.test.ts` (run them with `DATABASE_URL`).
- **One SQLite connection.** An async transaction holds it from `BEGIN` to
  `COMMIT`, also while it awaits. Calls from outside wait for it (taken
  without an await between check and `BEGIN`; the spike found and fixed
  that race); the synchronous SQLite statements are refused from outside.
  `afterTransaction` callbacks of other flows wait for the open
  transaction. Development builds warn when an async SQLite transaction
  spans I/O (a `setImmediate` fires while it is open): bodies of SQLite
  transactions should await database calls only, which resolve in
  microtasks. A statement outside a transaction runs at once (not after an
  await), so on SQLite a chain of `await one(…)` without other I/O still
  runs within one turn of the event loop, as the synchronous code did.
- **Opening.** The first call waits for the opening steps
  (`dbContext.hooks.open`): on Postgres a staged restore and the object
  storage queue (what opening the SQLite file does), on both the data steps
  (`lib/data-steps.ts`, §12).

### The transitional bridge (phase 1, removed in phase 2)

Phase 1 ran the then synchronous helpers on Postgres through a blocking
bridge (a worker thread with one connection, `Atomics.wait` for the
answer). Phase 2 converted every caller; the bridge is deleted and
`tests/no-sync-database.test.ts` fails if it, or any `Atomics.wait` round
trip, comes back into the server code. The synchronous SQLite statements
(`sqliteOne/sqliteAll/sqliteRun`) are for the SQLite driver and SQLite-only
code (the migrations) alone – the same test checks that.

## 2. Dialect

**Rule since phase 1: SQL is written once, for both databases.** Where the
two need different text, the fragment comes from the dialect;
everything else is plain SQL both accept (SQLite ≥ 3.39 reads
`IS [NOT] DISTINCT FROM`, `ON CONFLICT … DO NOTHING`, row values).

- `sql` from `lib/db.ts` – the dialect of this process
  (`sql.instr("d.html", "?")`) – or `db.dialect` (lib/db-driver); and
  `nowText()`/`daysAgoText()`.

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
| `key>='<p>|' AND key<'<p>}'` (prefix as a range of text) | `substr(key,1,n)='<p>|'`: a range of text holds only in a byte-wise collation; Postgres' linguistic ones (`en_US.utf8`, ICU – the `postgres` image's default) ignore punctuation at first (`clearFailures`, lib/local-auth.ts) | – |
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
  table (`page_id,row_id,title,body` plus `title_folded`, `body_folded`:
  lower case without diacritics, and the generated `doc_length`) with
  pg_trgm GIN indexes, see §5a. pgvector's `ai_embedding_vectors` (§5b) is
  not in the translated schema either: both are derived and rebuilt.

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
| Search queue (`search_*` → `search_dirty`) | 31 | PL/pgSQL; kept in phase 3 – the queue is how the index learns of changes on both databases, and what goes in is decided in JavaScript once (lib/search-index.ts) |
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

Two formats (phase 3):

- **The portable SQLite file** – the instance backup (ZIP, Administration),
  the instance move, and the state kept before a restore of such a file.
  `snapshotDatabase(path)` (lib/db-snapshot.ts) is `VACUUM INTO` on SQLite;
  on Postgres it writes the same file from the translated schema and the
  data (one `REPEATABLE READ` transaction, a cursor per table in key order,
  500 rows per round trip: bounded memory). A restore or move of such a
  file on Postgres (lib/db-restore.ts `loadSqliteFile`) keeps the current
  state as such a file (as SQLite keeps the swapped-out file), brings the
  backup up to this schema with the SQLite migrations and refills every
  table in one transaction (the file's rows iterated, 200 per INSERT;
  foreign keys dropped and re-added, user triggers disabled meanwhile,
  identities moved on); the search index is rebuilt, pgvector's table
  filled in, the data steps run. A backup made on either database restores
  on either – the format for moving between them.
- **`pg_dump` on Postgres** (lib/pg-backup.ts) – the scheduled backups and
  "Back up now" (lib/backup-copy.ts): `flowplan-<time>.dump[.enc]` in the
  custom format of the instance's schema, encrypted with
  `FLOWPLAN_ENCRYPTION_KEY`, uploaded to S3/SFTP or kept in the data folder
  and pruned exactly like the SQLite copies (both names count for the
  retention and the delayed deletion of uploads). Left out: the derived
  `search_index` and `ai_embedding_vectors` (rebuilt), so a dump is smaller
  and restores on a server without pg_trgm or pgvector. pg_dump takes its
  own consistent snapshot and runs outside Node (no event-loop or memory
  cost; on a large instance far faster than the row-by-row SQLite copy).
  - **Restore**: the setup screen (and SFTP/S3 setup restore) and
    Administration → "Restore from backup" accept a `.dump[.enc]` only on
    Postgres (on SQLite it says to use the ZIP or the move). Before staging,
    `checkDumpBackup` reads the dump's table of contents (`pg_restore
    --list`) and refuses a dump that is not one Flowplan schema with
    `flowplan_meta`, that comes from a newer version, or that holds
    **anything Flowplan does not make itself** (see "Restores run no SQL of
    the dump" below); it reads the version, counts and file ids with
    `pg_restore --data-only`, stages it as `restore-pending/flowplan.dump`,
    and the next opening loads it (`restorePgDump`): the current state is
    saved as `pre-restore-<time>/flowplan.dump`, then `restoreDump` replaces
    the schema in **one** psql transaction – the schema emptied (everything
    but extension members; the schema, its grants and extensions stay),
    made anew from this version's `postgres-schema.json` (tables, keys,
    indexes – not from the dump), the rows of the dump loaded, identity
    sequences set (the dump's value, at least past the highest key),
    foreign keys added (checked) and the triggers created from this code
    (none fired while the rows came in). A dump of an older version loads
    into the current tables (a column it lacks gets its default, a column
    this version no longer has is left out); the data steps follow at the
    opening. A dump of another schema's name loads the same way: the COPY
    statements name the instance's schema (an instance with
    `FLOWPLAN_PG_SCHEMA=flowplan` restoring a backup of one in `public`;
    tested between test schemas). Then `ensurePostgresSchema` writes this
    version's seed rows and version, and the search index is rebuilt. A
    failed restore changes nothing (one transaction); the saved state is
    put back all the same (without the object check: it is this instance's
    own). In cluster mode the leader also re-creates the file queue's
    trigger and the search's and pgvector's side after a restore
    (lib/cluster/duties.ts).
  - **Restores run no SQL of the dump.** A dump is an upload (an instance
    administrator's, or anyone's on the setup screen without
    `FLOWPLAN_SETUP_TOKEN`), and pg_restore's script would run with the
    rights of Flowplan's database role – definitions of functions, triggers,
    rules, defaults, checks or index expressions are arbitrary SQL, and
    with a superuser role `COPY … TO PROGRAM` runs commands on the database
    host. So (lib/pg-backup.ts):
    - the table of contents may hold only Flowplan's own objects, in the
      one schema: its tables (with data, constraints, foreign keys, indexes,
      defaults, identity sequences and their values), the trigger functions
      `trg_<trigger>()` and triggers of the translated schema, pgvector's
      (`flowplan_floats`, `flowplan_vector_sync`, `ai_embeddings_vector_sync`)
      and the file queue's (`storage_queue_file`, `storage_file_insert`/
      `_delete`), the schema itself, the extensions pg_trgm/vector and their
      comments. Anything else – another function, trigger, rule, view, event
      trigger, type, operator, cast, policy, default privilege, a separate
      CHECK constraint – refuses the dump ("Die Sicherung enthält
      Datenbankobjekte, die Flowplan nicht selbst anlegt …", translated).
      Custom objects an operator adds to Flowplan's schema therefore make
      its dumps unrestorable: keep them in another schema. A table or
      trigger a later version stops making must stay on these lists for
      older dumps to restore.
    - Even the allowed definitions are never run: only `TABLE DATA` and
      `SEQUENCE SET` entries are passed to `pg_restore --data-only
      --use-list`, and its output is read line by line. Only a
      `COPY <schema>.<table> (<columns>) FROM stdin;` into a table of this
      version (rewritten to the instance's schema and to the table's own
      columns), the rows up to `\.`, and `setval` numbers are taken; the
      script's comments and `SET` lines are dropped (psql gets settings of
      its own). Any other line – also text after a row block's `\.` in a
      crafted archive, or a COPY statement the archive's TOC rewrote – stops
      the restore; psql is killed before its input ends, so nothing is
      committed. psql 18 runs the whole input under `\restrict` (no
      meta-commands).
  - **Tools**: pg_dump refuses servers newer than itself, so the client must
    be at least the server's major version. Found in `FLOWPLAN_PG_BIN`, on
    `PATH` or in `/usr/lib/postgresql/<n>/bin` (the newest that fits); the
    Docker image installs `postgresql-client-18` from the PostgreSQL
    project's apt repository (Debian bookworm ships 15). Without fitting
    tools – or with `FLOWPLAN_BACKUP_FORMAT=sqlite` – the scheduled backup
    falls back to the portable SQLite file and logs why.
  - The password goes to the tools through `PGPASSWORD`, never on the
    command line; only libpq's own URL parameters are passed on (`ssl=true`
    of node-postgres becomes `sslmode=require`).
  - The container start (docker/entrypoint.sh) no longer swaps a pending
    restore on Postgres: it would have moved the staged file aside before
    the app could load it (a bug of phase 2 for SQLite files as well).
  - Extensions (pg_trgm, pgvector) are installed into a schema of their own,
    `flowplan_ext`, unless they exist already (lib/pg-extensions.ts): a
    restore empties the instance's schema, and a `pg_dump --schema` does not
    contain extensions.

### Security: Flowplan's database role

Flowplan needs a role that **owns its database** (or at least its schema:
it creates and alters tables, functions and triggers, and installs the
trusted extension pg_trgm) – **not a superuser**. A superuser can read
files and run programs on the database host (`COPY … TO PROGRAM`,
untrusted languages), so a flaw in Flowplan, or an instance administrator
abusing one, would reach the host. The official `postgres` image makes
`POSTGRES_USER` a superuser; the compose example therefore runs
`deploy/compose/cluster/postgres-init.sh` at the database's first start:
the image's superuser (`postgres`, `POSTGRES_ADMIN_PASSWORD`) creates the
role `flowplan` (`NOSUPERUSER NOCREATEDB NOCREATEROLE`, `POSTGRES_PASSWORD`)
owning the database `flowplan`, and installs pg_trgm (and pgvector when the
image has it) into `flowplan_ext`. pgvector is not a trusted extension
before 0.8: without it installed by an administrator, semantic search
falls back to the slower path. Tested: the pg_dump and setup-restore tests
pass with such a role.

An existing database whose `flowplan` role is the superuser (the compose
example before this change, or `POSTGRES_USER=flowplan` in general) can be
changed by another superuser:

```sql
CREATE ROLE admin LOGIN SUPERUSER PASSWORD '…';   -- once, as flowplan
-- then, connected as admin:
ALTER ROLE flowplan NOSUPERUSER NOCREATEROLE NOCREATEDB;
```

(The database and the objects stay owned by `flowplan`; the extensions
installed so far stay usable.)

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
   `tests/helpers/postgres-backend.ts`; the job `postgres` of
   `.github/workflows/ci.yml` since phase 2), the JSON schema check, the
   SQLite-only refusal.
2. **Dialect pass, synchronous – done (phase 1, §11).** All SQL runs on
   both databases; the whole suite passes on SQLite and on Postgres through
   the bridge. Search keeps a dialect seam (`lib/search-store.ts`) until its
   `tsvector` design.
3. **Async sweep – done (phase 2, §12)** with `scripts/codemod-async-sweep.mjs`
   (whole program, one run; the plan below was the spike's, with
   `scripts/codemod-await.mjs`): it wraps calls of the
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
4. **Callbacks – done (§12)**, mostly by the codemod (`lib/each-async.ts`): `map` → `Promise.all(map(async …))` only where
   order and concurrency do not matter (inside a transaction: a `for` loop –
   statements of one connection run one after another anyway); `filter`,
   `sort` comparators, `some/every/find` → loops.
5. **Bridge deleted (§12).** `lib/db.ts` keeps the SQLite connection, its
   synchronous statements for the driver, the migrations, and the
   asynchronous helpers everything else calls.

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
  exit (`--drop-all` cleans up after aborted runs). Tests use the same
  asynchronous helpers as the code (`await run("INSERT …")`). A test that switches to a
  fresh instance (`tests/setup-restore.test.ts`) gets a fresh schema, as it
  gets a fresh data folder on SQLite: `reopenDatabase()` connects anew when
  `FLOWPLAN_PG_SCHEMA` changed.
- `tests/helpers/backend.ts`: `onPostgres`, and `sqliteOnly` as a `skip`
  reason for the tests that check SQLite itself (see below).
- `tests/db-driver.test.ts`: the layer (placeholders, types, commit,
  rollback, savepoints, `afterTransaction`, locks, the refusal rules) and the
  slice end to end, on whichever backend is configured.
- `tests/no-sync-database.test.ts`: no bridge, no `Atomics.wait`, the
  synchronous SQLite statements only in the SQLite driver.
- CI: the job `postgres` runs the suite, `next build` and
  `scripts/check-standalone-postgres.mjs` against a `postgres:16` service.
- Results: §11 (phase 1), §12 (phase 2).

```sh
# a throwaway Postgres 16 (as the postgres user)
# with a linguistic collation like CI's postgres image (en_US.utf8); the
# C locale hides comparisons that only hold byte-wise
initdb -D /tmp/fp-pg/data -U postgres --auth=trust --locale-provider=icu --icu-locale=en-US --locale=C.utf8
pg_ctl -D /tmp/fp-pg/data -o "-p 55433 -k /tmp/fp-pg -c max_connections=400 -c max_locks_per_transaction=256 -c fsync=off" start
createdb -h localhost -p 55433 -U postgres flowplan_test
DATABASE_URL=postgres://postgres@localhost:55433/flowplan_test npm test
```

Each test schema has ~1,000 objects; dropping one locks them all, and a
snapshot or restore reads every table in one transaction: with the default
`max_locks_per_transaction=64` parallel test processes can run out of lock
slots ("out of shared memory"), hence 256 above.

## 5a. Search on Postgres (phase 3)

`lib/search-store.ts` is the one place that stores and matches search
entries (lib/search-index.ts decides what goes in, lib/collections.ts and
lib/related-pages.ts query it). SQLite: FTS5 with the trigram tokenizer,
BM25 with the title ten times the text – unchanged.

**Decision: trigrams, not `tsvector`.** #127 planned `tsvector` per language
with pg_trgm where it cannot help. Measured against what the search does
today, a word-based `tsvector` cannot give the same results at all: FTS5's
trigram tokenizer finds any part of a word – German compounds ("plan" in
"Projektplanung", "kühlschrank" in "Kühlschrank-Regale"), Chinese and
Japanese text without spaces ("第二阶段" inside a sentence) – and users rely on
that; `to_tsvector('simple', …)` makes one lexeme per run of letters, so
those queries would find nothing (prefix queries `:*` help only at the start
of a word, stemming per language would make it worse for mixed content). The
same semantics in Postgres is exactly pg_trgm's: `LIKE '%…%'` on the folded
text, served by GIN `gin_trgm_ops` indexes. `unaccent` is not needed: the
text is folded in JavaScript (lower case, NFD without marks – the same
function for the stored text, the query and the snippets), which also avoids
its non-immutable index expressions.

- **Matching**: a phrase (three characters or more) matches where the folded
  title or text contains it; shorter queries take the scans both databases
  share (`ILIKE`, `strpos`), as before.
- **Ranking**: FTS5's `bm25()` in SQL (`textMatch().rank`): per phrase its
  frequency (occurrences in the title × 10 + in the text, counted with
  `replace()`), saturated with k1 = 1.2, normalised by the entry's length
  (`doc_length`, a generated column) against the average (b = 0.75), times
  the phrase's IDF (log((N − n + 0.5)/(n + 0.5)), at least 1e-6; n counted
  by an index scan up to 10,000) when there are several phrases. N and the
  average length come from a count the indexer makes before searches every
  ten minutes, or sooner when a tenth of the index changed.
- **Equal ranks** keep the order of the entries in the index (`s.id`,
  as FTS5 returns its rows), and the indexer works through its queue in key
  order – so a rebuilt index ranks ties identically on both databases.
- **Snippets**: SQL selects an 800-character window of the text around the
  first hit (not the whole text, up to 400,000 characters); JavaScript cuts
  what FTS5's `snippet(…, 40)` shows – a port of `fts5SnippetFunction`: 40
  trigram tokens (42 characters), centred on the hits or starting at the
  sentence before them (bonus 100, 120 at the start), a hit crossing the
  edge marked up to it.
- **Structures** (made when the database opens, `ensureSearchStore`, under
  an advisory lock; also after a restore and for a database migrated by the
  tool): the table if missing, `doc_length` (filling in the stop-gap rows
  of phase 2 – no data migration needed: their folded columns are the
  same), pg_trgm (installed into `flowplan_ext` when the server has it; on
  every standard PostgreSQL, a "trusted" extension) and the two GIN
  indexes. Without pg_trgm the same queries scan (correct, slower; logged).
- **Rebuild**: `node scripts/db-search-rebuild.mjs` (SQLite file or
  `DATABASE_URL`; in the image `/app/scripts/`) empties `search_state`;
  the running instance reindexes everything within seconds (comments,
  messages and files included – a rebuild after a restore or migration
  missed those before, found by the migration test), on PostgreSQL after a
  `REINDEX` of the trigram indexes.
- **Parity** (tests/search-parity.test.ts on both databases, the same
  expectations; tests/db-migrate.test.ts on identical data): hits, order –
  BM25 including ties – and snippets are the same for German, French,
  Chinese and Japanese text, parts of words, diacritics, title vs. text,
  frequency and length, several phrases (IDF), title-only matches. Known
  differences: none in the tested set; in principle FTS5 counts overlapping
  occurrences of a phrase ("aaa" in "aaaa" twice) where `replace()` counts
  once, and `lower()` of characters outside Latin script may differ from
  SQLite's `remove_diacritics` in rare letters (both fold the same in
  JavaScript before storing on Postgres, so only SQLite's own folding is
  the reference).
- Performance: the trigram GIN index on large texts is about as large as
  FTS5's trigram index; a common short phrase (three letters) matches many
  entries, and BM25 needs all of them before `LIMIT` – as on SQLite. With a
  C collation, Postgres' pg_trgm treats only ASCII as word characters: CJK
  queries are then answered correctly but by a recheck of every row the
  index cannot narrow (the official Docker image uses `en_US.utf8`; see
  §13).

## 5b. pgvector for semantic search (phase 3)

`lib/ai/vector-store.ts`. With the `vector` extension the nearest chunks are
found by the database; without it (or `FLOWPLAN_PGVECTOR=off`) the
JavaScript scan of lib/ai/semantic.ts answers, as on SQLite.

- `ai_embeddings.vector` (4 bytes per dimension) stays what is stored,
  backed up, moved and restored on both databases. `ai_embedding_vectors`
  (key, hash, model, `dims`, `embedding vector`) is derived and Postgres'
  alone.
- **A trigger** on `ai_embeddings` keeps it current for every write, from
  whichever code (the bytes decoded in SQL, `flowplan_floats(bytea) →
  real[]`, about 0.4 ms per 768-dimension vector). What bypassed the
  trigger (a restore with triggers disabled, the migration tool, a
  database from before pgvector) is filled in at the next opening in the
  background, 500 per transaction (`syncVectors`); until then the
  JavaScript scan answers. A row counts only with the `ai_embeddings` row
  of the same key, hash and model.
- **Indexes**: models differ in size (768, 1536 …), and HNSW needs a fixed
  size: one partial expression index per size,
  `USING hnsw ((embedding::vector(d)) vector_ip_ops) WHERE dims=d`, made
  when vectors of a size first appear (up to 2,000 dimensions; larger ones
  are searched exactly). Inner product on normalised vectors = cosine.
- **Query**: through the index with `hnsw.ef_search` raised (100–1000), the
  workspace, model and page filters applied to the candidates; if that
  leaves fewer hits than wanted (a small workspace among large ones), the
  exact query (`ORDER BY embedding <#> q` without the cast, every vector of
  the workspace in SQL). pgvector 0.6 (Ubuntu 24.04) has no iterative index
  scans; with 0.8 `hnsw.iterative_scan` would make the fallback rare.
- **Statistics off for the vector column** (`SET STATISTICS 0`): ANALYZE
  sorts sampled values, and pgvector refuses to compare vectors of
  different sizes – a database-wide `ANALYZE` (or autovacuum) failed on a
  table with two models' vectors (found by the migration test).
- Tests (tests/pgvector.test.ts): the database finds exactly what the scan
  finds (scores within 1e-5), filters, deletes/updates/moved workspaces
  follow, the fill-in after a bypass, the switch-off.
- Not installed by Flowplan where the role may not: pgvector is not a
  trusted extension before 0.8; an administrator runs `CREATE EXTENSION
  vector` (in any schema), Flowplan uses it from the next start.

## 6. Migration tool and procedure (both directions)

`node scripts/db-migrate.mjs --from sqlite:<file> --to postgres://…` and
`--from postgres://… --to sqlite:<file>` (plain Node, no TypeScript loader;
in the Docker image `/app/scripts/db-migrate.mjs`). Options: `--schema`
(Postgres schema, default `public`, created if missing), `--tables
all|slice|a,b` (default all), `--batch` (rows per read, 1000),
`--verify-only` (compare only), `--quiet`.

What it does:

- Refuses a source whose schema version differs from this version's
  (`PRAGMA user_version` / `flowplan_meta`), a non-empty target table, an
  existing target file.
- Copies table by table in batches in primary-key order (`seq` values kept
  on both sides), values converted by the Postgres column type (refuses
  with the row when a value does not fit – SQLite keeps any value in any
  column; NUL in text).
- Into Postgres: foreign keys dropped for the copy and re-added afterwards
  (validated; no superuser needed), triggers created after the copy (and
  no seed rows: the copy brings its own), identity sequences continue after
  the copied values, the empty search table created, `ANALYZE` of the
  copied tables.
- Into SQLite: the schema exactly as SQLite had it (tables, then after the
  copy indexes, triggers and the FTS table from the JSON), `PRAGMA
  foreign_key_check`, `user_version`.
- Not copied, rebuilt by Flowplan at its first start: the search index
  (`search_state` emptied: everything is indexed again, comments, messages
  and files included), pgvector's table (filled in from `ai_embeddings`).
  Embeddings themselves are copied (bytes), so semantic search needs no
  provider calls after a move.
- Verifies every table: row count and an order-independent checksum (sum of
  64-bit SHA-256 prefixes of each row's canonical values, typed by the
  Postgres column type), batch by batch (bounded memory).
- Tested (tests/db-migrate.test.ts, with `DATABASE_URL`): a realistic
  instance – two workspaces with the example pages, documents in German,
  English, French and Chinese, a database with records, comments, files,
  160 embeddings of two models and sizes – SQLite → Postgres → SQLite; the
  tool verifies every table both ways, and each of the three instances
  answers 13 searches per workspace (hits, order, snippets), a multi-term
  match and semantic search (pgvector on Postgres) identically.

### Procedure (short downtime)

The same in both directions; the downtime is the copy (about a second per
few ten thousand rows locally; documents and embeddings dominate) plus the
first start's index rebuild (searches work meanwhile and fill up).

1. **Same version on both sides.** Update the old instance to the Flowplan
   version that will run afterwards and start it once (migrations), or the
   tool refuses the schema version.
2. **Prepare the target.** Into PostgreSQL: an empty database (or schema)
   on PostgreSQL 16 or newer, a role that owns it; pg_trgm is installed by
   Flowplan if the role may create it (otherwise `CREATE EXTENSION pg_trgm`
   as administrator); pgvector optional (`CREATE EXTENSION vector` as
   administrator). Into SQLite: a new, empty data folder.
3. **Make a backup** (Administration → instance backup, or the scheduled
   backup) and keep it until the new instance runs.
4. **Stop Flowplan** (the tool reads a consistent state only when nothing
   writes; with Litestream also stop the replication).
5. **Copy and verify**, e.g. in the image:
   `docker run --rm -v flowplan-data:/app/data --entrypoint node <image> /app/scripts/db-migrate.mjs --from sqlite:/app/data/flowplan.sqlite --to postgres://flowplan:…@db:5432/flowplan`
   – it ends with "verified: every table has the same rows" (exit 0) or
   lists the tables that differ (exit 1; nothing is used yet: fix and run
   again into an emptied target).
   The way back: `--from postgres://… --to sqlite:/app/data-new/flowplan.sqlite`.
6. **Switch the configuration**: set `DATABASE_URL` (and
   `FLOWPLAN_PG_SCHEMA` when not `public`) – or remove it for SQLite and
   point `FLOWPLAN_DATA_DIR` at the folder with the new file. The data
   folder keeps the uploads, `secrets.key` and the Web Push keys in both
   modes: keep using the same folder (or the same S3 bucket).
7. **Start Flowplan** and check: sign in, open a page, search (the index
   fills within seconds to minutes), Administration → system. With S3,
   Litestream is only for SQLite; on PostgreSQL the scheduled backups
   become pg_dump archives (§3).
8. Keep the old database (file or schema) until the next scheduled backup
   of the new one has run.

Not covered: progress resumption after an aborted copy (start over into an
emptied target), a live switch without downtime, uploads (they stay where
they are).

## 7. Performance

`node --import tsx scripts/db-bench.mjs postgres://…` – 20,000 point queries
(user by primary key, `SELECT *`, 10,000 users), median of 3, one Node
process, Postgres 16 on the same machine over TCP:

µs per query; runs 1 and 2 from the spike, run 3 after phase 2
(run-to-run noise is about ±15 %):

| Path | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| SQLite, synchronous `one()` (spike) / `sqliteOne()` (phase 2) | 10.8 | 11.7 | 11.6 |
| SQLite, `await one()` of `lib/db.ts` (phase 2: what the code calls) | – | – | 12.9 |
| SQLite, async `db.one()` awaited one by one | 12.3 | 9.7 | 12.0 |
| SQLite, async `db.one()` inside one `db.tx()` | 10.1 | 10.8 | 10.6 |
| Postgres, async, one by one | 91.8 | 89.5 | 104.0 |
| Postgres, async, 16 in flight | 54.0 | 51.2 | 55.0 |
| Postgres, async, inside one `db.tx()` | 84.9 | 88.1 | 83.9 |
| Postgres, async, unnamed statements | 145.0 | 132.1 | 136.8 |
| Postgres, synchronous bridge (removed in phase 2) | 185.2 | 173.9 | – |

Reading: the async wrapper's cost on SQLite is below the noise of this
benchmark (at most ~1.5 µs per statement, i.e. well under 0.1 ms for a
request with 50 statements). Postgres is ~8× slower per round trip locally
(about 90 µs; a separate host adds network latency), about 20,000 point
queries/s from one Node process with 16 in flight. Requests that issue many
small sequential queries (permission checks per page) will feel it, which
argues for batching those lookups (`read-memo` already helps) before cluster
mode. Named prepared statements are worth 1.5×. The bridge cost 2× the
async driver and blocked the event loop; it is gone. `one()` of `lib/db.ts`
adds about a microsecond on SQLite (two promise layers) – a request with
50 statements pays well under 0.1 ms.

## 8. What Redis/cluster mode needs from this layer

(Written before phase 3a; what was built: §14.)

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
  `FLOWPLAN_PG_PREPARE=off`); `statement_timeout`/`lock_timeout` per connection.
- **No synchronous paths:** done in phase 2 – the bridge is gone and every
  database call is asynchronous (§12).

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

1. **The bridge** was a development and CI aid only, not a product mode;
   removed in phase 2.
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

(Kept as written; what became of each point: §12.)

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

## 12. Phase 2: the asynchronous sweep (done)

All data access is asynchronous. `one/all/run/transaction` and the other
helpers of `lib/db.ts` return promises and go through the driver of
`lib/db-driver` on both databases; on PostgreSQL that is the `pg` pool, with
no blocking bridge left (deleted; `tests/no-sync-database.test.ts` keeps it
out). SQLite runs the same statements on the same connection as before.

### How it was done

1. **Driver and helpers by hand** (`lib/db.ts`, `lib/db-driver`): the
   helpers became asynchronous; the transaction steps both drivers take
   (relation sync before the commit with the actor, upload cleanup after
   it, rollback callbacks per transaction instead of a process-wide list,
   the opening steps) moved into `dbContext.hooks`. `inSavepoint` is a
   nested `db.tx`, `lockFor(key)` the advisory lock of the current
   transaction (the same as `tx(fn, { lock })`), `updateIgnoringConflicts`
   runs on both through them.
2. **Codemod** (`scripts/codemod-async-sweep.mjs`, TypeScript 5 compiler
   API with the checker): from the helpers it follows every caller through
   the whole program – imports, re-exports, destructured dynamic imports
   (`const { run } = await import("../lib/db")`), methods, object members,
   function aliases, IIFEs, parameters handed on – to a fixpoint, wraps
   each call in `await`, marks the functions `async` (`T` → `Promise<T>`),
   rewrites array callbacks to `lib/each-async.ts` (sequential `mapAsync`,
   `filterAsync`, `someAsync` …: order and side effects as before, one
   connection's statements one after another anyway), awaits generic
   wrappers whose result is the callback's (`withRequestLocale`,
   `withReadMemo`, `memoized` …) and makes the project's own functions
   that call a callback await it (types widened to `T | Promise<T>`),
   follows closures returned by factories (`--factory`: `nameLookup()`,
   `quotaCheckpoint()`, `streamGuard()` …), turns `assert.throws` around
   them into `assert.rejects`, and lists what it must not change.
   One run: 4,575 functions became async, 22,453 awaits in 558 files
   (tests included), array callbacks in 105 files; later passes with hand
   seeds added a few hundred more. `ReturnType<typeof f>` →
   `Awaited<ReturnType<typeof f>>` (perl).
3. **By hand** (what the codemod listed, then `tsc`): ~60 places.
   Synchronous renderers whose lookups now read the database get the
   answers ahead – `lib/resolve-ahead.ts` `withLookups` renders once noting
   the questions, resolves them, renders again (whiteboard SVG, Markdown
   export, EPUB/PDF/Word through `withExportLookups`, record placeholders
   through `withPlaceholders`, Markdown import through
   `markdownToHtmlAsync`); sanitize-html transforms that read the database
   use `cleanHtmlAsync` (two passes in the same tag order) or read ahead
   and stay synchronous; string replacers use `replaceAsync`; rollup field
   access is resolved ahead for all rollups of a schema; the AI access
   context has a static async factory instead of a constructor; defaults
   that awaited inside parameter lists moved into the body (`=== undefined`,
   so `null` keeps its meaning).
4. **What tsc does not see** – a promise where any value goes.
   `scripts/check-promises.mjs` (TypeScript 5 with types) reports promises
   as statements, conditions, `!p`, in `+` and templates, compared, given
   to `any`/`unknown` parameters or inside literals given there, async
   callbacks of `filter/some/every/find/sort/forEach`, and async functions
   where a function returning `void`/`unknown` is expected. What it still
   reports (about 40, mostly client code) are deliberate promise handles
   (`pending ??= …; if (!pending)`). The test runs found the rest: the
   idempotency reservation of `command()` and its after-commit tasks typed
   `=> void`, a template's `keep` callback typed `=> unknown`, a stream's
   keepalive that checked `!allowed()` on a promise (access was never
   revoked) – all awaited now.

### Data steps on both databases

`lib/data-steps.ts`: what migrations did to the *data* (saved searches →
collections, schema 85; identities from SSO subjects, 88; formatted text
escaped, 90; secrets sealed, 92; reaction emoji without a redundant
U+FE0F) is written once against the asynchronous helpers and runs at the
first use of the database on both (after a staged restore), each step in
a transaction with an advisory lock (several instances), marked in
`data_migrations` with the old names (done steps stay done), retried at the
next start after a failure. `migrate()` keeps the schema only. **New data
steps go there, never into `migrate()`.** The translated schema no longer
seeds markers. Their tests run on both databases now.

### Snapshots and restores

Asynchronous and with bounded memory: the snapshot reads each table
through a cursor of its `REPEATABLE READ` transaction (`FETCH 500`), the
restore iterates the backup file and inserts 200 rows per statement
(`tests/db-snapshot.test.ts`: a table larger than a batch, out and in).

### Prepared statements

Named prepared statements are per connection. DDL through the driver
forgets them (names are never reused); one prepared before a schema change
made elsewhere fails with "cached plan must not change result type" and
is retried unnamed outside a transaction (inside, the failure has spoilt
the transaction: the caller sees it).

### Results

- **`npx tsc --noEmit -p .`** clean; `node scripts/db-dialect-scan.mjs`: zero
  on every SQLite-only pattern (`LIKE` 76, reviewed: the data steps' fixed
  markers moved out of the migrations).
- **SQLite** (`npm test`): 2,064 of 2,064 pass.
- **PostgreSQL 16 without the bridge** (`DATABASE_URL=…`): 2,058 pass, 0 fail, 6 skipped of 2,064 – no bridge, the `pg` pool only.
- **`next build`** passes; `npm run check:standalone` (SQLite) and
  `scripts/check-standalone-postgres.mjs` (health, first sign-up,
  bootstrap through the pool; no bridge in the output) pass.
- **CI:** the job `postgres` runs the suite, the build and the standalone
  check against a `postgres:16` service.
- **Performance** (§7, run 3): the asynchronous `one()` costs about a
  microsecond more than the synchronous statement on SQLite; the whole
  suite takes about as long as before (about 6 minutes on SQLite, about 10½ minutes on
  Postgres, 4 cores – the bridge run took about 11½ minutes). Postgres now
  serves requests concurrently instead of blocking the event loop per
  round trip.

### What phase 3 (cluster mode, Redis, `tsvector`, pgvector, `pg_dump`) must know

- **Concurrency is real on Postgres now.** Transactions run in parallel
  (pool of `FLOWPLAN_PG_POOL`, default 10, connections per process) under
  `READ COMMITTED`. The known check-then-write places have advisory locks
  (`lockFor`/`tx(fn, { lock })`), unique keys or counter rows (§1, §11).
  Not yet reviewed one by one: the ~500 `transaction()` bodies for
  read-then-write without a lock (quotas, positions, Yjs merges by
  generation check – `FOR UPDATE` on the document row is the plan), and
  sequences outside transactions that relied on running in one turn of the
  event loop (on SQLite they still do; on Postgres they interleave).
- **No `statement_timeout`/`lock_timeout`** on the pool's connections yet
  (the bridge had `lock_timeout=10s`); a stuck lock waits. Set them per
  connection (pool `options`) with cluster mode, together with
  `idle_in_transaction_session_timeout`. *(Done in phase 3a, §14.)*
- **Sequential awaits** are the default everywhere (`mapAsync`, permission
  checks page by page): fine on SQLite, ~100 µs per round trip on Postgres
  (§7). Hot paths to batch or parallelise first: the sidebar/bootstrap
  permission checks, `filterAsync(pages, pageRole)` in search and
  collections, the exports' per-page lookups.
- **SQLite transactions hold the one connection across awaits**; their
  bodies must await database calls only (development warns). Code that
  awaits I/O inside `transaction()` (fetch, crypto, files) would stall
  every other request on SQLite.
- **Fire-and-forget callbacks** (timers, event handlers, `afterTransaction`)
  may now be async: a rejection is an unhandled rejection where a throw
  used to be an uncaught exception – same severity; the workers catch
  their own errors. `afterTransaction` logs failures of async callbacks.
- **Opening steps** (`dbContext.hooks.open`) run once per process; with
  several instances each runs them, the data steps serialise on their
  advisory locks. A staged restore on Postgres must be coordinated by the
  leader in cluster mode.
- **Named prepared statements** need PgBouncer ≥ 1.21 with
  `max_prepared_statements`, or `FLOWPLAN_PG_PREPARE=off` (§8).
- **Search** still uses the plain-table stop-gap (§5a) and its triggers;
  the object storage queue still polls every 0.5 s on Postgres. *(The
  queue: LISTEN/NOTIFY since phase 3a, §14.)*
- `scripts/check-promises.mjs` is a tool, not yet a CI gate (the
  deliberate handles it reports would need an allow-list); run it after
  larger changes, or turn it into a lint rule (`no-misused-promises`).
- Tests skipped on Postgres (they test SQLite itself): the Postgres schema file check (it builds the
  SQLite schema), schema 88 on an older SQLite file, schema 89's indexes,
  the incident channel upgrade, FTS5's content table, the read memo against
  a second SQLite connection – 6 (phase 1: 9; the formatted text, sealed
  secrets, saved searches and reaction emoji steps run on both now)..

## 13. Phase 3: search, pgvector, pg_dump, migration (branch `db-search`)

What changed (details in §3, §5a, §5b, §6):

- **Search on PostgreSQL**: pg_trgm GIN indexes on the folded title and
  text, FTS5's BM25 in SQL, FTS5's snippet window ported – instead of the
  `tsvector` of the plan, which cannot find parts of words or CJK text
  (§5a). Same API (`lib/search-store.ts`); SQLite unchanged. The stop-gap
  table of phase 2 is kept and extended in place (no data migration).
  `entryOrder()` makes equal ranks deterministic; the indexer drains its
  queue in key order.
- **Fixes found on the way**: a rebuilt index (after a restore, a move, a
  migration) left out comments, messages and files; BM25's statistics
  stayed at their defaults after a rebuild.
- **pgvector** (`lib/ai/vector-store.ts`): a trigger-maintained table, one
  HNSW index per vector size, exact SQL where the index cannot serve, the
  JavaScript scan without the extension.
- **pg_dump backups** (`lib/pg-backup.ts`): scheduled backups and "Back up
  now" on PostgreSQL; restore of the dump's rows only, through psql, into a
  schema made from this code (§3, "Restores run no SQL of the dump"); setup restore from upload, S3 and SFTP; the Docker image has
  `postgresql-client-18`; the container start leaves a pending restore to
  the app on PostgreSQL.
- **Migration tool**: all tables by default, streaming verification,
  progress, the empty search table on the target, `ANALYZE` of its own
  tables; tested on a realistic instance both ways (§6). Rebuild command
  `scripts/db-search-rebuild.mjs`. Both scripts are in the image
  (`/app/scripts/`).

### Results

- **`npx tsc --noEmit -p .`** clean; `node scripts/db-dialect-scan.mjs`:
  zero on every SQLite-only pattern (`LIKE` 77, reviewed: the one new is
  the IDF count's match on the folded text).
- **SQLite** (`npm test`): 2,080 tests, 2,071 pass, 0 fail, 9 skipped (the
  new PostgreSQL-only tests: pgvector 4, pg_dump 4, the migration 1).
- **PostgreSQL 16 with pgvector 0.6** (`DATABASE_URL=…`): 2,080 tests,
  2,074 pass, 0 fail, 6 skipped (the SQLite-only tests of §12) – about 15
  minutes on 4 cores alongside another suite.
- **Without pgvector** (its control file removed, a fresh database): the
  search, semantic search, Ask, related pages, migration and pg_dump tests
  pass (52), the pgvector tests skip.
- **Search parity**: tests/search-parity.test.ts (7 tests, the same
  expectations on both) and tests/db-migrate.test.ts (13 queries × 2
  workspaces, the multi-term match and semantic search identical on SQLite,
  PostgreSQL and SQLite again, snippets included).
- **`next build`** passes; `npm run check:standalone` (SQLite) passes;
  `scripts/check-standalone-postgres.mjs` passes and now also checks the
  trigram indexes, a search and "Back up now" (a 0.5 MB pg_dump archive).
- **Dockerfile**: not built here (no Docker daemon, and the sandbox may not
  reach apt.postgresql.org); the shell of the changed `RUN` step parses.
- **CI**: the `postgres` job uses `pgvector/pgvector:0.8.0-pg16` and checks
  that the runner's pg_dump is 16 or newer.
- **Found and fixed besides**: the relation sync wrote its control row in
  every transaction before the commit, even with nothing to sync – on
  PostgreSQL every transaction wrote that one row (a queue under
  concurrency, and the snapshot of an instance backup failed with a
  serialization error when another transaction committed meanwhile); now
  it writes only when there is something to sync.

### Open risks and what is left

- **pgvector without iterative scans** (0.6 in Ubuntu 24.04, what this was
  tested with): a workspace that holds
  few of the instance's vectors gets its hits from the exact query, i.e. a
  scan of its own vectors in SQL – fine up to some 100,000 per workspace;
  pgvector ≥ 0.8 (`hnsw.iterative_scan`) would let the index serve them.
  HNSW is approximate: the nearest chunks can differ slightly from the
  scan's on large sets (the tests compare exactly on small ones).
- **Vectors of more than 2,000 dimensions** (e.g. 3072 of
  text-embedding-3-large) have no index (halfvec would allow 4,000; not
  done): exact SQL.
- **pgvector is not trusted** before 0.8: Flowplan cannot install it as an
  ordinary role; the administrator runs `CREATE EXTENSION vector`.
- **Locale**: pg_trgm extracts trigrams only from what the database's
  `LC_CTYPE` calls letters – with the C locale none from CJK text: such
  queries are answered correctly but by rechecking every row (the official
  `postgres` image and most managed services use `en_US.utf8`). Worth a
  line in the installation docs.
- **Index build at the first start** after the update: the two trigram
  indexes (and `doc_length`, which rewrites the table) are built under an
  advisory lock while the instance opens – minutes on a very large index.
  Could move to a background step (`CREATE INDEX CONCURRENTLY`, outside a
  transaction).
- **Ranking detail**: FTS5 counts overlapping occurrences of a phrase,
  `replace()` does not; IDF counts stop at 10,000 matching entries. No
  difference in the tested set.
- **pg_dump restores replace the whole schema** of the instance; the state
  before is kept as a dump next to the data folder (disk space: one more
  dump). The restore drops and recreates every table in one transaction:
  about twice as many locks as the schema has objects (~2,000) – within
  the default lock table, but a server with a small
  `max_locks_per_transaction` and many busy connections may need more.
- **Tools in non-Docker installs**: without pg_dump/pg_restore ≥ the
  server's version the scheduled backup falls back to the SQLite file
  (logged); a staged dump waits until the tools are there.
- **Cluster mode** (branch `db-cluster`): the opening steps (search store,
  vector store, a staged restore) run per instance under advisory locks; a
  pg_dump restore should be coordinated by the leader, and `syncVectors`
  could run on the leader only.

## 14. Phase 3a: cluster mode (done)

Several Flowplan instances serve one installation: one PostgreSQL database,
one Redis, one S3 bucket, any number of app instances behind a load
balancer. The single container stays exactly as it was – SQLite (or
PostgreSQL), no Redis, S3 optional; none of the cluster code does anything
there (`clusterMode()` is false, `isLeader()` true, `publish()` a no-op).

### Switching it on, and what it requires

`FLOWPLAN_CLUSTER=1` (or `FLOWPLAN_MODE=cluster`). Then `DATABASE_URL`
must be PostgreSQL, `REDIS_URL` (`redis://` or `rediss://`) and `S3_BUCKET`
(with endpoint and keys) must be set; an instance missing one exits at
start with every problem listed (`lib/cluster/config.ts`,
`requireClusterConfig()` in `instrumentation.ts`). `REDIS_URL` without
cluster mode is ignored with a warning. `FLOWPLAN_INSTANCE_ID` names the
instance (default: host name and a random suffix; the Helm chart uses the
pod name).

### The pieces (`lib/cluster/`)

| File | What |
|---|---|
| `config.ts` | the switch, the requirement check, instance id, Redis key prefix (`FLOWPLAN_REDIS_PREFIX`) |
| `redis.ts` | a small RESP2 client (commands, `EVAL`, pub/sub, reconnect with back-off, TLS, AUTH/SELECT from the URL) – written here, not a dependency, as `lib/storage.ts` signs its own S3 requests; it keeps the process alive only while it connects or waits for a reply |
| `bus.ts` | pub/sub between instances: one Redis channel, messages `{origin, topic, payload}`, own messages ignored |
| `pg-session.ts` | one dedicated PostgreSQL connection per process outside the pool: `LISTEN` and the leader's session lock; reconnects and listens again |
| `leader.ts` | leader election: `pg_try_advisory_lock` on that connection every `FLOWPLAN_LEADER_INTERVAL` (5 s); the lock dies with the connection, so a crashed leader is replaced within a round; `resignLeadership()` on shutdown |
| `instances.ts` | heartbeats in a Redis hash every 10 s (id, host, version, leader, ready, pool, RSS); stale after 30 s |
| `runtime.ts` | start (check, bus, election, heartbeat) and graceful stop (both modes) |
| `health.ts` | liveness/readiness checks (database; cluster: Redis, bucket – cached 10 s) |
| `system.ts` | the administration's system view |

### Live updates, presence, rate limits (Redis)

The in-process hubs stay the delivery to the instance's own server-sent
event streams; each signal is delivered locally first and then published,
the other instances deliver what they receive to their listeners:
`lib/document-live.ts` (Yjs updates, encrypted updates, presence, "check"),
`lib/text-presence.ts` (cursors between members and guests, lease renewals
included), `lib/whiteboard-presence.ts` (cursors, leaves, board signals)
and the gathers of `lib/whiteboard-facilitation.ts`. Messages are signals,
PostgreSQL stays the source of truth: a lost message is caught up by the
clients' next "check". No sticky sessions are needed.

Rate limits (`lib/action-limits.ts`) keep their synchronous signature (the
AI code calls them; no caller changed): the decision is local, each
allowed action is also added to a sliding window in Redis (one Lua
script), and when the shared count is over the limit the instance refuses
the key until the window has room and tells the others (bus). Across N
instances a key gets its limit plus at most about one action per instance
in flight (tested: limit 6, two instances, ≤ 7). Redis down: each instance
counts alone, logged. Limits kept in PostgreSQL (sign-in failures, demo
starts, MCP) were already shared.

### Workers: leader duties and claimed queues

- **Leader only** (a guard at the start of each round, `isLeader()`): date
  reminders, task reminders, automations, page reviews, the search
  indexer, file text extraction, retention/trash/notification pruning,
  digests (not the sending), Telegram's long poll, the issue-sync poll,
  scheduled backups and Markdown exports, inactive accounts, LDAP account
  and contact sync, the AI worker, IMAP capture, calendar sync, the ops
  sweeps and health alerts. **Duties of the opening** wait for the
  election (`lib/cluster/duties.ts`): a staged restore (SQLite file or
  `pg_dump` archive) is applied only by the leader – it is staged in the
  data folder of the instance that received it, which applies it once it
  leads (a warning says so while another leads), then runs the data steps
  for the restored data; the SQLite refill also takes
  `lockFor("flowplan:restore")`. pgvector's filling of missing vectors
  (`syncVectors`, lib/ai/vector-store.ts) runs on the leader – also when an
  instance becomes leader after the opening; the others only check whether
  nothing is missing and then answer from the vector index as well. Data
  steps keep their per-step advisory locks, wherever they start.
- **Every instance, claiming:** mail, push, webhooks and chat-app
  deliveries already claimed each job with a conditional `UPDATE … WHERE
  next_at<=?` (compare and set) – cluster-safe as they were. The object
  storage queue now claims with `UPDATE … WHERE key IN (SELECT … FOR UPDATE
  SKIP LOCKED) RETURNING` and a lease (`next_at` + 10 min: a dead worker's
  jobs come back), `sql.skipLocked()` (nothing on SQLite).
- **Per instance:** ops counters and usage metrics (flushed into shared
  rows; the minute row is now added to under a lock instead of read and
  overwritten), runtime metrics.
- **Storage queue without polling:** the PostgreSQL trigger sends
  `pg_notify('flowplan_storage_<schema>', 'put:<key>')`; every instance
  listens on its session connection and – in cluster mode only the one that
  has the file locally – drains right away. The 0.5 s poll is now a 15 s
  fallback. In cluster mode the local uploads folder is a cache: files are
  fetched on demand (`ensureLocal`, which waits up to 5 s for an upload
  still under way on another instance), not all at start.

### Pool hardening

Every pooled connection gets `statement_timeout` (`FLOWPLAN_PG_STATEMENT_TIMEOUT`,
default 120 s), `lock_timeout` (`FLOWPLAN_PG_LOCK_TIMEOUT`, 10 s as the
bridge had), `idle_in_transaction_session_timeout`
(`FLOWPLAN_PG_IDLE_TX_TIMEOUT`, 60 s), a wait limit for a free connection
(`FLOWPLAN_PG_CONNECT_TIMEOUT`, 30 s) and `application_name`
`flowplan:<instance>`; `FLOWPLAN_PG_POOL` (default 10, max 500). `untimed()`
(lib/db.ts) lifts the two limits for the rest of a transaction that is long
by nature: data steps, snapshots, restores, the schema step.

### Schema on PostgreSQL

A new or older PostgreSQL database gets this version's schema at the first
use of the database (`lib/db-driver/pg-current.ts`: `ensureSchemaVersion()`
of `pg-ddl.mjs` – adds, never drops – under an advisory lock, limits
lifted); a current or newer one is left alone, so old and new instances run
side by side during a rolling update. `scripts/db-schema.mjs` (in the image
as `/app/scripts/db-schema.mjs`) does the same as a separate deployment step (the
Helm chart's Job, the compose example's `schema` service);
`FLOWPLAN_PG_SCHEMA_AUTO=off` leaves it to that step. (Before, nothing in
the app created the PostgreSQL schema – only tests and the migration tool
did.) The image no longer starts Litestream when `DATABASE_URL` is
PostgreSQL.

### Races reviewed (READ COMMITTED, several instances)

| Place | Before | Now | Test (`tests/cluster-concurrency.test.ts`, both databases) |
|---|---|---|---|
| Yjs merges: document, record document, whiteboard, server-side rewrites | read state, merge, write back – a parallel save from the same base lost the other's edits | the read is `SELECT … FOR UPDATE` (`sql.forUpdate()`), the second save waits and merges into the first's result | four saves from one base at once: all four paragraphs in the state and the HTML |
| Sign-up with one address | both passed the check; the second hit the unique index (500) | the check is repeated inside the sign-up lock: 409 `AccountExists` | three sign-ups at once: one account, two `AccountExists` |
| Sharing a page, accepting invitations | membership/guest/grant read then written; duplicates hit keys (500) | `lockMembership(workspace)` (advisory, per workspace) in `sharePage`, `updatePageShare`, `acceptInvite` (now in a transaction, skips an invitation another sign-in took) | three shares to one person at once: one membership, one grant |
| Last owner, last admin | "one owner/admin remains" read, then the demotion, leave or deletion written: two owners demoting each other (or leaving) at once, or two admins taking each other's right, left none | `lockMembership(workspace)` in `member.role` and `manageWorkspace`; `lockFor(ADMINS_LOCK)` in `setLocalAdmin` and `lastAdmin` (account deletion) | two owners demote each other / leave at once, two admins revoke each other at once: one remains |
| Quotas | two uploads both passed `used + size ≤ quota` | `enforceQuota`/`quotaCheckpoint` lock the workspace until the commit when it has a quota | three uploads that fit only once: one passes |
| Record numbers | counter row trigger | unchanged (the counter row's lock serialises) | twelve records at once: 1…12 |
| Queue claims | storage queue read then deleted | `SKIP LOCKED` claim with lease | five workers, 40 jobs: each taken once; leased jobs return after the lease |
| Usage metrics minute | read, add, overwrite | under `lockFor` | – |
| Tags/properties, first account, issue connections, SSO mappings, rack templates, collection order | locked in phase 1 | unchanged | phase 1 tests |
| Last owner (Nov 2026 audit) | `member.role`, `workspace.leave` counted the owners, then wrote: two owners demoting each other or leaving at once left none (and spaces owned by people who had left) | `lockMembership(workspace)` first – before the actor's own role is read – in `member.invite`, `invite.cancel`/`resend`, `member.role` (also remove), `member.guest`, `grant.set`, `group.member`, `space.create`, `manageWorkspace` (leave/delete), `removeFromWorkspace`, `e2ee.member.add`, SSO role sync (workspaces in sorted order), account deletion's hand-over (sorted) | `tests/concurrent-limits.test.ts`: mutual demotion, removal, leaving; owner and guest at once |
| Per-person and per-workspace limits (Nov 2026 audit) | counted, then inserted: parallel requests all passed | `lockFor` per key before the count: `user-workspaces:<user>` (workspace limit), `user-storage:<user>` (`enforceUserStorage`, always after `enforceQuota`), `share-links:<page>`, `api-tokens:<user>`, `plugins:<workspace>`, `webhooks:<workspace>`, `inbound-addresses:<workspace>`, `mobile-devices:<user>`, `date-reminders:<user>`, `ai-access-rules:<user>`, `page-ink:<page>`, `scim-tokens`; uploads (`lib/page-upload.ts`, mobile and widget capture) check again inside the insert's transaction | `tests/concurrent-limits.test.ts`: workspace limit, storage, quota, share links, API and SCIM tokens |

Without the fixes the same tests fail on PostgreSQL (checked by disabling
`forUpdate`/`skipLocked`/`lockFor`: 5 of 6 fail; record numbers pass on the
trigger alone). Positions computed as `MAX(position)+1` outside the locked
paths (row transfer, shared-content records) can still tie; ties sort by
`seq`/id, so the effect is cosmetic.

### Health, shutdown

`/api/health/live` (the process answers – no database: restarting would
not fix it), `/api/health/ready` (database; cluster: Redis and bucket –
which of them count: `FLOWPLAN_READY_REQUIRE`, default all; 503 while
stopping; details with the metrics token). `/api/health` stays the
combined check of the image's `HEALTHCHECK` and the apps. On SIGTERM/SIGINT
(alongside Next.js, which closes the server and waits for open requests):
readiness turns 503, the server-sent event streams are closed (browsers
reconnect through the balancer – otherwise Next.js would wait for them
until the platform kills the process), the leader unlocks, the heartbeat
entry goes, then Redis and the session connection close.

### Administration

Administration → Monitoring → **System** (`components/settings/admin/monitoring.tsx`,
data in the monitoring overview): mode, database kind/version/check, the
pool of this instance and the time limits, Redis (host, version, messages
sent/received/failed), object storage (host, bucket, check), the leader,
the instances with heartbeat, state, connections and memory, and the
shared queues (files due/in flight, mail, push, webhooks, chat apps).

### Deployment examples

- `deploy/compose/cluster/`: PostgreSQL 16 (Flowplan's role `flowplan`
  owns the database but is no superuser: `postgres-init.sh`, §3
  "Security"), Redis 7 (password, no
  persistence), MinIO with a bucket job, the `schema` step, two instances
  (cache volumes), Caddy as load balancer (round robin, health checks on
  `/api/health/ready`, streams unbuffered). `docker compose config` valid.
- `deploy/helm/flowplan`: `cluster.enabled` – replicas with rolling
  updates (`maxUnavailable: 0`), `DATABASE_URL`/`REDIS_URL` only as Secret
  references, schema Job as pre-install/pre-upgrade hook, live/ready probes,
  `preStop` pause, PodDisruptionBudget, spread over nodes, `emptyDir` cache
  instead of the PVC; refuses to render without database, Redis and bucket.
  The single-pod default renders as before (apart from the chart version).
  `helm lint --strict` and `helm template` pass for both.

### Tests

- `tests/cluster.test.ts`: the requirement check, pool limits, the RESP
  parser (every cut of a reply), the client (commands, pub/sub, reconnect
  after the connections drop), and on PostgreSQL **two and three instances
  as child processes** (`tests/helpers/cluster-instance.ts`) on one schema
  and one Redis: exactly one leader, heartbeats of both, a document update
  published on one arriving at an editor stream of the other, a shared
  rate limit, graceful handover (asserted under 5 s) and failover after
  `SIGKILL` of the leader. Real Redis with `FLOWPLAN_TEST_REDIS_URL` (CI's
  `postgres` job now has a `redis:7` service), else an in-process double
  (`tests/helpers/fake-redis.ts`).
- `tests/cluster-concurrency.test.ts`: the races above.

### Results

- **`npx tsc --noEmit -p .`** clean; `node scripts/db-dialect-scan.mjs`
  zero on every SQLite-only pattern (`LIKE` 76, as in phase 2).
- **SQLite** (`npm test`, after merging phase 3's search): 2,094 tests –
  2,084 pass, 0 fail, 10 skipped (the multi-instance test needs PostgreSQL;
  phase 3's PostgreSQL-only tests). Before the merge one time-bucket test of
  `tests/metrics.test.ts` failed once under load and passed on its own.
- **PostgreSQL 16** (`DATABASE_URL=…`, `FLOWPLAN_TEST_REDIS_URL` with a real
  Redis 7, after the merge): 2,094 tests – 2,088 pass, 0 fail, 6 skipped
  (SQLite's own; the one failure of the run, the Helm chart test's image
  path, fixed and re-run). Before the merge (2,078 tests) one flaky test: `tests/admin-ops.test.ts` "refusals are counted"
  fails in about half of the runs on a loaded host – on the unchanged
  `db-refactor` branch as well (a counter written after the transaction,
  awaited with one `setImmediate`); not caused by this phase. The cluster tests also ran against the in-process
  Redis double.
- **`next build`** passes; `npm run check:standalone` (SQLite) and
  `scripts/check-standalone-postgres.mjs` pass. The standalone build ran
  in cluster mode (two instances, Redis, an S3 stand-in) for the load test
  below.
- **Deployment:** `docker compose config` of `deploy/compose/cluster`
  valid; `helm lint --strict` and `helm template` of the chart valid with
  and without `cluster.enabled` (Helm 3.16).
- **Found by the load test and fixed:** the 18 offline change log triggers
  deleted and re-inserted the page's row (SQLite's `INSERT OR REPLACE`
  pattern) – two concurrent writes to one page (a comment and a save)
  failed with a unique violation on PostgreSQL, in single-container mode
  too. The trigger translator now makes those inserts upserts
  (`pg-triggers.ts` `UPSERTS`; test: eight comments on one page at once).
  `flowplan_meta.schema_hash` makes such a changed translation reach
  existing databases at the same schema version.
- **Search deadlocks** between the indexer and request-time index writes
  (`DELETE FROM search_index/search_dirty`) showed in run B, before the
  phase 3 search was merged; the run on the merged branch (§15, run A) had
  no server errors.

### What is left (open risks)

- **Files written on one instance** are uploaded by that instance (NOTIFY,
  then the queue). Until then (normally well under a second) other
  instances wait up to 5 s in `ensureLocal`; paths that read the uploads
  folder directly (exports, archives, some importers, publication copies)
  do not fetch from the bucket yet and can miss a file another instance
  wrote. A write-through upload (or reading through `ensureLocal`
  everywhere) closes this. If an instance dies before uploading, its files
  are lost (the queue gives up after its retries).
- **Leader duties during a handover:** a round already running on an old
  leader that lost its connection can overlap with the new leader's first
  round. The duties are idempotent or claim their rows, but none is
  checked against that.
- **Process-local state that is still per instance:** the setup restore
  and instance move progress (`lib/setup-restore.ts`, `lib/instance-move.ts`),
  their staged files in the local data folder (an `emptyDir` in Kubernetes:
  lost on a restart – run a restore with one instance), the in-memory
  "people active this hour" count (the hour row takes the maximum of the
  instances and of the sessions table), the search indexer's backlog
  numbers per process.
- **Restores on PostgreSQL** truncate and refill every table in one
  transaction: other instances' queries wait on the locks and fail after
  `lock_timeout`. Scale to one instance (or use maintenance mode) for a
  restore.
- **Sequential awaits** per request (§12) cost ~0.1 ms per round trip on
  PostgreSQL; the sidebar/bootstrap permission checks and `filterAsync`
  over pages are the hot spots in the load test (§15).
- **PgBouncer:** named prepared statements need ≥ 1.21 with
  `max_prepared_statements`; older ones, or without it:
  `FLOWPLAN_PG_PREPARE=off` (every statement unnamed, `postgresPrepare()`
  in lib/db-driver/postgres.ts; costs about a third of the throughput,
  §8). `LISTEN`, the leader's session-level advisory lock and
  `pg_dump`/`pg_restore`/`psql` need a session of their own:
  `DATABASE_SESSION_URL` (the server itself or a session-mode pool;
  `postgresSessionUrl()` in lib/db-driver/context.ts, used by
  lib/cluster/pg-session.ts and lib/pg-backup.ts) – without it they use
  `DATABASE_URL`. Pool connections pass `search_path` and the timeouts as
  startup parameter `options`: a PgBouncer that refuses it needs
  `ignore_startup_parameters = options`, and then the schema `public` and
  the timeouts set on the role (`ALTER ROLE … SET statement_timeout …`) –
  not tested here (no PgBouncer in CI).
- **Redis** is a single point for live updates and shared limits: when it is
  away, editing and saving keep working (PostgreSQL), live updates between
  instances stop (clients catch up on their next check), rate limits count
  per instance, and readiness turns 503 on every instance at once – the
  balancer has nothing left. `FLOWPLAN_READY_REQUIRE=database` (or
  `database,objectStorage`) keeps instances ready without Redis; the
  default requires all three, as decided. Redis Sentinel/Cluster are not
  supported by the small client (one endpoint; a managed Redis with a
  stable address works).
- `scripts/check-promises.mjs` is still a tool, not a CI gate.

## 15. Sizing (load test of cluster mode)

`scripts/load-test-cluster.mjs` (with `scripts/loadtest/`, see its
README): a fresh schema per run (`scripts/db-schema.mjs`), N instances of
the standalone build in cluster mode, a round-robin balancer in front
(`scripts/loadtest/balancer.mjs`, each request to the next instance – so
saves, live streams and cursors of one person land on different instances
and the fan-out goes through Redis), an in-memory S3 stand-in, the seeder
writing accounts straight into PostgreSQL (`seed.mjs --database`), then
`run.mjs` ramping virtual users (VUs): 200 accounts, 120 documents, a
database with 2,000 records; every 7th VU an editor typing with live
co-editors, the others the read/write mix of the SQLite load test (think
time 1.5 s ± 50 %). The knee is the first step with read p95 > 500 ms,
write p95 > 1 s or errors > 1 % (as for SQLite); "serves" is the step
before it.

```sh
npm run build
DATABASE_URL=postgres://… REDIS_URL=redis://… taskset -c 2,3 \
  node scripts/load-test-cluster.mjs --pin 0,1 --instances 1,2 \
  --steps 10,15,20,25,30,40,50,60 --duration 40 --out /tmp/lt-cluster.json
```

Machine: 4 vCPU Intel Xeon @ 2.10 GHz, 16 GB, PostgreSQL 16 and Redis 7
on the same host, Node 22.

**Run A – merged branch (search of phase 3 included), quiet host (load
average 1–4), pinned** (each instance one core of its own, `--pin 0,1`;
generator and balancer on cores 2–3; PostgreSQL unpinned). The numbers
for the sizing guide:

| VUs | 1 instance: req/s | read p95 ms | write p95 ms | errors | 2 instances: req/s | read p95 ms | write p95 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 11.4 | 153 | 59 | 0 | 11.3 | 110 | 36 | 0 |
| 20 | 21.2 | 234 | 88 | 0 | 21.8 | 134 | 46 | 0 |
| 30 | 38.4 | 340 | 107 | 0 | 39.2 | 229 | 71 | 0 |
| 40 | 45.9 | **1,847** | 253 | 0 | 48.5 | 249 | 68 | 0 |
| 50 | 53.7 | 5,341 | 269 | 0 | 65.4 | **595** | 113 | 0 |
| 60 | 50.2 | 8,750 | 304 | 1.3 % | 72.0 | 922 | 170 | 0 |
| 80 | 47.8 | 7,642 | 694 | 4.8 % | 82.6 | 7,920 | 263 | 0.4 % |

- **1 instance serves 30 VUs** (knee at 40); **2 instances serve 40**
  (knee at 50, read p95 595 ms – just over the line; 60 VUs still without
  errors at 922 ms). Throughput 54 → 83 req/s (1.5×). PostgreSQL, on the
  shared cores, takes part of the second core's gain.
- **What saturates first:** `bootstrap` (sidebar, permissions page by page:
  many sequential queries), then `db.open` (all records) and `search`.
  Writes and live editing stay fast long after: at 60 VUs on 2 instances
  `doc.sync` p95 182 ms, and the cross-instance fan-out (an editor's save
  arriving at another editor's stream on the other instance, through Redis)
  p95 195 ms. No server errors in this run.

**Run B – before the merge, host shared with another test suite** (load
average 4–15), same setup: 1 instance served 25 VUs (knee 30), 2 served 40
(knee 50); unpinned, both setups had their knee at 30 VUs, but 2 instances
carried 62 req/s without errors up to 60 VUs where 1 instance had 6 %
timeouts. This run found the offline change log race (§14) and search
deadlocks (gone after the merge).

- **Compared with SQLite** (one process, the earlier load test: knee at
  ~20 active VUs): one PostgreSQL instance on one core serves ~30, two
  ~40–50. The expected 35–40 per instance is not reached yet; batching the
  hot read paths (§12: sequential awaits; `bootstrap`'s permission checks,
  `filterAsync(pages, pageRole)`) is what moves it.
- **For the sizing guide** (a VU is a busy person – one request every
  1.5 s or typing continuously; real people are far less active, see the
  SQLite load test's notes on translating VUs into people): plan
  **~25–30 active VUs per instance with one dedicated core**, add
  instances linearly as long as PostgreSQL has headroom (it was not the
  bottleneck here: write p95 stayed under 500 ms everywhere), give each
  instance `FLOWPLAN_PG_POOL` 10–20 and PostgreSQL
  `max_connections ≥ instances × (pool + 2) + reserve`. Re-measure on the
  target hardware with the command above; a dedicated host (nothing else
  running) will give higher numbers.
