"use client";
// Administration → KI → Statistik (#admin/ai/ai-statistics): AI use per day,
// model (with the estimated cost from the prices in the AI settings),
// feature, workspace and person – requests, tokens, errors, timeouts and
// response times. Counts only, never a prompt or an answer; the
// per-person table is part of the administration only
// (/api/admin/monitoring?view=ai).
import { useState, type ReactNode } from "react";
import { Sparkle } from "@phosphor-icons/react";
import type { AiStatistics } from "@/lib/ai-statistics";
import { AI_FEATURES } from "@/lib/ai/features";
import { useT } from "../../i18n";
import { BarChart, Legend } from "../../charts";
import { EmptyState, ResponsiveTable, SettingGroup } from "../../settings-ui";
import { Select } from "../../select";
import { Kpi } from "./live";
import { useLive } from "./use-live";
import { compact, longDay, ms, num, percent, shortDay } from "./monitoring-format";

type T = (de: string, en: string) => string;
type Row = { requests: number; tokensIn: number; tokensOut: number; errors: number; timeouts: number; avgMs: number | null; p95: number | null; cost: number | null };

const featureName = (id: string, t: T) => {
  if (id === "embeddings") return t("Suchindex (Embeddings)", "Search index (embeddings)");
  const f = AI_FEATURES.find((x) => x.id === id);
  return f ? t(f.label[0], f.label[1]) : id;
};

export function AiStatisticsSection() {
  const t = useT();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  // Refreshed every minute while visible (the counts are written per minute).
  const live = useLive<AiStatistics>(`/api/admin/monitoring?view=ai&days=${days}`, 60_000);
  const s = live.data;
  const money = (n: number | null) => (n === null ? "–" : n.toLocaleString(undefined, { style: "currency", currency: s?.currency || "EUR", maximumFractionDigits: n < 10 ? 2 : 0 }));
  const failed = (r: Row) => (r.errors || r.timeouts ? t(`${num(r.errors)} Fehler · ${num(r.timeouts)} Zeitüberschr.`, `${num(r.errors)} errors · ${num(r.timeouts)} timeouts`) : "–");
  const share = (r: Row) => (r.requests ? percent((r.errors + r.timeouts) / r.requests) : "–");
  const common = (label: (r: Row & { key: string }) => ReactNode) => [
    { key: "name", header: t("Name", "Name"), primary: true, render: label },
    { key: "n", header: t("Anfragen", "Requests"), align: "end" as const, render: (r: Row) => num(r.requests) },
    { key: "tokens", header: t("Tokens (ein/aus)", "Tokens (in/out)"), align: "end" as const, render: (r: Row) => `${compact(r.tokensIn)} / ${compact(r.tokensOut)}` },
    { key: "cost", header: t("Kosten (geschätzt)", "Cost (estimated)"), align: "end" as const, render: (r: Row) => money(r.cost) },
    { key: "failed", header: t("Fehlgeschlagen", "Failed"), align: "end" as const, hideOnPhone: true, render: (r: Row) => failed(r) },
    { key: "p95", header: t("Antwort (p95)", "Answer (p95)"), align: "end" as const, hideOnPhone: true, render: (r: Row) => ms(r.p95) },
  ];
  return (
    <SettingGroup
      id="ai-statistics"
      title={t("Statistik", "Statistics")}
      description={t(
        "KI-Anfragen je Modell, Funktion, Arbeitsbereich und Person – nur Zahlen, nie Texte. Kosten sind geschätzt aus den Preisen oben; Tokens schätzt Flowplan, wo der Anbieter keine Zahl meldet.",
        "AI requests per model, feature, workspace and person – numbers only, never text. Costs are estimated from the prices above; Flowplan estimates tokens where the provider reports none.",
      )}
      actions={
        <label className="mon-range">
          <span>{t("Zeitraum", "Range")}</span>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}>
            <option value="7">{t("7 Tage", "7 days")}</option>
            <option value="30">{t("30 Tage", "30 days")}</option>
            <option value="90">{t("90 Tage", "90 days")}</option>
          </Select>
        </label>
      }
    >
      {!s ? (
        <p className="settings-loading" role="status">
          {live.state === "error" ? live.error : t("Wird geladen …", "Loading …")}
        </p>
      ) : !s.total.requests ? (
        <EmptyState icon={<Sparkle size={20} />} title={t("Noch keine KI-Anfragen gezählt.", "No AI requests counted yet.")}>
          {t("Sobald jemand die KI nutzt, erscheinen hier Tokens, Kosten und Antwortzeiten (mit eingeschalteter Statistik unter Überwachung).", "As soon as someone uses AI, tokens, costs and response times appear here (with statistics on under Monitoring).")}
        </EmptyState>
      ) : (
        <div className="ai-stats">
          <div className="ai-stats-totals">
            <Kpi label={t("Anfragen", "Requests")} value={num(s.total.requests)} />
            <Kpi label={t("Tokens", "Tokens")} value={compact(s.total.tokensIn + s.total.tokensOut)} note={t(`${compact(s.total.tokensIn)} ein · ${compact(s.total.tokensOut)} aus`, `${compact(s.total.tokensIn)} in · ${compact(s.total.tokensOut)} out`)} />
            <Kpi label={t("Kosten (geschätzt)", "Cost (estimated)")} value={money(s.total.cost)} note={s.total.cost === null ? t("Keine Preise eingetragen", "No prices entered") : undefined} />
            <Kpi label={t("Fehlgeschlagen", "Failed")} value={share(s.total)} note={failed(s.total)} />
            <Kpi label={t("Antwortzeit (p95)", "Response time (p95)")} value={ms(s.total.p95)} note={s.total.avgMs !== null ? t(`Mittel ${ms(s.total.avgMs)}`, `average ${ms(s.total.avgMs)}`) : undefined} />
          </div>
          <Legend
            items={[
              { label: t("Eingabe", "Input"), color: 0 },
              { label: t("Ausgabe", "Output"), color: 2 },
            ]}
          />
          <BarChart
            title={t("KI-Tokens je Tag", "AI tokens per day")}
            description={t(`Eingabe- und Ausgabe-Tokens je Tag, ${s.days} Tage.`, `Input and output tokens per day, ${s.days} days.`)}
            labels={s.perDay.map((d) => shortDay(d.day))}
            tips={s.perDay.map((d) => `${longDay(d.day)}${d.cost !== null ? ` · ${money(d.cost)}` : ""}`)}
            series={[
              { key: "in", label: t("Eingabe", "Input"), values: s.perDay.map((d) => d.tokensIn), color: 0 },
              { key: "out", label: t("Ausgabe", "Output"), values: s.perDay.map((d) => d.tokensOut), color: 2 },
            ]}
            formatY={(n) => compact(n)}
            limit={
              s.limits.quota.unit === "tokens" && typeof s.limits.quota.instance?.day === "number"
                ? { value: s.limits.quota.instance.day, label: t(`Grenze der Instanz je Tag: ${compact(s.limits.quota.instance.day)}`, `Instance limit per day: ${compact(s.limits.quota.instance.day)}`) }
                : null
            }
          />
          <h3 className="mon-subhead">{t("Nach Modell", "By model")}</h3>
          <div className="mon-table">
            <ResponsiveTable
              label={t("Nach Modell", "By model")}
              rows={s.models.map((m) => ({ ...m, key: `${m.model}|${m.source}` }))}
              rowKey={(r) => r.key}
              columns={common((r) => {
                const m = r as (typeof s.models)[number] & { key: string };
                return (
                  <span>
                    {m.model || t("Unbekannt (vor dieser Version gezählt)", "Unknown (counted before this version)")}
                    {m.source === "user" && <small className="muted"> · {t("eigener Anbieter", "own provider")}</small>}
                    {m.model && !m.priced && <small className="muted"> · {t("kein Preis", "no price")}</small>}
                  </span>
                );
              })}
            />
          </div>
          <h3 className="mon-subhead">{t("Nach Funktion", "By feature")}</h3>
          <div className="mon-table">
            <ResponsiveTable label={t("Nach Funktion", "By feature")} rows={s.features.map((f) => ({ ...f, key: f.feature }))} rowKey={(r) => r.key} columns={common((r) => featureName(r.key, t))} />
          </div>
          <h3 className="mon-subhead">{t("Nach Arbeitsbereich", "By workspace")}</h3>
          <div className="mon-table">
            <ResponsiveTable
              label={t("Nach Arbeitsbereich", "By workspace")}
              rows={s.workspaces.map((w) => ({ ...w, key: w.id }))}
              rowKey={(r) => r.key || "-"}
              columns={common((r) => {
                const w = r as (typeof s.workspaces)[number] & { key: string };
                return w.id ? (w.name ?? t("Gelöschter Arbeitsbereich", "Deleted workspace")) : t("Ohne Arbeitsbereich (Suchindex, früher gezählt)", "No workspace (search index, counted earlier)");
              })}
            />
          </div>
          <p className="muted mon-small">
            {t(
              `Grenzen: höchstens ${num(s.limits.requestsPerPersonHour)} KI-Anfragen je Person und Stunde${s.limits.workflowTokensPerDay !== null ? `, ${compact(s.limits.workflowTokensPerDay)} Tokens je Workflow und Tag` : ""}. Eine Grenze je Arbeitsbereich gibt es nicht.`,
              `Limits: at most ${num(s.limits.requestsPerPersonHour)} AI requests per person and hour${s.limits.workflowTokensPerDay !== null ? `, ${compact(s.limits.workflowTokensPerDay)} tokens per workflow and day` : ""}. There is no limit per workspace.`,
            )}
          </p>
          <QuotaLines quota={s.limits.quota} money={money} />
          {s.people && (
            <>
              <h3 className="mon-subhead">{t("Nach Person (nur für Administratoren)", "By person (administrators only)")}</h3>
              <div className="mon-table">
                <ResponsiveTable
                  label={t("Nach Person", "By person")}
                  rows={s.people.map((p) => ({ ...p, key: p.id }))}
                  rowKey={(r) => r.key || "-"}
                  columns={common((r) => {
                    const p = r as NonNullable<typeof s.people>[number] & { key: string };
                    return p.id ? (p.name ?? t("Gelöschtes Konto", "Deleted account")) : t("Ohne Person (Suchindex, früher gezählt)", "No person (search index, counted earlier)");
                  })}
                />
              </div>
            </>
          )}
        </div>
      )}
    </SettingGroup>
  );
}

// i18n-table: 1 – [German, English] pairs
const PER_PERIOD: Record<string, readonly [string, string]> = {
  day: ["je Tag", "per day"],
  week: ["je Woche", "per week"],
  month: ["je Monat", "per month"],
  year: ["je Jahr", "per year"],
};
// The AI quotas (#382) as lines below the statistics: the instance's
// ceiling and the default per person, per period.
function QuotaLines({ quota, money }: { quota: AiStatistics["limits"]["quota"]; money: (n: number | null) => string }) {
  const t = useT();
  if (!quota.rules) return null;
  const list = (limits: Partial<Record<string, number | null>> | null) =>
    Object.entries(limits || {})
      .filter((e): e is [string, number] => typeof e[1] === "number" && !!PER_PERIOD[e[0]])
      .map(([p, v]) => `${quota.unit === "cost" ? money(v) : compact(v)} ${t(PER_PERIOD[p][0], PER_PERIOD[p][1])}`)
      .join(", ");
  const instance = list(quota.instance),
    person = list(quota.person);
  return (
    <p className="muted mon-small">
      {instance ? t(`Kontingent der ganzen Instanz: ${instance}.`, `Quota of the whole instance: ${instance}.`) : t("Kein Kontingent für die ganze Instanz.", "No quota for the whole instance.")}{" "}
      {person ? t(`Standard je Person: ${person}.`, `Default per person: ${person}.`) : t("Kein Standard je Person.", "No default per person.")}{" "}
      <a href="#admin/ai/quotas">{t("Kontingente bearbeiten", "Edit quotas")}</a>
    </p>
  );
}
