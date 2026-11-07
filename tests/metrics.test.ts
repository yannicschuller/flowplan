// Usage statistics (lib/metrics.ts, lib/request-metrics.ts) and the
// monitoring dashboard (lib/admin-monitoring.ts, app/api/admin/monitoring).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Identity } from "../lib/types";
import { mapAsync } from "../lib/each-async";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-metrics-"));
delete process.env.FLOWPLAN_METRICS;
const { run, id, one, all, tableNames, tableColumns } = await import("../lib/db");
const metrics = await import("../lib/metrics");
const { startRequestMetrics, countedPath } = await import("../lib/request-metrics");
const { recordOpsEvent, flushOpsEvents } = await import("../lib/ops-events");
const { monitoringFor, monitoringOverview, monitoringLive, monitoringEvents } = await import("../lib/admin-monitoring");
const { adminSummary } = await import("../lib/admin-summary");
const { streamChat } = await import("../lib/ai/providers");

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;
const state = () => (globalThis as unknown as { flowplanMetrics: { current: unknown; done: unknown[]; hour: { at: number; people: Map<string, number> } } }).flowplanMetrics;

async function account(name: string, isAdmin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin, disabled: 0, created_at: "" };
}
const admin = await account("metrics-admin", true),
  member = await account("metrics-member");

// A fixed hour in the past, so the tests do not depend on the clock.
const base = Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR;

test("requests are counted in memory and written once per minute, rolled up per hour", async () => {
  await metrics.clearMetrics();
  metrics.noteRequest(200, 12, base + 1_000);
  metrics.noteRequest(200, 40, base + 2_000);
  metrics.noteRequest(503, 800, base + 3_000);
  // Nothing is written per request.
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM metrics_minute"))?.n, 0);
  metrics.noteRequest(200, 20, base + MINUTE + 5);
  await metrics.flushMetrics(base + 2 * MINUTE);
  const rows = await all<{ at: number; requests: number; errors: number; hist: string }>("SELECT at,requests,errors,hist FROM metrics_minute ORDER BY at");
  assert.deepEqual(
    rows.map((r) => [r.at, r.requests, r.errors]),
    [
      [base, 3, 1],
      [base + MINUTE, 1, 0],
    ],
  );
  assert.equal(metrics.decodeHist(rows[0].hist).reduce((a, b) => a + b, 0), 3);
  const hour = await one<{ requests: number; errors: number; hist: string }>("SELECT requests,errors,hist FROM metrics_hour WHERE at=?", base);
  assert.equal(hour?.requests, 4);
  assert.equal(hour?.errors, 1);
  assert.equal(metrics.percentile(metrics.decodeHist(hour!.hist), 0.5), 20);
  assert.equal(metrics.percentile(metrics.decodeHist(hour!.hist), 0.95), 1000);
  // A second flush of the same minute (after a restart) adds up.
  metrics.noteRequest(200, 5, base + 10);
  await metrics.flushMetrics(base + 3 * MINUTE);
  assert.equal((await one<{ requests: number }>("SELECT requests FROM metrics_minute WHERE at=?", base))?.requests, 4);
  assert.equal((await one<{ requests: number }>("SELECT requests FROM metrics_hour WHERE at=?", base))?.requests, 5);
});

test("percentiles and histograms", () => {
  assert.equal(metrics.percentile([], 0.5), null);
  const hist = metrics.decodeHist("0:9,19:1");
  assert.equal(metrics.percentile(hist, 0.5), 5);
  // The open last bucket reports twice the bound before it.
  assert.equal(metrics.percentile(hist, 1), 60_000);
  assert.equal(metrics.encodeHist(hist), "0:9,19:1");
  assert.deepEqual(metrics.decodeHist("x,3:2,99:1").slice(0, 4), [0, 0, 0, 2]);
});

test("the request series: buckets per range, gaps before collecting began", async () => {
  const now = base + 30 * MINUTE;
  const hourly = await metrics.requestSeries("1h", now);
  assert.equal(hourly.points.length, 60);
  assert.equal(hourly.bucketMs, MINUTE);
  const day = await metrics.requestSeries("24h", now);
  assert.equal(day.points.length, 288);
  const first = day.points.find((p) => p.at === base);
  assert.equal(first?.requests, 5);
  // Before the first minute: null (nothing collected), after it: 0.
  assert.equal(day.points[0].requests, null);
  assert.equal(day.points.find((p) => p.at === base + 15 * MINUTE)?.requests, 0);
  const week = await metrics.requestSeries("7d", now);
  assert.equal(week.points.length, 168);
  assert.equal(week.points.find((p) => p.at === base)?.requests, 5);
});

test("active people per hour: each person once, never stored by name", async () => {
  const at = base + 5 * MINUTE;
  metrics.noteActive(admin.id, at);
  metrics.noteActive(admin.id, at + 1000);
  metrics.noteActive(member.id, at + 2000);
  await metrics.flushMetrics(at + 3000);
  assert.equal((await one<{ active: number }>("SELECT active FROM metrics_hour WHERE at=?", base))?.active, 2);
  // The next hour starts at zero; the finished hour keeps its count.
  metrics.noteActive(admin.id, base + HOUR + 1);
  await metrics.flushMetrics(base + HOUR + 2);
  assert.equal((await one<{ active: number }>("SELECT active FROM metrics_hour WHERE at=?", base))?.active, 2);
  assert.equal((await one<{ active: number }>("SELECT active FROM metrics_hour WHERE at=?", base + HOUR))?.active, 1);
  const tables = (await mapAsync((await tableNames())
    .filter((name) => name.startsWith("metrics_")), async (name) => `${name}(${(await tableColumns(name)).join(",")})`))
    .join(" ");
  assert.doesNotMatch(tables, /user|ip|path|agent/i);
  const series = await metrics.activeSeries(base + HOUR + 10, 24);
  assert.equal(series.length, 24);
  assert.equal(series.find((p) => p.at === base)?.people, 2);
});

test("AI tokens per day and feature; reported by the provider or estimated", async () => {
  metrics.noteAiUsage("write", 100, 20);
  metrics.noteAiUsage("write", 50, 10);
  metrics.noteAiUsage("ask", 30, 0);
  const usage = await metrics.aiUsage(Date.now(), 14);
  assert.equal(usage.days.length, 14);
  const today = usage.days[usage.days.length - 1];
  assert.equal(today.tokensIn, 180);
  assert.equal(today.tokensOut, 30);
  assert.deepEqual(
    usage.features.map((f) => [f.feature, f.tokens, f.requests]),
    [
      ["write", 180, 2],
      ["ask", 30, 1],
    ],
  );
  assert.equal(metrics.estimateTokens(10), 3);
  // Ollama reports its counts at the end of the stream.
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: "Hallo" }, done: false }) + "\n");
      res.end(JSON.stringify({ done: true, prompt_eval_count: 42, eval_count: 7 }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const counted: { input?: number; output?: number } = {};
    let text = "";
    for await (const piece of streamChat(
      { kind: "ollama", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: "m", trusted: true },
      { messages: [{ role: "user", content: "Hi" }], usage: counted },
    ))
      text += piece;
    assert.equal(text, "Hallo");
    assert.deepEqual(counted, { input: 42, output: 7 });
  } finally {
    server.close();
  }
});

test("storage per day and disk usage", async () => {
  await metrics.snapshotStorage({ databaseBytes: 1000, uploadBytes: 500, files: 2 }, base);
  const trend = await metrics.storageTrend(base, 30);
  assert.equal(trend.length, 30);
  assert.equal(trend[trend.length - 1].bytes, 1500);
  assert.equal(trend[0].bytes, null);
  const disk = metrics.diskUsage();
  assert.ok(disk === null || (disk.total > 0 && disk.free >= 0 && disk.free <= disk.total));
});

test("retention: minutes 48 hours, hours 35 days, days 400", async () => {
  const now = Date.now();
  await run("INSERT INTO metrics_minute(at,requests,errors,hist) VALUES(?,1,0,'') ON CONFLICT DO NOTHING", now - 49 * HOUR);
  await run("INSERT INTO metrics_minute(at,requests,errors,hist) VALUES(?,1,0,'') ON CONFLICT DO NOTHING", now - 47 * HOUR);
  await run("INSERT INTO metrics_hour(at,requests) VALUES(?,1) ON CONFLICT DO NOTHING", now - 36 * DAY);
  await run("INSERT INTO metrics_hour(at,requests) VALUES(?,1) ON CONFLICT DO NOTHING", now - 34 * DAY);
  await run("INSERT INTO metrics_day(day,database_bytes,upload_bytes,files,at) VALUES('2000-01-01',1,1,1,0) ON CONFLICT DO NOTHING");
  await run("INSERT INTO metrics_ai(day,feature,requests) VALUES('2000-01-01','write',1) ON CONFLICT DO NOTHING");
  await metrics.sweepMetrics(now);
  assert.equal(await one("SELECT 1 FROM metrics_minute WHERE at=?", now - 49 * HOUR), undefined);
  assert.ok(await one("SELECT 1 FROM metrics_minute WHERE at=?", now - 47 * HOUR));
  assert.equal(await one("SELECT 1 FROM metrics_hour WHERE at=?", now - 36 * DAY), undefined);
  assert.ok(await one("SELECT 1 FROM metrics_hour WHERE at=?", now - 34 * DAY));
  assert.equal(await one("SELECT 1 FROM metrics_day WHERE day='2000-01-01'"), undefined);
  assert.equal(await one("SELECT 1 FROM metrics_ai WHERE day='2000-01-01'"), undefined);
});

test("switched off: nothing is counted, successful sign-ins neither; clearing removes all", async () => {
  await metrics.saveMetricsSetting(false);
  assert.equal((await metrics.metricsSetting()).enabled, false);
  const before = (await one<{ n: number }>("SELECT COUNT(*) n FROM metrics_minute"))?.n;
  metrics.noteRequest(200, 1, base + 40 * MINUTE);
  metrics.noteActive(admin.id, base + 40 * MINUTE);
  metrics.noteAiUsage("write", 1, 1);
  assert.equal(state().current, null);
  assert.equal(state().hour.people.size, 0);
  await metrics.flushMetrics(base + 50 * MINUTE);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM metrics_minute"))?.n, before);
  recordOpsEvent("login_success");
  await flushOpsEvents();
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind='login_success'"))?.n, 0);
  assert.equal((await monitoringLive()).collecting.enabled, false);
  await metrics.saveMetricsSetting(true);
  recordOpsEvent("login_success");
  await flushOpsEvents();
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind='login_success'"))?.n, 1);
  await metrics.clearMetrics();
  for (const table of ["metrics_minute", "metrics_hour", "metrics_day", "metrics_ai"]) assert.equal((await one<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`))?.n, 0, table);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM ops_events WHERE kind='login_success'"))?.n, 0);
});

test("FLOWPLAN_METRICS=off locks the switch", async () => {
  process.env.FLOWPLAN_METRICS = "off";
  try {
    assert.deepEqual(await metrics.metricsSetting(), { enabled: false, locked: true });
    assert.equal(await metrics.refreshMetricsEnabled(), false);
    assert.match(readFileSync(join(import.meta.dirname, "../app/api/admin/monitoring/route.ts"), "utf8"), /metricsSetting\(\)\.locked/);
  } finally {
    delete process.env.FLOWPLAN_METRICS;
    await metrics.refreshMetricsEnabled();
  }
});

test("every request of the Node.js server is counted through the diagnostics channels, without static files", async () => {
  await metrics.clearMetrics();
  assert.equal(countedPath("/api/bootstrap"), true);
  assert.equal(countedPath("/"), true);
  assert.equal(countedPath("/_next/static/chunks/a.js"), false);
  assert.equal(countedPath("/api/health"), false);
  assert.equal(countedPath("/api/healthy"), true);
  startRequestMetrics();
  const server = createServer((req, res) => {
    res.statusCode = req.url === "/boom" ? 500 : 200;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/a", "/b", "/boom", "/_next/static/x.js", "/api/health"]) await (await fetch(origin + path)).text();
    await new Promise((r) => setTimeout(r, 20));
    const live = await metrics.liveNumbers(Date.now() + MINUTE);
    assert.equal(live.requestsHour, 3);
    assert.equal(live.errorsHour, 1);
    assert.ok(live.p95 !== null);
  } finally {
    server.close();
  }
});

test("the dashboard: administrators in the browser only, all parts present", async () => {
  await assert.rejects(async () => await monitoringFor(member), /Administrator/);
  await assert.rejects(async () => await monitoringFor({ ...admin, apiScope: "read" }), /API-Token/);
  const d = await monitoringFor(admin, Date.now(), "1h");
  assert.equal(d.requests.range, "1h");
  assert.equal(d.requests.points.length, 60);
  assert.equal(d.active.length, 168);
  assert.equal(d.signins.length, 14);
  assert.equal(d.refused.days.length, 14);
  assert.equal(d.deliveries.days.length, 7);
  assert.equal(d.ai.days.length, 14);
  assert.equal(d.health.database.ok, true);
  assert.equal(d.health.uploads.ok, true);
  assert.equal(d.health.s3, null);
  assert.ok(d.storage.byType.some((s) => s.key === "database"));
  assert.ok(d.events.some((e) => e.kind === "started"));
  assert.deepEqual(Object.keys(d.queues).sort(), ["aiFields", "aiIndex", "mail", "push", "s3", "search", "webhooksGivenUp", "webhooksRetrying"]);
  // Numbers and codes only – no texts for the browser to show as they are.
  assert.equal(typeof (await monitoringOverview()).kpis.signinsToday, "number");
  const route = readFileSync(join(import.meta.dirname, "../app/api/admin/monitoring/route.ts"), "utf8");
  assert.match(route, /requireOpsAdmin\(await requireUser\(\)\)/);
  assert.match(route, /checkOrigin\(req\)/);
});

test("events: worker errors, failed sign-in spikes and the start", async () => {
  const now = Date.now();
  for (let i = 0; i < 12; i++) await run("INSERT INTO ops_events(kind,at) VALUES('login_failure',?)", now - HOUR - i * 1000);
  const events = await monitoringEvents(now);
  assert.ok(events.some((e) => e.kind === "login_spike" && (e.count || 0) >= 12));
  assert.deepEqual(
    events.map((e) => e.at),
    [...events.map((e) => e.at)].sort((a, b) => b - a),
  );
});

test("the summary carries the tiles' series", async () => {
  const s = await adminSummary();
  assert.equal(s.charts.active24h.length, 24);
  assert.equal(s.charts.requests24h.length, 24);
  assert.equal(s.charts.errors24h.length, 24);
  assert.equal(s.charts.storage30d.length, 30);
  assert.equal(s.charts.aiTokens14d.length, 14);
  assert.equal(s.charts.audit14d.length, 14);
  assert.equal(typeof s.users.activeNow, "number");
  assert.equal(typeof s.ai.tokensToday, "number");
});

after(async () => await metrics.clearMetrics());
