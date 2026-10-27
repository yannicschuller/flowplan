"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, DownloadSimple, Printer } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { Select } from "./select";
import { api } from "./ui";
import { ChartGraphic } from "./database-chart";
import { printPage } from "./print-page";
import { defaultChart, type ChartPoint } from "@/lib/database-chart";
import { formatDuration, hours } from "@/lib/durations";
import type { BillingState, ReportGroup, TimeReportData } from "@/lib/time-reports";

type Filters = {
  period: "this-week" | "this-month" | "last-month" | "custom";
  from: string;
  to: string;
  person: string;
  database: string;
  project: string;
  status: "" | BillingState;
  billable: "" | "yes" | "no";
  group: ReportGroup;
};
const initial: Filters = { period: "this-month", from: "", to: "", person: "", database: "", project: "", status: "", billable: "", group: "person" };
type Option = { id: string; name: string };

// Time worked in a database or the whole workspace: filters, grouping,
// totals with a chart, the entries with their billing status, rates,
// CSV export and a print view (lib/time-reports.ts).
export function TimeReport({ pageId, workspaceId, title }: { pageId?: string; workspaceId: string; title: string }) {
  const t = useT();
  const [scope, setScope] = useState<"database" | "workspace">(pageId ? "database" : "workspace");
  const [filters, setFilters] = useState<Filters>(initial);
  const [report, setReport] = useState<TimeReportData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showEntries, setShowEntries] = useState(false);
  // Choices seen so far, so a filter does not narrow its own list.
  const [seen, setSeen] = useState<{ people: Map<string, string>; databases: Map<string, string>; projects: Map<string, string> }>(() => ({
    people: new Map(),
    databases: new Map(),
    projects: new Map(),
  }));
  const printable = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (scope === "database" && pageId) params.set("page", pageId);
    else params.set("workspace", workspaceId);
    for (const [key, value] of Object.entries(filters)) {
      if (!value || ((key === "from" || key === "to") && filters.period !== "custom")) continue;
      if (key === "database" && scope === "database") continue;
      params.set(key, value);
    }
    return params.toString();
  }, [filters, scope, pageId, workspaceId]);
  const ready = filters.period !== "custom" || (!!filters.from && !!filters.to);
  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const data = await api<TimeReportData>(`/api/time-reports?${query}`);
      setReport(data);
      setError("");
      setSeen((s) => ({
        people: new Map([...s.people, ...data.options.people.map((p) => [p.id, p.name] as [string, string])]),
        databases: new Map([...s.databases, ...data.options.databases.map((p) => [p.id, p.title] as [string, string])]),
        projects: new Map([...s.projects, ...data.options.projects.map((p) => [p.id, p.title] as [string, string])]),
      }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query, ready]);
  useEffect(() => {
    void load();
  }, [load]);
  const options = (map: Map<string, string>): Option[] => [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const money = (n: number | null) =>
    n === null || !report ? "–" : new Intl.NumberFormat(LOCALE_TAG, { style: "currency", currency: report.currency }).format(n);
  const decimal = (seconds: number) => hours(seconds).toLocaleString(LOCALE_TAG);
  const date = (ms: number) => new Date(ms).toLocaleDateString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric" });
  const groupLabel = (key: string, label: string) =>
    report?.group === "week"
      ? t(`Woche ab ${date(new Date(`${key}T12:00:00`).getTime())}`, `Week of ${date(new Date(`${key}T12:00:00`).getTime())}`)
      : report?.group === "day"
        ? date(new Date(`${key}T12:00:00`).getTime())
        : label || t("Ohne Titel", "Untitled");
  const statusLabel = (s: BillingState) =>
    s === "billed" ? t("abgerechnet", "billed") : s === "unbillable" ? t("nicht abrechenbar", "not billable") : t("offen", "open||billing");
  async function billing(status: BillingState, ids?: string[]) {
    setBusy(true);
    setMessage("");
    try {
      const filter = Object.fromEntries(new URLSearchParams(query));
      const result = await api<{ changed: number; skipped: number }>(
        "/api/time-reports",
        ids ? { action: "billing", status, ids, workspace: workspaceId } : { action: "billing", status, filter },
      );
      if (!ids)
        setMessage(
          result.skipped
            ? t(`${result.changed} Einträge geändert, ${result.skipped} ohne Bearbeitungsrechte übersprungen.`, `${result.changed} entries changed, ${result.skipped} skipped without edit rights.`)
            : t(`${result.changed} Einträge geändert.`, `${result.changed} entries changed.`),
        );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveRate(kind: "person" | "project", targetId: string, raw: string) {
    const rate = raw.trim() === "" ? null : Number(raw.replace(",", "."));
    if (rate !== null && (!Number.isFinite(rate) || rate < 0)) return setError(t("Bitte einen gültigen Stundensatz eingeben.", "Please enter a valid hourly rate."));
    try {
      await api("/api/time-reports", { action: "rate", workspace: workspaceId, kind, targetId, rate });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function saveCurrency(currency: string) {
    if (!/^[A-Z]{3}$/.test(currency)) return setError(t("Bitte einen Währungscode wie EUR eingeben.", "Please enter a currency code such as EUR."));
    try {
      await api("/api/time-reports", { action: "currency", workspace: workspaceId, currency });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const points: ChartPoint[] = (report?.groups || []).map((g) => ({ key: g.key, label: groupLabel(g.key, g.label), value: hours(g.seconds), rows: [], numericCount: 1 }));
  const chartConfig = { ...defaultChart([]), kind: points.length > 8 && report?.group !== "day" && report?.group !== "week" ? ("horizontal" as const) : ("bar" as const), valueAxisLabel: t("Stunden", "Hours") };
  const selectGroup = (key: string) => {
    if (!report) return;
    if (report.group === "person") set({ person: key, group: "record" });
    else if (report.group === "project") set({ project: key, group: "record" });
    else if (report.group === "database") set({ database: key, group: "record" });
  };
  const openEditable = report?.entries.filter((e) => e.editable && e.billing === "open").length || 0;
  const csvUrl = (format: "csv" | "excel") => `/api/time-reports?${query}&format=${format}`;
  const rateOf = (kind: "person" | "project", id: string) => report?.rates.find((r) => r.kind === kind && r.targetId === id)?.rate;

  return (
    <div className="time-report">
      <div className="time-report-bar" role="group" aria-label={t("Filter", "Filters")}>
        {pageId && (
          <label className="time-report-filter">
            <span>{t("Umfang", "Scope")}</span>
            <Select aria-label={t("Umfang", "Scope")} value={scope} onChange={(e) => setScope(e.target.value as "database" | "workspace")}>
              <option value="database">{t(`Nur „${title}“`, `Only “${title}”`)}</option>
              <option value="workspace">{t("Ganzer Arbeitsbereich", "Whole workspace")}</option>
            </Select>
          </label>
        )}
        <label className="time-report-filter">
          <span>{t("Zeitraum", "Period")}</span>
          <Select aria-label={t("Zeitraum", "Period")} value={filters.period} onChange={(e) => set({ period: e.target.value as Filters["period"] })}>
            <option value="this-week">{t("Diese Woche", "This week")}</option>
            <option value="this-month">{t("Dieser Monat", "This month")}</option>
            <option value="last-month">{t("Letzter Monat", "Last month")}</option>
            <option value="custom">{t("Eigener Zeitraum", "Custom period")}</option>
          </Select>
        </label>
        {filters.period === "custom" && (
          <>
            <label className="time-report-filter">
              <span>{t("Von", "From")}</span>
              <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label className="time-report-filter">
              <span>{t("Bis", "To")}</span>
              <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
            </label>
          </>
        )}
        <label className="time-report-filter">
          <span>{t("Person", "Person")}</span>
          <Select aria-label={t("Person", "Person")} value={filters.person} onChange={(e) => set({ person: e.target.value })}>
            <option value="">{t("Alle Personen", "All people")}</option>
            {options(seen.people).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        {scope === "workspace" && (
          <label className="time-report-filter">
            <span>{t("Datenbank", "Database")}</span>
            <Select aria-label={t("Datenbank", "Database")} value={filters.database} onChange={(e) => set({ database: e.target.value })}>
              <option value="">{t("Alle Datenbanken", "All databases")}</option>
              {options(seen.databases).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label className="time-report-filter">
          <span>{t("Projekt", "Project")}</span>
          <Select aria-label={t("Projekt", "Project")} value={filters.project} onChange={(e) => set({ project: e.target.value })}>
            <option value="">{t("Alle Projekte", "All projects")}</option>
            <option value="none">{t("Ohne Projekt", "No project")}</option>
            {options(seen.projects).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="time-report-filter">
          <span>{t("Abrechnungsstatus", "Billing status")}</span>
          <Select aria-label={t("Abrechnungsstatus", "Billing status")} value={filters.status} onChange={(e) => set({ status: e.target.value as Filters["status"] })}>
            <option value="">{t("Jeder Status", "Any status")}</option>
            <option value="open">{t("offen", "open||billing")}</option>
            <option value="billed">{t("abgerechnet", "billed")}</option>
            <option value="unbillable">{t("nicht abrechenbar", "not billable")}</option>
          </Select>
        </label>
        <label className="time-report-filter">
          <span>{t("Abrechenbar", "Billable")}</span>
          <Select aria-label={t("Abrechenbar", "Billable")} value={filters.billable} onChange={(e) => set({ billable: e.target.value as Filters["billable"] })}>
            <option value="">{t("Abrechenbar und nicht", "Billable or not")}</option>
            <option value="yes">{t("Nur abrechenbare", "Billable only")}</option>
            <option value="no">{t("Nur nicht abrechenbare", "Not billable only")}</option>
          </Select>
        </label>
        <label className="time-report-filter">
          <span>{t("Gruppieren nach", "Group by")}</span>
          <Select aria-label={t("Gruppieren nach", "Group by")} value={filters.group} onChange={(e) => set({ group: e.target.value as ReportGroup })}>
            <option value="person">{t("Nach Person", "By person")}</option>
            <option value="project">{t("Nach Projekt", "By project")}</option>
            <option value="record">{t("Nach Eintrag", "By record")}</option>
            {scope === "workspace" && <option value="database">{t("Nach Datenbank", "By database")}</option>}
            <option value="day">{t("Nach Tag", "By day")}</option>
            <option value="week">{t("Nach Woche", "By week")}</option>
          </Select>
        </label>
        {Object.entries(filters).some(([k, v]) => v !== initial[k as keyof Filters]) && (
          <button type="button" className="button compact" onClick={() => setFilters(initial)}>
            {t("Filter zurücksetzen", "Reset filters")}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!ready && <p className="muted">{t("Bitte Start- und Enddatum wählen.", "Please choose a start and an end date.")}</p>}
      {ready && !report && !error && <p className="muted">{t("Wird geladen …", "Loading …")}</p>}
      {report && (
        <div ref={printable} className="time-report-body">
          <h2 className="time-report-print-title">
            {scope === "database" ? title : t("Zeiten im Arbeitsbereich", "Time in the workspace")} · {date(new Date(`${report.from}T12:00:00`).getTime())} – {date(new Date(`${report.to}T12:00:00`).getTime())}
          </h2>
          <div className="time-report-totals" aria-label={t("Summen", "Totals")}>
            <div>
              <span>{t("Gesamt", "Total")}</span>
              <strong>{t(`${decimal(report.total.seconds)} Std.`, `${decimal(report.total.seconds)} h`)}</strong>
              <small>{t(`${report.total.entries} Zeiteinträge`, `${report.total.entries} time entries`)}</small>
            </div>
            <div>
              <span>{t("Offen", "Open||status")}</span>
              <strong>{t(`${decimal(report.byStatus.open)} Std.`, `${decimal(report.byStatus.open)} h`)}</strong>
            </div>
            <div>
              <span>{t("Abgerechnet", "Billed")}</span>
              <strong>{t(`${decimal(report.byStatus.billed)} Std.`, `${decimal(report.byStatus.billed)} h`)}</strong>
            </div>
            <div>
              <span>{t("Nicht abrechenbar", "Not billable")}</span>
              <strong>{t(`${decimal(report.byStatus.unbillable)} Std.`, `${decimal(report.byStatus.unbillable)} h`)}</strong>
            </div>
            {report.showAmounts && (
              <div>
                <span>{t("Betrag", "Amount")}</span>
                <strong>{money(report.total.amount)}</strong>
              </div>
            )}
          </div>
          <div className="time-report-actions print-hidden">
            <a className="button compact" href={csvUrl("csv")} download>
              <DownloadSimple aria-hidden /> CSV
            </a>
            <a className="button compact" href={csvUrl("excel")} download title={t("Mit Semikolon und Dezimalkomma für Excel", "With semicolons and decimal commas for Excel")}>
              <DownloadSimple aria-hidden /> {t("CSV für Excel", "CSV for Excel")}
            </a>
            <button type="button" className="button compact" onClick={() => printable.current && printPage(printable.current)}>
              <Printer aria-hidden /> {t("Drucken", "Print")}
            </button>
            {openEditable > 0 && (
              <button
                type="button"
                className="button compact primary"
                disabled={busy}
                onClick={() => {
                  if (confirm(t("Alle offenen Einträge dieser Auswahl als abgerechnet markieren?", "Mark all open entries of this selection as billed?")))
                    void billing("billed");
                }}
              >
                <CheckCircle aria-hidden /> {t("Als abgerechnet markieren", "Mark as billed")}
              </button>
            )}
          </div>
          {message && (
            <p className="muted" role="status">
              {message}
            </p>
          )}
          {!report.groups.length ? (
            <p className="muted">{t("In diesem Zeitraum wurde keine Zeit erfasst.", "No time was tracked in this period.")}</p>
          ) : (
            <>
              <div className="time-report-chart">
                <ChartGraphic
                  points={points}
                  config={chartConfig}
                  onSelect={selectGroup}
                  describe={(p) => t(`${p.label}: ${(p.value ?? 0).toLocaleString(LOCALE_TAG)} Std.`, `${p.label}: ${(p.value ?? 0).toLocaleString(LOCALE_TAG)} h`)}
                />
              </div>
              <div className="time-report-scroll">
                <table className="time-report-table">
                  <thead>
                    <tr>
                      <th scope="col">
                        {
                          {
                            person: t("Person", "Person"),
                            project: t("Projekt", "Project"),
                            record: t("Eintrag", "Record"),
                            database: t("Datenbank", "Database"),
                            day: t("Tag", "Day"),
                            week: t("Woche", "Week"),
                          }[report.group]
                        }
                      </th>
                      <th scope="col">{t("Stunden", "Hours")}</th>
                      <th scope="col">{t("Dauer", "Duration")}</th>
                      <th scope="col">{t("Einträge", "Entries")}</th>
                      {report.showAmounts && <th scope="col">{t("Betrag", "Amount")}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.groups.map((g) => (
                      <tr key={g.key}>
                        <th scope="row">{groupLabel(g.key, g.label)}</th>
                        <td>{decimal(g.seconds)}</td>
                        <td>{formatDuration(g.seconds)}</td>
                        <td>{g.entries}</td>
                        {report.showAmounts && <td>{money(g.amount)}</td>}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">{t("Summe", "Total")}</th>
                      <td>
                        <strong>{decimal(report.total.seconds)}</strong>
                      </td>
                      <td>{formatDuration(report.total.seconds)}</td>
                      <td>{report.total.entries}</td>
                      {report.showAmounts && (
                        <td>
                          <strong>{money(report.total.amount)}</strong>
                        </td>
                      )}
                    </tr>
                  </tfoot>
                </table>
              </div>
              <details className="time-report-entries" open={showEntries} onToggle={(e) => setShowEntries((e.target as HTMLDetailsElement).open)}>
                <summary>{t(`Zeiteinträge (${report.total.entries})`, `Time entries (${report.total.entries})`)}</summary>
                {report.truncated && <p className="muted">{t("Die ersten 1000 Einträge; der Export enthält alle.", "The first 1000 entries; the export contains all.")}</p>}
                <div className="time-report-scroll">
                  <table className="time-report-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("Datum", "Date")}</th>
                        <th scope="col">{t("Person", "Person")}</th>
                        <th scope="col">{t("Eintrag", "Record")}</th>
                        <th scope="col">{t("Projekt", "Project")}</th>
                        <th scope="col">{t("Dauer", "Duration")}</th>
                        <th scope="col">{t("Abrechnung", "Billing")}</th>
                        {report.showAmounts && <th scope="col">{t("Betrag", "Amount")}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {report.entries.map((e) => (
                        <tr key={e.id}>
                          <td>{date(e.start)}</td>
                          <td>{e.person}</td>
                          <td>
                            {e.restricted ? <span className="muted">{t("Eintrag ohne Zugriff", "Record without access")}</span> : e.title}
                            {scope === "workspace" && e.database && <small className="muted"> · {e.database}</small>}
                            {e.note && <small className="time-report-note">{e.note}</small>}
                          </td>
                          <td>{e.projects.map((p) => p.title).join(", ")}</td>
                          <td>
                            {formatDuration(e.seconds)}
                            {e.end === null && <small className="muted"> · {t("läuft", "running")}</small>}
                          </td>
                          <td>
                            {e.editable ? (
                              <>
                                <span className="time-report-print-only">{statusLabel(e.billing)}</span>
                                <Select
                                  aria-label={t("Abrechnungsstatus", "Billing status")}
                                  value={e.billing}
                                  disabled={busy}
                                  onChange={(event) => void billing(event.target.value as BillingState, [e.id])}
                                >
                                  <option value="open">{statusLabel("open")}</option>
                                  <option value="billed">{statusLabel("billed")}</option>
                                  <option value="unbillable">{statusLabel("unbillable")}</option>
                                </Select>
                              </>
                            ) : (
                              <span className={`time-billing ${e.billing}`}>{statusLabel(e.billing)}</span>
                            )}
                          </td>
                          {report.showAmounts && <td>{money(e.amount)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
          {report.showAmounts && (
            <details className="time-report-rates print-hidden">
              <summary>{t("Stundensätze", "Hourly rates")}</summary>
              <p className="muted">
                {report.canEditRates
                  ? t("Ein Satz für das Projekt geht dem Satz der Person vor. Leer lassen, um ihn zu entfernen.", "A project's rate takes precedence over the person's. Leave empty to remove it.")
                  : t("Stundensätze legen Eigentümer des Arbeitsbereichs fest.", "Owners of the workspace set hourly rates.")}
              </p>
              <label className="time-report-currency">
                {t("Währung", "Currency")}
                <input
                  defaultValue={report.currency}
                  key={report.currency}
                  maxLength={3}
                  size={4}
                  disabled={!report.canEditRates}
                  onBlur={(e) => e.target.value.toUpperCase() !== report.currency && void saveCurrency(e.target.value.toUpperCase())}
                />
              </label>
              <div className="time-report-rate-list">
                {(
                  [
                    ["person", t("Personen", "People"), options(seen.people)],
                    ["project", t("Projekte", "Projects"), options(seen.projects)],
                  ] as const
                ).map(([kind, heading, list]) =>
                  list.length ? (
                    <fieldset key={kind}>
                      <legend>{heading}</legend>
                      {list.map((o) => (
                        <label key={o.id}>
                          <span>{o.name}</span>
                          <input
                            inputMode="decimal"
                            key={`${o.id}:${rateOf(kind, o.id) ?? ""}`}
                            defaultValue={rateOf(kind, o.id) ?? ""}
                            placeholder="–"
                            disabled={!report.canEditRates}
                            aria-label={t(`Stundensatz für ${o.name}`, `Hourly rate for ${o.name}`)}
                            onBlur={(e) => e.target.value !== String(rateOf(kind, o.id) ?? "") && void saveRate(kind, o.id, e.target.value)}
                          />
                          <small>{t(`${report.currency} je Std.`, `${report.currency} per h`)}</small>
                        </label>
                      ))}
                    </fieldset>
                  ) : null,
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
