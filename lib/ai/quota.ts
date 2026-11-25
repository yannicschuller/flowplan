// AI quotas (#382): limits for AI through the instance's provider – for the
// whole instance, a default per person, roles, workspace groups and single
// accounts – per calendar day, week, month and year, in tokens or (with
// prices per model) in estimated cost. Everyone sees what is left
// (GET /api/ai/quota); administrators set them under Administration → KI →
// Kontingente.
//
// Counting: lib/ai/run.ts (every chat request of every feature) and
// lib/ai/providers.ts (embeddings) record the tokens of each answered request
// with the instance's provider in ai_quota_usage – per day in the quota's
// time zone, person, model and kind ('person', 'workflow', 'system' for the
// search index). It is written at once into the shared database, so every
// instance of a cluster counts the same, and it is kept for 400 days (a
// year period needs a year). The monitoring's metrics_ai_usage stays what it
// is: buffered per process, optional (Überwachung → Statistik) and kept 90
// days – too loose to refuse a request on.
//
// What counts: the instance's provider only. A person's own provider and the
// on-device model never count and keep working when a quota is used up.
// Workflows keep their own daily budget (lib/workflows/limits.ts); their
// usage counts towards the instance ceiling (switchable), never towards the
// person a workflow runs as. Embeddings count towards the instance ceiling.
//
// Checking: before a request is sent (requireQuota in lib/ai/run.ts), its
// estimate – prompt size plus maximum output, priced when the unit is cost –
// plus what is used plus what other running requests of this process
// reserved must fit every period of the person's limits and of the instance
// ceiling. Otherwise it is refused (429) with the reset time and the
// alternatives. Precedence for a person: their own rule → their groups and
// roles (the highest limit per period; a group without a limit for a period
// means none) → the default. The instance ceiling applies on top. Groups:
// workspace groups in every workspace and directory groups by name
// (lib/person-groups.ts).
//
// After the quota: a rule can name a model of the instance's provider to go
// on with once its personal limits are used up ("weiter mit Modell …",
// after_model) – the request is then sent with that model, counted towards
// the person, but not limited by their limits; the instance ceiling still
// applies (and refuses as usual). Among several groups and roles the most
// capable such model wins (the highest price, as for the model rules).
// The continuation may have a limit of its own per period (after_limits,
// in the quota's unit): what was sent with the model after the quota is
// counted in ai_quota_after_usage, and once that limit is used up, AI is
// off until a period resets ("KI aus bis …"). Precedence as for the
// limits: the person's own rule, else the most generous of their groups
// and roles that go on (a period one of them leaves open is open), else
// the default.
import { z } from "zod";
import { all, one, run } from "../db";
import { HttpError } from "../auth";
import { requireAdmin } from "../permissions";
import type { Identity } from "../types";
import { Temporal, validZone } from "../date-values";
import { contentLocale, ct } from "../content-locale";
import { localeTag } from "../i18n";
import { costOf } from "../ai-statistics";
import { instanceAiSettings, type AiPrice } from "./settings";
import { allGroupKeys, groupChoices, personGroupKeys, validGroupKey } from "../person-groups";
import {
  QUOTA_PERIODS,
  type QuotaAfterStatus,
  QUOTA_ROLES,
  QUOTA_SCOPES,
  type QuotaLimits,
  type QuotaPeriod,
  type QuotaPeriodState,
  type QuotaRole,
  type QuotaRule,
  type QuotaSettings,
  type QuotaStatus,
  type QuotaUnit,
  tightest,
} from "./quota-shared";

const DAY = 86_400_000;
export const QUOTA_KEEP_DAYS = 400;
const SETTING_KEY = "aiQuota";

/* ---------- Calendar periods ---------- */

export function serverZone() {
  const env = process.env.TZ?.trim();
  if (env && validZone(env)) return env;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && validZone(zone)) return zone;
  } catch {}
  return "UTC";
}
const plainDate = (ms: number, zone: string) => Temporal.Instant.fromEpochMilliseconds(Math.floor(ms)).toZonedDateTimeISO(zone).toPlainDate();
// The calendar day of an instant in the zone ('YYYY-MM-DD').
export const quotaDay = (ms: number, zone: string) => plainDate(ms, zone).toString();
// The period an instant falls in: its first day, the first day after it and
// the instant it ends (midnight in the zone, or the first instant after a
// clock change's gap).
export function periodBounds(period: QuotaPeriod, ms: number, zone: string, weekStart: "monday" | "sunday" = "monday") {
  const date = plainDate(ms, zone);
  let start = date;
  let end: Temporal.PlainDate;
  if (period === "day") end = date.add({ days: 1 });
  else if (period === "week") {
    const first = weekStart === "sunday" ? 7 : 1;
    start = date.subtract({ days: (date.dayOfWeek - first + 7) % 7 });
    end = start.add({ days: 7 });
  } else if (period === "month") {
    start = date.with({ day: 1 });
    end = start.add({ months: 1 });
  } else {
    start = date.with({ month: 1, day: 1 });
    end = start.add({ years: 1 });
  }
  return { start: start.toString(), end: end.toString(), resetAt: end.toZonedDateTime({ timeZone: zone }).epochMilliseconds };
}

/* ---------- Settings and rules ---------- */

const limitValue = z.number().min(0).max(1e12).nullable().optional();
export const limitsSchema = z.object(Object.fromEntries(QUOTA_PERIODS.map((p) => [p, limitValue])) as Record<QuotaPeriod, typeof limitValue>).strict();
export const quotaSettingsSchema = z.object({
  unit: z.enum(["tokens", "cost"]),
  timeZone: z.string().trim().max(100).refine((zone) => validZone(zone), "Unbekannte Zeitzone."),
  weekStart: z.enum(["monday", "sunday"]),
  warnAt: z.number().int().min(1).max(99),
  workflowsCountInstance: z.boolean(),
});
const defaultSettings = (): QuotaSettings => ({ unit: "tokens", timeZone: serverZone(), weekStart: "monday", warnAt: 80, workflowsCountInstance: true });

export async function quotaSettings(): Promise<QuotaSettings> {
  const defaults = defaultSettings();
  try {
    const row = await one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", SETTING_KEY);
    if (!row) return defaults;
    const parsed = quotaSettingsSchema.partial().safeParse(JSON.parse(row.value));
    return parsed.success ? { ...defaults, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) } : defaults;
  } catch {
    return defaults;
  }
}

// Only the periods with a number; tokens are whole.
export function cleanLimits(raw: unknown, unit: QuotaUnit): QuotaLimits {
  const parsed = limitsSchema.safeParse(raw ?? {});
  const out: QuotaLimits = {};
  if (!parsed.success) return out;
  for (const p of QUOTA_PERIODS) {
    const v = parsed.data[p];
    if (typeof v === "number" && Number.isFinite(v)) out[p] = unit === "tokens" ? Math.round(v) : Math.round(v * 100) / 100;
  }
  return out;
}
export async function quotaRules(unit?: QuotaUnit): Promise<QuotaRule[]> {
  const u = unit ?? (await quotaSettings()).unit;
  try {
    return (await all<{ scope: string; target: string; exempt: number; limits: string; after_model: string | null; after_kind: string | null; after_limits: string | null }>("SELECT scope,target,exempt,limits,after_model,after_kind,after_limits FROM ai_quota_rules ORDER BY scope,target")).flatMap((r) => {
      if (!(QUOTA_SCOPES as readonly string[]).includes(r.scope)) return [];
      let limits: unknown = {};
      let afterLimits: unknown = {};
      try {
        limits = JSON.parse(r.limits);
      } catch {}
      try {
        afterLimits = r.after_limits ? JSON.parse(r.after_limits) : {};
      } catch {}
      const kept = cleanLimits(afterLimits, u);
      const after = r.after_model && !r.exempt && r.scope !== "instance" ? { after: r.after_model, afterKind: r.after_kind || "", ...(hasLimit(kept) ? { afterLimits: kept } : {}) } : {};
      return [{ scope: r.scope as QuotaRule["scope"], target: r.target, exempt: !!r.exempt, limits: cleanLimits(limits, u), ...after }];
    });
  } catch {
    return [];
  }
}
export const hasLimit = (limits: QuotaLimits | null | undefined) => !!limits && QUOTA_PERIODS.some((p) => typeof limits[p] === "number");

/* ---------- Which limits apply ---------- */

export type QuotaPerson = { userId: string; roles: QuotaRole[]; groups: string[] };
// after: the model to go on with once the limits are used up, and the
// provider kind it was chosen for (null: AI stops).
export type QuotaAfter = { model: string; kind: string };
// afterLimits: the continuation's own limits (null: unlimited).
export type PersonalLimits = { limits: QuotaLimits | null; exempt: boolean; source: "user" | "group" | "default" | "none"; after: QuotaAfter | null; afterLimits?: QuotaLimits | null };

const afterOf = (r: QuotaRule): QuotaAfter | null => (r.after ? { model: r.after, kind: r.afterKind || "" } : null);
// The most capable of several models: the highest price for a million
// tokens in and out (unpriced below priced), then A–Z (as
// lib/ai/model-policy.ts mostCapable).
const priceRank = (prices: AiPrice[], model: string) => costOf(prices, model, 1e6, 1e6) ?? -1;
function mostCapableAfter(list: QuotaAfter[], prices: AiPrice[]) {
  return [...list].sort((a, b) => priceRank(prices, b.model) - priceRank(prices, a.model) || a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind))[0] ?? null;
}

// The person's own rule, else the highest limit of their groups and roles
// per period (a period one of them leaves open is open), else the default.
export function personalLimits(rules: QuotaRule[], who: QuotaPerson, prices: AiPrice[] = []): PersonalLimits {
  const own = rules.find((r) => r.scope === "user" && r.target === who.userId);
  if (own) return own.exempt ? { limits: null, exempt: true, source: "user", after: null } : { limits: own.limits, exempt: false, source: "user", after: afterOf(own), ...(own.after && own.afterLimits ? { afterLimits: own.afterLimits } : {}) };
  const groups = rules.filter((r) => (r.scope === "group" && who.groups.includes(r.target)) || (r.scope === "role" && who.roles.includes(r.target as QuotaRole)));
  if (groups.length) {
    if (groups.some((r) => r.exempt)) return { limits: null, exempt: true, source: "group", after: null };
    const limits: QuotaLimits = {};
    for (const p of QUOTA_PERIODS) {
      const values = groups.map((r) => r.limits[p]);
      if (values.every((v): v is number => typeof v === "number")) limits[p] = Math.max(...values);
    }
    // The continuation's limit: the most generous of those that go on.
    const going = groups.filter((r) => r.after);
    let afterLimits: QuotaLimits | null = null;
    for (const p of QUOTA_PERIODS) {
      const values = going.map((r) => r.afterLimits?.[p]);
      if (going.length && values.every((v): v is number => typeof v === "number")) (afterLimits ??= {})[p] = Math.max(...values);
    }
    return { limits, exempt: false, source: "group", after: mostCapableAfter(groups.flatMap((r) => afterOf(r) ?? []), prices), ...(afterLimits ? { afterLimits } : {}) };
  }
  const fallback = rules.find((r) => r.scope === "default");
  return fallback ? { limits: fallback.limits, exempt: false, source: "default", after: afterOf(fallback), ...(fallback.after && fallback.afterLimits ? { afterLimits: fallback.afterLimits } : {}) } : { limits: null, exempt: false, source: "none", after: null };
}
// The model after the quota for the instance's provider now (null: none,
// or chosen for another provider kind).
export const activeAfter = (personal: PersonalLimits | null, provider: { kind: string; model: string } | null) =>
  personal?.after && provider?.model.trim() && personal.after.kind === provider.kind ? personal.after.model : null;
export const instanceLimits = (rules: QuotaRule[]) => rules.find((r) => r.scope === "instance")?.limits ?? null;

// Roles and groups of a person (also for the model, lib/ai/model-policy.ts).
export async function quotaPerson(user: Pick<Identity, "id" | "isAdmin">): Promise<QuotaPerson> {
  const groups = await personGroupKeys(user.id);
  const roles: QuotaRole[] = [];
  if (user.isAdmin) roles.push("admin");
  if (!(await fullMember(user.id))) roles.push("guest");
  return { userId: user.id, roles, groups };
}
const fullMember = async (userId: string) =>
  !!(await one("SELECT 1 FROM members m WHERE m.user_id=? AND NOT EXISTS (SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id) LIMIT 1", userId));

/* ---------- Usage ---------- */

export type UsageKind = "person" | "workflow" | "system";
type UsageRow = { day: string; model: string; kind: string; user_id: string; tokens_in: number; tokens_out: number };
// Tokens, or the cost with the current prices (models without a price: 0).
export function amountOf(rows: Pick<UsageRow, "model" | "tokens_in" | "tokens_out">[], unit: QuotaUnit, prices: AiPrice[]) {
  let sum = 0;
  for (const r of rows) sum += unit === "tokens" ? Number(r.tokens_in) + Number(r.tokens_out) : (costOf(prices, r.model, Number(r.tokens_in), Number(r.tokens_out)) ?? 0);
  return unit === "cost" ? Math.round(sum * 1e6) / 1e6 : sum;
}

const swept = globalThis as unknown as { flowplanQuotaSwept?: number };
// One answered request with the instance's provider (lib/ai/run.ts,
// lib/ai/providers.ts). Never throws: counting must not break an answer.
// `after`: sent with the model after the quota – counted for its limit too.
export async function recordQuotaUsage(input: { userId?: string | null; kind: UsageKind; model: string; tokensIn: number; tokensOut: number; after?: boolean }, now = Date.now()) {
  const tokensIn = Math.max(0, Math.round(input.tokensIn) || 0),
    tokensOut = Math.max(0, Math.round(input.tokensOut) || 0);
  if (!tokensIn && !tokensOut) return;
  try {
    const settings = await quotaSettings();
    await run(
      "INSERT INTO ai_quota_usage(day,user_id,model,kind,requests,tokens_in,tokens_out) VALUES(?,?,?,?,1,?,?) ON CONFLICT(day,user_id,model,kind) DO UPDATE SET requests=ai_quota_usage.requests+1,tokens_in=ai_quota_usage.tokens_in+excluded.tokens_in,tokens_out=ai_quota_usage.tokens_out+excluded.tokens_out",
      quotaDay(now, settings.timeZone),
      input.kind === "system" ? "" : input.userId || "",
      String(input.model || "").slice(0, 200),
      input.kind,
      tokensIn,
      tokensOut,
    );
    if (input.after && input.userId && input.kind === "person")
      await run(
        "INSERT INTO ai_quota_after_usage(day,user_id,model,requests,tokens_in,tokens_out) VALUES(?,?,?,1,?,?) ON CONFLICT(day,user_id,model) DO UPDATE SET requests=ai_quota_after_usage.requests+1,tokens_in=ai_quota_after_usage.tokens_in+excluded.tokens_in,tokens_out=ai_quota_after_usage.tokens_out+excluded.tokens_out",
        quotaDay(now, settings.timeZone),
        input.userId,
        String(input.model || "").slice(0, 200),
        tokensIn,
        tokensOut,
      );
    if (now - (swept.flowplanQuotaSwept ?? 0) > DAY) {
      swept.flowplanQuotaSwept = now;
      await run("DELETE FROM ai_quota_usage WHERE day<?", quotaDay(now - QUOTA_KEEP_DAYS * DAY, settings.timeZone));
      await run("DELETE FROM ai_quota_after_usage WHERE day<?", quotaDay(now - QUOTA_KEEP_DAYS * DAY, settings.timeZone));
    }
    await alertInstance(settings, now);
  } catch (error) {
    console.error("KI-Kontingent: Nutzung nicht gezählt", (error as Error)?.message || error);
  }
}

// What a person (kind 'person') or the instance (all counted kinds) used
// since a day, by period start.
async function usageSince(since: string, scope: { userId: string } | { instance: true; workflows: boolean } | { afterOf: string }) {
  if ("afterOf" in scope)
    return await all<UsageRow>(
      "SELECT day,model,'person' kind,user_id,SUM(tokens_in) tokens_in,SUM(tokens_out) tokens_out FROM ai_quota_after_usage WHERE day>=? AND user_id=? GROUP BY day,model,user_id",
      since,
      scope.afterOf,
    );
  if ("userId" in scope)
    return await all<UsageRow>(
      "SELECT day,model,kind,user_id,SUM(tokens_in) tokens_in,SUM(tokens_out) tokens_out FROM ai_quota_usage WHERE day>=? AND user_id=? AND kind='person' GROUP BY day,model,kind,user_id",
      since,
      scope.userId,
    );
  return await all<UsageRow>(
    `SELECT day,model,kind,'' user_id,SUM(tokens_in) tokens_in,SUM(tokens_out) tokens_out FROM ai_quota_usage WHERE day>=? AND kind IN (${scope.workflows ? "'person','workflow','system'" : "'person','system'"}) GROUP BY day,model,kind`,
    since,
  );
}
async function periodStates(level: "person" | "instance", limits: QuotaLimits, settings: QuotaSettings, prices: AiPrice[], scope: Parameters<typeof usageSince>[1], now: number): Promise<QuotaPeriodState[]> {
  const active = QUOTA_PERIODS.filter((p) => typeof limits[p] === "number");
  if (!active.length) return [];
  const bounds = active.map((p) => ({ p, ...periodBounds(p, now, settings.timeZone, settings.weekStart) }));
  const rows = await usageSince(bounds.reduce((a, b) => (b.start < a ? b.start : a), bounds[0].start), scope);
  return bounds.map(({ p, start, resetAt }) => {
    const used = amountOf(rows.filter((r) => r.day >= start), settings.unit, prices);
    const limit = limits[p] as number;
    return { level, period: p, limit, used, left: Math.max(0, Math.round((limit - used) * 1e6) / 1e6), resetAt };
  });
}

/* ---------- Reservations of running requests (this process) ---------- */

const holder = globalThis as unknown as { flowplanQuotaReserved?: Map<string, number> };
const reserved = (holder.flowplanQuotaReserved ??= new Map<string, number>());
function reserve(keys: string[], amount: number) {
  for (const k of keys) reserved.set(k, (reserved.get(k) || 0) + amount);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const k of keys) {
      const next = (reserved.get(k) || 0) - amount;
      if (next > 1e-9) reserved.set(k, next);
      else reserved.delete(k);
    }
  };
}

/* ---------- The refusal ---------- */

// i18n-table: 1 – [German, English] pairs
const HEADS: Record<string, readonly [string, string]> = {
  "person.day.used": ["Dein KI-Kontingent für heute ist aufgebraucht.", "Your AI quota for today is used up."],
  "person.week.used": ["Dein KI-Kontingent für diese Woche ist aufgebraucht.", "Your AI quota for this week is used up."],
  "person.month.used": ["Dein KI-Kontingent für diesen Monat ist aufgebraucht.", "Your AI quota for this month is used up."],
  "person.year.used": ["Dein KI-Kontingent für dieses Jahr ist aufgebraucht.", "Your AI quota for this year is used up."],
  "person.day.cross": ["Für diese Anfrage reicht dein KI-Kontingent für heute nicht mehr.", "Your AI quota for today is not enough for this request."],
  "person.week.cross": ["Für diese Anfrage reicht dein KI-Kontingent für diese Woche nicht mehr.", "Your AI quota for this week is not enough for this request."],
  "person.month.cross": ["Für diese Anfrage reicht dein KI-Kontingent für diesen Monat nicht mehr.", "Your AI quota for this month is not enough for this request."],
  "person.year.cross": ["Für diese Anfrage reicht dein KI-Kontingent für dieses Jahr nicht mehr.", "Your AI quota for this year is not enough for this request."],
  "instance.day.used": ["Das KI-Kontingent dieser Instanz für heute ist aufgebraucht.", "This instance's AI quota for today is used up."],
  "instance.week.used": ["Das KI-Kontingent dieser Instanz für diese Woche ist aufgebraucht.", "This instance's AI quota for this week is used up."],
  "instance.month.used": ["Das KI-Kontingent dieser Instanz für diesen Monat ist aufgebraucht.", "This instance's AI quota for this month is used up."],
  "instance.year.used": ["Das KI-Kontingent dieser Instanz für dieses Jahr ist aufgebraucht.", "This instance's AI quota for this year is used up."],
  "instance.day.cross": ["Für diese Anfrage reicht das KI-Kontingent dieser Instanz für heute nicht mehr.", "This instance's AI quota for today is not enough for this request."],
  "instance.week.cross": ["Für diese Anfrage reicht das KI-Kontingent dieser Instanz für diese Woche nicht mehr.", "This instance's AI quota for this week is not enough for this request."],
  "instance.month.cross": ["Für diese Anfrage reicht das KI-Kontingent dieser Instanz für diesen Monat nicht mehr.", "This instance's AI quota for this month is not enough for this request."],
  "instance.year.cross": ["Für diese Anfrage reicht das KI-Kontingent dieser Instanz für dieses Jahr nicht mehr.", "This instance's AI quota for this year is not enough for this request."],
};
// i18n-table: 1 – [German, English] pairs
const ALTERNATIVES = {
  both: ["Bis dahin kannst du einen eigenen KI-Anbieter (Einstellungen → KI) oder die KI auf dem Gerät nutzen.", "Until then you can use your own AI provider (Settings → AI) or on-device AI."],
  own: ["Bis dahin kannst du einen eigenen KI-Anbieter nutzen (Einstellungen → KI).", "Until then you can use your own AI provider (Settings → AI)."],
  device: ["Bis dahin kannst du die KI auf dem Gerät nutzen.", "Until then you can use on-device AI."],
} as const;

// A refused request: the period that is used up and when it resets.
export class AiQuotaError extends HttpError {
  constructor(
    message: string,
    public quota: { level: "person" | "instance"; period: QuotaPeriod; resetAt: number },
  ) {
    super(429, message);
  }
}
export function quotaMessage(state: Pick<QuotaPeriodState, "level" | "period" | "used" | "limit" | "resetAt">, settings: Pick<QuotaSettings, "timeZone">, alternatives: { own: boolean; device: boolean }) {
  const [de, en] = HEADS[`${state.level}.${state.period}.${state.used >= state.limit ? "used" : "cross"}`];
  let when = new Date(state.resetAt).toISOString();
  try {
    when = new Intl.DateTimeFormat(localeTag(contentLocale()), { dateStyle: "medium", timeStyle: "short", timeZone: settings.timeZone }).format(state.resetAt);
  } catch {}
  const alt = alternatives.own && alternatives.device ? ALTERNATIVES.both : alternatives.own ? ALTERNATIVES.own : alternatives.device ? ALTERNATIVES.device : null;
  return [ct(de, en), ct(`Es gilt wieder ab ${when}.`, `It is available again from ${when}.`), alt ? ct(alt[0], alt[1]) : ""].filter(Boolean).join(" ");
}

// The continuation's limit is used up too: AI is off until `resetAt`.
export function afterQuotaMessage(period: QuotaPeriod, model: string, resetAt: number, settings: Pick<QuotaSettings, "timeZone">, alternatives: { own: boolean; device: boolean }) {
  let when = new Date(resetAt).toISOString();
  try {
    when = new Intl.DateTimeFormat(localeTag(contentLocale()), { dateStyle: "medium", timeStyle: "short", timeZone: settings.timeZone }).format(resetAt);
  } catch {}
  const head =
    period === "day"
      ? ct(`Dein KI-Kontingent und die Fortsetzung mit ${model} sind für heute aufgebraucht.`, `Your AI quota and the continuation with ${model} are used up for today.`)
      : period === "week"
        ? ct(`Dein KI-Kontingent und die Fortsetzung mit ${model} sind für diese Woche aufgebraucht.`, `Your AI quota and the continuation with ${model} are used up for this week.`)
        : period === "year"
          ? ct(`Dein KI-Kontingent und die Fortsetzung mit ${model} sind für dieses Jahr aufgebraucht.`, `Your AI quota and the continuation with ${model} are used up for this year.`)
          : ct(`Dein KI-Kontingent und die Fortsetzung mit ${model} sind für diesen Monat aufgebraucht.`, `Your AI quota and the continuation with ${model} are used up for this month.`);
  const alt = alternatives.own && alternatives.device ? ALTERNATIVES.both : alternatives.own ? ALTERNATIVES.own : alternatives.device ? ALTERNATIVES.device : null;
  return [head, ct(`KI ist aus bis ${when}.`, `AI is off until ${when}.`), alt ? ct(alt[0], alt[1]) : ""].filter(Boolean).join(" ");
}

/* ---------- Checking before a request ---------- */

// What a request may do: `release` frees its reservation (call it once the
// usage is recorded); `model`, when set, is the model to send it with
// instead – the person's limit is used up and a rule says to go on with it
// (its usage is recorded with `after: true`).
export type QuotaGrant = { release: () => void; model: string | null };
const free: QuotaGrant = { release: () => {}, model: null };
// Refuses the request when it would cross a limit; else reserves its
// estimate until `release`.
export async function requireQuota(
  user: Pick<Identity, "id" | "isAdmin">,
  input: { feature: string; model: string; tokensIn: number; tokensOut: number },
  now = Date.now(),
): Promise<QuotaGrant> {
  const settings = await quotaSettings();
  const rules = await quotaRules(settings.unit);
  if (!rules.length) return free;
  const workflow = input.feature === "workflows";
  const instance = instanceLimits(rules);
  const checkInstance = hasLimit(instance) && (!workflow || settings.workflowsCountInstance);
  const ai = await instanceAiSettings();
  const personal = workflow ? null : personalLimits(rules, await quotaPerson(user), ai.prices);
  const checkPerson = !!personal && hasLimit(personal.limits);
  if (!checkInstance && !checkPerson) return free;
  const cost = (model: string) => (settings.unit === "tokens" ? input.tokensIn + input.tokensOut : (costOf(ai.prices, model, input.tokensIn, input.tokensOut) ?? 0));
  const estimate = cost(input.model);
  const keys: string[] = [];
  const states: QuotaPeriodState[] = [];
  if (checkPerson) {
    keys.push(`user:${user.id}`);
    states.push(...(await periodStates("person", personal!.limits!, settings, ai.prices, { userId: user.id }, now)).map((s) => ({ ...s, used: s.used + (reserved.get(`user:${user.id}`) || 0) })));
  }
  if (checkInstance) {
    keys.push("instance");
    states.push(...(await periodStates("instance", instance!, settings, ai.prices, { instance: true, workflows: settings.workflowsCountInstance }, now)).map((s) => ({ ...s, used: s.used + (reserved.get("instance") || 0) })));
  }
  // The instance's ceiling first: when both are used up, it is the one that
  // says when AI works again for everyone.
  let refused = states.sort((a, b) => (a.level === b.level ? 0 : a.level === "instance" ? -1 : 1)).find((s) => s.used >= s.limit || s.used + estimate > s.limit);
  // The person's limit is used up, a rule says to go on with another model:
  // only the instance ceiling is checked, with that model's estimate.
  const after = refused?.level === "person" ? activeAfter(personal, ai.provider ? { kind: ai.provider.kind, model: ai.provider.model } : null) : null;
  if (after) {
    const afterEstimate = cost(after);
    const personRefusal = refused!;
    refused = states.find((s) => s.level === "instance" && (s.used >= s.limit || s.used + afterEstimate > s.limit));
    // The continuation's own limit (after the instance: that one says when
    // AI works again for everyone).
    const afterKey = `after:${user.id}`;
    const limited = !refused && hasLimit(personal!.afterLimits);
    if (limited) {
      const spent = (await periodStates("person", personal!.afterLimits!, settings, ai.prices, { afterOf: user.id }, now))
        .map((s) => ({ ...s, used: s.used + (reserved.get(afterKey) || 0) }))
        .find((s) => s.used >= s.limit || s.used + afterEstimate > s.limit);
      if (spent) {
        // AI is back when either the quota or the continuation resets.
        const resetAt = Math.min(spent.resetAt, personRefusal.resetAt);
        throw new AiQuotaError(afterQuotaMessage(spent.period, after, resetAt, settings, { own: ai.userProviders, device: ai.device }), { level: "person", period: spent.period, resetAt });
      }
    }
    if (!refused) return { release: reserve([...(checkInstance ? ["instance"] : []), ...(limited ? [afterKey] : [])], afterEstimate), model: after };
  }
  if (refused) {
    const own = ai.userProviders;
    throw new AiQuotaError(quotaMessage(refused, settings, { own, device: ai.device }), { level: refused.level, period: refused.period, resetAt: refused.resetAt });
  }
  return { release: reserve(keys, estimate), model: null };
}

// The search index (embeddings, lib/ai/providers.ts): only the instance
// ceiling – it belongs to nobody.
export async function requireInstanceQuota(input: { model: string; tokensIn: number }, now = Date.now()): Promise<() => void> {
  const settings = await quotaSettings();
  const limits = instanceLimits(await quotaRules(settings.unit));
  if (!hasLimit(limits)) return () => {};
  const ai = await instanceAiSettings();
  const estimate = settings.unit === "tokens" ? input.tokensIn : (costOf(ai.prices, input.model, input.tokensIn, 0) ?? 0);
  const states = await periodStates("instance", limits!, settings, ai.prices, { instance: true, workflows: settings.workflowsCountInstance }, now);
  const refused = states.find((s) => s.used + (reserved.get("instance") || 0) >= s.limit || s.used + (reserved.get("instance") || 0) + estimate > s.limit);
  if (refused) throw new AiQuotaError(quotaMessage(refused, settings, { own: false, device: false }), { level: "instance", period: refused.period, resetAt: refused.resetAt });
  return reserve(["instance"], estimate);
}

/* ---------- What people see ---------- */

export async function quotaStatus(user: Pick<Identity, "id" | "isAdmin">, source: "instance" | "user" | null, now = Date.now()): Promise<QuotaStatus> {
  const settings = await quotaSettings();
  const ai = await instanceAiSettings();
  const base: QuotaStatus = { applies: false, unit: settings.unit, currency: ai.currency, warnAt: settings.warnAt, timeZone: settings.timeZone, exempt: false, periods: [], low: false, blocked: false };
  const rules = await quotaRules(settings.unit);
  if (!rules.length || source !== "instance") return base;
  const personal = personalLimits(rules, await quotaPerson(user), ai.prices);
  const after = activeAfter(personal, ai.provider ? { kind: ai.provider.kind, model: ai.provider.model } : null);
  const periods = [
    ...(hasLimit(personal.limits) ? await periodStates("person", personal.limits!, settings, ai.prices, { userId: user.id }, now) : []),
    ...(hasLimit(instanceLimits(rules)) ? await periodStates("instance", instanceLimits(rules)!, settings, ai.prices, { instance: true, workflows: settings.workflowsCountInstance }, now) : []),
  ];
  // The continuation and its own limit.
  let afterStatus: QuotaAfterStatus | null = null;
  if (after) {
    const states = hasLimit(personal.afterLimits) ? await periodStates("person", personal.afterLimits!, settings, ai.prices, { afterOf: user.id }, now) : [];
    const tight = tightest(states);
    const used = tight ? tight.used : amountOf(await usageSince(periodBounds("month", now, settings.timeZone, settings.weekStart).start, { afterOf: user.id }), settings.unit, ai.prices);
    afterStatus = { model: after, limit: tight?.limit ?? null, used, left: tight?.left ?? null, period: tight?.period ?? null, resetAt: tight?.resetAt ?? null, periods: states };
  }
  // A personal period that is used up only stops AI when there is no
  // continuation, or when the continuation's limit is used up as well.
  const personSpent = periods.some((p) => p.level === "person" && p.used >= p.limit);
  const afterSpent = !!afterStatus?.periods.some((p) => p.used >= p.limit);
  const afterLow = !!afterStatus?.periods.some((p) => p.limit <= 0 || p.used / p.limit >= settings.warnAt / 100);
  return {
    ...base,
    applies: periods.length > 0,
    exempt: personal.exempt,
    periods,
    low: periods.some((p) => (p.level === "instance" || !after) && (p.limit <= 0 || p.used / p.limit >= settings.warnAt / 100)) || (personSpent && afterLow),
    blocked: periods.some((p) => (p.level === "instance" || !after) && p.used >= p.limit) || (personSpent && afterSpent),
    after: afterStatus,
  };
}

/* ---------- Notifications for administrators ---------- */

// Stored in German like every notification; lib/i18n-errors.ts has the
// other languages.
const PERIOD_WORDS: Record<QuotaPeriod, string> = { day: "heute", week: "diese Woche", month: "diesen Monat", year: "dieses Jahr" };
export const instanceAlertText = (period: QuotaPeriod, level: number, resetDay: string) =>
  level >= 100
    ? `Das KI-Kontingent der Instanz für ${PERIOD_WORDS[period]} ist aufgebraucht – bis ${resetDay} ist KI über den Anbieter der Instanz gesperrt.`
    : `Das KI-Kontingent der Instanz für ${PERIOD_WORDS[period]} ist zu ${level} % verbraucht.`;

// Once per period and level (warnAt, then 100 %) – across instances too:
// the row only moves up.
async function alertInstance(settings: QuotaSettings, now: number) {
  const rules = await quotaRules(settings.unit);
  const limits = instanceLimits(rules);
  if (!hasLimit(limits)) return;
  const ai = await instanceAiSettings();
  for (const state of await periodStates("instance", limits!, settings, ai.prices, { instance: true, workflows: settings.workflowsCountInstance }, now)) {
    const share = state.limit > 0 ? state.used / state.limit : 1;
    const level = share >= 1 ? 100 : share >= settings.warnAt / 100 ? settings.warnAt : 0;
    if (!level) continue;
    const { start, end } = periodBounds(state.period, now, settings.timeZone, settings.weekStart);
    const key = `${state.period}:${start}`;
    const moved = await run("INSERT INTO ai_quota_alerts(period_key,level,at) VALUES(?,?,?) ON CONFLICT(period_key) DO UPDATE SET level=excluded.level,at=excluded.at WHERE ai_quota_alerts.level<excluded.level", key, level, now);
    if (!moved.changes) continue;
    const { adminUserIds } = await import("../auth");
    const { id } = await import("../db");
    for (const admin of await adminUserIds())
      await run("INSERT INTO notifications(id,user_id,body,kind,link) VALUES(?,?,?,'ai_quota',?)", id(), admin, instanceAlertText(state.period, level, end), "#settings/instance/ai/quotas");
    try {
      const { dispatchPush } = await import("../push");
      await dispatchPush();
    } catch {}
  }
  // Old periods' rows go.
  await run("DELETE FROM ai_quota_alerts WHERE at<?", now - QUOTA_KEEP_DAYS * DAY);
}

/* ---------- Accounts that go ---------- */

// A deleted or merged account (lib/metrics.ts forgetAiPerson): its usage
// stays in the instance's totals without a person; its own rule goes.
export async function forgetQuotaPerson(userId: string) {
  await run(
    "INSERT INTO ai_quota_usage(day,user_id,model,kind,requests,tokens_in,tokens_out) SELECT day,'',model,kind,requests,tokens_in,tokens_out FROM ai_quota_usage WHERE user_id=? ON CONFLICT(day,user_id,model,kind) DO UPDATE SET requests=ai_quota_usage.requests+excluded.requests,tokens_in=ai_quota_usage.tokens_in+excluded.tokens_in,tokens_out=ai_quota_usage.tokens_out+excluded.tokens_out",
    userId,
  );
  await run("DELETE FROM ai_quota_usage WHERE user_id=?", userId);
  await run("DELETE FROM ai_quota_after_usage WHERE user_id=?", userId);
  await run("DELETE FROM ai_quota_rules WHERE scope='user' AND target=?", userId);
  await run("DELETE FROM ai_model_rules WHERE scope='user' AND target=?", userId);
}

/* ---------- Administration ---------- */

// A model to go on with after the quota (null: AI stops).
export const afterSchema = z.string().trim().max(200).regex(/^[\w.\-:/@]+$/, "Ungültiger Modellname.").nullable().optional();
// The models of the instance's provider to choose from: its default, the
// price list and the models of the model rules for this provider kind.
export async function instanceModelOptions(kind: string | null, ruleModels?: { kind: string; model: string }[]) {
  const ai = await instanceAiSettings();
  const rules = ruleModels ?? (await all<{ kind: string; model: string }>("SELECT kind,model FROM ai_model_rules"));
  const list = [ai.provider?.model || "", ...ai.prices.map((p) => p.model), ...rules.filter((r) => r.kind === kind).map((r) => r.model)];
  return [...new Set(list.map((m) => m.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
// The model after the quota as stored: one of the options, with the kind.
export async function checkedAfter(model: string | null | undefined): Promise<QuotaAfter | null> {
  if (!model) return null;
  const provider = (await instanceAiSettings()).provider;
  if (!provider?.model.trim()) throw new HttpError(409, "Bitte zuerst einen KI-Anbieter der Instanz einrichten (Einstellungen → Instanz → KI).");
  if (!(await instanceModelOptions(provider.kind)).includes(model)) throw new HttpError(400, "Dieses Modell ist für die Instanz nicht vorgesehen.");
  return { model, kind: provider.kind };
}
const saveInput = z.object({
  settings: quotaSettingsSchema.partial().optional(),
  rules: z
    .array(z.object({ scope: z.enum(QUOTA_SCOPES), target: z.string().trim().max(210).default(""), exempt: z.boolean().default(false), limits: limitsSchema.default({}), after: afterSchema, afterLimits: limitsSchema.nullable().optional() }))
    .max(5000)
    .optional(),
});
export async function saveQuotaConfig(user: Identity, raw: unknown) {
  requireAdmin(user);
  const b = saveInput.parse(raw);
  const current = await quotaSettings();
  const next: QuotaSettings = { ...current, ...Object.fromEntries(Object.entries(b.settings || {}).filter(([, v]) => v !== undefined)) };
  const ai = await instanceAiSettings();
  if (next.unit === "cost" && !ai.prices.length) throw new HttpError(400, "Kostengrenzen brauchen Preise je Modell (Einstellungen → Instanz → KI → Preise).");
  let rules = b.rules ?? null;
  // Another unit: numbers of the old one mean nothing – limits start empty
  // (exemptions stay), unless new rules come along.
  if (next.unit !== current.unit && !rules) rules = (await quotaRules(current.unit)).map((r) => ({ ...r, limits: {} }));
  const afters = new Map<string, QuotaAfter | null>();
  if (rules) {
    const seen = new Set<string>();
    for (const r of rules) {
      if (r.scope === "instance" || r.scope === "default") {
        r.target = "";
        r.exempt = false;
      }
      if (r.scope === "instance" || r.exempt) r.after = null;
      if (r.scope === "role" && !(QUOTA_ROLES as readonly string[]).includes(r.target)) throw new HttpError(400, "Unbekannte Rolle.");
      if (r.scope === "group" && !(await validGroupKey(r.target))) throw new HttpError(404, "Gruppe nicht gefunden.");
      if (r.scope === "user" && !(await one("SELECT 1 FROM users WHERE id=?", r.target))) throw new HttpError(404, "Benutzer nicht gefunden.");
      const key = `${r.scope}|${r.target}`;
      if (seen.has(key)) throw new HttpError(400, "Eine Grenze ist doppelt eingetragen.");
      seen.add(key);
      afters.set(key, await checkedAfter(r.after));
    }
  }
  await run("INSERT INTO instance_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", SETTING_KEY, JSON.stringify(next));
  if (rules) {
    await run("DELETE FROM ai_quota_rules");
    for (const r of rules) {
      const limits = cleanLimits(r.limits, next.unit);
      // Nothing to say: no row (instance and default without numbers).
      if (!r.exempt && !hasLimit(limits) && (r.scope === "instance" || r.scope === "default")) continue;
      const after = afters.get(`${r.scope}|${r.target}`) ?? null;
      // Only with a model to go on with; after a unit change it starts
      // empty (unless the rules came along in the new unit).
      const afterLimits = after && (next.unit === current.unit || b.rules) ? cleanLimits(r.afterLimits ?? {}, next.unit) : {};
      await run(
        "INSERT INTO ai_quota_rules(scope,target,exempt,limits,after_model,after_kind,after_limits,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        r.scope,
        r.target,
        r.exempt ? 1 : 0,
        JSON.stringify(limits),
        after?.model ?? null,
        after?.kind ?? null,
        hasLimit(afterLimits) ? JSON.stringify(afterLimits) : null,
        Date.now(),
      );
    }
  }
  const { audit } = await import("../db");
  await audit(user.id, "admin.aiQuotas", "instance", JSON.stringify({ unit: next.unit, rules: rules ? rules.length : undefined }));
  return await adminQuotaView();
}

type PersonRow = { id: string; name: string; email: string };
// Administration → KI → Kontingente: settings, rules, and the usage of the
// chosen period per person (with their limits), group and model.
export async function adminQuotaView(period: QuotaPeriod = "month", now = Date.now()) {
  const settings = await quotaSettings();
  const ai = await instanceAiSettings();
  const rules = await quotaRules(settings.unit);
  const { start, end, resetAt } = periodBounds(period, now, settings.timeZone, settings.weekStart);
  const rows = await all<UsageRow>(
    "SELECT day,model,kind,user_id,SUM(tokens_in) tokens_in,SUM(tokens_out) tokens_out FROM ai_quota_usage WHERE day>=? AND day<? GROUP BY day,model,kind,user_id",
    start,
    end,
  );
  const people = await all<PersonRow>("SELECT id,name,email FROM users WHERE disabled=0 AND demo_until IS NULL AND subject NOT LIKE 'deleted:%' ORDER BY name LIMIT 5000");
  const { adminUserIds } = await import("../auth");
  const admins = new Set(await adminUserIds());
  const groupsOf = await allGroupKeys();
  const full = new Set((await all<{ user_id: string }>("SELECT DISTINCT m.user_id FROM members m WHERE NOT EXISTS (SELECT 1 FROM workspace_guests g WHERE g.workspace_id=m.workspace_id AND g.user_id=m.user_id)")).map((r) => r.user_id));
  const groups = await groupChoices(rules.filter((r) => r.scope === "group").map((r) => r.target));
  const membersOf = new Map<string, string[]>();
  for (const [userId, keys] of groupsOf) for (const key of keys) membersOf.set(key, [...(membersOf.get(key) || []), userId]);
  const personal = rows.filter((r) => r.kind === "person");
  const usedBy = new Map<string, typeof rows>();
  for (const r of personal) usedBy.set(r.user_id, [...(usedBy.get(r.user_id) || []), r]);
  const tokens = (list: UsageRow[]) => list.reduce((n, r) => n + Number(r.tokens_in) + Number(r.tokens_out), 0);
  const priced = (list: UsageRow[]) => (ai.prices.length ? amountOf(list, "cost", ai.prices) : null);
  const personView = people.map((p) => {
    const roles: QuotaRole[] = [...(admins.has(p.id) ? (["admin"] as const) : []), ...(!full.has(p.id) ? (["guest"] as const) : [])];
    const limits = personalLimits(rules, { userId: p.id, roles, groups: groupsOf.get(p.id) || [] }, ai.prices);
    const mine = usedBy.get(p.id) || [];
    return { ...p, groups: groupsOf.get(p.id) || [], roles, limits: limits.limits, exempt: limits.exempt, source: limits.source, after: activeAfter(limits, ai.provider ? { kind: ai.provider.kind, model: ai.provider.model } : null), used: amountOf(mine, settings.unit, ai.prices), tokens: tokens(mine), cost: priced(mine), limit: limits.limits?.[period] ?? null };
  });
  const instanceRows = rows.filter((r) => r.kind !== "workflow" || settings.workflowsCountInstance);
  const models = new Map<string, UsageRow[]>();
  for (const r of rows) models.set(r.model, [...(models.get(r.model) || []), r]);
  const usedModels = [...models.keys()].filter(Boolean);
  // The model per person, group and role (lib/ai/model-policy.ts) beside the limits.
  const { quotaModelView } = await import("./admin-rule");
  const model = await quotaModelView(personView);
  return {
    model: { provider: model.provider, rules: model.modelRules, options: model.modelOptions, ranges: model.modelRanges },
    settings,
    currency: ai.currency,
    priced: ai.prices.length > 0,
    // Used models without a price: they count 0 towards cost limits.
    missingPrices: settings.unit === "cost" ? usedModels.filter((m) => costOf(ai.prices, m, 0, 0) === null) : [],
    rules,
    period,
    start,
    resetAt,
    instance: { limit: instanceLimits(rules)?.[period] ?? null, used: amountOf(instanceRows, settings.unit, ai.prices), tokens: tokens(instanceRows), cost: priced(instanceRows) },
    workflows: { tokens: tokens(rows.filter((r) => r.kind === "workflow")) },
    people: personView.map((p) => ({ ...p, model: model.effective.get(p.id) ?? null })),
    groups: groups.map((g) => {
      const members = new Set(membersOf.get(g.id) || []);
      const list = personal.filter((r) => members.has(r.user_id));
      return { ...g, members: Math.max(members.size, g.members), used: amountOf(list, settings.unit, ai.prices), tokens: tokens(list), cost: priced(list) };
    }),
    models: [...models].map(([model, list]) => ({ model, used: amountOf(list, settings.unit, ai.prices), tokens: tokens(list), cost: priced(list), priced: costOf(ai.prices, model, 0, 0) !== null })),
  };
}
export type AdminQuotaView = Awaited<ReturnType<typeof adminQuotaView>>;
// GET /api/ai/admin/quotas: administrators only.
export async function adminQuotas(user: Identity, period: QuotaPeriod) {
  requireAdmin(user);
  return await adminQuotaView(period);
}
