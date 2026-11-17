// Server metrics (lib/server-metrics.ts), time per route and the detailed AI
// statistics (lib/metrics.ts, lib/ai-statistics.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-server-metrics-"));
delete process.env.FLOWPLAN_METRICS;
const { run, id, one, all } = await import("../lib/db");
const metrics = await import("../lib/metrics");
const server = await import("../lib/server-metrics");
const { aiStatistics, costOf } = await import("../lib/ai-statistics");
const { runDataSteps, AI_DETAIL_STEP } = await import("../lib/data-steps");

const MINUTE = 60_000,
  HOUR = 3_600_000;

test("cgroup limits: v2, v1, none", () => {
  const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;
  assert.deepEqual(server.cgroupLimits(files({ "/sys/fs/cgroup/memory.max": "536870912", "/sys/fs/cgroup/memory.current": "1000", "/sys/fs/cgroup/cpu.max": "150000 100000" })), {
    memory: 536870912,
    cpu: 1.5,
    memoryUsed: 1000,
  });
  assert.deepEqual(server.cgroupLimits(files({ "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/cpu.max": "max 100000" })), { memory: null, cpu: null, memoryUsed: null });
  assert.deepEqual(
    server.cgroupLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" })),
    { memory: 1073741824, cpu: 2, memoryUsed: null },
  );
  // v1 without a limit: a huge number, quota -1.
  assert.deepEqual(server.cgroupLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1" })), {
    memory: null,
    cpu: null,
    memoryUsed: null,
  });
  assert.deepEqual(server.cgroupLimits(files({})), { memory: null, cpu: null, memoryUsed: null });
});

const burn = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};
test("CPU per area: spans charge what ran while they were open, overlaps are split, the rest is other", () => {
  server.takeCharged();
  const done = server.enterArea("search");
  burn(30);
  done();
  done(); // ending twice does nothing
  burn(10);
  const a = server.takeCharged();
  // (CPU time, not wall time: a busy test machine gives less.)
  assert.ok(a.search > 0, `search ${a.search}`);
  assert.ok(a.other > 0, `other ${a.other}`);
  assert.equal(a.api, 0);
  // Two areas at once share; a shift moves one span of api to live.
  const api = server.enterArea("api");
  const api2 = server.enterArea("api");
  const shifted = server.shiftArea("api", "live");
  burn(30);
  shifted();
  api();
  api2();
  const b = server.takeCharged();
  assert.ok(b.live > 0 && b.api > 0);
  assert.ok(Math.abs(b.live - b.api) < Math.max(b.live, b.api) * 0.5, `live ${b.live} api ${b.api}`);
  // Without a span to move from, a shift is a span of its own.
  const lone = server.shiftArea("api", "ai");
  burn(10);
  lone();
  const c = server.takeCharged();
  assert.ok(c.ai > 0);
  assert.equal(c.api, 0);
});

test("route keys keep only plain words; ids, tokens and names become :id", () => {
  assert.equal(metrics.routeKey("GET", "/api/pages/0b8a4d2e-1111-4222-8333-444455556666?x=1"), "GET /api/pages/:id");
  assert.equal(metrics.routeKey("POST", "/api/whiteboards/0b8a4d2e-1111-4222-8333-444455556666/cursors"), "POST /api/whiteboards/:id/cursors");
  assert.equal(metrics.routeKey("GET", "/api/files/Report%20Q3.pdf"), "GET /api/files/:id");
  assert.equal(metrics.routeKey("GET", "/api/share/abcDEF123xyz/a1/b2"), "GET /api/share/:id");
  assert.equal(metrics.routeKey("GET", "/api/document-authors"), "GET /api/document-authors");
  assert.equal(metrics.routeKey("GET", "/api/a-very-long-made-up-slug"), "GET /api/:id");
  assert.equal(metrics.routeKey("GET", "/w/123/page"), "GET (pages)");
  assert.equal(metrics.routeKey("weird", "/api/x1"), "GET /api/:id");
  assert.equal(metrics.commandRoute("document.sync"), "POST /api/command · document.sync");
  assert.equal(metrics.commandRoute("<script>"), "POST /api/command · other");
});

test("time per route: written per hour, the slowest by total time with p95; 4xx counted apart", async () => {
  await metrics.clearMetrics();
  const base = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
  for (let i = 0; i < 20; i++) metrics.noteRequest(200, 30, base + i * 1000, "GET /api/pages/:id");
  metrics.noteRequest(200, 2000, base + 30_000, "GET /api/search");
  metrics.noteRequest(404, 5, base + 31_000, "GET /api/pages/:id");
  metrics.noteRequest(200, 10, base + 32_000, metrics.COMMAND_ROUTE);
  metrics.noteCommand("document.sync", 50, false, base + 33_000);
  await metrics.flushMetrics(base + 2 * MINUTE);
  const routes = await metrics.routeStats(base + HOUR, 24);
  assert.deepEqual(
    routes.map((r) => [r.route, r.requests]),
    [
      ["GET /api/search", 1],
      ["GET /api/pages/:id", 21],
      ["POST /api/command · document.sync", 1],
    ],
  );
  assert.equal(routes[0].p95, 2000);
  assert.equal((await one<{ client_errors: number }>("SELECT client_errors FROM metrics_minute WHERE at=?", base))?.client_errors, 1);
  const series = await metrics.requestSeries("24h", base + HOUR);
  assert.equal(series.points.reduce((n, p) => n + (p.clientErrors || 0), 0), 1);
  // A flood of routes stays bounded.
  for (let i = 0; i < 400; i++) metrics.noteRequest(200, 1, base + HOUR + i, `GET /api/r${i}`);
  await metrics.flushMetrics(base + HOUR + 2 * MINUTE);
  assert.ok(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM metrics_routes WHERE at=?", base + HOUR))?.n) <= 301);
  assert.ok(await one("SELECT 1 FROM metrics_routes WHERE route='other'"));
  // Swept after a week.
  await metrics.sweepMetrics(base + 8 * 24 * HOUR);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM metrics_routes"))?.n), 0);
});

test("a server sample is written per minute; the series reads shares of the limits", async () => {
  await run("DELETE FROM metrics_server");
  const now = Math.floor(Date.now() / MINUTE) * MINUTE;
  await server.recordServerSample(now - 2 * MINUTE);
  burn(20);
  await server.recordServerSample(now - MINUTE);
  const rows = await all<{ rss: number; mem_limit: number; cpu_limit: number; areas: string }>("SELECT rss,mem_limit,cpu_limit,areas FROM metrics_server ORDER BY at");
  assert.equal(rows.length, 2);
  assert.ok(rows[1].rss > 0 && rows[1].mem_limit >= rows[1].rss / 10 && rows[1].cpu_limit >= 1);
  assert.ok(typeof JSON.parse(rows[1].areas).other === "number");
  const series = await server.serverSeries("1h", now);
  const known = series.points.filter((p) => p.cpu !== null);
  assert.equal(known.length, 2);
  assert.ok(known.every((p) => p.memory! > 0 && p.memory! < 1 && p.cpu! >= 0));
  assert.equal(series.points.length, 60);
  const days = await server.serverDays(now, 7);
  assert.equal(days.reduce((n, d) => n + d.minutes, 0), 2);
  const current = await server.serverNow(now);
  assert.ok(current.memory.heapUsed > 0 && current.memory.rss >= current.memory.heapUsed);
  assert.equal(typeof current.memory.sqliteCache, "number");
});

test("AI calls in detail: per model, workspace and person with errors, timeouts, times and costs", async () => {
  await metrics.clearMetrics();
  const uid = id(),
    wid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "AI Person", `${uid}@example.test`);
  await run("INSERT INTO workspaces(id,name) VALUES(?,?)", wid, "AI Space");
  const call = { feature: "write", model: "gpt-x", source: "instance" as const, workspaceId: wid, userId: uid };
  metrics.noteAiCall({ ...call, tokensIn: 1_000_000, tokensOut: 500_000, answered: true, ms: 800 });
  metrics.noteAiCall({ ...call, tokensIn: 100, tokensOut: 0, answered: false, failure: "timeout", ms: 30_000 });
  metrics.noteAiCall({ ...call, tokensIn: 100, tokensOut: 0, answered: false, failure: "error", ms: 50 });
  // Cancelled: not counted at all.
  metrics.noteAiCall({ ...call, tokensIn: 100, tokensOut: 0, answered: false, failure: null });
  metrics.noteAiCall({ feature: "embeddings", model: "embed-y", source: "instance", tokensIn: 2000, tokensOut: 0, answered: true });
  await run("INSERT INTO ai_instance(id,config) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config", JSON.stringify({ prices: [{ model: "GPT-X", input: 2, output: 8 }], currency: "USD" }));
  const s = await aiStatistics(Date.now(), 30);
  assert.equal(s.currency, "USD");
  const gpt = s.models.find((m) => m.model === "gpt-x")!;
  assert.equal(gpt.requests, 3);
  assert.equal(gpt.errors, 1);
  assert.equal(gpt.timeouts, 1);
  assert.equal(gpt.tokensIn, 1_000_000);
  assert.equal(gpt.cost, 2 + 4);
  assert.equal(gpt.p95, 30_000);
  assert.equal(s.models.find((m) => m.model === "embed-y")!.cost, null);
  assert.equal(s.workspaces.find((w) => w.id === wid)?.name, "AI Space");
  assert.equal(s.people?.find((p) => p.id === uid)?.requests, 3);
  // The feature totals (metrics_ai) count answered requests only, as before.
  assert.equal((await one<{ requests: number }>("SELECT requests FROM metrics_ai WHERE feature='write'"))?.requests, 1);
  // Without people (the live strip's chart) no per-person numbers.
  assert.equal((await aiStatistics(Date.now(), 30, false)).people, null);
  // The person's counts stay, without the person, when the account goes.
  await metrics.forgetAiPerson(uid);
  assert.equal(await one("SELECT 1 FROM metrics_ai_usage WHERE user_id=?", uid), undefined);
  assert.equal((await aiStatistics(Date.now(), 30)).models.find((m) => m.model === "gpt-x")!.requests, 3);
  assert.equal(costOf([{ model: "models/gemini-pro", input: 1, output: 1 }], "gemini-pro", 1e6, 0), 1);
});

test("recommendations: gathered and cached, hidden while they apply, snoozed 30 days, rules switched off", async () => {
  const data = await import("../lib/recommendations-data");
  const now = Date.now();
  // No SMTP in the test instance: the mail tip applies.
  const first = await data.recommendations(now, true);
  assert.ok(first.items.some((r) => r.id === "mail"));
  assert.ok(first.items.every((r) => r.docs[0].startsWith("https://docs.flowplan.org/")));
  const input = await data.recommendationInput(now);
  assert.equal(input.database.backend, "sqlite");
  await data.applyRecommendationAction({ action: "recommendation.hide", id: "mail" }, now);
  const hidden = await data.recommendations(now + 1000);
  assert.equal(hidden.items.some((r) => r.id === "mail"), false);
  assert.deepEqual(hidden.quiet.map((q) => q.id), ["mail"]);
  // Cached: evaluated again only after 15 minutes.
  assert.equal(hidden.at, first.at);
  await data.applyRecommendationAction({ action: "recommendation.restore", id: "mail" }, now);
  await data.applyRecommendationAction({ action: "recommendation.snooze", id: "mail" }, now);
  assert.equal((await data.recommendations(now + 29 * 86_400_000, true)).items.some((r) => r.id === "mail"), false);
  assert.ok((await data.recommendations(now + 31 * 86_400_000, true)).items.some((r) => r.id === "mail"));
  // Switched off, with a threshold changed (clamped) – stored per instance.
  await data.applyRecommendationAction({ action: "recommendations.settings", off: ["mail"], thresholds: { cpuHigh: 0.9, highDays: 99 } }, now);
  const state = await data.recommendationState();
  assert.deepEqual(state.off, ["mail"]);
  assert.equal(state.thresholds.cpuHigh, 0.9);
  assert.equal(state.thresholds.highDays, 7);
  assert.equal((await data.recommendations(now)).items.some((r) => r.id === "mail"), false);
});

test("the AI totals counted before are copied once into the details", async () => {
  await metrics.clearMetrics();
  await run("INSERT INTO metrics_ai(day,feature,requests,tokens_in,tokens_out) VALUES('2026-01-02','ask',4,40,4)");
  await run("DELETE FROM data_migrations WHERE name=?", AI_DETAIL_STEP);
  await runDataSteps([AI_DETAIL_STEP]);
  await runDataSteps([AI_DETAIL_STEP]);
  const rows = await all<{ model: string; requests: number }>("SELECT model,requests FROM metrics_ai_usage WHERE day='2026-01-02'");
  assert.deepEqual(rows, [{ model: "", requests: 4 }]);
});
