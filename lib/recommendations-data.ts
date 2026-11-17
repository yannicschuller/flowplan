// The recommendations of the administration (lib/recommendations.ts): the
// snapshot of numbers the rules read, gathered at most every 15 minutes
// and cached in memory (the strip polls every 15 s – it reads the cache),
// and what administrators chose, stored per instance in instance_settings
// ("recommendations", both databases):
// - thresholds and the rules switched off (Überwachung → Empfehlungen);
// - hidden: "Ausblenden" – hidden while the situation lasts; once a rule
//   no longer applies its entry goes, so it shows again when it returns;
// - snoozed: "Erinnere mich in 30 Tagen" – hidden until then.
// Gathering reads rows the monitoring keeps anyway (a week of server
// samples, the hourly request rows, 30 days of storage rows, 14 days of AI
// counts) – a few milliseconds every 15 minutes.
import { z } from "zod";
import { all, one, run } from "./db";
import { database } from "./db-driver";
import { COMMAND_ROUTE, activeRecently, decodeHist, errorsDay, metricsSetting, percentile, routeStats } from "./metrics";
import { serverDays, serverNow } from "./server-metrics";
import { aiStatistics } from "./ai-statistics";
import { instanceAiSettings } from "./ai/settings";
import { AI_FEATURES } from "./ai/features";
import { scheduledBackupStatus } from "./scheduled-backup";
import { mailStatus } from "./mail";
import { buildInfo } from "./build-info";
import { knownUpdate } from "./update-check";
import { plainHttpInstance } from "./instance-https";
import { transactionTimes } from "./runtime-metrics";
import { instanceMetrics } from "./instance-ops";
import { cleanThresholds, evaluate, RECOMMENDATION_IDS, type Recommendation, type RecommendationId, type RecommendationInput, type Thresholds } from "./recommendations";

const MINUTE = 60_000,
  DAY = 86_400_000;
export const EVALUATE_EVERY_MS = 15 * MINUTE;
export const SNOOZE_DAYS = 30;
const KEY = "recommendations";

/* ---------- Choices of the administrators ---------- */

const idSchema = z.enum(RECOMMENDATION_IDS);
type Stored = { thresholds: Thresholds; off: RecommendationId[]; hidden: Partial<Record<RecommendationId, number>>; snoozed: Partial<Record<RecommendationId, number>> };
const holder = globalThis as unknown as { flowplanRecommendations?: { at: number; items: Recommendation[]; input?: RecommendationInput } };

export async function recommendationState(): Promise<Stored> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse((await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", KEY))?.value || "{}") || {};
  } catch {}
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is RecommendationId => idSchema.safeParse(x).success) : []);
  const times = (v: unknown) =>
    Object.fromEntries(Object.entries(v && typeof v === "object" ? v : {}).filter(([k, t]) => idSchema.safeParse(k).success && typeof t === "number")) as Partial<Record<RecommendationId, number>>;
  return { thresholds: cleanThresholds(raw.thresholds), off: ids(raw.off), hidden: times(raw.hidden), snoozed: times(raw.snoozed) };
}
async function saveState(state: Stored) {
  await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", KEY, JSON.stringify(state));
}

export const recommendationAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recommendation.hide"), id: idSchema }),
  z.object({ action: z.literal("recommendation.snooze"), id: idSchema }),
  z.object({ action: z.literal("recommendation.restore"), id: idSchema }),
  z.object({ action: z.literal("recommendations.settings"), thresholds: z.record(z.string(), z.number()).optional(), off: z.array(idSchema).optional() }),
]);
export async function applyRecommendationAction(input: z.infer<typeof recommendationAction>, now = Date.now()) {
  const state = await recommendationState();
  if (input.action === "recommendation.hide") state.hidden[input.id] = now;
  else if (input.action === "recommendation.snooze") state.snoozed[input.id] = now + SNOOZE_DAYS * DAY;
  else if (input.action === "recommendation.restore") {
    delete state.hidden[input.id];
    delete state.snoozed[input.id];
  } else {
    if (input.thresholds) state.thresholds = cleanThresholds({ ...state.thresholds, ...input.thresholds });
    if (input.off) state.off = [...new Set(input.off)];
    // New thresholds: evaluate again on the next read.
    delete holder.flowplanRecommendations;
  }
  await saveState(state);
}

/* ---------- The snapshot ---------- */

export async function recommendationInput(now = Date.now()): Promise<RecommendationInput> {
  const days = await serverDays(now, 7);
  // p95 and the most people per (UTC) day, from the hourly rows.
  const hours = await all<{ at: number; hist: string; active: number }>("SELECT at,hist,active FROM metrics_hour WHERE at>=?", Math.floor(now / DAY) * DAY - 6 * DAY);
  const perDay = new Map<number, { hist: number[]; active: number }>();
  for (const h of hours) {
    const day = Math.floor(h.at / DAY) * DAY;
    const d = perDay.get(day) || { hist: [], active: 0 };
    const hist = decodeHist(h.hist);
    d.hist = d.hist.length ? d.hist.map((v, i) => v + hist[i]) : hist;
    d.active = Math.max(d.active, h.active || 0);
    perDay.set(day, d);
  }
  const current = await serverNow(now);
  // Disk growth per day from the storage rows of 30 days (free space falling).
  const storage = await all<{ day: string; disk_free: number | null; at: number }>("SELECT day,disk_free,at FROM metrics_day WHERE disk_free IS NOT NULL ORDER BY day DESC LIMIT 30");
  let growthPerDay: number | null = null;
  if (storage.length >= 3) {
    const newest = storage[0],
      oldest = storage[storage.length - 1];
    const span = (newest.at - oldest.at) / DAY;
    if (span >= 2) growthPerDay = (Number(oldest.disk_free) - Number(newest.disk_free)) / span;
  }
  const metrics = await instanceMetrics().catch(() => null);
  const routes = await routeStats(now, 24, 50).catch(() => []);
  const weekRoutes = await routeStats(now, 7 * 24, 200).catch(() => []);
  const commands = weekRoutes.filter((r) => r.route.startsWith(`${COMMAND_ROUTE} · `) && r.requests >= 50 && r.p95 !== null);
  const backup = await scheduledBackupStatus().catch(() => null);
  const mail = await mailStatus().catch(() => null);
  const ai = await instanceAiSettings().catch(() => null);
  const aiOn = !!ai?.enabled && (!!ai.provider || ai.userProviders);
  const stats = aiOn ? await aiStatistics(now, 14, false).catch(() => null) : null;
  const week = (from: number, to: number) => stats?.perDay.slice(from, to) ?? [];
  const sum = (rows: { cost: number | null }[]) => (rows.some((r) => r.cost !== null) ? rows.reduce((a, r) => a + (r.cost || 0), 0) : null);
  const tokens = (rows: { tokensIn: number; tokensOut: number }[]) => rows.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0);
  const totalTokens = stats ? stats.total.tokensIn + stats.total.tokensOut : 0;
  const top = stats?.features[0];
  const featureLabel = (id: string) => (id === "embeddings" ? "Embeddings" : AI_FEATURES.find((f) => f.id === id)?.label[0] || id);
  const errors = await errorsDay(now).catch(() => ({ requests: 0, errors: 0, previous: null }));
  let searchBacklog = 0;
  try {
    searchBacklog = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM search_dirty"))?.n || 0);
  } catch {}
  const tx = transactionTimes();
  return {
    now,
    days: days.map((d) => {
      const h = perDay.get(d.day);
      return {
        day: d.day,
        cpuPeak: d.cpuPeak,
        memPeak: d.memPeak,
        cpuMean: d.cpuMean,
        memMean: d.memMean,
        rssFirst: d.rssFirst,
        rssLast: d.rssLast,
        activePeak: d.activePeak ?? (h ? h.active : null),
        p95: h && h.hist.length ? percentile(h.hist, 0.95) : null,
        gaps: d.gaps,
        minutes: d.minutes,
      };
    }),
    limits: { cpu: current.cpu.limit, cpuLimited: current.cpu.limited, memory: current.memory.limit, memoryLimited: current.memory.limited },
    disk: {
      total: current.disk.total,
      free: current.disk.free,
      growthPerDay,
      uploads: metrics?.uploadBytes ?? current.disk.uploads,
      database: metrics?.databaseBytes ?? current.disk.database,
      trashedPages: metrics?.trashedPages ?? 0,
      versions: metrics?.snapshots ?? 0,
    },
    database: { backend: database().backend === "postgres" ? "postgres" : "sqlite", commandP95: commands.length ? Math.max(...commands.map((c) => c.p95!)) : null, transactionMaxSeconds: tx?.maxSeconds ?? null },
    setup: {
      backup: { enabled: !!backup?.enabled, lastAt: backup?.last?.at ?? null, error: backup?.last?.error ?? null },
      litestream: process.env.FLOWPLAN_LITESTREAM_ACTIVE === "1",
      mail: !!mail?.configured,
      version: buildInfo().version || null,
      latest: knownUpdate()?.latest ?? null,
      plainHttp: plainHttpInstance(),
      metricsToken: process.env.FLOWPLAN_METRICS_TOKEN?.trim() || null,
    },
    routes,
    searchBacklog,
    live: { documents: current.live.documents, connections: current.live.connections, activeNow: activeRecently(now) ?? 0 },
    ai: {
      enabled: aiOn,
      p95: stats?.total.p95 ?? null,
      requests: week(7, 14).reduce((a, d) => a + d.requests, 0),
      cost: [sum(week(7, 14)), sum(week(0, 7))],
      tokens: [tokens(week(7, 14)), tokens(week(0, 7))],
      currency: stats?.currency || "EUR",
      topFeature: top && totalTokens ? { feature: featureLabel(top.feature), share: (top.tokensIn + top.tokensOut) / totalTokens } : null,
    },
    errors,
    statisticsOn: (await metricsSetting()).enabled,
  };
}

/* ---------- Reading ---------- */

// What applies now (cached up to 15 minutes), and the choices.
export async function recommendations(now = Date.now(), force = false) {
  const state = await recommendationState();
  let cached = holder.flowplanRecommendations;
  if (force || !cached || now - cached.at >= EVALUATE_EVERY_MS || now < cached.at) {
    const input = await recommendationInput(now);
    cached = { at: now, items: evaluate(input, state.thresholds, state.off), input };
    holder.flowplanRecommendations = cached;
    // "Ausblenden" lasts while the situation does.
    const applying = new Set(cached.items.map((r) => r.id));
    const gone = (Object.keys(state.hidden) as RecommendationId[]).filter((id) => !applying.has(id));
    const expired = (Object.keys(state.snoozed) as RecommendationId[]).filter((id) => (state.snoozed[id] ?? 0) <= now);
    if (gone.length || expired.length) {
      for (const id of gone) delete state.hidden[id];
      for (const id of expired) delete state.snoozed[id];
      await saveState(state).catch(() => {});
    }
  }
  const quiet = (id: RecommendationId) => state.hidden[id] !== undefined || (state.snoozed[id] ?? 0) > now;
  return {
    at: cached.at,
    items: cached.items.filter((r) => !quiet(r.id) && !state.off.includes(r.id)),
    // Hidden or postponed ones that still apply (to bring them back).
    quiet: cached.items.filter((r) => quiet(r.id)).map((r) => ({ id: r.id, title: r.title, until: state.snoozed[r.id] ?? null })),
    thresholds: state.thresholds,
    off: state.off,
  };
}
export type Recommendations = Awaited<ReturnType<typeof recommendations>>;
