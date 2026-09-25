import { z } from "zod";
import {
  Temporal,
  validZone,
  validDateValue,
  isTimed,
  instantOf,
  localToInstant,
  hasOffset,
} from "./date-values";
import { scheduleFields, schedulePatch } from "./database-timeline";
import type { Field, Row, View } from "./types";

export const calendarSchema = z.object({
  mode: z.enum(["month", "week", "day"]),
  timeZone: z.string().max(100).refine(validZone, "Ungültige Zeitzone."),
  // First column of weeks (default Monday) and whether Sat/Sun are shown.
  weekStart: z.enum(["monday", "sunday"]).optional(),
  showWeekends: z.boolean().optional(),
});
export const isWeekend = (date: string) =>
  Temporal.PlainDate.from(date).dayOfWeek >= 6;
// Weekday labels in display order.
export function weekdayLabels(
  config: Pick<CalendarConfig, "weekStart" | "showWeekends">,
) {
  const labels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const ordered =
    config.weekStart === "sunday" ? ["So", ...labels.slice(0, 6)] : labels;
  return config.showWeekends === false
    ? ordered.filter((l) => l !== "Sa" && l !== "So")
    : ordered;
}
export type CalendarConfig = z.infer<typeof calendarSchema>;
export const calendarChangeSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("set-range"),
    start: z.string().max(80),
    end: z.string().max(80),
    timeZone: z.string().max(100),
  }),
  z.object({
    operation: z.literal("move-calendar"),
    days: z.number().int().min(-366000).max(366000),
    timeZone: z.string().max(100),
  }),
  z.object({
    operation: z.enum(["move-time", "resize-time-start", "resize-time-end"]),
    at: z.string().max(80),
    timeZone: z.string().max(100),
  }),
]);
export type CalendarChange = z.infer<typeof calendarChangeSchema>;
export type CalendarRange = {
  timed: boolean;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  implicitEnd: boolean;
};
export function calendarRange(
  row: Pick<Row, "cells">,
  fields: Field[],
  view: View,
  zone: string,
): CalendarRange | null {
  const { start, end, invalidEnd } = scheduleFields(fields, view),
    a = row.cells[start?.id || ""],
    b = row.cells[end?.id || ""];
  if (!start || invalidEnd || !validDateValue(a) || (b && !validDateValue(b)))
    return null;
  try {
    if (isTimed(a)) {
      if (b && !isTimed(b)) return null;
      const first = instantOf(a, zone),
        last = b ? instantOf(String(b), zone) : first.add({ hours: 1 });
      if (Temporal.Instant.compare(first, last) >= 0) return null;
      return {
        timed: true,
        start: first.toString(),
        end: last.toString(),
        startMs: first.epochMilliseconds,
        endMs: last.epochMilliseconds,
        implicitEnd: !b,
      };
    }
    if (b && isTimed(b)) return null;
    const last = b ? String(b) : a;
    if (last < a) return null;
    return {
      timed: false,
      start: a,
      end: last,
      startMs: 0,
      endMs: 0,
      implicitEnd: !b,
    };
  } catch {
    return null;
  }
}
export function calendarPatch(
  row: Pick<Row, "cells">,
  fields: Field[],
  view: View,
  change: CalendarChange,
) {
  const { start, end, invalidEnd } = scheduleFields(fields, view),
    zone = change.timeZone;
  if (!start || invalidEnd)
    throw new Error(
      "Gültige, unterschiedliche Datumsfelder für Beginn und Ende auswählen.",
    );
  if (!validZone(zone)) throw new Error("Ungültige Zeitzone.");
  // The caller may use a personal display zone in a read-only linked view.
  // scheduleRow still checks the captured view version and source write rights.
  const checked = (a: string, b: string) => {
    if (!validDateValue(a) || (b && !validDateValue(b)))
      throw new Error("Bitte gültige Datumswerte eingeben.");
    if (!end && b)
      throw new Error(
        "Für einen Zeitraum ein separates Enddatumsfeld auswählen.",
      );
    const cells = { [start.id]: a, ...(end ? { [end.id]: b } : {}) };
    if (!calendarRange({ cells }, fields, view, zone))
      throw new Error(
        "Beginn und Ende müssen beide ganztägig oder mit Uhrzeit sein. Das Ende muss nach dem Beginn liegen.",
      );
    return cells;
  };
  if (change.operation === "set-range") {
    const normalize = (v: string) =>
      isTimed(v) ? instantOf(v, zone).toString() : v;
    return checked(
      normalize(change.start),
      change.end ? normalize(change.end) : "",
    );
  }
  const range = calendarRange(row, fields, view, zone);
  if (!range) throw new Error("Zuerst einen gültigen Zeitraum festlegen.");
  if (change.operation === "move-calendar" && !range.timed)
    return schedulePatch(row, fields, view, {
      operation: "move",
      days: change.days,
    });
  if (!range.timed) throw new Error("Dieser Termin hat keine Uhrzeit.");
  let first = Temporal.Instant.from(range.start),
    last = Temporal.Instant.from(range.end);
  if (change.operation === "move-calendar") {
    const target = first
      .toZonedDateTimeISO(zone)
      .toPlainDateTime()
      .add({ days: change.days });
    first = Temporal.Instant.from(localToInstant(target.toString(), zone));
    last = first.add({ milliseconds: range.endMs - range.startMs });
  } else {
    if (!validDateValue(change.at) || !hasOffset(change.at))
      throw new Error(
        "Ein eindeutiger Zeitpunkt mit Zeitzonenoffset ist erforderlich.",
      );
    const at = instantOf(change.at, zone);
    if (change.operation === "move-time") {
      first = at;
      last = at.add({ milliseconds: range.endMs - range.startMs });
    } else {
      if (!end)
        throw new Error("Für Größenänderungen ein Enddatumsfeld auswählen.");
      if (change.operation === "resize-time-start") first = at;
      else last = at;
    }
  }
  return checked(
    first.toString(),
    range.implicitEnd &&
      (change.operation === "move-calendar" || change.operation === "move-time")
      ? ""
      : last.toString(),
  );
}
export function calendarDays(
  anchor: string,
  mode: CalendarConfig["mode"],
  zone: string,
  weekStart: CalendarConfig["weekStart"] = "monday",
) {
  let first = Temporal.PlainDate.from(anchor);
  if (mode === "month") first = first.with({ day: 1 });
  if (mode !== "day")
    first = first.subtract({
      days: weekStart === "sunday" ? first.dayOfWeek % 7 : first.dayOfWeek - 1,
    });
  return Array.from(
    { length: mode === "month" ? 42 : mode === "week" ? 7 : 1 },
    (_, i) => {
      const date = first.add({ days: i }),
        start = date.toZonedDateTime(zone),
        end = date.add({ days: 1 }).toZonedDateTime(zone);
      return {
        date: date.toString(),
        start: start.epochMilliseconds,
        end: end.epochMilliseconds,
        minutes: (end.epochMilliseconds - start.epochMilliseconds) / 60000,
      };
    },
  );
}
export type CalendarDay = ReturnType<typeof calendarDays>[number];
export function rangeOnDay(range: CalendarRange, day: CalendarDay) {
  return range.timed
    ? range.startMs < day.end && range.endMs > day.start
    : range.start <= day.date && range.end >= day.date;
}
export type CalendarSegment = {
  row: Row;
  range: CalendarRange;
  start: number;
  end: number;
  column: number;
  columns: number;
};
export function daySegments(
  rows: Row[],
  fields: Field[],
  view: View,
  zone: string,
  day: CalendarDay,
  ranges?: Map<string, CalendarRange | null>,
) {
  const segments: CalendarSegment[] = [];
  for (const row of rows) {
    const range = ranges
      ? ranges.get(row.id)
      : calendarRange(row, fields, view, zone);
    if (range?.timed && rangeOnDay(range, day))
      segments.push({
        row,
        range,
        start: Math.max(range.startMs, day.start),
        end: Math.min(range.endMs, day.end),
        column: 0,
        columns: 1,
      });
  }
  segments.sort(
    (a, b) =>
      a.start - b.start || b.end - a.end || a.row.id.localeCompare(b.row.id),
  );
  let group: CalendarSegment[] = [],
    ends: number[] = [];
  const finish = () => {
    for (const item of group) item.columns = ends.length;
    group = [];
    ends = [];
  };
  for (const item of segments) {
    // Account for a minimum 20-minute hit area in the overlap layout too.
    if (ends.length && ends.every((end) => end <= item.start)) finish();
    const free = ends.findIndex((end) => end <= item.start);
    item.column = free < 0 ? ends.length : free;
    ends[item.column] = Math.max(item.end, item.start + 20 * 60000);
    group.push(item);
  }
  finish();
  return segments;
}
