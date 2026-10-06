"use client";
import { useEffect, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import Papa from "papaparse";
import { useT, useLocale } from "./i18n";
import { Select } from "./select";
import { api, download } from "./ui";
import { formatDuration, hours } from "@/lib/durations";

type Report = {
  weeks: string[];
  people: { name: string; weeks: Record<string, number>; total: number }[];
  records: { title: string; seconds: number; estimate: number | null }[];
};

// Time worked per person and week, and per record against its estimate.
export function TimeReport({ pageId, title }: { pageId: string; title: string }) {
  const t = useT();
  const locale = useLocale();
  const [weeks, setWeeks] = useState(8);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    void api<Report>(`/api/time-report?page=${pageId}&weeks=${weeks}`)
      .then(setReport)
      .catch(() => setReport(null));
  }, [pageId, weeks]);
  const label = (week: string) =>
    new Date(`${week}T12:00:00`).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "2-digit" });
  if (!report) return <p className="muted">{t("Wird geladen …", "Loading …")}</p>;
  const exportCsv = () =>
    download(
      `${title} – ${t("Zeiten", "Time")}.csv`,
      Papa.unparse({
        fields: [t("Person", "Person"), ...report.weeks, t("Summe (h)", "Total (h)")],
        data: report.people.map((p) => [p.name, ...report.weeks.map((w) => hours(p.weeks[w] || 0)), hours(p.total)]),
      }),
      "text/csv",
    );
  return (
    <div className="time-report">
      <div className="time-report-bar">
        <Select aria-label={t("Zeitraum", "Period")} value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))}>
          <option value="4">{t("Letzte 4 Wochen", "Last 4 weeks")}</option>
          <option value="8">{t("Letzte 8 Wochen", "Last 8 weeks")}</option>
          <option value="13">{t("Letztes Quartal", "Last quarter")}</option>
          <option value="26">{t("Letztes Halbjahr", "Last six months")}</option>
        </Select>
        <button className="button compact" onClick={exportCsv} disabled={!report.people.length}>
          <DownloadSimple /> CSV
        </button>
      </div>
      {!report.people.length ? (
        <p className="muted">{t("In diesem Zeitraum wurde keine Zeit erfasst.", "No time was tracked in this period.")}</p>
      ) : (
        <>
          <div className="time-report-scroll">
            <table className="time-report-table">
              <caption>{t("Stunden pro Person und Woche (ab Montag)", "Hours per person and week (from Monday)")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("Person", "Person")}</th>
                  {report.weeks.map((w) => (
                    <th scope="col" key={w}>
                      {label(w)}
                    </th>
                  ))}
                  <th scope="col">{t("Summe", "Total")}</th>
                </tr>
              </thead>
              <tbody>
                {report.people.map((p) => (
                  <tr key={p.name}>
                    <th scope="row">{p.name}</th>
                    {report.weeks.map((w) => (
                      <td key={w}>{p.weeks[w] ? hours(p.weeks[w]).toLocaleString(locale === "de" ? "de-DE" : "en-GB") : "–"}</td>
                    ))}
                    <td>
                      <strong>{hours(p.total).toLocaleString(locale === "de" ? "de-DE" : "en-GB")}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>{t("Einträge: Aufwand und Schätzung", "Records: effort and estimate")}</h3>
          <ul className="time-report-records">
            {report.records.map((r, i) => (
              <li key={i}>
                <span>{r.title || t("Ohne Titel", "Untitled")}</span>
                <span className={r.estimate !== null && r.seconds > r.estimate ? "over" : ""}>
                  {formatDuration(r.seconds)}
                  {r.estimate !== null && <span className="muted"> / {formatDuration(r.estimate)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
