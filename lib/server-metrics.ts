// Server metrics for the monitoring (Administration → Überwachung → Server
// and the live strip): CPU and memory of the Flowplan process against the
// limits of its container, the disk, and what uses the most of it.
//
// Always on, with or without the usage statistics (lib/metrics.ts): these
// are numbers of the process, nothing about people – except `active` (the
// people of the last five minutes), which is only there while the usage
// statistics are on.
//
// Overhead, by design tiny:
// - Once a minute (the metrics worker, lib/metrics-worker.ts) one sample:
//   process.cpuUsage(), process.memoryUsage(), the event-loop utilisation
//   (counters Node keeps anyway), statfs of the data directory and the
//   sizes of the live hub's maps – a few microseconds – and one row
//   written. The cgroup files are read every ten minutes, database and
//   upload sizes (a SUM over the files table) every fifteen.
// - CPU per area: every tracked span (an HTTP request, a live-sync command,
//   an AI call, a search-index batch, a workflow step, a background job)
//   reads process.cpuUsage() when it starts and ends (one getrusage call,
//   about a microsecond) and charges the CPU time since the previous
//   reading to the areas running at that moment, split by how many spans
//   of each run. Exact for work that does not overlap, an estimate under
//   load (an AI call waiting for its provider gets a share of what ran
//   meanwhile). CPU while nothing tracked runs (Next.js internals, timers,
//   garbage collection) is "other". Event streams are not spans: they wait
//   most of their life.
// - Memory: a row is about 300 bytes; 7 days of minutes ≈ 10 000 rows per
//   instance (≈ 3 MB). In memory: one counter per area.
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { performance, type EventLoopUtilization } from "node:perf_hooks";
import { all, one, run, sqliteCacheBytes } from "./db";
import { activeRecently, diskUsage } from "./metrics";
import { liveHubCounts } from "./document-live";
import { clusterMode, instanceId } from "./cluster/config";

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;
export const SERVER_KEEP_MS = 7 * DAY;
// A rough figure per open live connection (socket and stream buffers, the
// listener and its keepalive timer) for "what uses the memory" – not
// measured per connection.
export const CONNECTION_BYTES_ESTIMATE = 48 * 1024;

export const CPU_AREAS = ["api", "pages", "live", "ai", "workflows", "search", "jobs"] as const;
export type CpuArea = (typeof CPU_AREAS)[number];
type Charged = Record<CpuArea | "other", number>;
const zeroCharged = (): Charged => ({ api: 0, pages: 0, live: 0, ai: 0, workflows: 0, search: 0, jobs: 0, other: 0 });

type Limits = { cpu: number; cpuLimited: boolean; memory: number; memoryLimited: boolean; at: number };
type State = {
  mark: NodeJS.CpuUsage;
  active: Record<CpuArea, number>;
  charged: Charged;
  // Open event streams (lib/request-metrics.ts).
  streams: number;
  last?: { at: number; cpu: NodeJS.CpuUsage; elu: EventLoopUtilization };
  limits?: Limits;
  sizes?: { at: number; database: number | null; uploads: number | null };
};
const holder = globalThis as unknown as { flowplanServerMetrics?: State };
function state(): State {
  return (holder.flowplanServerMetrics ??= {
    mark: process.cpuUsage(),
    active: { api: 0, pages: 0, live: 0, ai: 0, workflows: 0, search: 0, jobs: 0 },
    charged: zeroCharged(),
    streams: 0,
  });
}

/* ---------- CPU per area ---------- */

// Charges the CPU time since the last reading to what ran meanwhile.
function checkpoint(s: State) {
  const now = process.cpuUsage();
  const delta = now.user - s.mark.user + (now.system - s.mark.system);
  s.mark = now;
  if (!(delta > 0)) return;
  let total = 0;
  for (const area of CPU_AREAS) total += s.active[area];
  if (!total) {
    s.charged.other += delta;
    return;
  }
  for (const area of CPU_AREAS) if (s.active[area]) s.charged[area] += (delta * s.active[area]) / total;
}
// A span of work of an area starts; the returned function ends it (once).
export function enterArea(area: CpuArea): () => void {
  const s = state();
  checkpoint(s);
  s.active[area]++;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    checkpoint(s);
    s.active[area] = Math.max(0, s.active[area] - 1);
  };
}
// Work of a request that belongs to another area (a live-sync command, an
// AI answer): one running span moves from `from` to `to` until the returned
// function is called. Without a span of `from` it is a span of its own.
export function shiftArea(from: CpuArea, to: CpuArea): () => void {
  const s = state();
  if (!s.active[from]) return enterArea(to);
  checkpoint(s);
  s.active[from]--;
  s.active[to]++;
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    checkpoint(s);
    s.active[to] = Math.max(0, s.active[to] - 1);
    s.active[from]++;
  };
}
export async function inArea<T>(area: CpuArea, work: () => Promise<T> | T): Promise<T> {
  const done = enterArea(area);
  try {
    return await work();
  } finally {
    done();
  }
}
// The CPU per area (µs) since the last call, and starts anew.
export function takeCharged(): Charged {
  const s = state();
  checkpoint(s);
  const out = s.charged;
  s.charged = zeroCharged();
  return out;
}
export function noteStream(delta: 1 | -1) {
  const s = state();
  s.streams = Math.max(0, s.streams + delta);
}

/* ---------- Limits ---------- */

type Read = (path: string) => string | null;
const readText: Read = (path) => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};
// Limits of the container from cgroup v2 (memory.max, cpu.max) or v1
// (memory.limit_in_bytes, cpu.cfs_quota_us/cfs_period_us); null where none
// is set. `cores` falls back to the cores of the host.
export function cgroupLimits(read: Read = readText): { memory: number | null; cpu: number | null; memoryUsed: number | null } {
  let memory: number | null = null,
    cpu: number | null = null,
    memoryUsed: number | null = null;
  const v2mem = read("/sys/fs/cgroup/memory.max");
  if (v2mem !== null) {
    if (/^\d+$/.test(v2mem)) memory = Number(v2mem);
    const used = read("/sys/fs/cgroup/memory.current");
    if (used && /^\d+$/.test(used)) memoryUsed = Number(used);
  } else {
    const v1 = read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    // "No limit" is a huge number (2^63 rounded down to the page size).
    if (v1 && /^\d+$/.test(v1) && Number(v1) < 2 ** 60) memory = Number(v1);
    const used = read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    if (used && /^\d+$/.test(used)) memoryUsed = Number(used);
  }
  const v2cpu = read("/sys/fs/cgroup/cpu.max");
  if (v2cpu !== null) {
    const [quota, period] = v2cpu.split(/\s+/);
    if (/^\d+$/.test(quota) && Number(period) > 0) cpu = Number(quota) / Number(period);
  } else {
    const quota = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") ?? -1),
      period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us") ?? 0);
    if (quota > 0 && period > 0) cpu = quota / period;
  }
  return { memory: memory && memory > 0 ? memory : null, cpu: cpu && cpu > 0 ? cpu : null, memoryUsed };
}
function limits(s: State, now: number): Limits {
  if (s.limits && now - s.limits.at < 10 * MINUTE) return s.limits;
  const c = cgroupLimits();
  const cores = availableParallelism();
  const host = totalmem();
  s.limits = {
    cpu: c.cpu ? Math.min(c.cpu, cores) : cores,
    cpuLimited: !!c.cpu && c.cpu < cores,
    memory: c.memory ? Math.min(c.memory, host) : host,
    memoryLimited: !!c.memory && c.memory < host,
    at: now,
  };
  return s.limits;
}

/* ---------- Sampling ---------- */

export type ServerSample = {
  at: number;
  wallMs: number;
  cpuUs: number;
  cpuLimit: number;
  cpuLimited: boolean;
  rss: number;
  memLimit: number;
  memLimited: boolean;
  cgroupMem: number | null;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  documents: number;
  connections: number;
  streams: number;
  elu: number;
  diskTotal: number | null;
  diskFree: number | null;
  databaseBytes: number | null;
  uploadBytes: number | null;
  active: number | null;
  areas: Charged;
};

// The numbers of now: the CPU since the previous sample (or since the
// process started), memory, the live hub, the disk.
export function sampleNow(now = Date.now(), take = true): ServerSample {
  const s = state();
  const cpu = process.cpuUsage();
  const elu = performance.eventLoopUtilization();
  const prev = s.last ?? { at: now - Math.max(1, Math.round(process.uptime() * 1000)), cpu: { user: 0, system: 0 }, elu: { idle: 0, active: 0, utilization: 0 } };
  const mem = process.memoryUsage();
  const lim = limits(s, now);
  const hub = liveHubCounts();
  const disk = diskUsage();
  const usage = performance.eventLoopUtilization(elu, prev.elu);
  const sample: ServerSample = {
    at: now,
    wallMs: Math.max(1, now - prev.at),
    cpuUs: Math.max(0, cpu.user - prev.cpu.user + (cpu.system - prev.cpu.system)),
    cpuLimit: lim.cpu,
    cpuLimited: lim.cpuLimited,
    rss: mem.rss,
    memLimit: lim.memory,
    memLimited: lim.memoryLimited,
    cgroupMem: lim.memoryLimited ? cgroupLimits().memoryUsed : null,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    documents: hub.documents,
    connections: hub.connections,
    streams: s.streams,
    elu: Number.isFinite(usage.utilization) ? usage.utilization : 0,
    diskTotal: disk?.total ?? null,
    diskFree: disk?.free ?? null,
    databaseBytes: s.sizes?.database ?? null,
    uploadBytes: s.sizes?.uploads ?? null,
    active: activeRecently(now),
    areas: take ? takeCharged() : { ...s.charged },
  };
  if (take) s.last = { at: now, cpu, elu };
  return sample;
}

// Database and upload sizes, at most every 15 minutes (`measure`:
// lib/instance-ops.ts instanceMetrics).
export async function refreshSizes(measure: () => Promise<{ databaseBytes: number; uploadBytes: number }>, now = Date.now()) {
  const s = state();
  if (s.sizes && now - s.sizes.at < 15 * MINUTE) return;
  try {
    const m = await measure();
    s.sizes = { at: now, database: m.databaseBytes, uploads: m.uploadBytes };
  } catch {
    s.sizes = { at: now, database: null, uploads: null };
  }
}

const instanceKey = () => (clusterMode() ? instanceId() : "");
const MINUTE_FLOOR = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;

// Takes and writes one sample (the metrics worker, once a minute), and
// removes rows older than a week once an hour.
export async function recordServerSample(now = Date.now()) {
  const x = sampleNow(now);
  await run(
    `INSERT INTO metrics_server(at,instance,wall_ms,cpu_us,cpu_limit,cpu_limited,rss,mem_limit,mem_limited,cgroup_mem,heap_used,heap_total,external_mem,array_buffers,documents,connections,streams,elu,disk_total,disk_free,database_bytes,upload_bytes,active,areas)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(at,instance) DO UPDATE SET wall_ms=excluded.wall_ms,cpu_us=excluded.cpu_us,rss=excluded.rss,heap_used=excluded.heap_used,heap_total=excluded.heap_total,areas=excluded.areas`,
    MINUTE_FLOOR(now),
    instanceKey(),
    Math.round(x.wallMs),
    Math.round(x.cpuUs),
    Math.round(x.cpuLimit * 1000),
    x.cpuLimited ? 1 : 0,
    x.rss,
    x.memLimit,
    x.memLimited ? 1 : 0,
    x.cgroupMem,
    x.heapUsed,
    x.heapTotal,
    x.external,
    x.arrayBuffers,
    x.documents,
    x.connections,
    x.streams,
    Math.round(x.elu * 1000),
    x.diskTotal,
    x.diskFree,
    x.databaseBytes,
    x.uploadBytes,
    x.active,
    JSON.stringify(Object.fromEntries(Object.entries(x.areas).map(([k, v]) => [k, Math.round(v)]))),
  );
  if (now % HOUR < MINUTE) await run("DELETE FROM metrics_server WHERE at<?", now - SERVER_KEEP_MS);
}

/* ---------- Reading ---------- */

type Row = {
  at: number;
  instance: string;
  wall_ms: number;
  cpu_us: number;
  cpu_limit: number;
  rss: number;
  mem_limit: number;
  cgroup_mem: number | null;
  heap_used: number;
  documents: number;
  connections: number;
  disk_total: number | null;
  disk_free: number | null;
  active: number | null;
  areas: string;
};
export type ServerRange = "1h" | "24h" | "7d";
export type ServerPoint = {
  at: number;
  // Share of the limit (0..1), null: no sample in the bucket.
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  // Cores used and bytes, for the tooltip.
  cores: number | null;
  rss: number | null;
  active: number | null;
  connections: number | null;
};
const parseAreas = (text: string): Partial<Charged> => {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

// One value per minute across instances: CPU and memory added up (against
// the added limits), the disk of the first, people as counted.
function perMinute(rows: Row[]) {
  const by = new Map<number, { cpuUs: number; wallMs: number; limit: number; rss: number; memLimit: number; diskTotal: number | null; diskFree: number | null; active: number | null; connections: number; documents: number; heap: number }>();
  for (const r of rows) {
    const m = by.get(r.at) || { cpuUs: 0, wallMs: 0, limit: 0, rss: 0, memLimit: 0, diskTotal: null, diskFree: null, active: null, connections: 0, documents: 0, heap: 0 };
    // CPU as cores: the share of a minute each instance used, added up.
    m.cpuUs += r.wall_ms > 0 ? (r.cpu_us / r.wall_ms) * MINUTE : 0;
    m.wallMs = MINUTE;
    m.limit += r.cpu_limit / 1000;
    m.rss += r.cgroup_mem ?? r.rss;
    m.memLimit += r.mem_limit;
    m.diskTotal ??= r.disk_total;
    m.diskFree ??= r.disk_free;
    if (r.active !== null) m.active = Math.max(m.active ?? 0, r.active);
    m.connections += r.connections;
    m.documents += r.documents;
    m.heap += r.heap_used;
    by.set(r.at, m);
  }
  return by;
}

export async function serverSeries(range: ServerRange = "24h", now = Date.now()) {
  const bucketMs = range === "1h" ? MINUTE : range === "24h" ? 5 * MINUTE : HOUR;
  const count = range === "1h" ? 60 : range === "24h" ? 288 : 168;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (count - 1) * bucketMs;
  const rows = await all<Row>("SELECT at,instance,wall_ms,cpu_us,cpu_limit,rss,mem_limit,cgroup_mem,heap_used,documents,connections,disk_total,disk_free,active,areas FROM metrics_server WHERE at>=?", start);
  const minutes = perMinute(rows);
  const buckets = new Map<number, ServerPoint & { n: number; nActive: number }>();
  for (const [at, m] of minutes) {
    const key = Math.floor(at / bucketMs) * bucketMs;
    const b = buckets.get(key) || { at: key, cpu: 0, memory: 0, disk: null, cores: 0, rss: 0, active: null, connections: 0, n: 0, nActive: 0 };
    const cores = m.cpuUs / 1000 / MINUTE;
    b.cores! += cores;
    b.cpu! += m.limit ? cores / m.limit : 0;
    b.rss! += m.rss;
    b.memory! += m.memLimit ? m.rss / m.memLimit : 0;
    b.connections! += m.connections;
    if (m.diskTotal) b.disk = 1 - (m.diskFree ?? 0) / m.diskTotal;
    if (m.active !== null) {
      b.active = (b.active ?? 0) + m.active;
      b.nActive++;
    }
    b.n++;
    buckets.set(key, b);
  }
  const points: ServerPoint[] = [];
  for (let at = start; at <= end; at += bucketMs) {
    const b = buckets.get(at);
    points.push(
      b
        ? {
            at,
            cpu: b.cpu! / b.n,
            memory: b.memory! / b.n,
            disk: b.disk,
            cores: b.cores! / b.n,
            rss: Math.round(b.rss! / b.n),
            active: b.nActive ? Math.round((b.active! / b.nActive) * 10) / 10 : null,
            connections: Math.round(b.connections! / b.n),
          }
        : { at, cpu: null, memory: null, disk: null, cores: null, rss: null, active: null, connections: null },
    );
  }
  return { range, bucketMs, points };
}
export type ServerSeries = Awaited<ReturnType<typeof serverSeries>>;

// CPU per area over the range (µs), from the rows and what was charged
// since the last one.
export async function cpuByArea(since: number): Promise<Charged> {
  const out = zeroCharged();
  for (const r of await all<{ areas: string }>("SELECT areas FROM metrics_server WHERE at>=?", since)) {
    const a = parseAreas(r.areas);
    for (const k of Object.keys(out) as (keyof Charged)[]) out[k] += Number(a[k]) || 0;
  }
  const s = state();
  checkpoint(s);
  for (const k of Object.keys(out) as (keyof Charged)[]) out[k] += s.charged[k];
  return out;
}

// What the detail view shows of this process now: memory by part, limits,
// live hub, SQLite's cache; and the other instances' latest rows.
export async function serverNow(now = Date.now()) {
  const x = sampleNow(now, false);
  const cache = await sqliteCacheBytes();
  // Live connections are event streams too: the larger count, not the sum.
  const live = Math.max(x.connections, x.streams);
  const known = x.heapTotal + x.external;
  const instances = clusterMode()
    ? await all<{ instance: string; at: number; rss: number; mem_limit: number; cpu_us: number; wall_ms: number; cpu_limit: number; connections: number; documents: number }>(
        "SELECT m.instance,m.at,m.rss,m.mem_limit,m.cpu_us,m.wall_ms,m.cpu_limit,m.connections,m.documents FROM metrics_server m WHERE m.at=(SELECT MAX(at) FROM metrics_server WHERE instance=m.instance) AND m.at>=?",
        now - 5 * MINUTE,
      )
    : [];
  const latest = await one<{ cpu_us: number; wall_ms: number }>("SELECT cpu_us,wall_ms FROM metrics_server WHERE instance=? ORDER BY at DESC LIMIT 1", instanceKey());
  return {
    at: now,
    cpu: {
      // Cores used in the last sampled minute (else since the start).
      cores: latest ? latest.cpu_us / 1000 / Math.max(1, latest.wall_ms) : x.cpuUs / 1000 / x.wallMs,
      limit: x.cpuLimit,
      limited: x.cpuLimited,
      loop: x.elu,
    },
    memory: {
      rss: x.rss,
      limit: x.memLimit,
      limited: x.memLimited,
      container: x.cgroupMem,
      heapUsed: x.heapUsed,
      heapTotal: x.heapTotal,
      external: x.external,
      arrayBuffers: x.arrayBuffers,
      sqliteCache: cache,
      // Native code, code space, thread stacks, allocator slack.
      rest: Math.max(0, x.rss - known),
    },
    live: { documents: x.documents, connections: x.connections, streams: x.streams, estimatedBytes: live * CONNECTION_BYTES_ESTIMATE },
    disk: { total: x.diskTotal, free: x.diskFree, database: x.databaseBytes, uploads: x.uploadBytes },
    instances: instances.map((i) => ({ id: i.instance, at: i.at, rss: i.rss, memLimit: i.mem_limit, cores: i.wall_ms ? i.cpu_us / 1000 / i.wall_ms : 0, cpuLimit: i.cpu_limit / 1000, connections: i.connections, documents: i.documents })),
  };
}
export type ServerNow = Awaited<ReturnType<typeof serverNow>>;

// Daily figures of the last `days` for the recommendations
// (lib/recommendations.ts): per day the CPU and memory share at the busiest
// hour (p95 of the minutes), the mean, people at peak, the process's
// memory at the start and end, and restarts (a fall of the uptime is not
// stored – a new instance key or a gap of more than 5 minutes counts).
export type ServerDay = { day: number; cpuPeak: number; cpuMean: number; memPeak: number; memMean: number; activePeak: number | null; rssFirst: number; rssLast: number; minutes: number; gaps: number; diskUsed: number | null; diskTotal: number | null };
export async function serverDays(now = Date.now(), days = 7): Promise<ServerDay[]> {
  const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const rows = await all<Row>("SELECT at,instance,wall_ms,cpu_us,cpu_limit,rss,mem_limit,cgroup_mem,heap_used,documents,connections,disk_total,disk_free,active,areas FROM metrics_server WHERE at>=? ORDER BY at", start);
  const minutes = [...perMinute(rows)].sort((a, b) => a[0] - b[0]);
  const out: ServerDay[] = [];
  for (let day = start; day < start + days * DAY; day += DAY) {
    const ms = minutes.filter(([at]) => at >= day && at < day + DAY);
    if (!ms.length) continue;
    const cpu = ms.map(([, m]) => (m.limit ? m.cpuUs / 1000 / MINUTE / m.limit : 0)).sort((a, b) => a - b);
    const mem = ms.map(([, m]) => (m.memLimit ? m.rss / m.memLimit : 0)).sort((a, b) => a - b);
    const p95 = (v: number[]) => v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
    const actives = ms.map(([, m]) => m.active).filter((v): v is number => v !== null);
    let gaps = 0;
    for (let i = 1; i < ms.length; i++) if (ms[i][0] - ms[i - 1][0] > 5 * MINUTE) gaps++;
    const last = ms[ms.length - 1][1];
    out.push({
      day,
      cpuPeak: p95(cpu),
      cpuMean: cpu.reduce((a, b) => a + b, 0) / cpu.length,
      memPeak: p95(mem),
      memMean: mem.reduce((a, b) => a + b, 0) / mem.length,
      activePeak: actives.length ? Math.max(...actives) : null,
      rssFirst: ms[0][1].rss,
      rssLast: last.rss,
      minutes: ms.length,
      gaps,
      diskUsed: last.diskTotal ? last.diskTotal - (last.diskFree ?? 0) : null,
      diskTotal: last.diskTotal,
    });
  }
  return out;
}
