"use client";
// What is left of the AI quota (#382, lib/ai/quota.ts): the small note in
// the AI panels once less than the warning threshold is left, and the data
// for the bars under Settings → KI (components/ai-quota-bars.tsx). Both read
// GET /api/ai/quota, remembered for a minute: opening panels costs one
// request at most.
import { useEffect, useState } from "react";
import { Gauge } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { tightest, type QuotaPeriod, type QuotaPeriodState, type QuotaStatus } from "@/lib/ai/quota-shared";

export type T = (de: string, en: string) => string;
const TTL = 60_000;
let cached: { at: number; value: Promise<QuotaStatus | null> } | null = null;
const listeners = new Set<() => void>();
function load(force = false): Promise<QuotaStatus | null> {
  if (!force && cached && Date.now() - cached.at < TTL) return cached.value;
  const value = api<QuotaStatus>("/api/ai/quota").catch(() => null);
  cached = { at: Date.now(), value };
  return value;
}
// After an AI request the numbers changed: the next look asks again.
export function refreshAiQuota() {
  cached = null;
  for (const l of listeners) l();
}
export function useAiQuota(): QuotaStatus | null {
  const [status, setStatus] = useState<QuotaStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => void load().then((s) => alive && setStatus(s));
    read();
    listeners.add(read);
    return () => {
      alive = false;
      listeners.delete(read);
    };
  }, []);
  return status;
}

export function formatQuotaAmount(n: number, s: Pick<QuotaStatus, "unit" | "currency">) {
  if (s.unit === "cost") return n.toLocaleString(LOCALE_TAG, { style: "currency", currency: s.currency || "EUR", maximumFractionDigits: 2 });
  return new Intl.NumberFormat(LOCALE_TAG, { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}
export const resetText = (p: QuotaPeriodState, zone: string) => {
  try {
    return new Intl.DateTimeFormat(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(p.resetAt);
  } catch {
    return new Date(p.resetAt).toLocaleString(LOCALE_TAG);
  }
};
// i18n-table: 1 – [German, English] pairs
export const PERIOD_NAMES: Record<QuotaPeriod, readonly [string, string]> = {
  day: ["Heute", "Today"],
  week: ["Diese Woche", "This week"],
  month: ["Diesen Monat", "This month"],
  year: ["Dieses Jahr", "This year"],
};
export const periodLabel = (p: QuotaPeriodState, t: T) => {
  const name = t(PERIOD_NAMES[p.period][0], PERIOD_NAMES[p.period][1]);
  return p.level === "instance" ? t(`${name} · ganze Instanz`, `${name} · whole instance`) : name;
};

// The note in the AI panels: only once little or nothing is left.
export function AiQuotaNote() {
  const t = useT();
  const s = useAiQuota();
  if (!s?.applies || !s.low) return null;
  // With a model to go on with, only the instance's ceiling warns.
  const p = tightest(s.after ? s.periods.filter((x) => x.level === "instance") : s.periods);
  if (!p) return null;
  const name = t(PERIOD_NAMES[p.period][0], PERIOD_NAMES[p.period][1]);
  const left = p.limit > 0 ? Math.max(0, Math.round((p.left / p.limit) * 100)) : 0;
  return (
    <p className={`ai-quota-note${p.used >= p.limit ? " full" : ""}`} role="status">
      <Gauge size={14} aria-hidden="true" />
      <span>
        {p.used >= p.limit
          ? t(`KI-Kontingent aufgebraucht (${name}) – wieder ab ${resetText(p, s.timeZone)}.`, `AI quota used up (${name}) – available again from ${resetText(p, s.timeZone)}.`)
          : t(`Noch ${left} % des KI-Kontingents übrig (${name}).`, `${left} % of the AI quota left (${name}).`)}
      </span>
    </p>
  );
}
