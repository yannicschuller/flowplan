// AI statistics for the administration (Administration → KI → Statistik and
// the AI chart of the live strip): per day, model, workspace and person –
// requests, tokens, errors, timeouts, response times and, where an
// administrator entered prices for a model (AI settings), the estimated
// cost. Reads metrics_ai_usage (lib/metrics.ts). Counts only, never a
// prompt or an answer; the per-person numbers are for administrators only
// (the route checks it, app/api/admin/monitoring).
import { all } from "./db";
import { decodeHist, flushAi, localDay, percentile } from "./metrics";
import { instanceAiSettings, type AiPrice } from "./ai/settings";
import { workflowLimits } from "./workflows/limits";

const DAY = 86_400_000;

type Row = { day: string; model: string; source: string; workspace_id: string; user_id: string; feature: string; requests: number; tokens_in: number; tokens_out: number; errors: number; timeouts: number; ms_total: number; hist: string };
type Sum = { requests: number; tokensIn: number; tokensOut: number; errors: number; timeouts: number; ms: number; timed: number; hist: number[]; cost: number; priced: boolean };
const empty = (): Sum => ({ requests: 0, tokensIn: 0, tokensOut: 0, errors: 0, timeouts: 0, ms: 0, timed: 0, hist: [], cost: 0, priced: false });

// The cost of tokens of a model with its price per million tokens; null
// without a price. Model names compare without case and an "models/" prefix.
export const priceKey = (model: string) => model.trim().toLowerCase().replace(/^models\//, "");
export function costOf(prices: AiPrice[], model: string, tokensIn: number, tokensOut: number): number | null {
  const key = priceKey(model);
  const price = key ? prices.find((p) => priceKey(p.model) === key) : undefined;
  return price ? (tokensIn / 1e6) * price.input + (tokensOut / 1e6) * price.output : null;
}

function add(sum: Sum, r: Row, prices: AiPrice[]) {
  sum.requests += r.requests;
  sum.tokensIn += r.tokens_in;
  sum.tokensOut += r.tokens_out;
  sum.errors += r.errors;
  sum.timeouts += r.timeouts;
  const hist = decodeHist(r.hist);
  const timed = hist.reduce((a, b) => a + b, 0);
  sum.ms += r.ms_total;
  sum.timed += timed;
  sum.hist = sum.hist.length ? sum.hist.map((n, i) => n + hist[i]) : hist;
  const cost = costOf(prices, r.model, r.tokens_in, r.tokens_out);
  if (cost !== null) {
    sum.cost += cost;
    sum.priced = true;
  }
}
const view = (s: Sum) => ({
  requests: s.requests,
  tokensIn: s.tokensIn,
  tokensOut: s.tokensOut,
  errors: s.errors,
  timeouts: s.timeouts,
  avgMs: s.timed ? Math.round(s.ms / s.timed) : null,
  p95: s.hist.length ? percentile(s.hist, 0.95) : null,
  cost: s.priced ? Math.round(s.cost * 10_000) / 10_000 : null,
});
const lastDays = (now: number, days: number) => {
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(localDay(noon.getTime() - i * DAY));
  return keys;
};

export async function aiStatistics(now = Date.now(), days = 30, people = true) {
  await flushAi();
  const settings = await instanceAiSettings();
  const prices = settings.prices;
  const keys = lastDays(now, days);
  const rows = await all<Row>("SELECT day,model,source,workspace_id,user_id,feature,requests,tokens_in,tokens_out,errors,timeouts,ms_total,hist FROM metrics_ai_usage WHERE day>=?", keys[0]);
  const perDay = new Map(keys.map((k) => [k, empty()]));
  const models = new Map<string, Sum & { model: string; source: string }>();
  const workspaces = new Map<string, Sum>();
  const persons = new Map<string, Sum>();
  const features = new Map<string, Sum>();
  const total = empty();
  for (const r of rows) {
    const d = perDay.get(r.day);
    if (!d) continue;
    add(d, r, prices);
    add(total, r, prices);
    const mk = `${r.model}|${r.source}`;
    if (!models.has(mk)) models.set(mk, { ...empty(), model: r.model, source: r.source });
    add(models.get(mk)!, r, prices);
    if (!workspaces.has(r.workspace_id)) workspaces.set(r.workspace_id, empty());
    add(workspaces.get(r.workspace_id)!, r, prices);
    if (people) {
      if (!persons.has(r.user_id)) persons.set(r.user_id, empty());
      add(persons.get(r.user_id)!, r, prices);
    }
    if (!features.has(r.feature)) features.set(r.feature, empty());
    add(features.get(r.feature)!, r, prices);
  }
  const names = async (table: "workspaces" | "users", ids: string[]) => {
    const wanted = ids.filter(Boolean);
    if (!wanted.length) return new Map<string, string>();
    const out = new Map<string, string>();
    for (let i = 0; i < wanted.length; i += 200) {
      const part = wanted.slice(i, i + 200);
      for (const r of await all<{ id: string; name: string }>(`SELECT id,name FROM ${table} WHERE id IN (${part.map(() => "?").join(",")})`, ...part)) out.set(r.id, r.name);
    }
    return out;
  };
  const byTokens = <T extends { tokensIn: number; tokensOut: number }>(a: T, b: T) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
  const workspaceNames = await names("workspaces", [...workspaces.keys()]);
  const personNames = people ? await names("users", [...persons.keys()]) : new Map<string, string>();
  const limits = await workflowLimits().catch(() => null);
  return {
    days,
    currency: settings.currency,
    pricedModels: prices.map((p) => p.model),
    total: view(total),
    perDay: [...perDay].map(([day, s]) => ({ day, ...view(s) })),
    models: [...models.values()].map((m) => ({ model: m.model, source: m.source, ...view(m), priced: costOf(prices, m.model, 0, 0) !== null })).sort(byTokens),
    features: [...features].map(([feature, s]) => ({ feature, ...view(s) })).sort(byTokens),
    // '' = not attributable (embeddings, counted before this version).
    workspaces: [...workspaces].map(([id, s]) => ({ id, name: id ? (workspaceNames.get(id) ?? null) : null, ...view(s) })).sort(byTokens).slice(0, 50),
    people: people ? [...persons].map(([id, s]) => ({ id, name: id ? (personNames.get(id) ?? null) : null, ...view(s) })).sort(byTokens).slice(0, 50) : null,
    // The limits that exist: requests per person and hour (lib/action-limits.ts)
    // and tokens per workflow and day (lib/workflows/limits.ts). There is no
    // limit per workspace.
    limits: {
      requestsPerPersonHour: Math.max(1, Number(process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR) || 300),
      workflowTokensPerDay: limits?.aiTokensPerDay ?? null,
    },
  };
}
export type AiStatistics = Awaited<ReturnType<typeof aiStatistics>>;

// The live strip's AI chart: tokens and cost per day (14 days).
export async function aiDaily(now = Date.now(), days = 14) {
  const s = await aiStatistics(now, days, false);
  return { currency: s.currency, priced: s.pricedModels.length > 0, total: s.total, perDay: s.perDay.map((d) => ({ day: d.day, tokensIn: d.tokensIn, tokensOut: d.tokensOut, requests: d.requests, errors: d.errors + d.timeouts, cost: d.cost })) };
}
export type AiDaily = Awaited<ReturnType<typeof aiDaily>>;
