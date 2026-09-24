"use client";
import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { DownloadSimple, SlidersHorizontal } from "@phosphor-icons/react";
import {
  chartAggregates,
  chartConfigError,
  chartDateField,
  chartGroupField,
  chartKinds,
  chartNumberField,
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
const colors = [
  "#4f70d5",
  "#299287",
  "#b07826",
  "#8d62bb",
  "#c26373",
  "#51849b",
  "#8c853b",
  "#9c6d56",
];
const format = (n: number | null) =>
  n === null
    ? "–"
    : new Intl.NumberFormat("de-DE", { maximumFractionDigits: 4 }).format(n);
const short = (s: string) => (s.length > 22 ? s.slice(0, 20) + "…" : s);
function ChartGraphic({
  points,
  config,
  onSelect,
}: {
  points: ChartPoint[];
  config: ChartConfig;
  onSelect: (key: string) => void;
}) {
  const available = points.slice(0, 100),
    values = available.map((p) => p.value ?? 0);
  const max = Math.max(0, ...values),
    min = Math.min(0, ...values);
  // Normalize first to avoid overflowing a domain containing large positive and negative values.
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const lo = min / magnitude,
    hi = max / magnitude || (min === 0 ? 1 : 0),
    span = hi - lo;
  const scale = (v: number) => (v / magnitude - lo) / span;
  const label = (p: ChartPoint) =>
    `${p.label}: ${format(p.value)} · ${p.rows.length} Einträge`;
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
        Keine Daten für diese Auswertung. Passe Filter, Suche oder Gruppierung
        an.
      </p>
    );
  if (config.kind === "donut") {
    if (available.some((p) => p.value !== null && p.value < 0))
      return (
        <p role="status">
          Ein Donut kann negative Werte nicht darstellen. Wähle Balken oder
          Linie. Alle Ergebnisse stehen in der Wertetabelle.
        </p>
      );
    const total = available.reduce(
      (sum, p) => sum + (p.value ?? 0) / magnitude,
      0,
    );
    if (!total)
      return (
        <p role="status">
          Für einen Donut werden positive Werte benötigt. Alle Ergebnisse stehen
          in der Wertetabelle.
        </p>
      );
    let offset = 0;
    return (
      <svg
        viewBox="0 0 440 330"
        width="440"
        height="330"
        className="chart-donut"
        aria-label="Donutdiagramm"
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
          Gruppen
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
        aria-label="Balkendiagramm"
      >
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
      aria-label={config.kind === "line" ? "Liniendiagramm" : "Säulendiagramm"}
    >
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
  const max = Math.max(0, ...extents),
    min = Math.min(0, ...extents);
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const lo = min / magnitude,
    hi = max / magnitude || (min === 0 ? 1 : 0),
    span = hi - lo;
  const scale = (v: number) => (v / magnitude - lo) / span;
  const label = (p: ChartPoint, s: ChartSeries) =>
    `${p.label} · ${s.label}: ${format(cell(p, s).value)} · ${cell(p, s).rows.length} Einträge`;
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
        Keine Daten für diese Auswertung. Passe Filter, Suche oder Gruppierung
        an.
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
        aria-label="Balkendiagramm mit Datenreihen"
      >
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
          ? "Liniendiagramm mit Datenreihen"
          : "Säulendiagramm mit Datenreihen"
      }
    >
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
              "Das Diagramm konnte nicht gespeichert werden. Bitte erneut versuchen.",
            );
        } catch {
          setError("Speichern fehlgeschlagen.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="schema-settings" disabled={busy || !editable}>
        <label>
          Diagrammtyp
          <select
            value={draft.kind}
            onChange={(e) =>
              patch({ kind: e.target.value as ChartConfig["kind"] })
            }
          >
            {Object.entries(chartKinds).map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Gruppierung
          <select
            value={draft.xField || ""}
            onChange={(e) => patch({ xField: e.target.value || undefined })}
          >
            <option value="">Alle Einträge</option>
            {fields.filter(chartGroupField).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {chartDateField(fields.find((f) => f.id === draft.xField)) && (
          <label>
            Datumsintervall
            <select
              value={draft.dateBucket}
              onChange={(e) =>
                patch({
                  dateBucket: e.target.value as ChartConfig["dateBucket"],
                })
              }
            >
              <option value="day">Tag</option>
              <option value="week">Woche (Montag–Sonntag)</option>
              <option value="month">Monat</option>
              <option value="year">Jahr</option>
            </select>
          </label>
        )}
        <label>
          Berechnung
          <select
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
                {title}
              </option>
            ))}
          </select>
        </label>
        {draft.aggregate !== "count" && (
          <label>
            Messwert
            <select
              value={draft.yField || ""}
              onChange={(e) => patch({ yField: e.target.value || undefined })}
            >
              <option value="">Eigenschaft wählen</option>
              {fields.filter(chartNumberField).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Datenreihen
          <select
            aria-label="Datenreihen"
            value={draft.seriesField || ""}
            onChange={(e) =>
              patch({ seriesField: e.target.value || undefined })
            }
          >
            <option value="">Keine (eine Reihe)</option>
            {fields
              .filter((f) => chartGroupField(f) && f.id !== draft.xField)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </label>
        {draft.seriesField &&
          draft.kind !== "line" &&
          draft.kind !== "donut" && (
            <label>
              Darstellung der Reihen
              <select
                aria-label="Darstellung der Reihen"
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
                <option value="grouped">Nebeneinander</option>
                <option value="stacked">Gestapelt</option>
              </select>
            </label>
          )}
        {draft.seriesField && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft.showLegend !== false}
              onChange={(e) => patch({ showLegend: e.target.checked })}
            />
            Legende anzeigen
          </label>
        )}
        <label>
          Gruppen sortieren
          <select
            value={draft.order}
            onChange={(e) =>
              patch({ order: e.target.value as ChartConfig["order"] })
            }
          >
            <option value="label_asc">Bezeichnung aufsteigend</option>
            <option value="label_desc">Bezeichnung absteigend</option>
            <option value="value_asc">Wert aufsteigend</option>
            <option value="value_desc">Wert absteigend</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.includeEmpty}
            onChange={(e) => patch({ includeEmpty: e.target.checked })}
          />
          Einträge ohne Gruppierungswert anzeigen
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.showValues}
            onChange={(e) => patch({ showValues: e.target.checked })}
          />
          Werte im Diagramm anzeigen
        </label>
      </fieldset>
      {invalid && <p role="alert">{invalid}</p>}
      {stale && (
        <div role="alert">
          <p>
            Die Ansicht wurde inzwischen geändert. Dein Entwurf bleibt erhalten.
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
            Entwurf verwerfen und neu laden
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Abbrechen
        </button>
        {editable && (
          <button
            className="button primary"
            disabled={busy || stale || !!invalid}
          >
            Anwenden
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
  const [settings, setSettings] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [tablePage, setTablePage] = useState(0),
    [entryPage, setEntryPage] = useState(0);
  const config = view.chart || defaultChart(fields),
    invalid = chartConfigError(config, fields);
  const points = useMemo(
    () => chartPoints(rows, fields, config, related, members),
    [rows, fields, config, related, members],
  );
  const { series, values } = useMemo(
    () => chartSeries(points, fields, config, related, members),
    [points, fields, config, related, members],
  );
  const withSeries = series.length > 0 && config.kind !== "donut";
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
      ? chartAggregates.count
      : `${chartAggregates[config.aggregate]} · ${fields.find((f) => f.id === config.yField)?.name || "Eigenschaft fehlt"}`;
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
    <section className="database-chart" aria-label="Datenbankdiagramm">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <p className="muted">
            {rows.length} Einträge · {points.length} Gruppen
          </p>
        </div>
        <div className="chart-actions">
          <button className="button compact" onClick={() => setSettings(true)}>
            <SlidersHorizontal size={16} />
            Diagramm konfigurieren
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
                    [withSeries ? "Gesamt" : "Wert"]: p.value,
                    Einträge: p.rows.length,
                  })),
                  { escapeFormulae: true },
                ),
                "text/csv;charset=utf-8",
              )
            }
          >
            <DownloadSimple size={16} />
            Auswertung als CSV
          </button>
        </div>
      </div>
      {invalid ? (
        <p role="alert">{invalid}</p>
      ) : (
        <>
          {points.length > 100 && (
            <p role="status">
              Im Diagramm werden die ersten 100 von {points.length} Gruppen
              dargestellt. Die Wertetabelle und der CSV-Export enthalten alle
              Gruppen.
            </p>
          )}
          <div
            className="chart-scroll"
            tabIndex={0}
            role="region"
            aria-label="Diagramm, bei Bedarf horizontal scrollen"
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
            <ul className="chart-legend" aria-label="Legende">
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
              Donutdiagramme zeigen keine Datenreihen; die Wertetabelle enthält
              die Aufschlüsselung.
            </p>
          )}
          <p className="chart-note muted">
            Datenpunkt oder Gruppe auswählen, um Einträge zu öffnen.
            Mehrfachzuordnungen zählen in jeder Gruppe. Leere oder nicht
            numerische Messwerte werden ausgelassen; „–“ bedeutet kein
            berechenbarer Wert.
          </p>
          <div className="chart-table-scroll">
            <table className="chart-data">
              <caption>Wertetabelle · {title}</caption>
              <thead>
                <tr>
                  <th>Gruppe</th>
                  {series.map((x) => (
                    <th key={x.key}>{x.label}</th>
                  ))}
                  <th>{series.length ? "Gesamt" : "Wert"}</th>
                  <th>Einträge</th>
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
                          aria-label={`${p.label} · ${x.label}: Einträge anzeigen`}
                          onClick={() => select(p.key + SEP + x.key)}
                        >
                          {format(values.get(p.key)?.get(x.key)?.value ?? null)}
                        </button>
                      </td>
                    ))}
                    <td>{format(p.value)}</td>
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
                Vorherige Gruppen
              </button>
              <span>
                {page + 1} / {Math.ceil(points.length / 50)}
              </span>
              <button
                className="button compact"
                disabled={(page + 1) * 50 >= points.length}
                onClick={() => setTablePage(page + 1)}
              >
                Weitere Gruppen
              </button>
            </div>
          )}
        </>
      )}
      {settings && (
        <Modal
          open
          title="Diagramm konfigurieren"
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
        title={selectedPoint ? `Einträge · ${selectedPoint.label}` : "Einträge"}
        onClose={() => setSelected(null)}
      >
        <p className="muted">
          {selectedPoint?.rows.length || 0} Einträge · {title}:{" "}
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
                <span>{cellText(r.cells.title) || "Ohne Titel"}</span>
                {config.aggregate !== "count" && (
                  <small>{cellText(r.cells[config.yField || ""]) || "–"}</small>
                )}
              </button>
            ))}
        </div>
        {!selectedPoint && (
          <p>
            Diese Gruppe ist in der aktuellen Auswertung nicht mehr enthalten.
          </p>
        )}
        {selectedPoint && selectedPoint.rows.length > 50 && (
          <div className="chart-pagination">
            <button
              className="button compact"
              disabled={!detailPage}
              onClick={() => setEntryPage(detailPage - 1)}
            >
              Zurück
            </button>
            <span>
              {detailPage + 1} / {Math.ceil(selectedPoint.rows.length / 50)}
            </span>
            <button
              className="button compact"
              disabled={(detailPage + 1) * 50 >= selectedPoint.rows.length}
              onClick={() => setEntryPage(detailPage + 1)}
            >
              Weiter
            </button>
          </div>
        )}
      </Modal>
    </section>
  );
}
