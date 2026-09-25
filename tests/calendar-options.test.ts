import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDays,
  calendarSchema,
  isWeekend,
  weekdayLabels,
} from "../lib/database-calendar";

test("weeks start on Monday or Sunday and weekends can be hidden", () => {
  // 2026-09-25 is a Friday.
  const monday = calendarDays("2026-09-25", "week", "UTC");
  assert.equal(monday[0].date, "2026-09-21");
  const sunday = calendarDays("2026-09-25", "week", "UTC", "sunday");
  assert.equal(sunday[0].date, "2026-09-20");
  assert.equal(sunday.length, 7);
  // A Sunday anchor starts its own week when weeks begin on Sunday.
  assert.equal(
    calendarDays("2026-09-27", "week", "UTC", "sunday")[0].date,
    "2026-09-27",
  );
  assert.equal(
    calendarDays("2026-09-01", "month", "UTC", "sunday")[0].date,
    "2026-08-30",
  );
  assert.deepEqual(weekdayLabels({ weekStart: "sunday" }), [
    "So",
    "Mo",
    "Di",
    "Mi",
    "Do",
    "Fr",
    "Sa",
  ]);
  assert.deepEqual(weekdayLabels({ showWeekends: false }), [
    "Mo",
    "Di",
    "Mi",
    "Do",
    "Fr",
  ]);
  assert.equal(isWeekend("2026-09-26"), true);
  assert.equal(isWeekend("2026-09-25"), false);
  assert.throws(() =>
    calendarSchema.parse({
      mode: "month",
      timeZone: "UTC",
      weekStart: "friday",
    }),
  );
});
