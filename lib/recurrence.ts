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
