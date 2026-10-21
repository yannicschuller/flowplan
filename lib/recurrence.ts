import { z } from "zod";
import { Temporal } from "./date-values";

// Repeating entries: the stored dates are the first occurrence; later ones
// are derived for display only and share the record.
export const recurrenceSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(99),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    count: z.number().int().min(2).max(1000).optional(),
    // Single occurrences that are skipped.
    exclude: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .max(200)
      .optional(),
  })
  .refine((r) => !(r.until && r.count), "Entweder Enddatum oder Anzahl.");
export type Recurrence = z.infer<typeof recurrenceSchema>;
export const recurrenceLabels: Record<Recurrence["freq"], [string, string]> = {
  daily: ["Täglich", "Tage"],
  weekly: ["Wöchentlich", "Wochen"],
  monthly: ["Monatlich", "Monate"],
  yearly: ["Jährlich", "Jahre"],
};
const units = {
  daily: "days",
  weekly: "weeks",
  monthly: "months",
  yearly: "years",
} as const;
export const OCCURRENCE_SEPARATOR = "::";
export function parseRecurrence(raw: unknown): Recurrence | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = recurrenceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function recurrenceText(rule: Recurrence) {
  const [label, plural] = recurrenceLabels[rule.freq];
  const base = rule.interval === 1 ? label : `Alle ${rule.interval} ${plural}`;
  return rule.until
    ? `${base} bis ${rule.until}`
    : rule.count
      ? `${base}, ${rule.count}-mal`
      : base;
}
// Start dates (YYYY-MM-DD) of occurrences after the first one that fall into
// [from, to]. Month ends are clamped (31 Jan → 28/29 Feb).
export function occurrenceDates(
  start: string,
  rule: Recurrence,
  from: string,
  to: string,
  limit = 400,
) {
  const base = Temporal.PlainDate.from(start.slice(0, 10)),
    first = Temporal.PlainDate.from(from),
    last = Temporal.PlainDate.from(to);
  const end =
    rule.until && Temporal.PlainDate.compare(rule.until, last) < 0
      ? Temporal.PlainDate.from(rule.until)
      : last;
  const step = (k: number) =>
    base.add({ [units[rule.freq]]: k * rule.interval });
  // Skip ahead for fixed-length steps instead of walking from the start.
  let k = 1;
  if (rule.freq === "daily" || rule.freq === "weekly") {
    const days = base.until(first, { largestUnit: "days" }).days;
    const size = rule.interval * (rule.freq === "weekly" ? 7 : 1);
    k = Math.max(1, Math.floor(days / size) - 1);
  }
  const dates: string[] = [];
  for (let guard = 0; guard < 20000 && dates.length < limit; guard++, k++) {
    if (rule.count && k >= rule.count) break;
    const date = step(k);
    if (Temporal.PlainDate.compare(date, end) > 0) break;
    if (
      Temporal.PlainDate.compare(date, first) >= 0 &&
      !rule.exclude?.includes(date.toString())
    )
      dates.push(date.toString());
  }
  return dates;
}
// Moves a stored date value to another day, keeping any time part.
export function shiftDateValue(value: string, days: number) {
  return (
    Temporal.PlainDate.from(value.slice(0, 10)).add({ days }).toString() +
    value.slice(10)
  );
}

/* ---------- Repeating records ("wiederkehrende Aufgabe") ---------- */

// Unlike a repeating entry above, a repeating record is a real record per
// occurrence: once it is done, the next one is created with its dates moved
// on (lib/repeat-records.ts). `field` is the date property that is moved;
// `weekdays` (ISO, 1 = Monday) picks days within a weekly rule; `day` keeps
// the day of the month for monthly and yearly rules, so 31 Jan → 28 Feb →
// 31 Mar instead of drifting to the 28th.
export const repeatSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(99).default(1),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  day: z.number().int().min(1).max(31).optional(),
  field: z.string().min(1).max(500),
});
export type RepeatRule = z.infer<typeof repeatSchema>;
export function parseRepeat(raw: unknown): RepeatRule | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = repeatSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
// The date (YYYY-MM-DD) of the occurrence after `date`.
export function nextOccurrence(
  date: string,
  rule: Pick<RepeatRule, "freq" | "interval" | "weekdays" | "day">,
) {
  const d = Temporal.PlainDate.from(date.slice(0, 10));
  const interval = rule.interval || 1;
  if (rule.freq === "daily") return d.add({ days: interval }).toString();
  if (rule.freq === "weekly") {
    const days = [...new Set(rule.weekdays || [])].sort((a, b) => a - b);
    if (!days.length) return d.add({ weeks: interval }).toString();
    // A later chosen day in the same week, else the first chosen day of the
    // week `interval` weeks on.
    const later = days.find((w) => w > d.dayOfWeek);
    if (later) return d.add({ days: later - d.dayOfWeek }).toString();
    const monday = d
      .subtract({ days: d.dayOfWeek - 1 })
      .add({ weeks: interval });
    return monday.add({ days: days[0] - 1 }).toString();
  }
  const moved = d.add(
    rule.freq === "monthly" ? { months: interval } : { years: interval },
  );
  // Yearly rules keep 29 Feb for leap years only through `day`.
  const day = Math.min(rule.day ?? d.day, moved.daysInMonth);
  return moved.with({ day }).toString();
}
