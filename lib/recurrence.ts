import { z } from "zod";
import { Temporal, hasOffset, isTimed, validDateValue, validZone } from "./date-values";

// Repeating entries: the stored dates are the first occurrence; later ones
// are derived for display only and share the record.
// A real calendar day: "2026-02-30" would break every later calculation.
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(validDateValue, "Ungültiges Datum.");
export const recurrenceSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(99),
    until: calendarDay.optional(),
    count: z.number().int().min(2).max(1000).optional(),
    // Single occurrences that are skipped.
    exclude: z.array(calendarDay).max(200).optional(),
    // Monthly and yearly: the day of the month the series was started on,
    // when the stored first date is a clamped one (a series split at 28 Feb
    // of a series on the 31st goes on with 31 Mar).
    day: z.number().int().min(1).max(31).optional(),
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
// The calendar day of a stored date value in `zone`: a timed value with an
// offset is an instant, so 00:30 in Berlin is the day before in UTC. All-day
// and floating values keep their own date.
export function localDay(value: string, zone = "UTC") {
  if (!isTimed(value) || !hasOffset(value) || !validZone(zone))
    return value.slice(0, 10);
  return Temporal.Instant.from(value)
    .toZonedDateTimeISO(zone)
    .toPlainDate()
    .toString();
}
// Start dates (YYYY-MM-DD, local days in `zone`) of occurrences after the
// first one that fall into [from, to]. Month ends are clamped (31 Jan →
// 28/29 Feb).
export function occurrenceDates(
  start: string,
  rule: Recurrence,
  from: string,
  to: string,
  limit = 400,
  zone = "UTC",
) {
  const base = Temporal.PlainDate.from(localDay(start, zone)),
    first = Temporal.PlainDate.from(from),
    last = Temporal.PlainDate.from(to);
  const end =
    rule.until && Temporal.PlainDate.compare(rule.until, last) < 0
      ? Temporal.PlainDate.from(rule.until)
      : last;
  const anchor =
    rule.freq === "monthly" || rule.freq === "yearly" ? rule.day : undefined;
  const step = (k: number) => {
    const date = base.add({ [units[rule.freq]]: k * rule.interval });
    return anchor && anchor !== date.day
      ? date.with({ day: Math.min(anchor, date.daysInMonth) })
      : date;
  };
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
// Moves a stored date value to another day, keeping any time part. A timed
// value moves in `zone`, so 09:00 stays 09:00 across a clock change.
export function shiftDateValue(value: string, days: number, zone = "UTC") {
  if (isTimed(value) && hasOffset(value) && zone !== "UTC" && validZone(zone))
    return Temporal.Instant.from(value)
      .toZonedDateTimeISO(zone)
      .toPlainDateTime()
      .add({ days })
      .toZonedDateTime(zone, { disambiguation: "compatible" })
      .toInstant()
      .toString();
  return (
    Temporal.PlainDate.from(value.slice(0, 10)).add({ days }).toString() +
    value.slice(10)
  );
}
// The value of the occurrence on `date` (a local day from occurrenceDates).
export function occurrenceValue(
  value: string,
  first: string,
  date: string,
  zone = "UTC",
) {
  const days = Temporal.PlainDate.from(localDay(first, zone)).until(
    Temporal.PlainDate.from(date),
    { largestUnit: "days" },
  ).days;
  return shiftDateValue(value, days, zone);
}

/* ---------- Repeating records ("wiederkehrende Aufgabe") ---------- */

// Unlike a repeating entry above, a repeating record is a real record per
// occurrence: once it is done, the next one is created with its dates moved
// on (lib/repeat-records.ts). `field` is the date property that is moved;
// `date` below is a local day (localDay with the rule's `timeZone`);
// `weekdays` (ISO, 1 = Monday) picks days within a weekly rule; `day` keeps
// the day of the month for monthly and yearly rules, so 31 Jan → 28 Feb →
// 31 Mar instead of drifting to the 28th.
export const repeatSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(99).default(1),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  day: z.number().int().min(1).max(31).optional(),
  field: z.string().min(1).max(500),
  // The zone of the person who set the rule: a timed date is a day there
  // (Monday 18:00 in Los Angeles is Tuesday in UTC) and keeps its local time.
  timeZone: z.string().max(100).refine(validZone, "Ungültige Zeitzone.").optional(),
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

/* ---------- iCalendar (lib/calendar-feed.ts, lib/caldav.ts) ---------- */

const icsDay = (date: string) => date.slice(0, 10).replace(/-/g, "");
const icsInstant = (value: string) =>
  Temporal.Instant.from(value)
    .toString({ smallestUnit: "second" })
    .replace(/[-:]/g, "");
// The RRULE and EXDATE lines of a repeating entry whose DTSTART is `start`:
// an all-day date, or an instant sent in UTC. Clients expand a UTC DTSTART
// in UTC, so skipped dates (local days in `zone`) are sent as the instants
// that expansion gives. Month ends are clamped as in occurrenceDates
// (31 Jan → 28 Feb → 31 Mar), not skipped as a plain RFC 5545 rule would.
export function icsRecurrenceLines(rule: Recurrence, start: string, timed: boolean, zone = "UTC") {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`, `INTERVAL=${rule.interval}`];
  const first = Temporal.PlainDate.from(timed ? start.slice(0, 10) : start);
  const day = (rule.freq === "monthly" || rule.freq === "yearly") && rule.day ? rule.day : first.day;
  if (rule.freq === "monthly" && day > 28)
    parts.push(`BYMONTHDAY=${[28, 29, 30, 31].filter((d) => d <= day).join(",")}`, "BYSETPOS=-1");
  if (rule.freq === "yearly" && first.month === 2 && day === 29)
    parts.push("BYMONTH=2", "BYMONTHDAY=28,29", "BYSETPOS=-1");
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${icsDay(rule.until)}${timed ? "T235959Z" : ""}`);
  const lines = [`RRULE:${parts.join(";")}`];
  for (const skipped of rule.exclude || []) {
    if (!timed) {
      lines.push(`EXDATE;VALUE=DATE:${icsDay(skipped)}`);
      continue;
    }
    const days = Temporal.PlainDate.from(localDay(start, zone)).until(
      Temporal.PlainDate.from(skipped),
      { largestUnit: "days" },
    ).days;
    lines.push(`EXDATE:${icsInstant(Temporal.Instant.from(start).add({ hours: 24 * days }).toString())}`);
  }
  return lines;
}
