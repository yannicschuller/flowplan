// The colours of the charts (components/charts.tsx, components/sparkline.tsx,
// app/globals.css --chart-*). Several series: the categorical palette in
// fixed order, validated for colour-blind separation in both themes. A
// chart of one colour – one series in the first colour, a sparkline, a
// usage ring – follows the workspace's accent (#590, --chart-accent: the
// accent as the look derives it per mode, readable on every background;
// Flowplan's own --chart-1 without a look). Status colours are never used
// for series.
export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-other)"] as const;
export const ACCENT_SERIES = "var(--chart-accent)";

// The colour of series `index` (its own `color` if it has one) in a chart
// of `count` series: alone and in the first colour, the accent; otherwise
// the palette (another colour chosen on purpose – errors, storage – stays).
export function seriesColor(color: number | undefined, index: number, count: number): string {
  const n = color ?? index;
  return count === 1 && n === 0 ? ACCENT_SERIES : SERIES[n] ?? SERIES[SERIES.length - 1];
}
