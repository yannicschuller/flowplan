// Opt-in runtime measurements for load tests (scripts/loadtest):
// FLOWPLAN_METRICS_LOOP=1 measures the Node event-loop delay and utilisation
// and the time spent in SQLite (lib/db.ts: transactions and the one/all/run
// helpers), and adds them to the Prometheus endpoint (/api/metrics, needs
// FLOWPLAN_METRICS_TOKEN). Off by default: then nothing is measured and the
// helpers below cost one boolean check.
//
// The delay, utilisation and maximum values cover the time since the
// previous scrape – meant for one scraper (the load test), not for a
// Prometheus server shared with others.
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

type State = {
  histogram: IntervalHistogram;
  elu: EventLoopUtilization;
  txCount: number;
  txSeconds: number;
  txMax: number;
  sqlCount: number;
  sqlSeconds: number;
  sqlMax: number;
};
const holder = globalThis as unknown as { flowplanRuntimeMetrics?: State };

export const runtimeMetricsOn = process.env.FLOWPLAN_METRICS_LOOP === "1";
const RESOLUTION_MS = 10;

export function startRuntimeMetrics() {
  if (!runtimeMetricsOn || holder.flowplanRuntimeMetrics) return;
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  holder.flowplanRuntimeMetrics = {
    histogram,
    elu: performance.eventLoopUtilization(),
    txCount: 0,
    txSeconds: 0,
    txMax: 0,
    sqlCount: 0,
    sqlSeconds: 0,
    sqlMax: 0,
  };
}

// Time from a performance.now() start until now, as a finished transaction
// or a single statement.
export function noteTransaction(start: number) {
  const s = holder.flowplanRuntimeMetrics;
  if (!s) return;
  const seconds = (performance.now() - start) / 1000;
  s.txCount++;
  s.txSeconds += seconds;
  if (seconds > s.txMax) s.txMax = seconds;
}
export function noteStatement(start: number) {
  const s = holder.flowplanRuntimeMetrics;
  if (!s) return;
  const seconds = (performance.now() - start) / 1000;
  s.sqlCount++;
  s.sqlSeconds += seconds;
  if (seconds > s.sqlMax) s.sqlMax = seconds;
}

// Prometheus lines; empty while the measurement is off.
export function runtimeMetricLines(walBytes: number) {
  const s = holder.flowplanRuntimeMetrics;
  if (!s) return [];
  const lines: string[] = [];
  const add = (name: string, help: string, type: "gauge" | "counter", values: [string, number][]) => {
    lines.push(`# HELP flowplan_${name} ${help}`, `# TYPE flowplan_${name} ${type}`);
    for (const [labels, value] of values) lines.push(`flowplan_${name}${labels} ${Number.isFinite(value) ? value : 0}`);
  };
  const h = s.histogram;
  // The histogram's values include its 10 ms sampling interval.
  const sec = (ns: number) => Math.max(0, ns - RESOLUTION_MS * 1e6) / 1e9;
  add("event_loop_delay_seconds", "Event-loop delay since the previous scrape.", "gauge", [
    ['{quantile="0.5"}', sec(h.percentile(50))],
    ['{quantile="0.95"}', sec(h.percentile(95))],
    ['{quantile="0.99"}', sec(h.percentile(99))],
    ['{quantile="1"}', sec(h.max)],
  ]);
  add("event_loop_delay_mean_seconds", "Mean event-loop delay since the previous scrape.", "gauge", [["", sec(h.mean)]]);
  h.reset();
  const elu = performance.eventLoopUtilization(s.elu);
  s.elu = performance.eventLoopUtilization();
  add("event_loop_utilization", "Share of time the event loop was busy since the previous scrape (0–1).", "gauge", [["", elu.utilization]]);
  add("sqlite_transactions_total", "Write transactions (BEGIN IMMEDIATE … COMMIT/ROLLBACK).", "counter", [["", s.txCount]]);
  add("sqlite_transaction_seconds_total", "Time spent inside write transactions.", "counter", [["", s.txSeconds]]);
  add("sqlite_transaction_max_seconds", "Longest write transaction since the previous scrape.", "gauge", [["", s.txMax]]);
  add("sqlite_statements_total", "Statements through one/all/run (lib/db.ts).", "counter", [["", s.sqlCount]]);
  add("sqlite_statement_seconds_total", "Time spent in statements through one/all/run.", "counter", [["", s.sqlSeconds]]);
  add("sqlite_statement_max_seconds", "Longest statement since the previous scrape.", "gauge", [["", s.sqlMax]]);
  s.txMax = 0;
  s.sqlMax = 0;
  add("sqlite_wal_bytes", "Size of the SQLite write-ahead log.", "gauge", [["", walBytes]]);
  const mem = process.memoryUsage(),
    cpu = process.cpuUsage();
  add("process_cpu_seconds_total", "User and system CPU time of the process.", "counter", [["", (cpu.user + cpu.system) / 1e6]]);
  add("process_resident_memory_bytes", "Resident memory of the process.", "gauge", [["", mem.rss]]);
  add("process_heap_used_bytes", "V8 heap in use.", "gauge", [["", mem.heapUsed]]);
  return lines;
}
