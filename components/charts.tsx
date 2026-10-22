"use client";
// Small charts without a library, for the administration's monitoring:
// a sparkline, a line/area chart with a crosshair, stacked columns and a
// donut. SVG measured to its box (crisp text at any width, no horizontal
// scrolling), colours from the --chart-* tokens of app/globals.css (light
// and dark), a title and description for screen readers, keyboard and
// touch to read values (arrow keys, tap or drag), and the data as a table
// below each chart (ChartTable).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useT } from "./i18n";

import { SERIES } from "./sparkline";
export { SERIES, Sparkline } from "./sparkline";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// 0, a "nice" step and its multiples up to at least max.
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) || raw;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  if (ticks.length < 2) ticks.push(step);
  return ticks;
}

/* ---------- Shared pieces ---------- */

export type Series = { key: string; label: string; values: (number | null)[]; color?: number };

export function Legend({ items }: { items: { label: string; color: number; value?: string; line?: boolean }[] }) {
  return (
    <ul className="vz-legend">
      {items.map((item) => (
        <li key={item.label}>
          <i className={item.line ? "line" : undefined} style={{ background: SERIES[item.color] }} aria-hidden />
          {item.label}
          {item.value !== undefined && <strong>{item.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

// The chart's data as a table (collapsed): always there for screen
// readers, print and anyone who prefers numbers.
export function ChartTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  const t = useT();
  return (
    <details className="vz-table">
      <summary>{t("Als Tabelle", "As a table")}</summary>
      <div className="data-table-scroll">
        <table className="data-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// Which index the pointer or the keyboard points at, and the tooltip.
function useCursor(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const [announce, setAnnounce] = useState(false);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!count) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "End" ? count : e.key === "Home" ? -count : 0;
    if (!step) {
      if (e.key === "Escape") setIndex(null);
      return;
    }
    e.preventDefault();
    setAnnounce(true);
    setIndex((i) => Math.max(0, Math.min(count - 1, (i ?? (step > 0 ? -1 : count)) + step)));
  };
  return { index, setIndex, announce, setAnnounce, onKeyDown };
}

const MARGIN = { top: 10, right: 8, bottom: 22, left: 40 };

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  // Kept inside the chart: flips to the left of the cursor near the right edge.
  const right = x > width * 0.6;
  return (
    <div className="vz-tip" aria-hidden style={right ? { right: Math.max(0, width - x + 10) } : { left: Math.max(0, x + 10) }}>
      {children}
    </div>
  );
}

/* ---------- Line / area ---------- */

export function LineChart({
  title,
  description,
  x,
  series,
  formatX,
  formatTip,
  formatY = (n) => String(n),
  height = 200,
  area = true,
  maxY,
}: {
  title: string;
  description: string;
  // Time (ms) of each point.
  x: number[];
  series: Series[];
  // Axis labels (short) and the tooltip's heading (full).
  formatX: (at: number) => string;
  formatTip?: (at: number) => string;
  formatY?: (n: number) => string;
  height?: number;
  area?: boolean;
  maxY?: number;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const id = useId();
  const cursor = useCursor(x.length);
  const max = Math.max(maxY ?? 0, ...series.flatMap((s) => s.values.filter((v): v is number => typeof v === "number")));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const inner = { w: Math.max(10, width - MARGIN.left - MARGIN.right), h: height - MARGIN.top - MARGIN.bottom };
  const px = (i: number) => MARGIN.left + (x.length <= 1 ? inner.w : (i / (x.length - 1)) * inner.w);
  const py = (v: number) => MARGIN.top + (1 - v / (top || 1)) * inner.h;
  const paths = useMemo(
    () =>
      series.map((s) => {
        const parts: { line: string; area: string; dot: { x: number; y: number } | null }[] = [];
        let line = "",
          first = -1,
          last = -1;
        const close = () => {
          if (line)
            parts.push({
              line,
              area: `${line}L${px(last).toFixed(1)},${py(0).toFixed(1)}L${px(first).toFixed(1)},${py(0).toFixed(1)}Z`,
              // A lone value has no line: it shows as a dot.
              dot: first === last ? { x: px(first), y: py(s.values[first] as number) } : null,
            });
          line = "";
        };
        s.values.forEach((v, i) => {
          if (typeof v !== "number") return close();
          if (!line) first = i;
          last = i;
          line += `${line ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
        });
        close();
        return parts;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, height, top],
  );
  // About one x label per 90 px.
  const labelEvery = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(inner.w / 90))));
  const xLabels = x.map((at, i) => ({ at, i })).filter(({ i }) => i % labelEvery === 0 && px(i) < MARGIN.left + inner.w - 30);
  const pick = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rel = (e.clientX - rect.left - MARGIN.left) / inner.w;
    cursor.setAnnounce(false);
    cursor.setIndex(Math.max(0, Math.min(x.length - 1, Math.round(rel * (x.length - 1)))));
  };
  const i = cursor.index;
  return (
    <div className="vz" ref={box}>
      <div
        className="vz-plot"
        tabIndex={0}
        role="group"
        aria-label={`${title}. ${description}`}
        onKeyDown={cursor.onKeyDown}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={(e) => e.pointerType === "mouse" && cursor.setIndex(null)}
        onBlur={() => cursor.setIndex(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
            <title id={`${id}-title`}>{title}</title>
            <desc id={`${id}-desc`}>{description}</desc>
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={MARGIN.left} x2={MARGIN.left + inner.w} y1={py(tick)} y2={py(tick)} className="vz-grid" />
                <text x={MARGIN.left - 6} y={py(tick)} dy="0.32em" textAnchor="end" className="vz-axis">
                  {formatY(tick)}
                </text>
              </g>
            ))}
            {xLabels.map(({ at, i: index }) => (
              <text key={at} x={px(index)} y={height - 6} textAnchor={index === 0 ? "start" : "middle"} className="vz-axis">
                {formatX(at)}
              </text>
            ))}
            {paths.map((parts, s) =>
              parts.map((part, k) => (
                <g key={`${s}-${k}`}>
                  {area && <path d={part.area} fill={SERIES[series[s].color ?? s]} className="vz-area" />}
                  <path d={part.line} fill="none" stroke={SERIES[series[s].color ?? s]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {part.dot && <circle cx={part.dot.x} cy={part.dot.y} r={3} fill={SERIES[series[s].color ?? s]} />}
                </g>
              )),
            )}
            {i !== null && (
              <g>
                <line x1={px(i)} x2={px(i)} y1={MARGIN.top} y2={MARGIN.top + inner.h} className="vz-cursor" />
                {series.map((s, k) =>
                  typeof s.values[i] === "number" ? <circle key={s.key} cx={px(i)} cy={py(s.values[i] as number)} r={4} fill={SERIES[s.color ?? k]} className="vz-dot" /> : null,
                )}
              </g>
            )}
          </svg>
        )}
        {i !== null && width > 0 && (
          <Tooltip x={px(i)} width={width}>
            <strong>{(formatTip || formatX)(x[i])}</strong>
            {series.map((s, k) => (
              <span key={s.key} className="vz-tip-row">
                <i style={{ background: SERIES[s.color ?? k] }} />
                {s.label}
                <b>{typeof s.values[i] === "number" ? formatY(s.values[i] as number) : "–"}</b>
              </span>
            ))}
          </Tooltip>
        )}
      </div>
      {cursor.announce && (
        <p className="sr-only" aria-live="polite">
          {i !== null ? `${(formatTip || formatX)(x[i])}: ${series.map((s) => `${s.label} ${typeof s.values[i] === "number" ? formatY(s.values[i] as number) : "–"}`).join(", ")}` : ""}
        </p>
      )}
    </div>
  );
}

/* ---------- Stacked columns ---------- */

export function BarChart({
  title,
  description,
  labels,
  tips,
  series,
  formatY = (n) => String(n),
  height = 190,
  total = true,
}: {
  title: string;
  description: string;
  // Axis label per column (short) and the tooltip's heading (full).
  labels: string[];
  tips?: string[];
  series: Series[];
  formatY?: (n: number) => string;
  height?: number;
  // Show the column's sum in the tooltip (stacks of 2 or more).
  total?: boolean;
}) {
  const t = useT();
  const [box, width] = useWidth<HTMLDivElement>();
  const id = useId();
  const cursor = useCursor(labels.length);
  const sums = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const ticks = niceTicks(Math.max(...sums, 0));
  const top = ticks[ticks.length - 1];
  const inner = { w: Math.max(10, width - MARGIN.left - MARGIN.right), h: height - MARGIN.top - MARGIN.bottom };
  const slot = inner.w / Math.max(1, labels.length);
  const barW = Math.max(3, Math.min(28, slot * 0.62));
  const py = (v: number) => MARGIN.top + (1 - v / (top || 1)) * inner.h;
  const cx = (i: number) => MARGIN.left + slot * (i + 0.5);
  const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(inner.w / 48))));
  const pick = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    cursor.setAnnounce(false);
    cursor.setIndex(Math.max(0, Math.min(labels.length - 1, Math.floor((e.clientX - rect.left - MARGIN.left) / slot))));
  };
  const i = cursor.index;
  const tipText = (k: number) =>
    `${(tips || labels)[k]}: ${series.map((s) => `${s.label} ${formatY(s.values[k] || 0)}`).join(", ")}${series.length > 1 && total ? `, ${t("zusammen", "total")} ${formatY(sums[k])}` : ""}`;
  return (
    <div className="vz" ref={box}>
      <div
        className="vz-plot"
        tabIndex={0}
        role="group"
        aria-label={`${title}. ${description}`}
        onKeyDown={cursor.onKeyDown}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={(e) => e.pointerType === "mouse" && cursor.setIndex(null)}
        onBlur={() => cursor.setIndex(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
            <title id={`${id}-title`}>{title}</title>
            <desc id={`${id}-desc`}>{description}</desc>
            {ticks.map((tick) => (
              <g key={tick}>
                <line x1={MARGIN.left} x2={MARGIN.left + inner.w} y1={py(tick)} y2={py(tick)} className="vz-grid" />
                <text x={MARGIN.left - 6} y={py(tick)} dy="0.32em" textAnchor="end" className="vz-axis">
                  {formatY(tick)}
                </text>
              </g>
            ))}
            {i !== null && <rect x={MARGIN.left + slot * i} y={MARGIN.top} width={slot} height={inner.h} className="vz-hover" />}
            {labels.map((label, k) => {
              let base = 0;
              const parts = series
                .map((s, n) => ({ s, n, v: s.values[k] || 0 }))
                .filter((p) => p.v > 0);
              return (
                <g key={k}>
                  {parts.map((p, n) => {
                    const y0 = py(base),
                      y1 = py(base + p.v);
                    base += p.v;
                    const isTop = n === parts.length - 1;
                    // A 2 px gap between stacked parts (surface colour shows).
                    const h = Math.max(1, y0 - y1 - (isTop ? 0 : 2));
                    const r = isTop ? Math.min(4, barW / 2, h) : 0;
                    const xl = cx(k) - barW / 2;
                    const d = r
                      ? `M${xl},${y1 + h}V${y1 + r}Q${xl},${y1} ${xl + r},${y1}H${xl + barW - r}Q${xl + barW},${y1} ${xl + barW},${y1 + r}V${y1 + h}Z`
                      : `M${xl},${y1 + h}V${y1}H${xl + barW}V${y1 + h}Z`;
                    return <path key={p.s.key} d={d} fill={SERIES[p.s.color ?? p.n]} />;
                  })}
                  {k % labelEvery === 0 && (
                    <text x={cx(k)} y={height - 6} textAnchor="middle" className="vz-axis">
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {i !== null && width > 0 && (
          <Tooltip x={cx(i)} width={width}>
            <strong>{(tips || labels)[i]}</strong>
            {series.map((s, k) => (
              <span key={s.key} className="vz-tip-row">
                <i style={{ background: SERIES[s.color ?? k] }} />
                {s.label}
                <b>{formatY(s.values[i] || 0)}</b>
              </span>
            ))}
            {series.length > 1 && total && (
              <span className="vz-tip-row total">
                {t("Zusammen", "Total")}
                <b>{formatY(sums[i])}</b>
              </span>
            )}
          </Tooltip>
        )}
      </div>
      {cursor.announce && (
        <p className="sr-only" aria-live="polite">
          {i !== null ? tipText(i) : ""}
        </p>
      )}
    </div>
  );
}

/* ---------- Donut ---------- */

export function Donut({
  title,
  segments,
  format,
  center,
  centerLabel,
  size = 148,
}: {
  title: string;
  segments: { key: string; label: string; value: number; color: number }[];
  format: (n: number) => string;
  center: string;
  centerLabel: string;
  size?: number;
}) {
  const [active, setActive] = useState<string | null>(null);
  const sum = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = size / 2 - 10,
    stroke = 18;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const id = useId();
  return (
    <div className="vz-donut">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={`${id}-title`}>
        <title id={`${id}-title`}>{`${title}: ${segments.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`}</title>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="vz-track" strokeWidth={stroke} />
        {segments.map((s) => {
          const length = (s.value / sum) * circumference;
          // A 2 px gap between segments (only when there is room).
          const gap = segments.length > 1 && length > 4 ? 2 : 0;
          const el = (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={SERIES[s.color]}
              strokeWidth={active === s.key ? stroke + 4 : stroke}
              strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              opacity={active && active !== s.key ? 0.45 : 1}
            />
          );
          offset += length;
          return el;
        })}
        <text x="50%" y="47%" textAnchor="middle" className="vz-donut-value">
          {active ? format(segments.find((s) => s.key === active)?.value || 0) : center}
        </text>
        <text x="50%" y="61%" textAnchor="middle" className="vz-axis">
          {active ? segments.find((s) => s.key === active)?.label.slice(0, 22) : centerLabel}
        </text>
      </svg>
      <ul className="vz-legend vertical">
        {segments.map((s) => (
          <li key={s.key}>
            <button type="button" onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(s.key)} onBlur={() => setActive(null)} onClick={() => setActive((a) => (a === s.key ? null : s.key))}>
              <i style={{ background: SERIES[s.color] }} aria-hidden />
              <span>{s.label}</span>
              <strong>{format(s.value)}</strong>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
