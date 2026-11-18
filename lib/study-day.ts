// The study day of flashcards (docs/specs/flashcards.md §4.5): it starts at
// 04:00 (`dayStart`) in the person's time zone, not at midnight and never in
// UTC or the server's zone. A study day is named by its calendar date
// ('YYYY-MM-DD') – the date of the local wall time minus `dayStart` hours.
// Only Temporal (lib/date-values.ts) – never Date#getDate() – so the result
// is the same on a server in UTC, in any other TZ, and in the browser.
// Client-safe.
import { Temporal, validZone } from "./date-values";

export const DEFAULT_DAY_START = 4;

// A zone that works: the given one, else the fallback, else UTC.
export function studyZone(zone: unknown, fallback?: string | null) {
  if (typeof zone === "string" && validZone(zone)) return zone;
  if (fallback && validZone(fallback)) return fallback;
  return "UTC";
}
const hourOf = (dayStart: number) => (Number.isInteger(dayStart) && dayStart >= 0 && dayStart <= 23 ? dayStart : DEFAULT_DAY_START);

// The study day of an instant.
export function studyDay(ms: number, zone: string, dayStart = DEFAULT_DAY_START): string {
  const local = Temporal.Instant.fromEpochMilliseconds(Math.floor(ms)).toZonedDateTimeISO(zone).toPlainDateTime();
  return local.subtract({ hours: hourOf(dayStart) }).toPlainDate().toString();
}
// When a study day begins (ms): 04:00 local on its date. A day whose 04:00
// falls into a gap of a clock change begins at the first instant after it
// ("compatible", as Temporal and the calendar do it).
export function studyDayStart(day: string, zone: string, dayStart = DEFAULT_DAY_START): number {
  const date = Temporal.PlainDate.from(day);
  return date
    .toPlainDateTime(new Temporal.PlainTime(hourOf(dayStart)))
    .toZonedDateTime(zone, { disambiguation: "compatible" }).epochMilliseconds;
}
export function addDays(day: string, n: number) {
  return Temporal.PlainDate.from(day).add({ days: n }).toString();
}
// Whole days from a to b (b later: positive).
export function daysBetween(a: string, b: string) {
  return Temporal.PlainDate.from(a).until(Temporal.PlainDate.from(b), { largestUnit: "days" }).days;
}
// The day of an instant and the bounds of that day.
export function studyClock(ms: number, zone: string, dayStart = DEFAULT_DAY_START) {
  const day = studyDay(ms, zone, dayStart);
  return { day, start: studyDayStart(day, zone, dayStart), end: studyDayStart(addDays(day, 1), zone, dayStart) };
}
// FSRS counts days between reviews in study days (lib/fsrs): an instant on
// a "virtual" clock where every study day is a UTC day of 24 hours, so a
// library that counts UTC dates counts study days. Within a day the time
// since its start is kept (a day of 23 or 25 hours is cut to 24).
export function virtualTime(ms: number, zone: string, dayStart = DEFAULT_DAY_START) {
  const { day, start } = studyClock(ms, zone, dayStart);
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + Math.min(Math.max(ms - start, 0), 86_400_000 - 1);
}
// The study day a virtual instant falls on.
export const virtualDay = (virtual: number) => new Date(virtual).toISOString().slice(0, 10);

// The daily study reminder (docs/specs/flashcards.md §10.3,
// lib/study-reminders.ts): a local time 'HH:MM'. Its moment within a study
// day: that wall time on the day's date – or, for a time before the day's
// start (02:00 with the day starting at 04:00), on the next date, which
// still belongs to the day.
export const REMIND_AT = /^([01]\d|2[0-3]):[0-5]\d$/;
export function reminderMoment(day: string, remindAt: string, zone: string, dayStart = DEFAULT_DAY_START): number {
  const [hour, minute] = remindAt.split(":").map(Number);
  const date = Temporal.PlainDate.from(day).add({ days: hour < hourOf(dayStart) ? 1 : 0 });
  return date.toPlainDateTime(new Temporal.PlainTime(hour, minute)).toZonedDateTime(zone, { disambiguation: "compatible" }).epochMilliseconds;
}
