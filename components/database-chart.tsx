"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { DownloadSimple, SlidersHorizontal } from "@phosphor-icons/react";
import {
  chartAggregates,
  chartConfigError,
  chartDateField,
  chartGroupField,
  chartDomain,
  chartKinds,
  chartNumberField,
  chartPaletteNames,
  chartPalettes,
  chartPoints,
  chartSeries,
  canStack,
  defaultChart,
  type ChartConfig,
  type ChartPoint,
  type ChartSeries,
  type SeriesValue,
} from "@/lib/database-chart";
import { cellText } from "@/lib/cell-text";
import type { Field, Row, User, View } from "@/lib/types";
import { Modal, download } from "./ui";
const paletteOf = (config: ChartConfig) =>
  chartPalettes[config.palette || "default"];
const format = (n: number | null) =>
  n === null
    ? "–"
    : new Intl.NumberFormat(LOCALE_TAG, { maximumFractionDigits: 4 }).format(n);
const short = (s: string) => (s.length > 22 ? s.slice(0, 20) + "…" : s);
// Optional axis titles; the value axis is vertical except in bar charts.
function AxisTitles({
  config,
  height,
  horizontal,
  plotTop,
  plotBottom,
  plotLeft,
  plotRight,
}: {
  config: ChartConfig;
  height: number;
  horizontal: boolean;
  plotTop: number;
  plotBottom: number;
  plotLeft: number;
  plotRight: number;
}) {
  const across = horizontal ? config.valueAxisLabel : config.groupAxisLabel,
    up = horizontal ? config.groupAxisLabel : config.valueAxisLabel;
  return (
    <>
      {across && (
        <text
          className="chart-axis-title"
          x={(plotLeft + plotRight) / 2}
          y={height - 6}
          textAnchor="middle"
        >
          {across}
        </text>
      )}
      {up && (
        <text
          className="chart-axis-title"
          transform={`translate(14,${(plotTop + plotBottom) / 2}) rotate(-90)`}
          textAnchor="middle"
        >
          {up}
        </text>
      )}
    </>
  );
}
function ChartGraphic({
  points,
  config,
  onSelect,
}: {
  points: ChartPoint[];
  config: ChartConfig;
  onSelect: (key: string) => void;
}) {
  const t = useT();
  const colors = paletteOf(config);
  const available = points.slice(0, 100),
    values = available.map((p) => p.value ?? 0);
  const { lo, span, magnitude, scale } = chartDomain(values, config);
  const label = (p: ChartPoint) =>
    t(`${p.label}: ${format(p.value)} · ${p.rows.length} Einträge`, `${p.label}: ${format(p.value)} · ${p.rows.length} records`);
  const interaction = (p: ChartPoint) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label(p),
    onClick: () => onSelect(p.key),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(p.key);
      }
    },
    className: "chart-point",
  });
  if (!available.length)
    return (
      <p className="muted">
        {t("Keine Daten für diese Auswertung. Passe Filter, Suche oder Gruppierung an.", "No data for this chart. Adjust filters, search or grouping.")}
      </p>
    );
  if (config.kind === "donut") {
    if (available.some((p) => p.value !== null && p.value < 0))
      return (
        <p role="status">
          {t("Ein Donut kann negative Werte nicht darstellen. Wähle Balken oder Linie. Alle Ergebnisse stehen in der Wertetabelle.", "A donut cannot show negative values. Choose bars or a line. All results are in the value table.")}
        </p>
      );
    const total = available.reduce(
      (sum, p) => sum + (p.value ?? 0) / magnitude,
      0,
    );
    if (!total)
      return (
        <p role="status">
          {t("Für einen Donut werden positive Werte benötigt. Alle Ergebnisse stehen in der Wertetabelle.", "A donut needs positive values. All results are in the value table.")}
        </p>
      );
    let offset = 0;
    return (
      <svg
        viewBox="0 0 440 330"
        width="440"
        height="330"
        className="chart-donut"
        aria-label={t("Donutdiagramm", "Donut chart")}
      >
        {available.map((p, i) => {
          const part = (p.value ?? 0) / magnitude / total;
          const start = offset;
          offset += part;
          if (!part) return null;
          const a = start * Math.PI * 2 - Math.PI / 2,
            b = offset * Math.PI * 2 - Math.PI / 2;
          const x = (r: number, t: number) => 220 + r * Math.cos(t),
            y = (r: number, t: number) => 165 + r * Math.sin(t);
          return (
            <g key={p.key} {...interaction(p)}>
              <title>{label(p)}</title>
              {part === 1 ? (
                <circle
                  cx="220"
                  cy="165"
                  r="104"
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth="52"
                />
              ) : (
                <path
                  fill={colors[i % colors.length]}
                  d={`M ${x(130, a)} ${y(130, a)} A 130 130 0 ${part > 0.5 ? 1 : 0} 1 ${x(130, b)} ${y(130, b)} L ${x(78, b)} ${y(78, b)} A 78 78 0 ${part > 0.5 ? 1 : 0} 0 ${x(78, a)} ${y(78, a)} Z`}
                />
              )}
              {config.showValues && part >= 0.08 && (
                <text
                  x={x(104, (a + b) / 2)}
                  y={y(104, (a + b) / 2) + 4}
                  textAnchor="middle"
                  className="chart-segment-label"
                >
                  {short(format(p.value))}
                </text>
              )}
            </g>
          );
        })}
        <text x="220" y="161" textAnchor="middle" className="chart-center">
          {available.length}
        </text>
        <text x="220" y="185" textAnchor="middle">
          {t("Gruppen", "Groups")}
        </text>
      </svg>
    );
  }
  if (config.kind === "horizontal") {
    const width = 720,
      height = Math.max(150, available.length * 42 + 50),
      left = 165,
      extent = 480;
    const x = (v: number) => left + scale(v) * extent,
      zero = x(0);
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-label={t("Balkendiagramm", "Bar chart")}
      >
        <AxisTitles
          config={config}
          height={height}
          horizontal
          plotTop={10}
          plotBottom={height - 35}
          plotLeft={left}
          plotRight={left + extent}
        />
        <line
          x1={zero}
          x2={zero}
          y1="10"
          y2={height - 35}
          className="chart-axis"
        />
        {available.map((p, i) => (
          <g key={p.key} {...interaction(p)}>
            <title>{label(p)}</title>
            <rect
              x="0"
              y={i * 42 + 10}
              width={width}
              height="40"
              fill="transparent"
            />
            <text x={left - 10} y={i * 42 + 36} textAnchor="end">
              {short(p.label)}
            </text>
            <rect
              x={Math.min(zero, x(p.value ?? 0))}
              y={i * 42 + 15}
              width={Math.max(1, Math.abs(x(p.value ?? 0) - zero))}
              height="27"
              rx="3"
              fill={colors[i % colors.length]}
            />
            {config.showValues && (
              <text
                x={x(p.value ?? 0) + ((p.value ?? 0) < 0 ? -5 : 5)}
                y={i * 42 + 34}
                textAnchor={(p.value ?? 0) < 0 ? "end" : "start"}
              >
                {format(p.value)}
              </text>
            )}
          </g>
        ))}
      </svg>
    );
  }
  const width = Math.max(650, available.length * 85 + 110),
    height = 365,
    left = 70,
    plot = 235,
    bottom = 265;
  const y = (v: number) => bottom - scale(v) * plot,
    step = (width - left - 35) / available.length;
  const x = (i: number) => left + step * (i + 0.5),
    zero = y(0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={config.kind === "line" ? t("Liniendiagramm", "Line chart") : t("Säulendiagramm", "Column chart")}
    >
      <AxisTitles
        config={config}
        height={height}
        horizontal={false}
        plotTop={bottom - plot}
        plotBottom={bottom}
        plotLeft={left}
        plotRight={width - 20}
      />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line
            x1={left}
            x2={width - 20}
            y1={bottom - t * plot}
            y2={bottom - t * plot}
            className="chart-grid"
          />
          <text x={left - 8} y={bottom - t * plot + 4} textAnchor="end">
            {short(format((lo + span * t) * magnitude))}
          </text>
        </g>
      ))}
      <line
        x1={left}
        x2={width - 20}
        y1={zero}
        y2={zero}
        className="chart-axis"
      />
      {config.kind === "line" &&
        available.map((p, i) =>
          i > 0 && p.value !== null && available[i - 1].value !== null ? (
            <line
              key={p.key}
              x1={x(i - 1)}
              x2={x(i)}
              y1={y(available[i - 1].value!)}
              y2={y(p.value)}
              stroke={colors[0]}
              strokeWidth="3"
            />
          ) : null,
        )}
      {available.map((p, i) => (
        <g key={p.key} {...interaction(p)}>
          <title>{label(p)}</title>
          <rect
            x={left + step * i}
            y="0"
            width={step}
            height={height}
            fill="transparent"
          />
          {p.value !== null &&
            (config.kind === "line" ? (
              <circle cx={x(i)} cy={y(p.value)} r="6" fill={colors[0]} />
            ) : (
              <rect
                x={x(i) - Math.min(44, step * 0.6) / 2}
                y={Math.min(zero, y(p.value))}
                width={Math.min(44, step * 0.6)}
                height={Math.max(1, Math.abs(y(p.value) - zero))}
                rx="3"
                fill={colors[i % colors.length]}
              />
            ))}
          {config.showValues && (
            <text
              x={x(i)}
              y={y(p.value ?? 0) + ((p.value ?? 0) < 0 ? 17 : -10)}
              textAnchor="middle"
            >
              {format(p.value)}
            </text>
          )}
          <text
            transform={`translate(${x(i)},288) rotate(30)`}
            textAnchor="start"
          >
            {short(p.label)}
          </text>
        </g>
      ))}
    </svg>
  );
}
const SEP = "\u001f";
function SeriesGraphic({
  points,
  series,
  values,
  config,
  onSelect,
}: {
  points: ChartPoint[];
  series: ChartSeries[];
  values: Map<string, Map<string, SeriesValue>>;
  config: ChartConfig;
  onSelect: (key: string) => void;
}) {
  const t = useT();
  const colors = paletteOf(config);
  const available = points.slice(0, 100);
  const stacked =
    config.kind !== "line" &&
    config.seriesMode === "stacked" &&
    canStack(config);
  const cell = (p: ChartPoint, s: ChartSeries) =>
    values.get(p.key)?.get(s.key) || { value: null, rows: [] };
  // Stacks grow separately above and below zero.
  const extents = available.flatMap((p) => {
    if (!stacked) return series.map((s) => cell(p, s).value ?? 0);
    let pos = 0,
      neg = 0;
    for (const s of series) {
      const v = cell(p, s).value ?? 0;
      if (v >= 0) pos += v;
      else neg += v;
    }
    return [pos, neg];
  });
  const { lo, span, magnitude, scale } = chartDomain(extents, config);
  const label = (p: ChartPoint, s: ChartSeries) =>
    t(`${p.label} · ${s.label}: ${format(cell(p, s).value)} · ${cell(p, s).rows.length} Einträge`, `${p.label} · ${s.label}: ${format(cell(p, s).value)} · ${cell(p, s).rows.length} records`);
  const interaction = (p: ChartPoint, s: ChartSeries) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label(p, s),
    onClick: () => onSelect(p.key + SEP + s.key),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(p.key + SEP + s.key);
      }
    },
    className: "chart-point",
  });
  const color = (i: number) => colors[i % colors.length];
  if (!available.length)
    return (
      <p className="muted">
        {t("Keine Daten für diese Auswertung. Passe Filter, Suche oder Gruppierung an.", "No data for this chart. Adjust filters, search or grouping.")}
      </p>
    );
  // Segments of one group: offsets for stacks, slots for grouped bars.
  const segments = (p: ChartPoint) => {
    let pos = 0,
      neg = 0;
    return series.map((s, i) => {
      const v = cell(p, s).value;
      if (!stacked) return { s, i, v, from: 0, to: v ?? 0 };
      const base = (v ?? 0) >= 0 ? pos : neg;
      if ((v ?? 0) >= 0) pos += v ?? 0;
      else neg += v ?? 0;
      return { s, i, v, from: base, to: base + (v ?? 0) };
    });
  };
  if (config.kind === "horizontal") {
    const band = stacked ? 42 : Math.max(42, series.length * 14 + 14);
    const width = 720,
      height = Math.max(150, available.length * band + 50),
      left = 165,
      extent = 480;
    const x = (v: number) => left + scale(v) * extent,
      zero = x(0);
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-label={t("Balkendiagramm mit Datenreihen", "Bar chart with series")}
      >
        <AxisTitles
          config={config}
          height={height}
          horizontal
          plotTop={10}
          plotBottom={height - 35}
          plotLeft={left}
          plotRight={left + extent}
        />
        <line
          x1={zero}
          x2={zero}
          y1="10"
          y2={height - 35}
          className="chart-axis"
        />
        {available.map((p, row) => {
          const top = row * band + 10,
            inner = band - 12,
            thickness = stacked ? inner : inner / series.length;
          return (
            <g key={p.key}>
              <text x={left - 10} y={top + band / 2 + 4} textAnchor="end">
                {short(p.label)}
              </text>
              {segments(p).map(({ s, i, v, from, to }) =>
                v === null ? null : (
                  <g key={s.key} {...interaction(p, s)}>
                    <title>{label(p, s)}</title>
                    <rect
                      x={Math.min(x(from), x(to))}
                      y={top + 4 + (stacked ? 0 : i * thickness)}
                      width={Math.max(1, Math.abs(x(to) - x(from)))}
                      height={Math.max(2, thickness - (stacked ? 0 : 2))}
                      rx="2"
                      fill={color(i)}
                    />
                  </g>
                ),
              )}
            </g>
          );
        })}
      </svg>
    );
  }
  const step =
    stacked || config.kind === "line"
      ? 85
      : Math.max(85, series.length * 18 + 20);
  const width = Math.max(650, available.length * step + 110),
    height = 365,
    left = 70,
    plot = 235,
    bottom = 265;
  const y = (v: number) => bottom - scale(v) * plot,
    slot = (width - left - 35) / available.length;
  const x = (i: number) => left + slot * (i + 0.5),
    zero = y(0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={
        config.kind === "line"
          ? t("Liniendiagramm mit Datenreihen", "Line chart with series")
          : t("Säulendiagramm mit Datenreihen", "Column chart with series")
      }
    >
      <AxisTitles
        config={config}
        height={height}
        horizontal={false}
        plotTop={bottom - plot}
        plotBottom={bottom}
        plotLeft={left}
        plotRight={width - 20}
      />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line
            x1={left}
            x2={width - 20}
            y1={bottom - t * plot}
            y2={bottom - t * plot}
            className="chart-grid"
          />
          <text x={left - 8} y={bottom - t * plot + 4} textAnchor="end">
            {short(format((lo + span * t) * magnitude))}
          </text>
        </g>
      ))}
      <line
        x1={left}
        x2={width - 20}
        y1={zero}
        y2={zero}
        className="chart-axis"
      />
      {config.kind === "line" &&
        series.map((s, si) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={color(si)}
            strokeWidth="2.5"
            points={available
              .map((p, i) =>
                cell(p, s).value === null
                  ? null
                  : `${x(i)},${y(cell(p, s).value!)}`,
              )
              .filter(Boolean)
              .join(" ")}
          />
        ))}
      {available.map((p, i) => {
        const width = Math.min(
          stacked ? 44 : 16,
          (slot * 0.8) / (stacked ? 1 : series.length),
        );
        const start =
          x(i) - (stacked ? width / 2 : (width * series.length) / 2);
        return (
          <g key={p.key}>
            {segments(p).map(({ s, i: si, v, from, to }) =>
              v === null ? null : config.kind === "line" ? (
                <g key={s.key} {...interaction(p, s)}>
                  <title>{label(p, s)}</title>
                  <circle cx={x(i)} cy={y(v)} r="5" fill={color(si)} />
                </g>
              ) : (
                <g key={s.key} {...interaction(p, s)}>
                  <title>{label(p, s)}</title>
                  <rect
                    x={stacked ? start : start + si * width}
                    y={Math.min(y(from), y(to))}
                    width={Math.max(2, width - (stacked ? 0 : 2))}
                    height={Math.max(1, Math.abs(y(to) - y(from)))}
                    rx="2"
                    fill={color(si)}
                  />
                </g>
              ),
            )}
            {config.showValues && stacked && (
              <text x={x(i)} y={y(p.value ?? 0) - 8} textAnchor="middle">
                {format(p.value)}
              </text>
            )}
            <text
              transform={`translate(${x(i)},288) rotate(30)`}
              textAnchor="start"
            >
              {short(p.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
function ChartSettings({
  initial,
  fields,
  version,
  editable,
  onSave,
  onClose,
}: {
  initial: ChartConfig;
  fields: Field[];
  version: number;
  editable: boolean;
  onSave: (c: ChartConfig, version: number) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial),
    [baseVersion, setBaseVersion] = useState(version),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const remote = JSON.stringify(initial);
  useEffect(() => {
    if (!dirty) {
      setDraft(JSON.parse(remote));
      setBaseVersion(version);
    }
  }, [remote, version, dirty]);
  const stale = dirty && version !== baseVersion;
  const patch = (p: Partial<ChartConfig>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
    setError("");
  };
  const invalid = chartConfigError(draft, fields);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (invalid || stale || !editable || busy) return;
        setBusy(true);
        try {
          if (await onSave(draft, baseVersion)) onClose();
          else
            setError(
              t("Das Diagramm konnte nicht gespeichert werden. Bitte erneut versuchen.", "The chart could not be saved. Please try again."),
            );
        } catch {
          setError(t("Speichern fehlgeschlagen.", "Saving failed."));
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="schema-settings" disabled={busy || !editable}>
        <label>
          {t("Diagrammtyp", "Chart type")}
          <Select
            value={draft.kind}
            onChange={(e) =>
              patch({ kind: e.target.value as ChartConfig["kind"] })
            }
          >
            {Object.entries(chartKinds).map(([value, title]) => (
              <option key={value} value={value}>
                {t(title)}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {t("Gruppierung", "Grouping")}
          <Select
            value={draft.xField || ""}
            onChange={(e) => patch({ xField: e.target.value || undefined })}
          >
            <option value="">{t("Alle Einträge", "All records")}</option>
            {fields.filter(chartGroupField).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </label>
        {chartDateField(fields.find((f) => f.id === draft.xField)) && (
          <label>
            {t("Datumsintervall", "Date interval")}
            <Select
              value={draft.dateBucket}
              onChange={(e) =>
                patch({
                  dateBucket: e.target.value as ChartConfig["dateBucket"],
                })
              }
            >
              <option value="day">{t("Tag", "Day")}</option>
              <option value="week">{t("Woche (Montag–Sonntag)", "Week (Monday–Sunday)")}</option>
              <option value="month">{t("Monat", "Month")}</option>
              <option value="year">{t("Jahr", "Year")}</option>
            </Select>
          </label>
        )}
        <label>
          {t("Berechnung", "Calculation")}
          <Select
            value={draft.aggregate}
            onChange={(e) =>
              patch({
                aggregate: e.target.value as ChartConfig["aggregate"],
                yField: draft.yField || fields.find(chartNumberField)?.id,
              })
            }
          >
            {Object.entries(chartAggregates).map(([value, title]) => (
              <option key={value} value={value}>
                {t(title)}
              </option>
            ))}
          </Select>
        </label>
        {draft.aggregate !== "count" && (
          <label>
            {t("Messwert", "Measure")}
            <Select
              value={draft.yField || ""}
              onChange={(e) => patch({ yField: e.target.value || undefined })}
            >
              <option value="">{t("Eigenschaft wählen", "Choose property")}</option>
              {fields.filter(chartNumberField).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <label>
          {t("Datenreihen", "Series")}
          <Select
            aria-label={t("Datenreihen", "Series")}
            disabled={!!draft.measures?.length}
            value={draft.seriesField || ""}
            onChange={(e) =>
              patch({ seriesField: e.target.value || undefined })
            }
          >
            <option value="">{t("Keine (eine Reihe)", "None (one series)")}</option>
            {fields
              .filter((f) => chartGroupField(f) && f.id !== draft.xField)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </Select>
        </label>
        {!draft.seriesField && draft.kind !== "donut" && (
          <fieldset className="chart-measures">
            <legend>{t("Weitere Werte", "More values")}</legend>
            {(draft.measures || []).map((m, i) => (
              <div key={i} className="chart-measure">
                <Select
                  aria-label={t(`Weiterer Wert ${i + 1}: Berechnung`, `Extra value ${i + 1}: calculation`)}
                  value={m.aggregate}
                  onChange={(e) =>
                    patch({
                      measures: (draft.measures || []).map((x, j) =>
                        j === i ? { ...x, aggregate: e.target.value as typeof m.aggregate } : x,
                      ),
                    })
                  }
                >
                  {(["sum", "average", "min", "max"] as const).map((a) => (
                    <option key={a} value={a}>
                      {t(chartAggregates[a])}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={t(`Weiterer Wert ${i + 1}: Eigenschaft`, `Extra value ${i + 1}: property`)}
                  value={m.field}
                  onChange={(e) =>
                    patch({
                      measures: (draft.measures || []).map((x, j) =>
                        j === i ? { ...x, field: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {fields.filter(chartNumberField).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(`Weiteren Wert ${i + 1} entfernen`, `Remove extra value ${i + 1}`)}
                  onClick={() => {
                    const next = (draft.measures || []).filter((_, j) => j !== i);
                    patch({ measures: next.length ? next : undefined });
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {(draft.measures?.length || 0) < 4 && fields.some(chartNumberField) && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  patch({
                    measures: [
                      ...(draft.measures || []),
                      { aggregate: "sum", field: fields.find(chartNumberField)!.id },
                    ],
                  })
                }
              >
                {t("+ Wert hinzufügen", "+ Add value")}
              </button>
            )}
            {!fields.some(chartNumberField) && (
              <small className="muted">{t("Braucht eine Zahl-, Formel- oder Rollup-Eigenschaft.", "Needs a number, formula or rollup property.")}</small>
            )}
          </fieldset>
        )}
        {draft.seriesField &&
          draft.kind !== "line" &&
          draft.kind !== "donut" && (
            <label>
              {t("Darstellung der Reihen", "Series layout")}
              <Select
                aria-label={t("Darstellung der Reihen", "Series layout")}
                value={
                  canStack(draft) ? draft.seriesMode || "grouped" : "grouped"
                }
                disabled={!canStack(draft)}
                onChange={(e) =>
                  patch({
                    seriesMode: e.target.value as ChartConfig["seriesMode"],
                  })
                }
              >
                <option value="grouped">{t("Nebeneinander", "Side by side")}</option>
                <option value="stacked">{t("Gestapelt", "Stacked")}</option>
              </Select>
            </label>
          )}
        {(draft.seriesField || !!draft.measures?.length) && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.showLegend !== false}
              onChange={(e) => patch({ showLegend: e.target.checked })}
            />
            {t("Legende anzeigen", "Show legend")}
          </label>
        )}
        <label>
          {t("Farben", "Colours")}
          <Select
            aria-label={t("Farbpalette", "Colour palette")}
            value={draft.palette || "default"}
            onChange={(e) =>
              patch({ palette: e.target.value as ChartConfig["palette"] })
            }
          >
            {Object.entries(chartPaletteNames).map(([key, label]) => (
              <option key={key} value={key}>
                {t(label)}
              </option>
            ))}
          </Select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.showGrid !== false}
            onChange={(e) => patch({ showGrid: e.target.checked })}
          />
          {t("Gitterlinien anzeigen", "Show grid lines")}
        </label>
        {draft.kind !== "donut" && (
          <>
            <label>
              {t("Beschriftung Gruppenachse", "Group axis label")}
              <input
                aria-label={t("Beschriftung Gruppenachse", "Group axis label")}
                maxLength={80}
                value={draft.groupAxisLabel || ""}
                onChange={(e) =>
                  patch({ groupAxisLabel: e.target.value || undefined })
                }
              />
            </label>
            <label>
              {t("Beschriftung Werteachse", "Value axis label")}
              <input
                aria-label={t("Beschriftung Werteachse", "Value axis label")}
                maxLength={80}
                value={draft.valueAxisLabel || ""}
                onChange={(e) =>
                  patch({ valueAxisLabel: e.target.value || undefined })
                }
              />
            </label>
            <div className="chart-range">
              <label>
                {t("Werteachse von", "Value axis from")}
                <input
                  aria-label={t("Werteachse von", "Value axis from")}
                  type="number"
                  step="any"
                  placeholder={t("Automatisch", "Automatic")}
                  value={draft.valueMin ?? ""}
                  onChange={(e) =>
                    patch({
                      valueMin:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                bis
                <input
                  aria-label={t("Werteachse bis", "Value axis to")}
                  type="number"
                  step="any"
                  placeholder={t("Automatisch", "Automatic")}
                  value={draft.valueMax ?? ""}
                  onChange={(e) =>
                    patch({
                      valueMax:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            {draft.valueMin !== undefined &&
              draft.valueMax !== undefined &&
              draft.valueMax <= draft.valueMin && (
                <p className="field-error" role="alert">
                  {t("Der Endwert muss größer als der Anfangswert sein; bis dahin wird automatisch skaliert.", "The end value must be greater than the start value; until then the scale is automatic.")}
                </p>
              )}
          </>
        )}
        <label>
          {t("Gruppen sortieren", "Sort groups")}
          <Select
            value={draft.order}
            onChange={(e) =>
              patch({ order: e.target.value as ChartConfig["order"] })
            }
          >
            <option value="label_asc">{t("Bezeichnung aufsteigend", "Label ascending")}</option>
            <option value="label_desc">{t("Bezeichnung absteigend", "Label descending")}</option>
            <option value="value_asc">{t("Wert aufsteigend", "Value ascending")}</option>
            <option value="value_desc">{t("Wert absteigend", "Value descending")}</option>
          </Select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.includeEmpty}
            onChange={(e) => patch({ includeEmpty: e.target.checked })}
          />
          {t("Einträge ohne Gruppierungswert anzeigen", "Show records without a grouping value")}
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.showValues}
            onChange={(e) => patch({ showValues: e.target.checked })}
          />
          {t("Werte im Diagramm anzeigen", "Show values in the chart")}
        </label>
      </fieldset>
      {invalid && <p role="alert">{invalid}</p>}
      {stale && (
        <div role="alert">
          <p>
            {t("Die Ansicht wurde inzwischen geändert. Dein Entwurf bleibt erhalten.", "The view was changed in the meantime. Your draft is kept.")}
          </p>
          <button
            type="button"
            className="button"
            onClick={() => {
              setDraft(initial);
              setBaseVersion(version);
              setDirty(false);
              setError("");
            }}
          >
            {t("Entwurf verwerfen und neu laden", "Discard draft and reload")}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        {editable && (
          <button
            className="button primary"
            disabled={busy || stale || !!invalid}
          >
            {t("Anwenden", "Apply")}
          </button>
        )}
      </div>
    </form>
  );
}
export default function DatabaseChart({
  view,
  version,
  fields,
  rows,
  related,
  members,
  editable,
  onSave,
  onOpenRow,
}: {
  view: View;
  version: number;
  fields: Field[];
  rows: Row[];
  related: Record<string, Row[]>;
  members: User[];
  editable: boolean;
  onSave: (c: ChartConfig, version: number) => Promise<unknown>;
  onOpenRow: (id: string) => void;
}) {
  const t = useT();
  const [settings, setSettings] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [tablePage, setTablePage] = useState(0),
    [entryPage, setEntryPage] = useState(0);
  const config = view.chart || defaultChart(fields),
    invalid = chartConfigError(config, fields),
    colors = paletteOf(config);
  const points = useMemo(
    () => chartPoints(rows, fields, config, related, members),
    [rows, fields, config, related, members],
  );
  const { series, values } = useMemo(
    () => chartSeries(points, fields, config, related, members),
    [points, fields, config, related, members],
  );
  const withSeries = series.length > 0 && config.kind !== "donut";
  // Further values: series are measures, a total across them means nothing.
  const measured = !!config.measures?.length && series.length > 0;
  // Selections address a group or a group/series pair.
  const [selectedGroup, selectedSeries] = (selected || "").split(SEP);
  const groupPoint = points.find((p) => p.key === selectedGroup);
  const seriesInfo = series.find((x) => x.key === selectedSeries);
  const selectedPoint: ChartPoint | undefined =
    groupPoint && selectedSeries !== undefined
      ? seriesInfo && {
          ...groupPoint,
          label: `${groupPoint.label} · ${seriesInfo.label}`,
          value: values.get(groupPoint.key)?.get(seriesInfo.key)?.value ?? null,
          rows: values.get(groupPoint.key)?.get(seriesInfo.key)?.rows || [],
        }
      : groupPoint;
  const title =
    config.aggregate === "count"
      ? t(chartAggregates.count)
      : `${t(chartAggregates[config.aggregate])} · ${fields.find((f) => f.id === config.yField)?.name || t("Eigenschaft fehlt", "Property missing")}`;
  const page = Math.min(
      tablePage,
      Math.max(0, Math.ceil(points.length / 50) - 1),
    ),
    detailPage = Math.min(
      entryPage,
      Math.max(0, Math.ceil((selectedPoint?.rows.length || 0) / 50) - 1),
    );
  const select = (key: string) => {
    setSelected(key);
    setEntryPage(0);
  };
  return (
    <section className="database-chart" aria-label={t("Datenbankdiagramm", "Database chart")}>
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <p className="muted">
            {rows.length} {t("Einträge ·", "records ·")}{" "}{points.length} {t("Gruppen", "Groups")}
          </p>
        </div>
        <div className="chart-actions">
          <button className="button compact" onClick={() => setSettings(true)}>
            <SlidersHorizontal size={16} />
            {t("Diagramm konfigurieren", "Configure chart")}
          </button>
          <button
            className="button compact"
            disabled={!!invalid || !points.length}
            onClick={() =>
              download(
                `${view.name}-Auswertung.csv`,
                Papa.unparse(
                  points.map((p) => ({
                    Gruppe: p.label,
                    ...(withSeries
                      ? Object.fromEntries(
                          series.map((x) => [
                            x.label,
                            values.get(p.key)?.get(x.key)?.value ?? null,
                          ]),
                        )
                      : {}),
                    // With further values the main value is already a column.
                    ...(measured ? {} : { [withSeries ? t("Gesamt", "Total") : t("Wert", "Value")]: p.value }),
                    Einträge: p.rows.length,
                  })),
                  { escapeFormulae: true },
                ),
                "text/csv;charset=utf-8",
              )
            }
          >
            <DownloadSimple size={16} />
            {t("Auswertung als CSV", "Results as CSV")}
          </button>
        </div>
      </div>
      {invalid ? (
        <p role="alert">{invalid}</p>
      ) : (
        <>
          {points.length > 100 && (
            <p role="status">
              {t("Im Diagramm werden die ersten 100 von", "The chart shows the first 100 of")}{" "}{points.length} {t("Gruppen dargestellt. Die Wertetabelle und der CSV-Export enthalten alle Gruppen.", "groups. The value table and the CSV export contain all groups.")}
            </p>
          )}
          <div
            className={`chart-scroll ${config.showGrid === false ? "no-grid" : ""}`}
            tabIndex={0}
            role="region"
            aria-label={t("Diagramm, bei Bedarf horizontal scrollen", "Chart, scroll horizontally if needed")}
          >
            {withSeries ? (
              <SeriesGraphic
                points={points}
                series={series}
                values={values}
                config={config}
                onSelect={select}
              />
            ) : (
              <ChartGraphic points={points} config={config} onSelect={select} />
            )}
          </div>
          {withSeries && config.showLegend !== false && (
            <ul className="chart-legend" aria-label={t("Legende", "Legend")}>
              {series.map((x, i) => (
                <li key={x.key}>
                  <span
                    className="chart-swatch"
                    style={{ background: colors[i % colors.length] }}
                  />
                  {x.label}
                </li>
              ))}
            </ul>
          )}
          {series.length > 0 && config.kind === "donut" && (
            <p className="muted" role="status">
              {t("Donutdiagramme zeigen keine Datenreihen; die Wertetabelle enthält die Aufschlüsselung.", "Donut charts show no series; the value table contains the breakdown.")}
            </p>
          )}
          <p className="chart-note muted">
            {t("Datenpunkt oder Gruppe auswählen, um Einträge zu öffnen. Mehrfachzuordnungen zählen in jeder Gruppe. Leere oder nicht numerische Messwerte werden ausgelassen; „–“ bedeutet kein berechenbarer Wert.", "Select a data point or group to open its records. Records in several groups count in each. Empty or non-numeric measures are left out; “–” means no computable value.")}
          </p>
          <div className="chart-table-scroll">
            <table className="chart-data">
              <caption>{t("Wertetabelle ·", "Value table ·")}{" "}{title}</caption>
              <thead>
                <tr>
                  <th>{t("Gruppe", "Group")}</th>
                  {series.map((x) => (
                    <th key={x.key}>{x.label}</th>
                  ))}
                  {!measured && <th>{series.length ? t("Gesamt", "Total") : t("Wert", "Value")}</th>}
                  <th>{t("Einträge", "Records")}</th>
                </tr>
              </thead>
              <tbody>
                {points.slice(page * 50, page * 50 + 50).map((p, i) => (
                  <tr key={p.key}>
                    <td>
                      <button onClick={() => select(p.key)}>
                        <span
                          className="chart-swatch"
                          style={{
                            background: colors[(page * 50 + i) % colors.length],
                          }}
                        />
                        {p.label}
                      </button>
                    </td>
                    {series.map((x) => (
                      <td key={x.key}>
                        <button
                          aria-label={t(`${p.label} · ${x.label}: Einträge anzeigen`, `${p.label} · ${x.label}: show records`)}
                          onClick={() => select(p.key + SEP + x.key)}
                        >
                          {format(values.get(p.key)?.get(x.key)?.value ?? null)}
                        </button>
                      </td>
                    ))}
                    {!measured && <td>{format(p.value)}</td>}
                    <td>{p.rows.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {points.length > 50 && (
            <div className="chart-pagination">
              <button
                className="button compact"
                disabled={!page}
                onClick={() => setTablePage(page - 1)}
              >
                {t("Vorherige Gruppen", "Previous groups")}
              </button>
              <span>
                {page + 1} / {Math.ceil(points.length / 50)}
              </span>
              <button
                className="button compact"
                disabled={(page + 1) * 50 >= points.length}
                onClick={() => setTablePage(page + 1)}
              >
                {t("Weitere Gruppen", "More groups")}
              </button>
            </div>
          )}
        </>
      )}
      {settings && (
        <Modal
          open
          title={t("Diagramm konfigurieren", "Configure chart")}
          onClose={() => setSettings(false)}
        >
          <ChartSettings
            initial={config}
            fields={fields}
            version={version}
            editable={editable}
            onSave={onSave}
            onClose={() => setSettings(false)}
          />
        </Modal>
      )}
      <Modal
        open={selected !== null}
        title={selectedPoint ? t(`Einträge · ${selectedPoint.label}`, `Records · ${selectedPoint.label}`) : t("Einträge", "Records")}
        onClose={() => setSelected(null)}
      >
        <p className="muted">
          {selectedPoint?.rows.length || 0} {t("Einträge ·", "records ·")}{" "}{title}:{" "}
          {format(selectedPoint?.value ?? null)}
        </p>
        <div className="chart-entry-list">
          {selectedPoint?.rows
            .slice(detailPage * 50, detailPage * 50 + 50)
            .map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelected(null);
                  onOpenRow(r.id);
                }}
              >
                <span>{cellText(r.cells.title) || t("Ohne Titel", "Untitled")}</span>
                {config.aggregate !== "count" && (
                  <small>{cellText(r.cells[config.yField || ""]) || "–"}</small>
                )}
              </button>
            ))}
        </div>
        {!selectedPoint && (
          <p>
            {t("Diese Gruppe ist in der aktuellen Auswertung nicht mehr enthalten.", "This group is no longer part of the current chart.")}
          </p>
        )}
        {selectedPoint && selectedPoint.rows.length > 50 && (
          <div className="chart-pagination">
            <button
              className="button compact"
              disabled={!detailPage}
              onClick={() => setEntryPage(detailPage - 1)}
            >
              {t("Zurück", "Back")}
            </button>
            <span>
              {detailPage + 1} / {Math.ceil(selectedPoint.rows.length / 50)}
            </span>
            <button
              className="button compact"
              disabled={(detailPage + 1) * 50 >= selectedPoint.rows.length}
              onClick={() => setEntryPage(detailPage + 1)}
            >
              {t("Weiter", "Next")}
            </button>
          </div>
        )}
      </Modal>
    </section>
  );
}
