"use client";
// The top of the administration's landing page: the state of the instance
// (problems and notices of the tiles below, linked), the live numbers and a
// carousel of charts of the last 24 hours (components/settings/admin/
// strip-charts.tsx) – refreshed every 15 seconds while the page is visible
// (/api/admin/monitoring?view=live).
import { CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { MonitoringLive } from "@/lib/admin-monitoring";
import { settingsHash } from "@/lib/settings-sections";
import { useT } from "../../i18n";
import { LiveBadge, LiveKpis, rangeLabel } from "./live";
import { ChartCarousel, stripSlides } from "./strip-charts";
import { useLive } from "./use-live";
import { uptime } from "./monitoring-format";

export type StripItem = { id: string; title: string; badge?: string };

export function LiveStrip({ problems, notices, version, uptimeSeconds, loaded }: { problems: StripItem[]; notices: StripItem[]; version?: string; uptimeSeconds?: number; loaded: boolean }) {
  const t = useT();
  const live = useLive<MonitoringLive>("/api/admin/monitoring?view=live&range=24h");
  const tone = problems.length ? "error" : notices.length ? "warn" : "ok";
  const Icon = tone === "error" ? XCircle : tone === "warn" ? WarningCircle : CheckCircle;
  const headline = !loaded
    ? t("Zustand wird geladen …", "Loading state …")
    : problems.length || notices.length
      ? [
          problems.length === 1 ? t("1 Störung", "1 problem") : problems.length ? t(`${problems.length} Störungen`, `${problems.length} problems`) : "",
          notices.length === 1 ? t("1 Hinweis", "1 notice") : notices.length ? t(`${notices.length} Hinweise`, `${notices.length} notices`) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : t("Alles in Ordnung", "All fine");
  const items = [...problems, ...notices];
  return (
    <section className="live-strip" aria-label={t("Zustand der Instanz", "State of the instance")}>
      <div className="live-strip-state">
        <div className={`live-strip-head ${tone}`}>
          <span className="live-strip-icon" aria-hidden>
            <Icon size={20} weight="bold" />
          </span>
          <div>
            <strong role="status">{headline}</strong>
            {items.length ? (
              <ul className="live-strip-items">
                {items.slice(0, 4).map((item) => (
                  <li key={item.id}>
                    <a href={settingsHash({ area: "admin", section: item.id })}>{item.badge ? `${item.title}: ${item.badge}` : item.title}</a>
                  </li>
                ))}
              </ul>
            ) : (
              <small className="muted">
                {[version && `v${version}`, uptimeSeconds !== undefined && t(`läuft seit ${uptime(uptimeSeconds, t)}`, `running for ${uptime(uptimeSeconds, t)}`)].filter(Boolean).join(" · ") || " "}
              </small>
            )}
          </div>
        </div>
        {live.data ? <LiveKpis live={live.data} /> : <div className="kpi-grid placeholder" aria-hidden />}
      </div>
      <div className="live-strip-chart">
        {live.data ? (
          <ChartCarousel slides={stripSlides(live.data, t)} badge={<LiveBadge state={live.state} label={rangeLabel("24h", t)} />} />
        ) : (
          <>
            <header>
              <h2>{t("Diagramme", "Charts")}</h2>
              <LiveBadge state={live.state} label={rangeLabel("24h", t)} />
            </header>
            <div className="vz-placeholder" aria-hidden />
          </>
        )}
      </div>
    </section>
  );
}
