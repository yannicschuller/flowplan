"use client";
// Pieces the settings' start page (live-panels.tsx) and the monitoring
// share: the "Live" indicator, the requests chart and a KPI number.
import type { ReactNode } from "react";
import type { MonitoringLive } from "@/lib/admin-monitoring";
import { useT } from "../../i18n";
import { LineChart } from "../../charts";
import type { LiveState } from "./use-live";
import { clock, compact, dateTime, num, weekday } from "./monitoring-format";

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
export function RequestsChart({ requests, kind = "requests", height, onPick }: { requests: MonitoringLive["requests"]; kind?: "requests" | "errors"; height?: number; onPick?: (at: number) => void }) {
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
          ? long
            ? t(`Durchschnitt je Stunde, ${rangeLabel(requests.range, t)}.`, `Average per hour, ${rangeLabel(requests.range, t)}.`)
            : requests.range === "24h"
              ? t(`Durchschnitt je 5 Minuten, ${rangeLabel(requests.range, t)}.`, `Average per 5 minutes, ${rangeLabel(requests.range, t)}.`)
              : t(`Durchschnitt je Minute, ${rangeLabel(requests.range, t)}.`, `Average per minute, ${rangeLabel(requests.range, t)}.`)
          : long
            ? t("Antworten mit Status 500–599 je Stunde.", "Answers with status 500–599 per hour.")
            : requests.range === "24h"
              ? t("Antworten mit Status 500–599 je 5 Minuten.", "Answers with status 500–599 per 5 minutes.")
              : t("Antworten mit Status 500–599 je Minute.", "Answers with status 500–599 per minute.")
      }
      x={requests.points.map((p) => p.at)}
      series={[{ key: kind, label: kind === "requests" ? t("Anfragen/Min.", "Requests/min") : t("Fehler", "Errors"), values, color: kind === "requests" ? 0 : 1 }]}
      formatX={long ? weekday : clock}
      formatTip={dateTime}
      formatY={(n) => (n >= 1000 ? compact(n) : num(n, n < 10 && n % 1 ? 1 : 0))}
      height={height ?? (kind === "requests" ? 200 : 110)}
      onPick={onPick ? (i) => requests.points[i] && onPick(requests.points[i].at) : undefined}
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
