// Load test runner (scripts/loadtest/README.md): ramps virtual users in
// steps against a seeded instance (seed.mjs), runs heavy background jobs
// alongside if asked, and reports per step: requests per second, latency
// percentiles per scenario, errors, and – with FLOWPLAN_METRICS_TOKEN and
// FLOWPLAN_METRICS_LOOP=1 on the server – event-loop delay and utilisation,
// time spent in SQLite, CPU and memory of the server process.
import { Worker } from "node:worker_threads";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { loadavg, cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    seed: { type: "string", default: "loadtest-seed.json" },
    steps: { type: "string", default: "10,25,50,100,200,400" },
    duration: { type: "string", default: "60" },
    settle: { type: "string", default: "5" },
    think: { type: "string", default: "1500" },
    "editor-share": { type: "string", default: "0.15" },
    coeditors: { type: "string", default: "5" },
    keystroke: { type: "string", default: "200" },
    presence: { type: "string", default: "on" },
    heavy: { type: "string", default: "none" },
    "heavy-interval": { type: "string", default: "20" },
    "import-rows": { type: "string", default: "2000" },
    workers: { type: "string", default: "2" },
    timeout: { type: "string", default: "10000" },
    "metrics-token": { type: "string", default: process.env.FLOWPLAN_METRICS_TOKEN || "" },
    data: { type: "string" },
    pid: { type: "string" },
    label: { type: "string", default: "" },
    out: { type: "string", default: "loadtest-result.json" },
    "stop-p95": { type: "string", default: "5000" },
    probe: { type: "string", default: "0" },
    mix: { type: "string", default: "" },
  },
});
const seed = JSON.parse(readFileSync(opt.seed, "utf8"));
const origin = seed.origin;
const steps = opt.steps.split(",").map(Number);
const DURATION = Number(opt.duration) * 1000,
  SETTLE = Number(opt.settle) * 1000,
  WORKERS = Number(opt.workers);
const options = {
  think: Number(opt.think),
  timeout: Number(opt.timeout),
  keystrokeMs: Number(opt.keystroke),
  presence: opt.presence !== "off",
  rampMs: SETTLE,
  mix: opt.mix,
};
const editorEvery = Number(opt["editor-share"]) > 0 ? Math.max(1, Math.round(1 / Number(opt["editor-share"]))) : Infinity;
const coeditors = Number(opt.coeditors);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Server metrics ----------------------------------------------------------
async function scrape() {
  if (!opt["metrics-token"]) return null;
  try {
    const r = await fetch(`${origin}/api/metrics`, { headers: { authorization: `Bearer ${opt["metrics-token"]}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const m = {};
    for (const line of (await r.text()).split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const i = line.lastIndexOf(" ");
      m[line.slice(0, i)] = Number(line.slice(i + 1));
    }
    return m;
  } catch {
    return null;
  }
}
// CPU (user+system ticks) and RSS of a local server process from /proc.
function procStat() {
  if (!opt.pid) return null;
  try {
    const stat = readFileSync(`/proc/${opt.pid}/stat`, "utf8").split(") ")[1].split(" ");
    const status = readFileSync(`/proc/${opt.pid}/status`, "utf8");
    return { cpu: (Number(stat[11]) + Number(stat[12])) / 100, rss: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0) * 1024, at: Date.now() };
  } catch {
    return null;
  }
}
function fileSizes() {
  if (!opt.data) return {};
  const size = (n) => (existsSync(resolve(opt.data, n)) ? statSync(resolve(opt.data, n)).size : 0);
  return { db: size("flowplan.sqlite"), wal: size("flowplan.sqlite-wal") };
}

// --- Workers -----------------------------------------------------------------
const workers = [];
let pendingFlush = null;
for (let w = 0; w < WORKERS; w++) {
  const worker = new Worker(new URL("./vu-worker.mjs", import.meta.url), {
    workerData: { seed: { ...seed, rows: seed.rows }, options, workerIndex: w, workerCount: WORKERS },
  });
  await new Promise((r) => worker.once("message", r));
  worker.on("message", (msg) => {
    if (msg.type === "samples" && pendingFlush) pendingFlush.push(msg);
  });
  worker.on("error", (e) => console.error("worker error", e));
  workers.push(worker);
}
async function flush() {
  pendingFlush = [];
  for (const w of workers) w.postMessage({ type: "flush" });
  while (pendingFlush.length < workers.length) await sleep(20);
  const got = pendingFlush;
  pendingFlush = null;
  return got;
}
// Virtual user i: an editor every `editorEvery` users (editors of one
// document in the same worker), the others readers/writers.
function plan(n) {
  const lists = workers.map(() => []);
  let editor = 0;
  for (let i = 0; i < n; i++) {
    const userIndex = i % seed.users.length;
    if (i % editorEvery === editorEvery - 1) {
      const docIndex = Math.floor(editor++ / coeditors) % seed.docIds.length;
      lists[docIndex % workers.length].push({ id: i, kind: "editor", userIndex, docId: seed.docIds[docIndex] });
    } else lists[i % workers.length].push({ id: i, kind: "reader", userIndex });
  }
  return lists;
}

// --- Heavy background jobs ---------------------------------------------------
const heavySamples = [];
let heavyOn = false;
async function heavyLoop(kind) {
  const admin = seed.admin.cookie;
  let n = 0;
  while (true) {
    if (!heavyOn) {
      await sleep(250);
      continue;
    }
    const job = kind === "both" ? (n++ % 2 ? "import" : "backup") : kind;
    const start = performance.now();
    let ok = false,
      bytes = 0,
      status = 0,
      error = "";
    try {
      if (job === "backup") {
        const r = await fetch(`${origin}/api/backup?workspace=${seed.workspaceId}`, { headers: { cookie: admin, origin }, signal: AbortSignal.timeout(300_000) });
        status = r.status;
        if (!r.ok) error = (await r.text()).slice(0, 160);
        else for await (const chunk of r.body) bytes += chunk.length;
        ok = r.ok;
      } else {
        const rows = Array.from({ length: Number(opt["import-rows"]) }, (_, i) => ({
          title: `Import ${Date.now()} ${i}`,
          status: "Offen",
          priority: "Niedrig",
          estimate: i % 13,
          notes: "Importierte Zeile mit etwas Text für den Suchindex",
        }));
        const r = await fetch(`${origin}/api/command`, {
          method: "POST",
          headers: { cookie: admin, origin, "content-type": "application/json" },
          body: JSON.stringify({ action: "rows.import", pageId: seed.importDatabaseId, rows }),
          signal: AbortSignal.timeout(300_000),
        });
        status = r.status;
        const text = await r.text();
        bytes = text.length;
        if (!r.ok) error = text.slice(0, 160);
        ok = r.ok;
      }
    } catch (e) {
      error = String(e?.message || e);
    }
    heavySamples.push({ job, ms: Math.round(performance.now() - start), ok, status, bytes, ...(error ? { error } : {}) });
    await sleep(Number(opt["heavy-interval"]) * 1000);
  }
}
if (opt.heavy !== "none") void heavyLoop(opt.heavy);

// --- Statistics --------------------------------------------------------------
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
function summarize(lat) {
  const s = Float64Array.from(lat).sort();
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.length ? s[s.length - 1] : null };
}
function merge(results) {
  const out = {};
  for (const r of results)
    for (const [name, b] of Object.entries(r.samples)) {
      const o = (out[name] ??= { lat: [], ok: 0, err: {} });
      for (const v of b.lat) o.lat.push(v);
      o.ok += b.ok;
      for (const [k, v] of Object.entries(b.err)) o.err[k] = (o.err[k] || 0) + v;
    }
  return out;
}
const READS = new Set(["bootstrap", "page.open", "db.open", "db.query", "search", "editor.open"]);
const WRITES = new Set(["row.update", "row.create", "page.create", "comment.create", "doc.sync", "presence"]);
const NOT_REQUESTS = new Set(["fanout", "fanout.unmatched", "sse.connect"]);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// --- Service times (--probe N) ------------------------------------------------
if (Number(opt.probe) > 0) {
  const got = await new Promise((done) => {
    workers[0].on("message", (msg) => msg.type === "probe" && done(msg.samples));
    workers[0].postMessage({ type: "probe", count: Number(opt.probe) });
  });
  console.log(`service times, ${opt.probe} sequential requests each (ms):`);
  const table = {};
  for (const [name, b] of Object.entries(got)) {
    const s = summarize(b.lat);
    table[name] = { ...s, errors: b.err };
    console.log(`  ${name.padEnd(16)} median=${Math.round(pct(Float64Array.from(b.lat).sort(), 50))} p90=${Math.round(pct(Float64Array.from(b.lat).sort(), 90))} max=${Math.round(s.max)} errors=${JSON.stringify(b.err)}`);
  }
  writeFileSync(opt.out, JSON.stringify({ label: opt.label, probe: table, loadavg: loadavg() }, null, 1));
  for (const w of workers) w.postMessage({ type: "stop" });
  await sleep(300);
  process.exit(0);
}

// --- Run ---------------------------------------------------------------------
const machine = { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGB: Math.round(totalmem() / 2 ** 30), node: process.version };
console.log(`machine: ${JSON.stringify(machine)} loadavg ${loadavg().map((v) => v.toFixed(2)).join(" ")}`);
const report = { label: opt.label, startedAt: new Date().toISOString(), machine, options: { ...opt, "metrics-token": opt["metrics-token"] ? "(set)" : "" }, steps: [] };
const header = "| VUs | req/s | read p50/p95/p99 ms | write p50/p95/p99 ms | sync p95 | fan-out p95 | err % | srv CPU % | ELU | loop p99/max ms | SQL share | RSS MB | WAL MB | load |";
console.log(header);
console.log(header.replace(/[^|]/g, "-"));
for (const vus of steps) {
  const lists = plan(vus);
  workers.forEach((w, i) => w.postMessage({ type: "vus", list: lists[i] }));
  await sleep(SETTLE);
  await flush(); // discard the ramp
  heavyOn = opt.heavy !== "none";
  const heavyFrom = heavySamples.length;
  const m0 = await scrape(),
    p0 = procStat(),
    t0 = Date.now();
  const windows = [];
  const loads = [];
  let rssMax = 0;
  while (Date.now() - t0 < DURATION) {
    await sleep(Math.min(5000, DURATION - (Date.now() - t0)));
    const m = await scrape();
    const p = procStat();
    loads.push(loadavg()[0]);
    if (p) rssMax = Math.max(rssMax, p.rss);
    if (m) {
      windows.push({
        loopP99: m['flowplan_event_loop_delay_seconds{quantile="0.99"}'],
        loopMax: m['flowplan_event_loop_delay_seconds{quantile="1"}'],
        elu: m.flowplan_event_loop_utilization,
        txMax: m.flowplan_sqlite_transaction_max_seconds,
        stmtMax: m.flowplan_sqlite_statement_max_seconds,
        rss: m.flowplan_process_resident_memory_bytes,
      });
      rssMax = Math.max(rssMax, m.flowplan_process_resident_memory_bytes || 0);
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  heavyOn = false;
  const results = await flush();
  const m1 = windows.length ? await scrape() : null;
  const p1 = procStat();
  const merged = merge(results);
  const scenarios = {};
  let total = 0,
    errors = 0;
  const readLat = [],
    writeLat = [];
  const errorKinds = {};
  for (const [name, b] of Object.entries(merged)) {
    const errs = Object.values(b.err).reduce((s, v) => s + v, 0);
    scenarios[name] = { ...summarize(b.lat), ok: b.ok, errors: b.err };
    if (NOT_REQUESTS.has(name)) continue;
    total += b.ok + errs;
    // A 409 on a record edit is a real conflict (two people, one property),
    // not a server failure.
    const hard = errs - (b.err["409"] || 0);
    errors += hard;
    for (const [k, v] of Object.entries(b.err)) errorKinds[k] = (errorKinds[k] || 0) + v;
    if (READS.has(name)) readLat.push(...b.lat);
    if (WRITES.has(name)) writeLat.push(...b.lat);
  }
  const d = (k) => (m0 && m1 && m1[k] != null && m0[k] != null ? m1[k] - m0[k] : null);
  const cpuSeconds = p0 && p1 ? p1.cpu - p0.cpu : d("flowplan_process_cpu_seconds_total");
  const files = fileSizes();
  const step = {
    vus,
    editors: lists.flat().filter((v) => v.kind === "editor").length,
    seconds: elapsed,
    requests: total,
    rps: total / elapsed,
    errorRate: total ? errors / total : 0,
    errorKinds,
    reads: summarize(readLat),
    writes: summarize(writeLat),
    scenarios,
    server: {
      cpuPercent: cpuSeconds != null ? (cpuSeconds / elapsed) * 100 : null,
      eluMean: windows.length ? windows.reduce((s, w) => s + (w.elu || 0), 0) / windows.length : null,
      loopP99MaxMs: windows.length ? Math.max(...windows.map((w) => (w.loopP99 || 0) * 1000)) : null,
      loopMaxMs: windows.length ? Math.max(...windows.map((w) => (w.loopMax || 0) * 1000)) : null,
      txPerSecond: d("flowplan_sqlite_transactions_total") != null ? d("flowplan_sqlite_transactions_total") / elapsed : null,
      txShare: d("flowplan_sqlite_transaction_seconds_total") != null ? d("flowplan_sqlite_transaction_seconds_total") / elapsed : null,
      txMaxMs: windows.length ? Math.max(...windows.map((w) => (w.txMax || 0) * 1000)) : null,
      stmtPerSecond: d("flowplan_sqlite_statements_total") != null ? d("flowplan_sqlite_statements_total") / elapsed : null,
      stmtShare: d("flowplan_sqlite_statement_seconds_total") != null ? d("flowplan_sqlite_statement_seconds_total") / elapsed : null,
      stmtMaxMs: windows.length ? Math.max(...windows.map((w) => (w.stmtMax || 0) * 1000)) : null,
      rssMaxMB: rssMax ? rssMax / 2 ** 20 : null,
      heapMB: m1?.flowplan_process_heap_used_bytes ? m1.flowplan_process_heap_used_bytes / 2 ** 20 : null,
      dbMB: files.db != null ? files.db / 2 ** 20 : m1?.flowplan_database_bytes / 2 ** 20,
      walMB: files.wal != null ? files.wal / 2 ** 20 : m1?.flowplan_sqlite_wal_bytes / 2 ** 20,
      searchBacklog: m1?.flowplan_search_backlog ?? null,
    },
    generator: { loopP99Ms: Math.max(...results.map((r) => r.lag.p99)), loopMaxMs: Math.max(...results.map((r) => r.lag.max)) },
    loadavg: { mean: loads.reduce((s, v) => s + v, 0) / (loads.length || 1), max: Math.max(...loads) },
    heavy: heavySamples.slice(heavyFrom),
  };
  report.steps.push(step);
  const s = step.server;
  const f = (x) => (x == null ? "–" : Math.round(x));
  console.log(
    `| ${vus} (${step.editors} ed.) | ${step.rps.toFixed(1)} | ${f(step.reads.p50)}/${f(step.reads.p95)}/${f(step.reads.p99)} | ${f(step.writes.p50)}/${f(step.writes.p95)}/${f(step.writes.p99)} | ${f(scenarios["doc.sync"]?.p95)} | ${f(scenarios.fanout?.p95)} | ${(step.errorRate * 100).toFixed(2)} | ${f(s.cpuPercent)} | ${s.eluMean == null ? "–" : s.eluMean.toFixed(2)} | ${f(s.loopP99MaxMs)}/${f(s.loopMaxMs)} | ${s.stmtShare == null ? "–" : (s.stmtShare * 100).toFixed(0) + "%"} | ${f(s.rssMaxMB)} | ${s.walMB == null ? "–" : s.walMB.toFixed(1)} | ${step.loadavg.mean.toFixed(1)} |`,
  );
  writeFileSync(opt.out, JSON.stringify(report, (k, v) => (typeof v === "number" ? r1(v) : v), 1));
  // Far past the knee: further steps only pile up timeouts.
  if (step.reads.p95 > Number(opt["stop-p95"]) && step.writes.p95 > Number(opt["stop-p95"])) {
    console.log(`stopping: p95 above ${opt["stop-p95"]} ms for reads and writes`);
    break;
  }
}
// Per scenario of the last step, for a closer look.
const last = report.steps.at(-1);
if (last) {
  console.log(`\nscenarios at ${last.vus} VUs:`);
  for (const [name, s] of Object.entries(last.scenarios))
    console.log(`  ${name.padEnd(16)} n=${String(s.ok).padStart(6)} p50=${f0(s.p50)} p95=${f0(s.p95)} p99=${f0(s.p99)} max=${f0(s.max)} errors=${JSON.stringify(s.errors)}`);
}
function f0(v) {
  return v == null ? "–" : String(Math.round(v)).padStart(5);
}
for (const w of workers) w.postMessage({ type: "stop" });
await sleep(500);
console.log(`\nresult written to ${opt.out}`);
process.exit(0);
