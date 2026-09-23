export const relativeDateNames = {
  today: "Heute",
  yesterday: "Gestern",
  tomorrow: "Morgen",
  this_week: "Diese Woche",
  last_week: "Letzte Woche",
  next_week: "Nächste Woche",
  this_month: "Dieser Monat",
  last_month: "Letzter Monat",
  next_month: "Nächster Monat",
  this_year: "Dieses Jahr",
  last_year: "Letztes Jahr",
  next_year: "Nächstes Jahr",
  last_7_days: "Letzte 7 Tage (inkl. heute)",
  last_30_days: "Letzte 30 Tage (inkl. heute)",
  next_7_days: "Nächste 7 Tage (inkl. heute)",
  next_30_days: "Nächste 30 Tage (inkl. heute)",
  past_days: "Letzte N Tage (inkl. heute)",
  next_days: "Nächste N Tage (inkl. heute)",
};
export type RelativeRange = keyof typeof relativeDateNames;
export const isRelativeOperator = (op: string) =>
  op === "in_relative" || op === "not_in_relative";
export function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
const dayMs = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    if (formatters.size >= 64)
      formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, result);
  }
  return result;
}
function ordinal(key: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const timestamp = Date.parse(key + "T00:00:00Z");
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === key
    ? timestamp / dayMs
    : NaN;
}
function zonedDay(date: Date, timeZone: string) {
  if (!Number.isFinite(date.getTime())) return NaN;
  const parts = formatter(timeZone).formatToParts(date),
    part = (type: string) => parts.find((p) => p.type === type)?.value;
  return ordinal(
    `${part("year")?.padStart(4, "0")}-${part("month")}-${part("day")}`,
  );
}
// Date-only cells are calendar dates. Time-bearing cells are instants, interpreted in the saved zone.
export function relativeCellDay(value: unknown, timeZone: string): number {
  if (typeof value !== "string") return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return ordinal(value);
  if (
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(
      value,
    ) ||
    !Number.isFinite(ordinal(value.slice(0, 10)))
  )
    return NaN;
  const normalized = value.replace(" ", "T"),
    date = new Date(
      /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
        ? normalized
        : normalized + "Z",
    );
  try {
    return zonedDay(date, timeZone);
  } catch {
    return NaN;
  }
}
export type RelativeWindow = { start: number; end: number };
const windows = new WeakMap<Date, Map<string, RelativeWindow | null>>();
export function relativeDateWindow(
  range: string,
  timeZone: string,
  days: number | undefined,
  now: Date,
): RelativeWindow | null {
  const key = JSON.stringify([range, timeZone, days]);
  let cache = windows.get(now);
  if (!cache) {
    cache = new Map();
    windows.set(now, cache);
  }
  if (cache.has(key)) return cache.get(key)!;
  const result = calculateWindow(range, timeZone, days, now);
  cache.set(key, result);
  return result;
}
function calculateWindow(
  range: string,
  timeZone: string,
  days: number | undefined,
  now: Date,
): RelativeWindow | null {
  if (!Object.hasOwn(relativeDateNames, range)) return null;
  let today: number;
  try {
    today = zonedDay(now, timeZone);
  } catch {
    return null;
  }
  if (!Number.isFinite(today)) return null;
  if (range === "today") return { start: today, end: today + 1 };
  if (range === "yesterday") return { start: today - 1, end: today };
  if (range === "tomorrow") return { start: today + 1, end: today + 2 };
  const date = new Date(today * dayMs);
  const offset = range.startsWith("last_")
    ? -1
    : range.startsWith("next_")
      ? 1
      : 0;
  if (range.endsWith("_week")) {
    const start = today - ((date.getUTCDay() + 6) % 7) + offset * 7;
    return { start, end: start + 7 };
  }
  if (range.endsWith("_month") || range.endsWith("_year")) {
    date.setUTCDate(1);
    if (range.endsWith("_year")) {
      date.setUTCMonth(0);
      date.setUTCFullYear(date.getUTCFullYear() + offset);
    } else date.setUTCMonth(date.getUTCMonth() + offset);
    const start = date.getTime() / dayMs;
    if (range.endsWith("_year")) date.setUTCFullYear(date.getUTCFullYear() + 1);
    else date.setUTCMonth(date.getUTCMonth() + 1);
    return { start, end: date.getTime() / dayMs };
  }
  const n = range.includes("_7_") ? 7 : range.includes("_30_") ? 30 : days;
  if (!Number.isInteger(n) || !n || n < 1 || n > 36600) return null;
  return range.startsWith("next_")
    ? { start: today, end: today + n }
    : { start: today - n + 1, end: today + 1 };
}
export function relativeWindowLabel(
  range: string,
  timeZone: string,
  days: number | undefined,
  now: Date,
) {
  const window = relativeDateWindow(range, timeZone, days, now);
  if (!window) return "Ungültiger Zeitraum";
  const label = (day: number) =>
    new Date(day * dayMs).toLocaleDateString("de-DE", {
      timeZone: "UTC",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  return `${label(window.start)} – ${label(window.end - 1)}`;
}
