// A trend without axes (tiles of the administration, KPI cards), kept apart
// from components/charts.tsx so the landing pages load only this. Colours
// from the --chart-* tokens of app/globals.css; gaps (null) stay gaps.

// Categorical colours in fixed order (validated for colour-blind separation
// in both themes); status colours are never used for series.
export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-other)"] as const;

export function Sparkline({ values, label, tone = 1, height = 32, area = true }: { values: (number | null)[]; label: string; tone?: 1 | 2 | 3 | 4 | 5; height?: number; area?: boolean }) {
  const all = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  // Before anything was collected there is nothing to show: the trend starts there.
  const numbers = all.slice(Math.max(0, all.findIndex((v) => v !== null)));
  const known = numbers.filter((v): v is number => v !== null);
  if (known.length < 2) return <span className="sparkline empty" aria-hidden style={{ height }} />;
  const max = Math.max(...known),
    min = Math.min(0, ...known);
  const span = max - min || 1;
  const w = 100,
    pad = 3;
  const x = (i: number) => (i / Math.max(1, numbers.length - 1)) * w;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  // Contiguous runs of values: one line (and area) each.
  const runs: { from: number; to: number; d: string }[] = [];
  numbers.forEach((v, i) => {
    if (v === null) return;
    const last = runs[runs.length - 1];
    if (last && last.to === i - 1) {
      last.d += `L${x(i).toFixed(2)},${y(v).toFixed(2)}`;
      last.to = i;
    } else runs.push({ from: i, to: i, d: `M${x(i).toFixed(2)},${y(v).toFixed(2)}` });
  });
  const color = SERIES[tone - 1];
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
      {runs.map((r) => (
        <g key={r.from}>
          {area && r.to > r.from && <path d={`${r.d}L${x(r.to).toFixed(2)},${height}L${x(r.from).toFixed(2)},${height}Z`} fill={color} className="vz-area" />}
          <path d={r.d} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}
