import { z } from "zod";
import type { Field, Row, View } from "./types";
export const timelineSchema = z.object({
  scale: z.enum(["week", "month", "quarter", "year"]),
  showWeekends: z.boolean(),
});
export type TimelineConfig = z.infer<typeof timelineSchema>;
export const defaultTimeline: TimelineConfig = {
  scale: "month",
  showWeekends: true,
};
export const DAY = 86400000;
export function dateDay(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(
      value,
    )
  )
    return null;
  const day = value.slice(0, 10),
    time = Date.parse(day + "T00:00:00Z");
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== day ||
    day < "0001-01-01" ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return time / DAY;
}
export function dayKey(day: number) {
  const value = new Date(day * DAY).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01")
    throw new Error("Datum liegt außerhalb des unterstützten Bereichs.");
  return value;
}
export function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function scheduleFields(fields: Field[], view: View) {
  const start = view.dateField
    ? fields.find((f) => f.id === view.dateField && f.type === "date")
    : fields.find((f) => f.type === "date");
  const end = view.endDateField
    ? fields.find((f) => f.id === view.endDateField && f.type === "date")
    : undefined;
  return {
    start,
    end: end?.id === start?.id ? undefined : end,
    invalidEnd: !!view.endDateField && (!end || end.id === start?.id),
  };
}
export function rowRange(row: Pick<Row, "cells">, start?: Field, end?: Field) {
  const a = dateDay(row.cells[start?.id || ""]),
    rawEnd = row.cells[end?.id || ""],
    b = rawEnd ? dateDay(rawEnd) : a;
  return a !== null && b !== null && b >= a ? { start: a, end: b } : null;
}
export type ScheduleChange =
  | { operation: "move" | "resize-start" | "resize-end"; days: number }
  | { operation: "set"; start: string; end: string };
export function schedulePatch(
  row: Pick<Row, "cells">,
  fields: Field[],
  view: View,
  change: ScheduleChange,
) {
  const { start, end, invalidEnd } = scheduleFields(fields, view);
  if (!start || invalidEnd)
    throw new Error(
      "Gültige, unterschiedliche Datumsfelder für Beginn und Ende auswählen.",
    );
  const keepTime = (field: Field, day: number) => {
    const previous = row.cells[field.id];
    return (
      dayKey(day) +
      (dateDay(previous) !== null && typeof previous === "string"
        ? previous.slice(10)
        : "")
    );
  };
  if (change.operation === "set") {
    const a = dateDay(change.start),
      b = change.end ? dateDay(change.end) : a;
    if (a === null || b === null || b < a)
      throw new Error("Das Ende darf nicht vor dem Beginn liegen.");
    if (!end && change.end && a !== b)
      throw new Error(
        "Für einen Zeitraum ein separates Enddatumsfeld auswählen.",
      );
    return {
      [start.id]: keepTime(start, a),
      ...(end ? { [end.id]: change.end ? keepTime(end, b) : "" } : {}),
    };
  }
  const range = rowRange(row, start, end);
  if (!range) throw new Error("Zuerst einen gültigen Zeitraum festlegen.");
  if (!Number.isInteger(change.days) || Math.abs(change.days) > 366000)
    throw new Error("Ungültige Datumsverschiebung.");
  if (change.operation !== "move" && !end)
    throw new Error("Für Größenänderungen ein Enddatumsfeld auswählen.");
  const a = range.start + (change.operation !== "resize-end" ? change.days : 0),
    b = range.end + (change.operation !== "resize-start" ? change.days : 0);
  if (b < a) throw new Error("Das Ende darf nicht vor dem Beginn liegen.");
  return {
    [start.id]: keepTime(start, a),
    ...(end
      ? {
          [end.id]:
            change.operation === "move" && !row.cells[end.id]
              ? ""
              : keepTime(end, b),
        }
      : {}),
  };
}
function epoch(year: number, month: number, date: number) {
  const d = new Date(0);
  d.setUTCFullYear(year, month, date);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() / DAY;
}
export function timelinePeriod(anchor: string, scale: TimelineConfig["scale"]) {
  const day = dateDay(anchor) ?? dateDay(todayKey())!,
    d = new Date(day * DAY),
    year = d.getUTCFullYear(),
    month = d.getUTCMonth();
  let start: number, end: number;
  if (scale === "week") {
    start = day - ((d.getUTCDay() + 6) % 7);
    end = start + 7;
  } else if (scale === "month") {
    start = epoch(year, month, 1);
    end = epoch(year, month + 1, 1);
  } else if (scale === "quarter") {
    start = epoch(year, Math.floor(month / 3) * 3, 1);
    end = epoch(year, Math.floor(month / 3) * 3 + 3, 1);
  } else {
    start = epoch(year, 0, 1);
    end = epoch(year + 1, 0, 1);
  }
  start = Math.max(dateDay("0001-01-01")!, start);
  end = Math.min(dateDay("9999-12-31")! + 1, end);
  return {
    start,
    end,
    days: end - start,
    dayWidth: { week: 80, month: 32, quarter: 14, year: 5 }[scale],
  };
}
export function clipRange(
  start: number,
  end: number,
  period: { start: number; end: number; dayWidth: number },
) {
  const a = Math.max(start, period.start),
    b = Math.min(end + 1, period.end);
  return b > a
    ? {
        left: (a - period.start) * period.dayWidth,
        width: (b - a) * period.dayWidth,
        clippedStart: start < period.start,
        clippedEnd: end >= period.end,
      }
    : null;
}
