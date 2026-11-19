import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrowPath,
  arrowStep,
  axisSegments,
  axisUnits,
  clampDayWidth,
  dataRange,
  dayAt,
  extendWindow,
  FIRST_DAY,
  fitDayWidth,
  fitMargin,
  fitTarget,
  initialLeft,
  isoWeek,
  keyDay,
  LAST_END,
  MAX_WINDOW_DAYS,
  readScrollDay,
  scaleOf,
  scrollFor,
  settleDayWidth,
  sliderToZoom,
  stickyLabelLeft,
  timelineWindow,
  todayLeft,
  unitSegments,
  writeScrollDay,
  zoomScroll,
  zoomStep,
  zoomToSlider,
} from "../lib/timeline-scale";
import { dateDay, dayKey, timelineSchema } from "../lib/database-timeline";
import { milestoneBox, milestoneDay, periodBounds, SCALES, SCALE_DAY_WIDTH } from "../lib/timeline-scale";

const d = (key: string) => keyDay(key)!;

test("day bounds match the supported dates", () => {
  assert.equal(FIRST_DAY, dateDay("0001-01-01"));
  assert.equal(LAST_END, dateDay("9999-12-31")! + 1);
  assert.equal(keyDay("2026-02-30"), null);
  assert.equal(keyDay("2026-11-19"), dateDay("2026-11-19"));
});

test("a saved range spans from its first to its last day, All records fits the data with a margin", () => {
  const today = d("2026-11-19");
  const range = timelineWindow({ range: { from: "2026-11-01", to: "2027-03-31" }, data: null, today, scale: "month" });
  assert.deepEqual(range, { start: d("2026-11-01"), end: d("2027-04-01") });
  assert.equal(range.end - range.start, 151);
  // Records from 10 Nov to 20 Feb (inclusive ends).
  const data = dataRange([{ start: d("2026-11-10"), end: d("2026-12-01") }, null, { start: d("2027-01-05"), end: d("2027-02-20") }]);
  assert.deepEqual(data, { start: d("2026-11-10"), end: d("2027-02-21") });
  const m = fitMargin(data!.end - data!.start);
  assert.equal(m, 5);
  assert.deepEqual(timelineWindow({ range: "fit", data, today, scale: "month" }), {
    start: d("2026-11-10") - 5,
    end: d("2027-02-21") + 5,
  });
  assert.equal(fitMargin(3), 2);
  // Without records "fit" shows today's period.
  assert.deepEqual(timelineWindow({ range: "fit", data: null, today, scale: "month" }), { start: d("2026-11-01"), end: d("2026-12-01") });
  // An invalid saved range falls back to the continuous window.
  const broken = timelineWindow({ range: { from: "2027-01-01", to: "2026-01-01" }, data: null, today, scale: "month" });
  assert.ok(broken.start < d("2026-11-01") && broken.end > d("2026-12-01"));
  assert.equal(dataRange([]), null);
});

test("without a range the window holds today's period and the records with room to scroll", () => {
  const today = d("2026-11-19");
  const w = timelineWindow({ data: { start: d("2026-09-22"), end: d("2026-09-24") }, today, scale: "month" });
  assert.equal(w.start, d("2026-09-22") - 30);
  assert.equal(w.end, d("2026-12-01") + 30);
  const week = timelineWindow({ data: null, today, scale: "week" });
  assert.deepEqual(week, { start: d("2026-11-16") - 14, end: d("2026-11-23") + 14 });
  // Never longer than 20 years, kept around today.
  const far = timelineWindow({ data: { start: d("1900-01-01"), end: d("2100-01-01") }, today, scale: "year" });
  assert.equal(far.end - far.start, MAX_WINDOW_DAYS);
  assert.ok(far.start < today && far.end > today);
  // The edges of the calendar.
  const first = timelineWindow({ range: "fit", data: { start: FIRST_DAY, end: FIRST_DAY + 1 }, today, scale: "month" });
  assert.equal(first.start, FIRST_DAY);
  const last = timelineWindow({ range: "fit", data: { start: LAST_END - 1, end: LAST_END }, today, scale: "month" });
  assert.equal(last.end, LAST_END);
  // Extending (jumping, scrolling on) keeps the limits.
  assert.deepEqual(extendWindow({ start: 10, end: 20 }, { start: 5, end: 12 }), { start: 5, end: 20 });
  assert.deepEqual(extendWindow({ start: 10, end: 20 }, { start: 10 - MAX_WINDOW_DAYS, end: 20 }), { start: 10, end: 20 });
  assert.deepEqual(extendWindow({ start: 10, end: 20 }, null), { start: 10, end: 20 });
  // Fit: the range, else all records, else the period.
  assert.deepEqual(fitTarget(undefined, { start: 100, end: 200 }, today, "month"), { start: 96, end: 204 });
  assert.deepEqual(fitTarget(undefined, null, today, "month"), { start: d("2026-11-01"), end: d("2026-12-01") });
});

test("zoom is clamped, stepped, settled and mapped to the slider", () => {
  assert.equal(clampDayWidth(0.1), 0.5);
  assert.equal(clampDayWidth(500), 120);
  assert.equal(clampDayWidth(NaN), 32);
  assert.equal(settleDayWidth(13.3333), 13.33);
  assert.equal(zoomStep(32, 1), 40);
  assert.equal(zoomStep(32, -1), 25.6);
  assert.equal(zoomStep(110, 1), 120);
  assert.equal(zoomStep(0.6, -1), 0.5);
  assert.equal(scaleOf(32), "month");
  assert.equal(scaleOf(5), "year");
  assert.equal(scaleOf(33), null);
  assert.equal(scaleOf(120), "day");
  assert.equal(scaleOf(48), "twoWeeks");
  assert.equal(scaleOf(0.6), "fiveYears");
  assert.equal(zoomToSlider(0.5), 0);
  assert.equal(zoomToSlider(120), 100);
  assert.equal(sliderToZoom(0), 0.5);
  assert.equal(sliderToZoom(100), 120);
  for (const w of [0.6, 2, 5, 14, 32, 80, 120]) assert.ok(Math.abs(sliderToZoom(zoomToSlider(w)) - w) / w < 0.05);
  // 151 days (Nov–Mar) in 900 px.
  assert.equal(fitDayWidth(151, 900), 900 / 151);
  assert.equal(fitDayWidth(7305, 300), 0.5);
  assert.equal(fitDayWidth(1, 900), 120);
});

test("zooming keeps the day under the cursor in place", () => {
  const start = d("2026-11-01");
  // 32 px a day, scrolled by 640 px, the cursor 100 px into the lanes.
  const day = dayAt(start, 640, 100, 32);
  assert.equal(day, start + 23.125);
  const scroll = zoomScroll(640, 100, 32, 64);
  assert.equal(scroll, 1380);
  assert.equal(dayAt(start, scroll, 100, 64), day);
  assert.equal(scrollFor(start, day, 100, 64), scroll);
  // Never before the start.
  assert.equal(zoomScroll(0, 0, 32, 2), 0);
  assert.equal(scrollFor(start, start - 3, 0, 32), 0);
});

test("the arrows move by 80 % of the visible width", () => {
  assert.equal(arrowStep(1000), 800);
  assert.equal(arrowStep(250), 200);
  assert.equal(arrowStep(10), 40);
});

test("opening: a range at its start, else today's period; Today puts today at 15 %", () => {
  const today = d("2026-11-19");
  const w = { start: d("2026-10-01"), end: d("2027-01-01") };
  assert.equal(initialLeft({ window: w, ranged: true, today, scale: "month" }), w.start);
  assert.equal(initialLeft({ window: w, ranged: false, today, scale: "month" }), d("2026-11-01"));
  assert.equal(initialLeft({ window: w, ranged: false, today, scale: "week" }), d("2026-11-16"));
  assert.equal(todayLeft(today, 320, 32), today - 1.5);
});

test("ISO calendar weeks", () => {
  const cases: [string, number, number][] = [
    ["2026-01-01", 2026, 1],
    ["2025-12-29", 2026, 1],
    ["2027-01-01", 2026, 53],
    ["2027-01-04", 2027, 1],
    ["2021-01-03", 2020, 53],
    ["2026-11-19", 2026, 47],
    ["2024-12-30", 2025, 1],
  ];
  for (const [key, year, week] of cases) assert.deepEqual(isoWeek(d(key)), { year, week }, key);
});

test("the axis rows follow the zoom and are built only for the visible part", () => {
  assert.deepEqual(axisUnits(80), ["month", "day"]);
  assert.deepEqual(axisUnits(24), ["month", "day"]);
  assert.deepEqual(axisUnits(14), ["month", "week"]);
  assert.deepEqual(axisUnits(10), ["month", "week"]);
  assert.deepEqual(axisUnits(9.9), ["quarter", "month"]);
  assert.deepEqual(axisUnits(4), ["quarter", "month"]);
  assert.deepEqual(axisUnits(2), ["year", "month"]);
  assert.deepEqual(axisUnits(0.6), ["year", "quarter"]);
  // Nov 2026 – Mar 2027 at 6 px a day: quarters over months, across the
  // year boundary without a break.
  const w = { start: d("2026-11-01"), end: d("2027-04-01") };
  const at6 = axisSegments(w, 6, w.start, w.end);
  assert.deepEqual(
    at6.top.map((s) => [dayKey(s.start), s.value, s.year]),
    [
      ["2026-11-01", 4, 2026],
      ["2027-01-01", 1, 2027],
    ],
  );
  assert.deepEqual(
    at6.bottom.map((s) => dayKey(s.start)),
    ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"],
  );
  assert.equal(at6.bottom.at(-1)!.end, w.end);
  // Weeks: cut to the window, ISO numbers across the year.
  const weeks = unitSegments("week", w, d("2026-12-26"), d("2027-01-12"));
  assert.deepEqual(
    weeks.map((s) => [dayKey(s.start), s.value, s.year]),
    [
      ["2026-12-21", 52, 2026],
      ["2026-12-28", 53, 2026],
      ["2027-01-04", 1, 2027],
      ["2027-01-11", 2, 2027],
    ],
  );
  const first = unitSegments("week", w, w.start, w.start + 3)[0];
  assert.equal(first.start, w.start); // 1 Nov 2026 is a Sunday: cut.
  // Days: only the visible ones, however long the window is.
  const long = { start: d("2020-01-01"), end: d("2039-12-31") };
  const days = axisSegments(long, 60, d("2030-05-01"), d("2030-05-21"));
  assert.equal(days.bottom.length, 20);
  assert.deepEqual(days.top.map((s) => dayKey(s.start)), ["2030-05-01"]);
  assert.equal(days.bottom[0].value, 1);
  // A month label sticks to the visible left edge, inside its segment.
  assert.equal(stickyLabelLeft(0, 900, 300, 100), 300);
  assert.equal(stickyLabelLeft(0, 900, 850, 100), 800);
  assert.equal(stickyLabelLeft(400, 900, 300, 100), 400);
});

test("dependency arrows leave and enter the linked ends", () => {
  const a = { left: 10, right: 110, top: 10, height: 28 },
    b = { left: 200, right: 260, top: 58, height: 28 };
  assert.equal(arrowPath(a, b, "fs"), "M 110 24 C 150 24, 160 72, 194 72");
  assert.match(arrowPath(a, b, "ss"), /^M 10 24 .* 194 72$/);
  assert.match(arrowPath(a, b, "ff"), /^M 110 24 .* 266 72$/);
});

test("the scroll position is remembered per view and survives broken storage", () => {
  const map = new Map<string, string>();
  const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  assert.equal(readScrollDay(store, "p:v"), null);
  writeScrollDay(store, "p:v", 20500.123);
  assert.equal(readScrollDay(store, "p:v"), 20500.12);
  assert.equal(readScrollDay(store, "p:other"), null);
  map.set("flowplan:timeline-scroll:p:v", "{broken");
  assert.equal(readScrollDay(store, "p:v"), null);
  map.set("flowplan:timeline-scroll:p:v", JSON.stringify({ day: 1e12 }));
  assert.equal(readScrollDay(store, "p:v"), null);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readScrollDay(throwing, "p:v"), null);
  writeScrollDay(throwing, "p:v", 1);
  writeScrollDay(null, "p:v", 1);
});

test("the view stores range and zoom; older views stay valid", () => {
  assert.ok(timelineSchema.safeParse({ scale: "month", showWeekends: true }).success);
  assert.ok(timelineSchema.safeParse({ scale: "month", showWeekends: true, range: "fit", dayWidth: 6.5 }).success);
  assert.ok(timelineSchema.safeParse({ scale: "month", showWeekends: true, range: { from: "2026-11-01", to: "2027-03-31" } }).success);
  assert.ok(!timelineSchema.safeParse({ scale: "month", showWeekends: true, range: { from: "2027-03-31", to: "2026-11-01" } }).success);
  assert.ok(!timelineSchema.safeParse({ scale: "month", showWeekends: true, range: "all" }).success);
  assert.ok(!timelineSchema.safeParse({ scale: "month", showWeekends: true, dayWidth: 0.2 }).success);
  assert.ok(!timelineSchema.safeParse({ scale: "month", showWeekends: true, dayWidth: 121 }).success);
});

test("every scale is a zoom preset with a period to open on", () => {
  const today = d("2026-11-19"); // a Thursday
  assert.deepEqual(SCALES, ["day", "week", "twoWeeks", "month", "quarter", "year", "fiveYears"]);
  for (const scale of SCALES) assert.ok(timelineSchema.safeParse({ scale, showWeekends: true }).success, scale);
  assert.ok(SCALES.every((s, i) => i === 0 || SCALE_DAY_WIDTH[SCALES[i - 1]] > SCALE_DAY_WIDTH[s]));
  assert.deepEqual(periodBounds(today, "day"), { start: today, end: today + 1 });
  assert.deepEqual(periodBounds(today, "twoWeeks"), { start: d("2026-11-16"), end: d("2026-11-30") });
  assert.deepEqual(periodBounds(today, "fiveYears"), { start: d("2025-01-01"), end: d("2030-01-01") });
  assert.ok(timelineSchema.safeParse({ scale: "fiveYears", showWeekends: true, dayWidth: 0.6 }).success);
  assert.ok(!timelineSchema.safeParse({ scale: "month", showWeekends: true, dayWidth: 0.4 }).success);
});

test("milestones: one-day records or marked ones, a diamond on its day", () => {
  assert.equal(milestoneDay({ start: 10, end: 10 }, false), 10);
  assert.equal(milestoneDay({ start: 10, end: 14 }, false), null);
  // Marked by the checkbox: on the last day.
  assert.equal(milestoneDay({ start: 10, end: 14 }, true), 14);
  const period = { start: 0, end: 30, dayWidth: 32 };
  assert.deepEqual(milestoneBox(3, period), { left: 3 * 32 + 16 - 9, width: 18, clippedStart: false, clippedEnd: false });
  assert.equal(milestoneBox(30, period), null);
  assert.equal(milestoneBox(-1, period), null);
  assert.ok(timelineSchema.safeParse({ scale: "month", showWeekends: true, milestoneField: "done", labelFields: ["no", "owner"] }).success);
  assert.ok(!timelineSchema.safeParse({ scale: "month", showWeekends: true, labelFields: ["a", "b", "c", "d", "e"] }).success);
});
