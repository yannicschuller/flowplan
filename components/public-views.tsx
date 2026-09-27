import type { CSSProperties } from "react";
import { Temporal } from "@/lib/date-values";
import { weekdayLabels } from "@/lib/database-calendar";
import { PublicCalendarGrid } from "./public-calendar-grid";
import { cellText } from "@/lib/database";
import {
  chartAggregates,
  chartConfigError,
  chartPalettes,
  chartPoints,
  chartSeries,
  defaultChart,
} from "@/lib/database-chart";
import { scheduleFields } from "@/lib/database-timeline";
import {
  occurrenceDates,
  parseRecurrence,
  shiftDateValue,
} from "@/lib/recurrence";
import { publicField, publicFieldIds } from "@/lib/shared-content";
import type { Field, Row, View } from "@/lib/types";

// Read-only, server-rendered calendar, timeline and chart views for
// publications. They only use properties that are public anyway.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export function publicMonth(value: string | undefined) {
  return value && MONTH.test(value)
    ? value
    : Temporal.Now.plainDateISO("UTC").toString().slice(0, 7);
}
const shiftMonth = (month: string, by: number) =>
  Temporal.PlainYearMonth.from(month).add({ months: by }).toString();
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("de-DE", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

// Whether a view can be published without revealing hidden properties.
export function publicLayout(view: View, fields: Field[]) {
  const publicIds = publicFieldIds(fields);
  const visible = (id?: string) => !!id && publicIds.has(id);
  if (view.type === "calendar" || view.type === "timeline") {
    const { start, end, invalidEnd } = scheduleFields(fields, view);
    return (
      !!start && !invalidEnd && publicField(start) && (!end || publicField(end))
    );
  }
  if (view.type === "chart") {
    const config = view.chart || defaultChart(fields);
    return (
      !chartConfigError(config, fields) &&
      (!config.xField || visible(config.xField)) &&
      (config.aggregate === "count" || visible(config.yField)) &&
      (!config.seriesField || visible(config.seriesField)) &&
      (config.measures || []).every((m) => visible(m.field))
    );
  }
  return ["table", "board", "gallery", "list", "feed"].includes(view.type);
}

type Span = { row: Row; start: string; end: string; occurrence: boolean };
// Records and repeating occurrences whose dates touch [from, to].
function spans(
  rows: Row[],
  fields: Field[],
  view: View,
  from: string,
  to: string,
) {
  const { start, end } = scheduleFields(fields, view);
  if (!start) return [];
  const result: Span[] = [];
  for (const row of rows) {
    const first = row.cells[start.id],
      last = end ? row.cells[end.id] : undefined;
    if (typeof first !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(first))
      continue;
    const a = first.slice(0, 10),
      b =
        typeof last === "string" && /^\d{4}-\d{2}-\d{2}/.test(last)
          ? last.slice(0, 10)
          : a;
    if (b < a) continue;
    const length = Temporal.PlainDate.from(a).until(
      Temporal.PlainDate.from(b),
    ).days;
    const add = (s: string, occurrence: boolean) => {
      const e = Temporal.PlainDate.from(s).add({ days: length }).toString();
      if (e >= from && s <= to)
        result.push({ row, start: s, end: e, occurrence });
    };
    add(a, false);
    const rule = parseRecurrence(row.recurrence);
    if (rule)
      for (const date of occurrenceDates(
        first,
        rule,
        Temporal.PlainDate.from(from).subtract({ days: length }).toString(),
        to,
        200,
      ))
        add(
          shiftDateValue(
            a,
            Temporal.PlainDate.from(a).until(Temporal.PlainDate.from(date))
              .days,
          ),
          true,
        );
  }
  return result.sort(
    (x, y) => x.start.localeCompare(y.start) || x.end.localeCompare(y.end),
  );
}

function MonthNav({
  month,
  link,
}: {
  month: string;
  link: (month: string) => string;
}) {
  return (
    <nav className="public-month" aria-label="Zeitraum">
      <a href={link(shiftMonth(month, -1))} aria-label="Vorheriger Monat">
        ←
      </a>
      <strong>{monthLabel(month)}</strong>
      <a href={link(shiftMonth(month, 1))} aria-label="Nächster Monat">
        →
      </a>
    </nav>
  );
}
const title = (row: Row, fields: Field[]) =>
  cellText(row.cells[fields[0]?.id]) || "Ohne Titel";

export function PublicCalendar({
  records,
  fields,
  view,
  month,
  monthLink,
  recordLink,
  editable = false,
  token = "",
  pageId = "",
}: {
  records: Row[];
  fields: Field[];
  view: View;
  month: string;
  monthLink: (month: string) => string;
  recordLink: (row: Row) => string;
  // Edit links may move entries; the date fields must be writable.
  editable?: boolean;
  token?: string;
  pageId?: string;
}) {
  const schedule = scheduleFields(fields, view);
  const first = Temporal.PlainDate.from(`${month}-01`);
  const config = view.calendar || { mode: "month", timeZone: "UTC" };
  const sunday = config.weekStart === "sunday",
    weekends = config.showWeekends !== false;
  const offset = (d: Temporal.PlainDate) =>
    sunday ? d.dayOfWeek % 7 : d.dayOfWeek - 1;
  const gridStart = first.subtract({ days: offset(first) });
  const lastDay = first.add({ months: 1 }).subtract({ days: 1 });
  const gridEnd = lastDay.add({ days: 6 - offset(lastDay) });
  const days: string[] = [];
  for (
    let d = gridStart;
    Temporal.PlainDate.compare(d, gridEnd) <= 0;
    d = d.add({ days: 1 })
  )
    if (weekends || d.dayOfWeek < 6) days.push(d.toString());
  const entries = spans(records, fields, view, days[0], days[days.length - 1]);
  return (
    <section className="public-calendar" aria-label="Kalender">
      <MonthNav month={month} link={monthLink} />
      <PublicCalendarGrid
        days={days}
        month={month}
        labels={weekdayLabels(config)}
        weekends={weekends}
        editable={editable}
        token={token}
        pageId={pageId}
        startField={schedule.start?.id || ""}
        endField={schedule.end?.id}
        entries={entries.map((e) => ({
          rowId: e.row.id,
          title: title(e.row, fields),
          href: recordLink(e.row),
          start: e.start,
          end: e.end,
          occurrence: e.occurrence,
        }))}
      />
    </section>
  );
}

export function PublicTimeline({
  records,
  fields,
  view,
  month,
  monthLink,
  recordLink,
}: {
  records: Row[];
  fields: Field[];
  view: View;
  month: string;
  monthLink: (month: string) => string;
  recordLink: (row: Row) => string;
}) {
  const first = Temporal.PlainDate.from(`${month}-01`);
  const last = first.add({ months: 1 }).subtract({ days: 1 });
  const total = last.day;
  const entries = spans(
    records,
    fields,
    view,
    first.toString(),
    last.toString(),
  );
  const offset = (date: string) =>
    Math.min(
      total,
      Math.max(0, first.until(Temporal.PlainDate.from(date)).days),
    );
  return (
    <section className="public-timeline" aria-label="Timeline">
      <MonthNav month={month} link={monthLink} />
      {!entries.length && (
        <p className="muted">Keine Einträge in diesem Monat.</p>
      )}
      <ol className="public-timeline-rows">
        {entries.map((e) => {
          const left = offset(e.start),
            right = offset(
              Temporal.PlainDate.from(e.end).add({ days: 1 }).toString(),
            );
          return (
            <li key={`${e.row.id}:${e.start}`}>
              <a href={recordLink(e.row)}>{title(e.row, fields)}</a>
              <span className="public-timeline-track">
                <span
                  className="public-timeline-bar"
                  style={{
                    left: `${(left / total) * 100}%`,
                    width: `${(Math.max(right - left, 1) / total) * 100}%`,
                  }}
                  title={`${e.start}${e.end !== e.start ? ` – ${e.end}` : ""}`}
                />
              </span>
              <small className="muted">
                {e.start}
                {e.end !== e.start ? ` – ${e.end}` : ""}
              </small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function PublicChart({
  records,
  fields,
  view,
}: {
  records: Row[];
  fields: Field[];
  view: View;
}) {
  const config = view.chart || defaultChart(fields);
  const points = chartPoints(records, fields, config).slice(0, 100);
  // Series (by a property or further values): one bar per series and group.
  const { series, values } = config.kind === "donut" ? { series: [], values: new Map() } : chartSeries(points, fields, config);
  const seriesMax = Math.max(
    0,
    ...[...values.values()].flatMap((row) => [...row.values()].map((v) => Math.abs(v.value || 0))),
  );
  const max = Math.max(0, ...points.map((p) => Math.abs(p.value || 0)));
  const colors = chartPalettes[config.palette || "default"];
  const format = (value: number | null) =>
    value === null
      ? "—"
      : value.toLocaleString("de-DE", { maximumFractionDigits: 2 });
  const measure =
    config.aggregate === "count"
      ? chartAggregates.count
      : `${chartAggregates[config.aggregate]} von ${fields.find((f) => f.id === config.yField)?.name || ""}`;
  const total = points.reduce((sum, p) => sum + Math.max(0, p.value || 0), 0);
  let angle = 0;
  const donut =
    config.kind === "donut" && total
      ? `conic-gradient(${points
          .map((p, i) => {
            const from = angle;
            angle += (Math.max(0, p.value || 0) / total) * 360;
            return `${colors[i % colors.length]} ${from}deg ${angle}deg`;
          })
          .join(", ")})`
      : undefined;
  return (
    <section className="public-chart" aria-label={`Diagramm: ${measure}`}>
      {donut ? (
        <div
          className="public-donut"
          style={{ background: donut }}
          role="img"
          aria-label={measure}
        />
      ) : (
        <div className="public-bars" role="img" aria-label={measure}>
          {series.length > 0 && (
            <p className="public-chart-legend">
              {series.map((sr: { key: string; label: string }, i: number) => (
                <span key={sr.key}>
                  <i style={{ background: colors[i % colors.length] }} />
                  {sr.label}
                </span>
              ))}
            </p>
          )}
          {series.length > 0 && points.map((p) => (
            <div key={p.key} className="public-bar-row">
              <span className="public-bar-label">{p.label}</span>
              <span className="public-bar-stack">
                {series.map((sr: { key: string; label: string }, i: number) => {
                  const v = values.get(p.key)?.get(sr.key)?.value ?? null;
                  return (
                    <span key={sr.key} className="public-bar-track" title={`${sr.label}: ${format(v)}`}>
                      <span
                        className="public-bar"
                        style={{
                          width: `${seriesMax ? (Math.abs(v || 0) / seriesMax) * 100 : 0}%`,
                          background: colors[i % colors.length],
                        }}
                      />
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
          {!series.length && points.map((p, i) => (
            <div key={p.key} className="public-bar-row">
              <span className="public-bar-label">{p.label}</span>
              <span className="public-bar-track">
                <span
                  className="public-bar"
                  style={{
                    width: `${max ? (Math.abs(p.value || 0) / max) * 100 : 0}%`,
                    background:
                      colors[config.palette === "mono" ? 2 : i % colors.length],
                  }}
                />
              </span>
              {config.showValues && (
                <span className="public-bar-value">{format(p.value)}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <table className="data-table public-chart-table">
        <caption className="muted">{measure}</caption>
        <thead>
          <tr>
            <th>Gruppe</th>
            {series.length ? (
              series.map((sr: { key: string; label: string }) => <th key={sr.key}>{sr.label}</th>)
            ) : (
              <th>Wert</th>
            )}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={p.key}>
              <td>
                {donut && (
                  <span
                    className="public-legend"
                    style={{ background: colors[i % colors.length] }}
                  />
                )}
                {p.label}
              </td>
              {series.length ? (
                series.map((sr: { key: string; label: string }) => (
                  <td key={sr.key}>{format(values.get(p.key)?.get(sr.key)?.value ?? null)}</td>
                ))
              ) : (
                <td>{format(p.value)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
