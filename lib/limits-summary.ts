// Settings → Speicher & KI: the tile's summary, the page's figures and the
// notice at 80 % and 100 % (components/settings/user/usage.tsx,
// components/limits-notice.tsx). Pure – the bootstrap's `myLimits`, its
// `ai` status and GET /api/ai/quota in, texts and shares out – so the tests
// can call it.
//
// Storage: 0 MB = unlimited (lib/user-limits.ts). AI: the person's quota
// (lib/ai/quota.ts) through the instance's provider; the instance's ceiling
// only shows where it bites. No AI on the instance: no AI figure at all.
import type { Bootstrap } from "./types";
import type { AiStatus } from "./ai/features";
import { quotaShare, type QuotaPeriod, type QuotaPeriodState, type QuotaStatus } from "./ai/quota-shared";
import { storageSizeText } from "./limit-explain";

export type T = (de: string, en: string) => string;

// The page's address.
export const USAGE_LINK = "#settings/usage";
// The instance's AI could have a quota for this person: only then is
// GET /api/ai/quota asked.
export const quotaPossible = (ai: AiStatus | null | undefined, demo: boolean) => !demo && !!ai?.enabled && ai.provider?.source === "instance";
export type MyLimits = NonNullable<Bootstrap["myLimits"]>;

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Bytes in the unit of `scale` (GB from 1 GB on, else MB), one decimal
// below ten, e.g. "4,2" for 4.2 GB.
function amount(bytes: number, unit: "GB" | "MB", tag: string) {
  const n = bytes / (unit === "GB" ? GB : MB);
  return n.toLocaleString(tag, { maximumFractionDigits: n < 10 ? 1 : 0 });
}
const unitFor = (bytes: number): "GB" | "MB" => (bytes >= GB ? "GB" : "MB");

// "4,2 von 25 GB", "350 MB von 2 GB", unlimited "4,2 GB · unbegrenzt".
export function storageText(usedBytes: number, limitMb: number, t: T, tag: string) {
  if (!limitMb) {
    const unit = unitFor(usedBytes);
    return t(`${amount(usedBytes, unit, tag)} ${unit} · unbegrenzt`, `${amount(usedBytes, unit, tag)} ${unit} · unlimited`);
  }
  const limit = storageSizeText(limitMb, tag);
  const limitUnit = limit.endsWith(" GB") ? "GB" : "MB";
  // A little in a large limit: "3 MB von 25 GB" rather than "0 von 25 GB".
  const usedUnit = limitUnit === "GB" && usedBytes < GB / 10 ? "MB" : limitUnit;
  if (usedUnit === limitUnit) {
    // The unit once: "4,2 von 25 GB".
    const bare = limit.slice(0, -3);
    return t(`${amount(usedBytes, usedUnit, tag)} von ${bare} ${limitUnit}`, `${amount(usedBytes, usedUnit, tag)} of ${bare} ${limitUnit}`);
  }
  return t(`${amount(usedBytes, usedUnit, tag)} ${usedUnit} von ${limit}`, `${amount(usedBytes, usedUnit, tag)} ${usedUnit} of ${limit}`);
}

// Where the storage comes from, short: the group (several with add-ons),
// "Standard" or "Für dich festgelegt".
export function storageSource(limits: Pick<MyLimits, "admin" | "sources" | "groupNames">, t: T) {
  if (limits.admin) return t("Administrator", "Administrator");
  const source = limits.sources?.storageMb;
  const name = (group: string | null) => (group && limits.groupNames?.[group]) || t("eine deiner Gruppen", "one of your groups");
  const base = !source || source.from === "default" ? t("Standard", "Default") : source.from === "user" ? t("Für dich festgelegt", "Set for you") : name(source.group);
  return [base, ...(source?.addons || []).map((a) => name(a.group))].join(" + ");
}

export type Level = 0 | 80 | 100;
// The notice's thresholds: 80 % (or the quota's warning threshold) and 100 %.
export function levelOf(share: number | null, warnAt = 80): Level {
  if (share === null) return 0;
  if (share >= 1) return 100;
  return share >= warnAt / 100 ? 80 : 0;
}

export type StorageSummary = { text: string; share: number | null; source: string; level: Level };
export function storageSummary(limits: MyLimits, t: T, tag: string): StorageSummary {
  const share = limits.storageMb > 0 ? Math.min(1, limits.usedBytes / (limits.storageMb * MB)) : null;
  return { text: storageText(limits.usedBytes, limits.storageMb, t, tag), share, source: storageSource(limits, t), level: levelOf(share) };
}

// i18n-table: 1 – [German, English] pairs, lower case for inside a sentence.
const PERIOD_PHRASES: Record<QuotaPeriod, readonly [string, string]> = {
  day: ["heute", "today"],
  week: ["diese Woche", "this week"],
  month: ["diesen Monat", "this month"],
  year: ["dieses Jahr", "this year"],
};
export const periodPhrase = (period: QuotaPeriod, t: T) => t(PERIOD_PHRASES[period][0], PERIOD_PHRASES[period][1]);

export function quotaAmount(n: number, s: Pick<QuotaStatus, "unit" | "currency">, tag: string) {
  if (s.unit === "cost") return n.toLocaleString(tag, { style: "currency", currency: s.currency || "EUR", maximumFractionDigits: 2 });
  return new Intl.NumberFormat(tag, { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

// The person's own period that is closest to its limit (the instance's
// ceiling is not theirs).
export function personalPeriod(status: QuotaStatus | null): QuotaPeriodState | null {
  let best: QuotaPeriodState | null = null;
  for (const p of status?.periods || []) if (p.level === "person" && (!best || quotaShare(p) > quotaShare(best))) best = p;
  return best;
}
// The instance's ceiling, only once it bites (past the warning threshold).
export function instanceCeiling(status: QuotaStatus | null): QuotaPeriodState | null {
  let best: QuotaPeriodState | null = null;
  for (const p of status?.periods || []) if (p.level === "instance" && quotaShare(p) >= (status!.warnAt || 80) / 100 && (!best || quotaShare(p) > quotaShare(best))) best = p;
  return best;
}

// none: the instance has no AI (no figure); off: AI is off for the person;
// own: the person's own provider (no quota); unlimited: no personal limit;
// quota: a personal limit with a bar.
export type AiState = "none" | "off" | "own" | "unlimited" | "quota";
const INSTANCE_REASONS = new Set(["off", "no-provider", "demo", "api-token", "unknown-feature", "feature-off"]);
export function aiState(ai: AiStatus | null | undefined, status: QuotaStatus | null): AiState {
  if (!ai) return "none";
  if (!ai.enabled) {
    const reasons = Object.values(ai.features || {}).map((f) => f.reason || "");
    return reasons.length && reasons.every((r) => INSTANCE_REASONS.has(r)) ? "none" : "off";
  }
  if (ai.provider?.source === "user") return "own";
  if (status?.exempt || !personalPeriod(status)) return "unlimited";
  return "quota";
}

export type AiSummary = { state: AiState; text: string; share: number | null; level: Level; period: QuotaPeriodState | null };
export function aiSummary(ai: AiStatus | null | undefined, status: QuotaStatus | null, t: T, tag: string): AiSummary {
  const state = aiState(ai, status);
  const p = state === "quota" ? personalPeriod(status) : null;
  if (!p || !status) {
    const text = state === "off" ? t("KI aus", "AI off") : state === "own" ? t("Eigener Anbieter · unbegrenzt", "Own provider · unlimited") : state === "unlimited" ? t("unbegrenzt", "unlimited") : "";
    return { state, text, share: null, level: 0, period: null };
  }
  const share = quotaShare(p);
  const used = quotaAmount(Math.min(p.used, p.limit), status, tag);
  const limit = quotaAmount(p.limit, status, tag);
  const when = periodPhrase(p.period, t);
  const text = status.unit === "tokens" ? t(`${used} von ${limit} Tokens ${when}`, `${used} of ${limit} tokens ${when}`) : t(`${used} von ${limit} ${when}`, `${used} of ${limit} ${when}`);
  return { state, text, share, level: levelOf(share, status.warnAt || 80), period: p };
}

// ---------------------------------------------------------------- notices

// What the person closed, per device and account: the storage level, and
// the AI level of one period (its key: period and end).
export type NoticeMemory = { storage?: Level; ai?: { key: string; level: Level } };
export type NoticeKind = "storage" | "ai";
// ai: the personal period now (level 0 below the threshold); null: no
// personal quota; undefined: not known yet (still loading) – kept as it is.
export type NoticeInput = { storage: Level; ai?: { level: Level; key: string } | null };

export const aiPeriodKey = (p: Pick<QuotaPeriodState, "period" | "resetAt">) => `${p.period}:${p.resetAt}`;

// Which notices show, and the memory to keep. Storage: a closed level stays
// closed until the usage drops below it (then it may come again); a higher
// level (100 % after 80 %) shows again. AI: a closed level stays closed for
// its period; the next period starts afresh.
export function limitNotices(now: NoticeInput, memory: NoticeMemory): { show: NoticeKind[]; memory: NoticeMemory } {
  const next: NoticeMemory = { ...memory };
  if (next.storage && now.storage < next.storage) next.storage = now.storage || undefined;
  if (!next.storage) delete next.storage;
  if (next.ai && now.ai !== undefined && (!now.ai || next.ai.key !== now.ai.key)) delete next.ai;
  const show: NoticeKind[] = [];
  if (now.storage > (next.storage || 0)) show.push("storage");
  if (now.ai && now.ai.level > (next.ai?.level || 0)) show.push("ai");
  return { show, memory: next };
}
export function dismissNotice(now: NoticeInput, memory: NoticeMemory, kind: NoticeKind): NoticeMemory {
  const next = limitNotices(now, memory).memory;
  if (kind === "storage") return now.storage ? { ...next, storage: now.storage } : next;
  return now.ai?.level ? { ...next, ai: { key: now.ai.key, level: now.ai.level } } : next;
}
export function parseNoticeMemory(raw: string | null): NoticeMemory {
  try {
    const v = JSON.parse(raw || "{}") as NoticeMemory;
    const level = (l: unknown): Level | undefined => (l === 80 || l === 100 ? l : undefined);
    const out: NoticeMemory = {};
    if (level(v.storage)) out.storage = level(v.storage);
    if (v.ai && typeof v.ai.key === "string" && level(v.ai.level)) out.ai = { key: v.ai.key, level: level(v.ai.level)! };
    return out;
  } catch {
    return {};
  }
}
