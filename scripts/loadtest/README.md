# Load test

Finds out how many active people one Flowplan instance (one Node process,
SQLite in WAL mode) serves before it slows down, and what runs out
first. Plain Node: `fetch`, `worker_threads`, and `yjs` from the project's
own dependencies. Nothing to install.

> **Never run this against an instance that real people use.** The seeder
> creates an admin account, hundreds of accounts with sessions and API
> tokens, spaces, documents and thousands of records. The load itself
> slows the instance down for everyone. Use a fresh, separate instance and
> delete its data directory afterwards.

## What it does

- `serve.mjs` starts the production build the way the Docker image does
  (`node server.js` from `.next/standalone`) with an empty data directory,
  `FLOWPLAN_METRICS_TOKEN` and `FLOWPLAN_METRICS_LOOP=1`.
- `seed.mjs` fills the instance: the first account (admin) creates spaces,
  documents with a few KB of text, a task database with views that filter
  and sort, and a few thousand records (one `rows.import`, like the CSV
  import). Accounts, workspace memberships, browser sessions and read-only
  API tokens are written straight into the SQLite file (through the API,
  the sign-up and invitation limits would stop at a few dozen accounts), so
  the seeder needs the data directory: run it on the server host or inside
  the container.
- `run.mjs` ramps virtual users (VUs) in steps and prints one table row per
  step. Two kinds of VUs (`vu-worker.mjs`):
  - **readers/writers** loop over a weighted mix with a think time
    (default 1.5 s ± 50 %) between requests: `bootstrap` 15, open a document
    (`page.open`) 20, open the database (`db.open`, all records, as the web
    app's table does) 8, filtered/sorted database query through the MCP
    endpoint (`db.query`, evaluated on the server) 10, `search` 12, edit a
    record cell (`row.update`) 15, `row.create` 4, `page.create` 4,
    `comment.create` 12. Change the weights with `--mix`.
  - **editors** (`--editor-share`, default every 7th VU) do what the web
    editor does (`components/editor.tsx`): open a document, keep the live
    channel open (server-sent events, `/api/documents/live`), type in bursts
    at ~5 keystrokes per second, save as Yjs updates with `document.sync`
    80 ms after typing (one request in flight, the rest batched) and send
    cursor updates (`/api/presence`). `--coeditors` editors share a
    document; the time from one editor's save to the update arriving at the
    others is reported as `fanout`.
  - `--heavy backup|import|both` runs large jobs alongside: the workspace
    export (`/api/backup`) and a `rows.import` of `--import-rows` records
    (which the search index then picks up), every `--heavy-interval` s.
- `run.mjs --probe N` sends every request type N times one after the other
  on an idle instance: the service time (what one request costs the server
  without queueing). Run it before the ramp.

Per step: requests per second, latency p50/p95/p99 for reads and writes
and per scenario, errors (5xx, 429, timeouts, network; 409 conflicts on
record edits are counted but not as failures), and from the server (with the
metrics token): CPU, event-loop utilisation and delay, time spent in SQLite
statements and write transactions, RSS, database and WAL size. Rate limits:
none of the scenarios hits one at these rates (MCP allows 120 calls per
person and minute; the VUs use 400 different accounts), so nothing needs to
be switched off – a 429 in the output means a limit did kick in.

## Run it

```sh
npm run build
node scripts/loadtest/serve.mjs --work /tmp/flowplan-lt --port 3497 &
node scripts/loadtest/seed.mjs --url http://127.0.0.1:3497 --data /tmp/flowplan-lt/data --out /tmp/lt-seed.json
node scripts/loadtest/run.mjs --seed /tmp/lt-seed.json --probe 20 --workers 1 --out /tmp/lt-probe.json
node scripts/loadtest/run.mjs --seed /tmp/lt-seed.json \
  --metrics-token loadtest-metrics-token-0123456789 \
  --data /tmp/flowplan-lt/data --pid "$(cat /tmp/flowplan-lt/server.pid)" \
  --steps 5,10,20,30,40,60,100 --duration 60 --out /tmp/lt-result.json
kill -INT "$(cat /tmp/flowplan-lt/server.pid)"; rm -rf /tmp/flowplan-lt
```

Against another instance (e.g. a container on your hardware): start it with
an empty data directory and `FLOWPLAN_METRICS_TOKEN=<16+ chars>` and
`FLOWPLAN_METRICS_LOOP=1`, run `seed.mjs` where it can open the data
directory (`docker exec`, or the mounted volume on the host), and point
`run.mjs` at the seed file. `--data` and `--pid` are optional (file sizes
and CPU from `/proc`; without them CPU and sizes come from the metrics
endpoint). The seed file holds session cookies and tokens: delete it after
the test.

Useful options: `--steps`, `--duration` (s per step), `--think` (ms),
`--editor-share` (0–1), `--coeditors`, `--keystroke` (ms), `--presence off`,
`--heavy`, `--mix name=weight,…`, `--workers` (load-generator threads),
`--timeout` (ms per request), `--stop-p95` (stop when reads and writes are
both above this). Profile the server with `serve.mjs --cpu-prof`; the
`.cpuprofile` is written to `<work>/profiles` when the server stops.

Seeder options: `--users` (400), `--docs` (300), `--records` (3000),
`--spaces` (6).

## Cluster mode (PostgreSQL, several instances)

`scripts/load-test-cluster.mjs` runs the same ramp against 1, 2, …
instances of the standalone build in cluster mode on one PostgreSQL and
one Redis: a fresh schema per run, a round-robin balancer in front
(`balancer.mjs`), an S3 stand-in, `seed.mjs --database postgres://… --schema …`
(accounts written into PostgreSQL instead of the SQLite file). `--pin 0,1`
gives each instance a core of its own. Results and how to read them:
docs/architecture/database.md §15.

```sh
npm run build
DATABASE_URL=postgres://… REDIS_URL=redis://… taskset -c 2,3 \
  node scripts/load-test-cluster.mjs --pin 0,1 --instances 1,2 --steps 10,20,30,40,50,60 --out /tmp/lt-cluster.json
```

## Reading the results

- The **knee** is the first step where read p95 passes ~500 ms, write p95
  ~1 s, or errors rise above ~1 %.
- Event-loop utilisation near 1 and a growing loop delay mean the single
  Node thread is the limit (CPU); a high SQL share says how much of it is
  SQLite. Rising RSS with flat CPU points at memory, a growing WAL at
  checkpoints falling behind.
- The load generator measures its own event-loop delay (`generator` in the
  JSON). If it is high, the generator is the limit – use more `--workers`
  or a second machine.
- A VU is a busy person: one request every 1.5 s, or typing continuously.
  Real people pause far longer; see the report that came with this tool
  for how VUs translate into people.
- Absolute numbers depend on the CPU (single-thread speed matters most)
  and on what else runs on the machine. Record `nproc`, the CPU model and
  the load average (`run.mjs` prints them) and compare steps within one run
  rather than numbers across machines.
