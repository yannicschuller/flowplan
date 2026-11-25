"use client";
// Administration → Überwachung → Empfehlungen (#settings/instance/monitoring/
// recommendations): what the measurements suggest (lib/recommendations.ts),
// each with its reason in numbers, what to do and a page of the
// documentation; "Ausblenden" (while it lasts) and "Erinnere mich in 30
// Tagen"; anomalies offer their numbers for a bug report. Below, the
// thresholds and a switch per rule. The landing page's strip shows the same
// recommendations as notices.
import { useEffect, useState } from "react";
import { ArrowSquareOut, Lightbulb } from "@phosphor-icons/react";
import type { Recommendations } from "@/lib/recommendations-data";
import { DEFAULT_THRESHOLDS, RECOMMENDATION_IDS, THRESHOLD_LIMITS, type RecommendationId, type Thresholds } from "@/lib/recommendations";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { EmptyState, StatusBadge, Switch } from "../../settings-ui";
import { dateTime } from "./monitoring-format";

type T = (de: string, en: string) => string;

const RULE_NAMES: Record<RecommendationId, [string, string]> = {
  "scale-up": ["Mehr Leistung einplanen", "Plan for more capacity"],
  "over-provisioned": ["Limits zu großzügig", "Limits too generous"],
  disk: ["Speicherplatz", "Disk space"],
  "sqlite-postgres": ["SQLite → PostgreSQL", "SQLite → PostgreSQL"],
  backup: ["Sicherung", "Backup"],
  mail: ["E-Mail-Versand", "E-mail delivery"],
  update: ["Neue Version", "New version"],
  https: ["HTTPS", "HTTPS"],
  "metrics-token": ["Token für /api/metrics", "Token for /api/metrics"],
  "slow-endpoints": ["Langsame Endpunkte", "Slow endpoints"],
  "documents-per-person": ["Offene Dokumente je Person", "Open documents per person"],
  "ai-latency": ["KI-Antwortzeit", "AI response time"],
  "ai-costs": ["KI-Kosten", "AI costs"],
  "memory-growth": ["Speicher wächst (Leck?)", "Memory grows (leak?)"],
  "error-jump": ["Fehlerquote springt", "Error rate jumps"],
  restarts: ["Neustarts", "Restarts"],
};
// Shares are edited in %, the rest as they are.
const SHARES = new Set<keyof Thresholds>(["cpuHigh", "memHigh", "cpuLow", "memLow", "diskUsed", "aiFeatureShare", "memGrowth"]);
const THRESHOLD_NAMES: Record<keyof Thresholds, [string, string]> = {
  cpuHigh: ["CPU hoch ab (% des Limits)", "CPU high from (% of the limit)"],
  memHigh: ["RAM hoch ab (% des Limits)", "RAM high from (% of the limit)"],
  highDays: ["… an so vielen von 7 Tagen", "… on this many of 7 days"],
  cpuLow: ["CPU niedrig unter (%)", "CPU low below (%)"],
  memLow: ["RAM niedrig unter (%)", "RAM low below (%)"],
  diskDaysLeft: ["Speicherplatz voll in weniger als (Tage)", "Disk full in less than (days)"],
  diskUsed: ["Speicherplatz belegt ab (%)", "Disk used from (%)"],
  sqliteActive: ["PostgreSQL ab gleichzeitig aktiven Personen", "PostgreSQL from people active at once"],
  backupAgeDays: ["Sicherung alt ab (Tage)", "Backup old from (days)"],
  slowRouteMs: ["Endpunkt langsam ab (ms, p95)", "Endpoint slow from (ms, p95)"],
  documentsPerPerson: ["Offene Dokumente je Person ab", "Open documents per person from"],
  aiP95Ms: ["KI langsam ab (ms, p95 von Schreibassistent, Fragen, Datenbanken, Handschrift)", "AI slow from (ms, p95 of writing assistant, questions, databases, handwriting)"],
  aiMinRequests: ["… bei mindestens so vielen dieser Anfragen in 7 Tagen", "… with at least this many of these requests in 7 days"],
  aiGrowth: ["KI-Kosten gestiegen ab (Faktor zur Vorwoche)", "AI costs risen from (factor to the week before)"],
  aiFeatureShare: ["Eine KI-Funktion dominiert ab (%)", "One AI feature dominates from (%)"],
  memGrowth: ["RAM-Zuwachs ohne mehr Personen ab (%)", "Memory growth without more people from (%)"],
  errorJump: ["Fehlerquote gesprungen ab (Faktor)", "Error rate jumped from (factor)"],
  restarts: ["Neustarts in 7 Tagen ab", "Restarts in 7 days from"],
};

export function Recommendations({ data, onChange }: { data: Recommendations; onChange: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api("/api/admin/monitoring", body);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="setting-group mon-card" id="recommendations" aria-labelledby="recommendations-title">
      <header>
        <div>
          <h2 id="recommendations-title">{t("Empfehlungen", "Recommendations")}</h2>
          <p>{t(`Aus den Messwerten abgeleitet, zuletzt geprüft ${dateTime(data.at)} (höchstens alle 15 Minuten).`, `Derived from the measurements, last checked ${dateTime(data.at)} (at most every 15 minutes).`)}</p>
        </div>
      </header>
      <div className="mon-card-body">
        {!data.items.length ? (
          <EmptyState icon={<Lightbulb size={20} />} title={t("Keine Empfehlungen.", "No recommendations.")}>
            {t("Die Messwerte und die Einrichtung sehen gut aus.", "The measurements and the setup look fine.")}
          </EmptyState>
        ) : (
          <ul className="mon-advice">
            {data.items.map((r) => (
              <li key={r.id} className={r.level}>
                <div className="mon-advice-head">
                  <strong>{t(r.title[0], r.title[1])}</strong>
                  <StatusBadge tone={r.level === "warn" ? "warn" : "info"}>{r.level === "warn" ? t("Wichtig", "Important") : t("Tipp", "Tip")}</StatusBadge>
                </div>
                <p>{t(r.reason[0], r.reason[1])}</p>
                <p className="muted">
                  {t(r.action[0], r.action[1])}{" "}
                  <a href={t(r.docs[0], r.docs[1])} target="_blank" rel="noopener noreferrer">
                    {t("Anleitung", "Guide")} <ArrowSquareOut size={12} aria-hidden />
                  </a>
                </p>
                <div className="mon-advice-actions">
                  <button type="button" className="button compact" disabled={busy} onClick={() => void send({ action: "recommendation.hide", id: r.id })}>
                    {t("Ausblenden", "Hide")}
                  </button>
                  <button type="button" className="button compact" disabled={busy} onClick={() => void send({ action: "recommendation.snooze", id: r.id })}>
                    {t("Erinnere mich in 30 Tagen", "Remind me in 30 days")}
                  </button>
                  {r.debug && (
                    <button
                      type="button"
                      className="button compact"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(JSON.stringify({ recommendation: r.id, reason: r.reason[1], ...r.debug }, null, 2));
                          setCopied(r.id);
                        } catch {}
                      }}
                    >
                      {copied === r.id ? t("Kopiert", "Copied") : t("Debug-Daten kopieren", "Copy debug data")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.quiet.length > 0 && (
          <details className="mon-advice-quiet">
            <summary>{t(`${data.quiet.length} ausgeblendet`, `${data.quiet.length} hidden`)}</summary>
            <ul>
              {data.quiet.map((q) => (
                <li key={q.id}>
                  <span>
                    {t(q.title[0], q.title[1])}
                    {q.until && <small className="muted"> · {t(`bis ${dateTime(q.until)}`, `until ${dateTime(q.until)}`)}</small>}
                  </span>
                  <button type="button" className="button compact" disabled={busy} onClick={() => void send({ action: "recommendation.restore", id: q.id })}>
                    {t("Wieder anzeigen", "Show again")}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <AdviceSettings data={data} busy={busy} send={send} t={t} />
      </div>
    </section>
  );
}

function AdviceSettings({ data, busy, send, t }: { data: Recommendations; busy: boolean; send: (body: Record<string, unknown>) => Promise<void>; t: T }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [off, setOff] = useState<RecommendationId[]>(data.off);
  useEffect(() => setOff(data.off), [data.off]);
  const shown = (k: keyof Thresholds) => (SHARES.has(k) ? String(Math.round(data.thresholds[k] * 1000) / 10) : String(data.thresholds[k]));
  const dirty = Object.keys(draft).length > 0 || JSON.stringify([...off].sort()) !== JSON.stringify([...data.off].sort());
  return (
    <details className="mon-advice-settings">
      <summary>{t("Schwellen und Regeln", "Thresholds and rules")}</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const thresholds = Object.fromEntries(
            Object.entries(draft)
              .map(([k, v]) => [k, Number(v.replace(",", ".")) / (SHARES.has(k as keyof Thresholds) ? 100 : 1)] as const)
              .filter(([, v]) => Number.isFinite(v)),
          );
          await send({ action: "recommendations.settings", thresholds, off });
          setDraft({});
        }}
      >
        <fieldset>
          <legend>{t("Regeln", "Rules")}</legend>
          <ul className="mon-advice-rules">
            {RECOMMENDATION_IDS.map((id) => (
              <li key={id}>
                <span>{t(RULE_NAMES[id][0], RULE_NAMES[id][1])}</span>
                <Switch checked={!off.includes(id)} label={t(`${RULE_NAMES[id][0]} prüfen`, `Check ${RULE_NAMES[id][1]}`)} onChange={(on) => setOff((o) => (on ? o.filter((x) => x !== id) : [...o, id]))} />
              </li>
            ))}
          </ul>
        </fieldset>
        <fieldset>
          <legend>{t("Schwellen", "Thresholds")}</legend>
          <div className="mon-advice-thresholds">
            {(Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]).map((k) => {
              const [min, max] = THRESHOLD_LIMITS[k];
              const scale = SHARES.has(k) ? 100 : 1;
              return (
                <label key={k}>
                  <span>{t(THRESHOLD_NAMES[k][0], THRESHOLD_NAMES[k][1])}</span>
                  <input
                    type="number"
                    min={min * scale}
                    max={max * scale}
                    step="any"
                    value={draft[k] ?? shown(k)}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                  />
                  <small className="muted">{t(`Standard: ${Math.round(DEFAULT_THRESHOLDS[k] * scale * 10) / 10}`, `Default: ${Math.round(DEFAULT_THRESHOLDS[k] * scale * 10) / 10}`)}</small>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="mon-advice-actions">
          <button type="submit" className="button primary compact" disabled={!dirty || busy}>
            {t("Speichern", "Save")}
          </button>
          <button
            type="button"
            className="button compact"
            disabled={busy}
            onClick={() => {
              setDraft({});
              void send({ action: "recommendations.settings", thresholds: { ...DEFAULT_THRESHOLDS }, off: [] });
            }}
          >
            {t("Standardwerte", "Defaults")}
          </button>
        </div>
      </form>
    </details>
  );
}
