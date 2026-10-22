"use client";
// Pieces the landing page's live strip and the monitoring share: the "Live"
// indicator, the requests chart and the KPI numbers.
import type { ReactNode } from "react";
import type { MonitoringLive } from "@/lib/admin-monitoring";
import { useT } from "../../i18n";
import { LineChart } from "../../charts";
import type { LiveState } from "./use-live";
import { clock, compact, dateTime, num, percent, weekday } from "./monitoring-format";

export function LiveBadge({ state, label }: { state: LiveState; label?: string }) {
  const t = useT();
  const text =
    state === "live"
      ? t("Live", "Live")
      : state === "paused"
        ? t("Pausiert", "Paused")
        : state === "error"
          ? t("Verbindung unterbrochen", "Connection lost")
          : t("Wird geladen", "Loading");
  return (
    <span className={`live-badge ${state}`} role="status">
      {text}
      {label && <span className="muted"> · {label}</span>}
    </span>
  );
}

export const rangeLabel = (range: string, t: (de: string, en: string) => string) =>
  range === "1h" ? t("1 Std.", "1 h") : range === "7d" ? t("7 Tage", "7 days") : t("24 Std.", "24 h");

// Requests per minute (averaged over the bucket) – or the 5xx errors.
export function RequestsChart({ requests, kind = "requests", height }: { requests: MonitoringLive["requests"]; kind?: "requests" | "errors"; height?: number }) {
  const t = useT();
  const perMinute = requests.bucketMs / 60_000;
  const values = requests.points.map((p) => {
    const v = kind === "requests" ? p.requests : p.errors;
    return v === null ? null : kind === "requests" ? v / perMinute : v;
  });
  const long = requests.range === "7d";
  const title = kind === "requests" ? t("Anfragen pro Minute", "Requests per minute") : t("Fehler (5xx)", "Errors (5xx)");
  return (
    <LineChart
      title={title}
      description={
        kind === "requests"
          ? t(`Durchschnitt je ${long ? "Stunde" : requests.range === "24h" ? "5 Minuten" : "Minute"}, ${rangeLabel(requests.range, t)}.`, `Average per ${long ? "hour" : requests.range === "24h" ? "5 minutes" : "minute"}, ${rangeLabel(requests.range, t)}.`)
          : t(`Antworten mit Status 500–599 je ${long ? "Stunde" : requests.range === "24h" ? "5 Minuten" : "Minute"}.`, `Answers with status 500–599 per ${long ? "hour" : requests.range === "24h" ? "5 minutes" : "minute"}.`)
      }
      x={requests.points.map((p) => p.at)}
      series={[{ key: kind, label: kind === "requests" ? t("Anfragen/Min.", "Requests/min") : t("Fehler", "Errors"), values, color: kind === "requests" ? 0 : 1 }]}
      formatX={long ? weekday : clock}
      formatTip={dateTime}
      formatY={(n) => (n >= 1000 ? compact(n) : num(n, n < 10 && n % 1 ? 1 : 0))}
      height={height ?? (kind === "requests" ? 200 : 110)}
    />
  );
}

export function Kpi({ label, value, note, children }: { label: string; value: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="kpi">
      <strong>{value}</strong>
      <span>{label}</span>
      {note && <small>{note}</small>}
      {children}
    </div>
  );
}

export function LiveKpis({ live }: { live: MonitoringLive }) {
  const t = useT();
  const k = live.kpis;
  return (
    <div className="kpi-grid">
      <Kpi label={t("gerade aktiv", "active now")} value={num(k.activeNow)} />
      <Kpi label={t("Anfragen/Min.", "Requests/min")} value={live.collecting.enabled ? num(k.requestsPerMinute) : "–"} />
      <Kpi label={t("Fehlerquote (1 Std.)", "Error rate (1 h)")} value={live.collecting.enabled ? percent(k.errorRate) : "–"} />
      <Kpi label={t("Anmeldungen heute", "Sign-ins today")} value={num(k.signinsToday)} />
    </div>
  );
}
