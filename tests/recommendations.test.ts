// The recommendation rules (lib/recommendations.ts): pure functions of a
// snapshot – each one triggers, stays quiet, and its edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as r from "../lib/recommendations";
import type { DayLoad, RecommendationInput, Thresholds } from "../lib/recommendations";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12);
const T: Thresholds = { ...r.DEFAULT_THRESHOLDS };
const GB = 1024 ** 3;

const day = (i: number, over: Partial<DayLoad> = {}): DayLoad => ({
  day: Math.floor(NOW / DAY) * DAY - (6 - i) * DAY,
  cpuPeak: 0.3,
  memPeak: 0.5,
  cpuMean: 0.1,
  memMean: 0.45,
  rssFirst: 400e6,
  rssLast: 410e6,
  activePeak: 10,
  p95: 120,
  gaps: 0,
  minutes: 1440,
  ...over,
});
function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    now: NOW,
    days: [0, 1, 2, 3, 4, 5, 6].map((i) => day(i)),
    limits: { cpu: 2, cpuLimited: true, memory: 2 * GB, memoryLimited: true },
    disk: { total: 100 * GB, free: 60 * GB, growthPerDay: 0.1 * GB, uploads: 10 * GB, database: 1 * GB, trashedPages: 10, versions: 100 },
    database: { backend: "sqlite", commandP95: 80, transactionMaxSeconds: null },
    setup: { backup: { enabled: true, lastAt: NOW - DAY / 2, error: null }, litestream: false, mail: true, version: "0.9.8", latest: null, plainHttp: false, metricsToken: null },
    routes: [],
    searchBacklog: 0,
    live: { documents: 4, connections: 6, activeNow: 3 },
    ai: { enabled: true, p95: 3000, requests: 50, cost: [2, 1.8], tokens: [200_000, 180_000], currency: "EUR", topFeature: { feature: "Schreiben", share: 0.4 }, },
    errors: { requests: 10_000, errors: 5, previous: { requests: 9000, errors: 4 } },
    statisticsOn: true,
    ...over,
  };
}
const days = (fn: (i: number) => Partial<DayLoad>) => [0, 1, 2, 3, 4, 5, 6].map((i) => day(i, fn(i)));

test("a healthy instance has no recommendations", () => {
  assert.deepEqual(r.evaluate(input()).map((x) => x.id), []);
});

test("scale-up: CPU near the limit at peak times on 3 of 7 days, not on 2", () => {
  const hot = r.scaleUp(input({ days: days((i) => (i >= 4 ? { cpuPeak: 0.92 } : {})) }), T)!;
  assert.equal(hot.id, "scale-up");
  assert.match(hot.reason[0], /CPU über 80 % des Limits an 3 der letzten 7 Tage zu Stoßzeiten/);
  assert.match(hot.reason[1], /^CPU above 80 % of the limit on 3 of the last 7 days/);
  assert.equal(hot.docs[1], "https://docs.flowplan.org/en/sizing");
  assert.equal(r.scaleUp(input({ days: days((i) => (i >= 5 ? { cpuPeak: 0.92 } : {})) }), T), null);
  // Exactly at the threshold counts.
  assert.ok(r.scaleUp(input({ days: days((i) => (i >= 4 ? { memPeak: 0.8 } : {})) }), T));
  // Days with less than an hour of samples do not count.
  assert.equal(r.scaleUp(input({ days: days((i) => (i >= 4 ? { cpuPeak: 0.95, minutes: 30 } : {})) }), T), null);
  // Many people: PostgreSQL and replicas (the Kubernetes page).
  const big = r.scaleUp(input({ days: days((i) => (i >= 4 ? { cpuPeak: 0.95, activePeak: 120 } : {})) }), T)!;
  assert.deepEqual(big.docs, ["https://docs.flowplan.org/kubernetes", "https://docs.flowplan.org/en/kubernetes"]);
  // A lower threshold of days set by an administrator.
  assert.ok(r.scaleUp(input({ days: days((i) => (i === 6 ? { cpuPeak: 0.95 } : {})) }), { ...T, highDays: 1 }));
});

test("scale-up: answers slower on the days with more people, together with some load", () => {
  const x = input({ days: days((i) => (i >= 4 ? { activePeak: 40, p95: 1500, cpuPeak: 0.85 } : { activePeak: 10, p95: 200 })) });
  const rec = r.scaleUp(x, T)!;
  assert.match(rec.reason[0], /langsamer \(p95 1,5 s statt 200 ms\)/);
  // Slower alone, without load near the limit: not a reason to scale.
  assert.equal(r.scaleUp(input({ days: days((i) => (i >= 4 ? { activePeak: 40, p95: 1500 } : { activePeak: 10, p95: 200 })) }), T), null);
});

test("over-provisioned: only with container limits, at least 3 full days, every day below", () => {
  const idle = days(() => ({ cpuPeak: 0.05, memPeak: 0.2 }));
  const rec = r.overProvisioned(input({ days: idle }), T)!;
  assert.match(rec.reason[0], /höchstens 5 % CPU und 20 % Arbeitsspeicher/);
  assert.equal(r.overProvisioned(input({ days: idle, limits: { cpu: 8, cpuLimited: false, memory: 16 * GB, memoryLimited: false } }), T), null);
  assert.equal(r.overProvisioned(input({ days: idle.slice(0, 2) }), T), null);
  assert.equal(r.overProvisioned(input({ days: idle.map((d, i) => (i === 3 ? { ...d, cpuPeak: 0.5 } : d)) }), T), null);
});

test("disk: full within the days left, or nearly full; nothing without numbers", () => {
  const soon = r.disk(input({ disk: { total: 100 * GB, free: 10 * GB, growthPerDay: 1 * GB, uploads: 50 * GB, database: 1 * GB, trashedPages: 5000, versions: 60_000 } }), T)!;
  assert.match(soon.reason[0], /in etwa 10 Tagen voll \(90 % belegt\); Uploads belegen 50 GB; 60\.000 alte Versionen; 5\.000 Seiten im Papierkorb/);
  assert.equal(soon.level, "info");
  assert.equal(r.disk(input({ disk: { ...input().disk, free: 5 * GB, growthPerDay: 1 * GB } }), T)!.level, "warn");
  assert.ok(r.disk(input({ disk: { ...input().disk, free: 12 * GB, growthPerDay: 0 } }), T));
  assert.equal(r.disk(input({ disk: { ...input().disk, free: 50 * GB, growthPerDay: -1 * GB } }), T), null);
  assert.equal(r.disk(input({ disk: { ...input().disk, total: null } }), T), null);
});

test("sqlite-postgres: many people at once on SQLite, slow changes, long locks; never on PostgreSQL", () => {
  assert.match(r.sqlitePostgres(input({ days: days((i) => (i === 6 ? { activePeak: 90 } : {})) }), T)!.reason[0], /^Bis zu 90 Personen gleichzeitig aktiv/);
  assert.equal(r.sqlitePostgres(input({ days: days((i) => (i === 6 ? { activePeak: 90 } : {})), database: { backend: "postgres", commandP95: null, transactionMaxSeconds: null } }), T), null);
  assert.ok(r.sqlitePostgres(input({ database: { backend: "sqlite", commandP95: 80, transactionMaxSeconds: 3 } }), T));
  assert.equal(r.sqlitePostgres(input({ database: { backend: "sqlite", commandP95: 1500, transactionMaxSeconds: null } }), T), null);
  assert.ok(r.sqlitePostgres(input({ days: days(() => ({ activePeak: 40 })), database: { backend: "sqlite", commandP95: 1500, transactionMaxSeconds: null } }), T));
});

test("backup: none set up, failed, old; Litestream counts", () => {
  const setup = input().setup;
  assert.equal(r.backup(input({ setup: { ...setup, backup: { enabled: false, lastAt: null, error: null } } }), T)!.title[0], "Keine Sicherung eingerichtet");
  assert.equal(r.backup(input({ setup: { ...setup, litestream: true, backup: { enabled: false, lastAt: null, error: null } } }), T), null);
  assert.match(r.backup(input({ setup: { ...setup, backup: { enabled: true, lastAt: NOW - DAY, error: "disk full" } } }), T)!.reason[0], /disk full/);
  assert.match(r.backup(input({ setup: { ...setup, backup: { enabled: true, lastAt: NOW - 4 * DAY, error: null } } }), T)!.reason[0], /4 Tage alt/);
  assert.ok(r.backup(input({ setup: { ...setup, backup: { enabled: true, lastAt: null, error: null } } }), T));
  assert.equal(r.backup(input(), T), null);
});

test("setup: mail, update, https, weak metrics token", () => {
  const setup = input().setup;
  assert.ok(r.mail(input({ setup: { ...setup, mail: false } }), T));
  assert.equal(r.mail(input(), T), null);
  assert.equal(r.update(input({ setup: { ...setup, latest: "0.9.9" } }), T)!.level, "info");
  assert.equal(r.update(input({ setup: { ...setup, latest: "0.11.0" } }), T)!.level, "warn");
  assert.equal(r.update(input(), T), null);
  assert.ok(r.https(input({ setup: { ...setup, plainHttp: true } }), T));
  assert.match(r.metricsToken(input({ setup: { ...setup, metricsToken: "short" } }), T)!.reason[0], /nur 5 Zeichen/);
  assert.equal(r.metricsToken(input({ setup: { ...setup, metricsToken: "x".repeat(40) } }), T), null);
});

test("slow endpoints name the route, its numbers and a known cause", () => {
  const route = (name: string, p95: number, requests = 50) => ({ route: name, requests, errors: 0, totalMs: p95 * requests, avgMs: p95 / 2, p95 });
  const rec = r.slowEndpoints(input({ routes: [route("GET /api/databases/:id/rows", 5000), route("GET /api/pages/:id", 2500)] }), T)!;
  assert.match(rec.reason[0], /GET \/api\/databases\/:id\/rows braucht p95 5 s bei 50 Anfragen – meist eine sehr große Datenbankansicht.*; 1 weitere über 2 s\./);
  assert.match(rec.reason[1], /; 1 more above 2 s\.$/);
  assert.match(r.slowEndpoints(input({ routes: [route("GET /api/search", 3000)], searchBacklog: 4000 }), T)!.reason[0], /Suchindex wird gerade neu aufgebaut \(4\.000 Einträge warten\)/);
  // Rarely used or fast: quiet.
  assert.equal(r.slowEndpoints(input({ routes: [route("GET /api/export", 9000, 3), route("GET /api/pages/:id", 300)] }), T), null);
  assert.equal(r.slowEndpoints(input({ routes: [route("GET /api/x", 7000)] }), T)!.level, "warn");
});

test("documents per person, AI latency", () => {
  assert.match(r.documentsPerPerson(input({ live: { documents: 40, connections: 120, activeNow: 4 } }), T)!.reason[0], /40 Dokumente sind live geöffnet bei 4 aktiven Personen \(10 je Person, 120 Verbindungen\)/);
  assert.equal(r.documentsPerPerson(input({ live: { documents: 40, connections: 40, activeNow: 1 } }), T), null);
  assert.equal(r.documentsPerPerson(input({ live: { documents: 20, connections: 20, activeNow: 10 } }), T), null);
  assert.ok(r.aiLatency(input({ ai: { ...input().ai, p95: 30_000 } }), T));
  assert.equal(r.aiLatency(input({ ai: { ...input().ai, p95: 30_000, requests: 3 } }), T), null);
  assert.equal(r.aiLatency(input({ ai: { ...input().ai, p95: 30_000, enabled: false } }), T), null);
});

test("AI costs: rising sharply, the feature using most; tokens when there are no prices", () => {
  const ai = input().ai;
  const rec = r.aiCosts(input({ ai: { ...ai, cost: [25, 10], topFeature: { feature: "Fragen", share: 0.8 } } }), T)!;
  assert.match(rec.reason[0], /auf 25,00\s€ gestiegen \(das 2,5-Fache der 7 Tage davor\); „Fragen“ braucht 80 % davon\. Grenzen je Arbeitsbereich gibt es nicht\./);
  assert.equal(r.aiCosts(input({ ai: { ...ai, cost: [15, 10] } }), T), null);
  // Tiny sums are no trend.
  assert.equal(r.aiCosts(input({ ai: { ...ai, cost: [0.5, 0.1] } }), T), null);
  assert.ok(r.aiCosts(input({ ai: { ...ai, cost: [null, null], tokens: [900_000, 300_000] } }), T));
  assert.equal(r.aiCosts(input({ ai: { ...ai, cost: [null, null], tokens: [900_000, 0] } }), T), null);
});

test("memory growing without more people is a possible leak, with debug data; a restart or more people is not", () => {
  const leak = days((i) => ({ rssFirst: 300e6 + i * 80e6, rssLast: 380e6 + i * 80e6, activePeak: 10 }));
  const rec = r.memoryGrowth(input({ days: leak }), T)!;
  assert.match(rec.reason[0], /seit 7 Tagen immer mehr Arbeitsspeicher \(286 MB → 820 MB, \+187 %\)/);
  assert.equal((rec.debug!.rss as unknown[]).length, 7);
  assert.equal(r.memoryGrowth(input({ days: leak.map((d, i) => ({ ...d, activePeak: 10 + i * 30 })) }), T), null);
  assert.equal(r.memoryGrowth(input({ days: leak.map((d, i) => (i === 3 ? { ...d, gaps: 1 } : d)) }), T), null);
  assert.equal(r.memoryGrowth(input({ days: leak.map((d, i) => (i === 3 ? { ...d, rssLast: 200e6 } : d)) }), T), null);
});

test("error rate jump and restarts", () => {
  assert.match(r.errorJump(input({ errors: { requests: 10_000, errors: 400, previous: { requests: 10_000, errors: 20 } } }), T)!.reason[0], /^4 % der Anfragen/);
  assert.equal(r.errorJump(input({ errors: { requests: 10_000, errors: 400, previous: null } }), T), null);
  assert.equal(r.errorJump(input({ errors: { requests: 100, errors: 50, previous: { requests: 100, errors: 0 } } }), T), null);
  assert.equal(r.errorJump(input({ errors: { requests: 10_000, errors: 50, previous: { requests: 10_000, errors: 1 } } }), T), null);
  assert.ok(r.restarts(input({ days: days((i) => ({ gaps: i % 2 })) }), T));
  assert.equal(r.restarts(input({ days: days((i) => ({ gaps: i === 1 ? 2 : 0 })) }), T), null);
});

test("evaluate: rules switched off are skipped, warnings first; thresholds are clamped", () => {
  const x = input({ setup: { ...input().setup, mail: false, plainHttp: true } });
  assert.deepEqual(r.evaluate(x).map((y) => y.id), ["https", "mail"]);
  assert.deepEqual(r.evaluate(x, T, ["https"]).map((y) => y.id), ["mail"]);
  const clean = r.cleanThresholds({ cpuHigh: 5, highDays: 0, restarts: "x", unknown: 1 });
  assert.equal(clean.cpuHigh, 1);
  assert.equal(clean.highDays, 1);
  assert.equal(clean.restarts, r.DEFAULT_THRESHOLDS.restarts);
  assert.equal("unknown" in clean, false);
});

test("disk growth counts Flowplan's own data, not the disk's free space", () => {
  const day = 86_400_000;
  // Newest first: 82 MB in 7 days.
  const rows = [7, 3, 0].map((d) => ({ at: d * day, bytes: 149e6 - (7 - d) * (82e6 / 7) }));
  assert.equal(Math.round(r.dataGrowthPerDay(rows)!), Math.round(82e6 / 7));
  assert.equal(r.dataGrowthPerDay(rows.slice(0, 2)), null);
  assert.equal(r.dataGrowthPerDay([{ at: 1.5 * day, bytes: 2 }, { at: day, bytes: 1 }, { at: 0, bytes: 0 }]), null);
});
