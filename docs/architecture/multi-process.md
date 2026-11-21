# Several processes behind one port (#383 wave 5)

Status: **opt-in** (`FLOWPLAN_PROCESSES`, default 1 = one process, exactly
as before). Measurements: §8.

## 1. Why

Wave 4 left a fixed cost of about 4 ms CPU per request (Next.js routing,
sockets, async hooks; a bit less on Node 24) and one process saturating at
about 100 busy virtual users on a 4 vCPU box, its one event loop at 100 %
while the other cores idle. The worker threads of waves 2/3 take long jobs
(exports, imports, search, database opens) off the request thread, but not
the per-request cost. Spreading requests over processes is the remaining
lever on one host.

## 2. What it is

```
                 :3000 (one port)
                      │
        processes.mjs (supervisor, node:cluster primary, ~45 MB)
        ├─ round robin of connections
        ├─ IPC hub: bus fan-out, shared limit windows, AI slots, "ask"
        ├─ start order, respawn with backoff, ordered shutdown
        │
        ├── process 1  "primary": requests + everything once per host
        ├── process 2  "worker":  requests only
        └── process n  "worker":  requests only
```

- `FLOWPLAN_PROCESSES` – in line with `FLOWPLAN_WORKERS` (threads). Unset or
  `1`: `server.js` as today (the entrypoint does not even start the
  supervisor). A number 2–16, or `auto` = the cores the container may use
  (cgroup CPU quota, at most 8).
- `scripts/processes.mjs` is copied to `/app/processes.mjs` next to
  `server.js` (image and release archives). `docker/entrypoint.sh` runs
  `node processes.mjs` instead of `node server.js` when the setting is > 1,
  in every path (with and without Litestream). Installs without Docker
  start `node processes.mjs` themselves. With N = 1 `processes.mjs` just
  loads `server.js` in its own process.
- The supervisor is plain JavaScript and loads none of Flowplan. It starts
  process 1 alone; process 1 opens the database (migrations, data steps,
  a staged restore) and sends `ready` (instrumentation.ts →
  `announceReady`); only then the others start. So migrations run once and
  before any other process opens the file.

## 3. Decisions

### 3.1 Primary process, reusing the leader

The cluster mode's "leader" already gates every singleton duty:
`leaderDuty()` and `isLeader()` (lib/cluster/leader.ts). Outside cluster
mode they used to be always true; now they are true in process 1 only
(`primaryProcess()`, lib/cluster/processes.ts). On top, the processes 2…n
skip the whole block of timed workers in instrumentation.ts, so they poll
nothing. What a request kicks on demand (`dispatchPush`, `dispatchMail`,
webhooks, chat apps, the workflow queue's wake) still runs in the process
that got the request: those queues claim their rows atomically (they are
written for several cluster instances already), and the workflow wake goes
over the bus to process 1.

Role is fixed to process 1. If it crashes, the supervisor starts it again
(1 s, doubling to 30 s while it keeps crashing within a minute); the timed
jobs pause for those seconds. A promotion of another process was not worth
it: every job catches up on its next round.

### 3.2 Singletons, classified

Once per host (process 1 only):

| What | Where | How |
|---|---|---|
| Migrations, data steps, staged restore at start | lib/db.ts open, `startOpening` | process 1 first, the others after `ready`; a respawned process never applies a staged restore (`restoreAtThisStart`) |
| Date/task/study/meeting reminders, automations, page reviews, emergency access, inactivity message, retention, inactive accounts, LDAP and contacts sync, calendar sync, issue sync, inbound IMAP, AI worker, file text, search indexing, digests, Telegram links, ops sweeps, scheduled backup, workflow schedules | their `start…Worker` | timers started in process 1 only, and `leaderDuty` is false elsewhere |
| Push/mail/webhook/chat queues (timers) | lib/push.ts, mail.ts, webhooks.ts, messengers.ts | timers in process 1; on-demand dispatch anywhere (atomic claims) |
| Workflow queue and lease sweep | lib/workflows/queue.ts | process 1; others publish `workflow:wake` |
| Litestream health and memory | lib/litestream-health.ts | process 1 |
| Restart history (heartbeat files, previous runs) | lib/restarts/* | process 1; the others keep their own log file (`app-<host>-p<n>.log`) and their crashes show in the supervisor's table |
| Setup warnings, TLS warnings | instrumentation.ts | process 1 |
| Second-instance guard on PostgreSQL | lib/cluster/single-instance.ts | process 1 (one advisory lock per host, not N) |
| Meeting audio sweep | lib/meetings.ts | process 1 |

Per process (unchanged, harmless or necessary):

| What | Why it stays per process |
|---|---|
| Request metrics, server metrics sample | each process counts its own requests; the minute rows add up (`writeMinute` locks and adds) |
| Runtime metrics (event loop, SQLite time) | per event loop |
| `PRAGMA optimize` every 6 h | per connection |
| Storage queue (S3 mirror) timers | started at the opening of the database; claims in the database, already cluster-safe |
| Kept answers (cheap 304), VersionedCache, read memo, statement cache, SQLite page cache (64 MiB), mmap | caches; correctness from versions in the database and `PRAGMA data_version`, see §5 |
| Live hubs: document live, audience rooms, board cursors, text presence, workspace signals, whiteboard facilitation | they serve the SSE streams of their process; the bus carries what others need |
| Worker-thread pool | per process, size divided (§3.6) |

### 3.3 One port: round robin

node:cluster's round robin (the default on Linux): the supervisor accepts
and passes each connection to the next process. Alternatives:

- `SCHED_NONE` (`FLOWPLAN_PROCESS_BALANCE=os`): all processes accept on the
  shared socket; the kernel wakes whoever. Known to be uneven on Linux
  (the busy process keeps winning); measured in §8.
- `SO_REUSEPORT`: one socket per process, the kernel hashes the 4-tuple.
  Needs patching Next.js's `listen` call in each process, and with a
  reverse proxy holding few long-lived upstream connections the hash can
  pin most of the traffic on one process. Not done.
- A front proxy in Node (like scripts/loadtest/balancer.mjs): one more
  copy of every byte and its own event loop as the bottleneck.

Round robin costs the supervisor an accept and a handle transfer per
*connection*, not per request; with keep-alive that is small (§8). It
balances connections, not requests: a browser keeps ~6 connections, a
reverse proxy a pool – enough connections for an even spread in practice.

### 3.4 The bus over IPC

`publish()`/`onBus()` (lib/cluster/bus.ts) keep their semantics: the hub
delivers to its own listeners first, then publishes; the others' handlers
get `(payload, origin)`; messages are signals, best effort. Without cluster
mode and with several processes, `publish()` sends `{fp:"bus", o, t, p}`
over the process's IPC channel; the supervisor forwards it to every other
process. JSON serialisation, as with Redis, so payloads behave the same.

Composition with Redis (cluster mode across hosts): **each process is a
cluster instance of its own** (its id gets `-p<n>`): its own Redis
connections, its own heartbeat, it takes part in the PostgreSQL leader
election. IPC is not used for the bus then. Reasons: Redis already reaches
the processes next door (sub-millisecond on the same host); one transport
means no duplicates and no dedup logic; failover and fencing stay exactly
as tested. A bridge (one process relaying between IPC and Redis) would save
Redis connections but adds a single point that sees every message twice and
a dedup step on every receiver. Costs of "each": N× Redis connections and
N× PostgreSQL pools per pod (documented).

### 3.5 SQLite with several processes

- Driver: `node:sqlite` (`DatabaseSync`), synchronous. WAL mode, foreign
  keys and `busy_timeout=5000` are set on every connection already; write
  transactions are `BEGIN IMMEDIATE` (lib/db-driver/sqlite.ts), so two
  processes never deadlock on a read-to-write upgrade: the second waits for
  the lock (up to 5 s) at BEGIN.
- The wait is synchronous: a process waiting for another's write lock
  blocks its event loop for that time (SQLite's busy handler sleeps
  1, 2, 5, 10 … ms). Flowplan's write transactions take well under a
  millisecond to a few ms; a long one (an import of thousands of records)
  makes the other processes' writes wait. Litestream's checkpoints already
  cause the same waits today. Measured in §8 (`write p95`).
- Migrations: only process 1 opens the file before `ready` (§2). The others
  run `migrate()` on open as before; it finds the schema current.
- Litestream: its docs ("Tips: Busy timeout") call SQLite "built to run as
  a multi-process embedded database and Litestream acts as just another
  process". Its requirements are WAL mode, a `busy_timeout` on every
  connection (5 s, as recommended), and that only one Litestream
  replicates the database (the entrypoint's flock already ensures one per
  data folder). Several writer processes are fine: Litestream holds a read
  lock between its own checkpoints, so neither process checkpoints behind
  its back; if one does under very high write load (an automatic
  checkpoint in between), Litestream notices and takes a fresh snapshot –
  correctness holds, only that sync is larger. Nothing in Flowplan runs a
  TRUNCATE checkpoint, changes the journal mode or VACUUMs the live file.
- Restores that swap the file: a staged restore is applied only by
  process 1 at the host's start (`restoreAtThisStart`), never by a process
  the supervisor started again while the others hold the file open. The
  restore during setup (lib/setup-restore.ts) asks for a container restart
  with several processes, as it already does with Litestream.

### 3.6 State that must be per host

- **Rate limits** (lib/action-limits.ts: invitations, mail, AI, sign-up,
  reset, form suggestions, workflow hooks, move requests): the decision
  stays synchronous and local; each allowed action is also counted in a
  sliding window in the supervisor (same answer as the Redis Lua script).
  When the shared window is full, the process refuses the key and tells the
  others over the bus. A key gets at most its limit plus about one action
  per process in flight – not N × the limit (test: 15 tries, 5 allowed).
- **Sign-in brute-force counters** are rows (`login_failures`, reserved in a
  transaction) – shared already.
- **AI parallel answers** (lib/ai/concurrency.ts): slots in the supervisor,
  with the same expiry and renewal as in Redis; the slots of a process that
  ends go back at once.
- **Page presence** (lib/page-presence.ts, in memory since wave 1): what a
  process sees goes over the bus (`presence`) at most every 15 s per person
  and page; the others keep it alongside their own. No table writes (they
  would bump `data_version` and empty every process's kept answers).
- **Worker threads**: `FLOWPLAN_WORKERS` counts for the host; each process
  gets its share, at least 1 (unless 0). Default: (cores − 1) / N, at least
  1 per process.
- Questions to the other processes (`askPeers`): the setup restore's
  progress (its poll may reach another process than the one restoring).
- Left per process, as in cluster mode: the AI quota's reservations of
  requests in flight, "account exists" notes (one per address and 15 min),
  the move token's failure counter (10 per 15 min per address and process;
  tokens are 256 bit), security-event counters for the metrics.

### 3.7 Shutdown and crashes

SIGTERM/SIGINT reach the supervisor (PID 1's child under Litestream, or PID
1). It signals the processes 2…n first; each runs the graceful shutdown of
lib/cluster/runtime.ts (readiness 503, SSE streams closed so browsers
reconnect, Next.js drains, shutdown tasks); once they ended (or 60 % of the
budget passed), process 1 gets the signal and drains the same way, its
timed jobs running until then; the supervisor exits with 143/130. Bounded
by `FLOWPLAN_SHUTDOWN_SECONDS` + 5 s, then SIGKILL. If the supervisor itself
dies, node:cluster's workers exit when their channel closes.

A crashed process is started again with a backoff (1 s, doubling to 30 s,
reset after a minute up). If process 1 ends before it was ever ready (bad
configuration, failed migration), the supervisor exits with its code, so
the container restarts as it would today.

### 3.8 Monitoring

- Each process writes its own `metrics_server` row (instance key with
  `-p<n>`), CPU and RSS of its own; only process 1's row carries the
  container's limits and cgroup memory, so the sums per minute count the
  host once (CPU added up, memory = the cgroup's, or the processes' RSS on
  bare metal). Administration → Überwachung → Server shows the total and,
  as a table, every process; plus the supervisor's table (pid, memory, CPU
  since start, restarts, last exit).
- `/api/metrics`: a scrape reaches one process; its own series carry
  `process="n"`, the installation's figures are the same from every
  process, and `flowplan_host_process_*` (memory, CPU, restarts of every
  process) come from the supervisor in every scrape.

## 4. What stays per process, and its cost

- Memory: each process has its own V8 heap, Next.js, caches and SQLite page
  cache. §8 has the RSS per process.
- Kept answers (the cheap 304, wave 3/4) are invalidated by *any* commit of
  another process (`PRAGMA data_version` moves), not per table: under write
  load the 304 hit rate drops; correctness holds.
- VersionedCache entries (roles, page lists, bits): versions live in the
  database; each process builds its own copy once per version.
- SSE streams are bound to the process that accepted them; their signals
  come over the bus.

## 5. Risks and limits

- Synchronous SQLite lock waits across processes (§3.5).
- In-memory progress of rare admin flows (an instance move's job progress,
  a chat-app connection test) is per process; their status poll may land
  on another process. The setup restore's progress is asked from the
  others; for an instance move, run with one process (as with cluster mode).
- A chunked recording upload (notebook audio) serialises its chunks in
  memory; a retry overlapping its original on another process could race.
  Same as cluster mode; staging is on the same disk here.
- Next.js's own disk cache (`.next/cache`, image optimisation) is shared by
  the processes; Next writes it per entry.
- With PostgreSQL every process has its own pool: N × `FLOWPLAN_PG_POOL`.

## 6. Turning it on

- Docker: `FLOWPLAN_PROCESSES=auto` (or a number) and restart. Memory: see §8;
  give the container about 300 MB more per process.
- Helm: `env: { FLOWPLAN_PROCESSES: "2" }` with a CPU request of 2.
- Release archive / YunoHost: `FLOWPLAN_PROCESSES=… node processes.mjs`.
- `FLOWPLAN_PROCESS_BALANCE=os` hands connections out by the kernel.

## 7. Tests

tests/processes.test.ts: settings, the shared window (same answers as the
Lua script), AI slots, and a real supervisor with three processes (start
order, bus with origin, leader duties only in process 1, a limit of 5 is 5
for the host, AI slots across processes, presence, questions, the table,
respawn, ordered shutdown with 143, process 1 failing before ready).

## 8. Measurements

(Filled in after the load test.)
