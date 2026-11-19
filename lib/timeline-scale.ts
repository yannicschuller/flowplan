// The time axis of the database timeline (#390): the window of days it
// shows as one continuous grid (a saved range, all records or – without
// either – the current period plus whatever the records need), the zoom in
// pixels per day, zooming around the cursor, the step of the arrows, ISO
// calendar weeks and the two rows of the axis. Pure and free of imports, so
// the published timeline (components/public-timeline.tsx) can use it
// without the app's code; the tests call it directly.

export const DAY = 86400000;
// The zoom steps of the scale menu (the main control); the zoom in
// between is continuous.
export const SCALES = ["day", "week", "twoWeeks", "month", "quarter", "year", "fiveYears"] as const;
export type Scale = (typeof SCALES)[number];
// Days since 1970-01-01; `end` is exclusive.
export type DayRange = { start: number; end: number };
export type SavedRange = { from: string; to: string } | "fit";

// Zoom in pixels per day. The scales are presets of it.
export const MIN_DAY_WIDTH = 0.5;
export const MAX_DAY_WIDTH = 120;
export const SCALE_DAY_WIDTH: Record<Scale, number> = {
  day: 120,
  week: 80,
  twoWeeks: 48,
  month: 32,
  quarter: 14,
  year: 5,
  fiveYears: 0.6,
};
// The longest window: 20 years (about 0.9 million pixels at the largest
// zoom, well below what browsers lay out).
export const MAX_WINDOW_DAYS = 7305;
export const FIRST_DAY = -719162; // 0001-01-01
export const LAST_END = 2932897; // the day after 9999-12-31

export const clampDayWidth = (value: number) =>
  Number.isFinite(value) ? Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, value)) : SCALE_DAY_WIDTH.month;
// Two decimals are plenty for a stored zoom.
export const settleDayWidth = (value: number) => clampDayWidth(Math.round(value * 100) / 100);
// The preset a zoom matches, if any (for the scale menu).
export function scaleOf(dayWidth: number): Scale | null {
  for (const [scale, width] of Object.entries(SCALE_DAY_WIDTH)) if (Math.abs(width - dayWidth) < 0.01) return scale as Scale;
  return null;
}
// −/+ buttons and keys: a quarter more or less.
export const zoomStep = (dayWidth: number, direction: 1 | -1) => settleDayWidth(dayWidth * 1.25 ** direction);
// The slider runs logarithmically from the smallest to the largest zoom.
const SPAN = Math.log(MAX_DAY_WIDTH / MIN_DAY_WIDTH);
export const zoomToSlider = (dayWidth: number) => Math.round((Math.log(clampDayWidth(dayWidth) / MIN_DAY_WIDTH) / SPAN) * 100);
export const sliderToZoom = (value: number) =>
  settleDayWidth(MIN_DAY_WIDTH * Math.exp((Math.min(100, Math.max(0, value)) / 100) * SPAN));
// The zoom that shows `days` in `pixels`.
export const fitDayWidth = (days: number, pixels: number) => clampDayWidth(pixels / Math.max(1, days));

export function epoch(year: number, month: number, date: number) {
  const d = new Date(0);
  d.setUTCFullYear(year, month, date);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() / DAY;
}
const parts = (day: number) => {
  const d = new Date(day * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(), weekday: (d.getUTCDay() + 6) % 7 };
};
export function keyDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = Date.parse(value + "T00:00:00Z") / DAY;
  return Number.isFinite(day) && new Date(day * DAY).toISOString().slice(0, 10) === value ? day : null;
}
export const clampDay = (day: number) => Math.min(LAST_END - 1, Math.max(FIRST_DAY, day));

// The week, month, quarter or year containing `day`.
export function periodBounds(day: number, scale: Scale): DayRange {
  const { year, month, weekday } = parts(day);
  let start: number, end: number;
  if (scale === "day") {
    start = day;
    end = day + 1;
  } else if (scale === "week" || scale === "twoWeeks") {
    start = day - weekday;
    end = start + (scale === "week" ? 7 : 14);
  } else if (scale === "fiveYears") {
    start = epoch(year - (((year % 5) + 5) % 5), 0, 1);
    end = epoch(year - (((year % 5) + 5) % 5) + 5, 0, 1);
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
  return { start: Math.max(FIRST_DAY, start), end: Math.min(LAST_END, end) };
}

export function clipRange(start: number, end: number, period: { start: number; end: number; dayWidth: number }) {
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

// From the first start to the day after the last end of the records
// (ranges with inclusive ends, as rowRange gives them).
export function dataRange(ranges: Iterable<{ start: number; end: number } | null | undefined>): DayRange | null {
  let start = Infinity,
    end = -Infinity;
  for (const r of ranges)
    if (r) {
      start = Math.min(start, r.start);
      end = Math.max(end, r.end + 1);
    }
  return start < end ? { start, end } : null;
}
// "Alle Einträge": a little room on both sides (4 %, at least two days).
export const fitMargin = (days: number) => Math.max(2, Math.ceil(days * 0.04));
function clampWindow(range: DayRange, keep: number): DayRange {
  let { start, end } = range;
  start = Math.max(FIRST_DAY, Math.floor(start));
  end = Math.min(LAST_END, Math.ceil(end));
  if (end <= start) end = Math.min(LAST_END, start + 1);
  if (end - start > MAX_WINDOW_DAYS) {
    // Too long: the part around `keep` (today, or the saved start).
    const from = Math.min(Math.max(start, keep - Math.floor(MAX_WINDOW_DAYS / 2)), end - MAX_WINDOW_DAYS);
    start = from;
    end = from + MAX_WINDOW_DAYS;
  }
  return { start, end };
}
// The days the grid spans.
export function timelineWindow({
  range,
  data,
  today,
  scale,
}: {
  range?: SavedRange;
  data: DayRange | null;
  today: number;
  scale: Scale;
}): DayRange {
  const period = periodBounds(today, scale);
  if (range === "fit") {
    if (!data) return period;
    const m = fitMargin(data.end - data.start);
    return clampWindow({ start: data.start - m, end: data.end + m }, data.start);
  }
  if (range) {
    const from = keyDay(range.from),
      to = keyDay(range.to);
    if (from !== null && to !== null && to >= from) return clampWindow({ start: from, end: to + 1 }, from);
  }
  // Without a saved range: today's period and the records, with room to
  // scroll on (it grows while scrolling, see extendWindow).
  const pad = Math.max(14, period.end - period.start);
  const start = Math.min(period.start, data?.start ?? Infinity) - pad,
    end = Math.max(period.end, data?.end ?? -Infinity) + pad;
  return clampWindow({ start, end }, today);
}
// The window grown to include `extra` (a day to jump to, room to scroll).
export function extendWindow(window: DayRange, extra: DayRange | null): DayRange {
  if (!extra) return window;
  const start = Math.max(FIRST_DAY, Math.min(window.start, extra.start)),
    end = Math.min(LAST_END, Math.max(window.end, extra.end));
  return end - start > MAX_WINDOW_DAYS ? window : { start, end };
}
// What "Einpassen" shows: the saved range, else the records with their
// margin, else today's period.
export function fitTarget(range: SavedRange | undefined, data: DayRange | null, today: number, scale: Scale): DayRange {
  if (range) return timelineWindow({ range, data, today, scale });
  if (data) {
    const m = fitMargin(data.end - data.start);
    return clampWindow({ start: data.start - m, end: data.end + m }, data.start);
  }
  return periodBounds(today, scale);
}

// Positions: `px` is a distance from the left edge of the visible lanes
// (right of the sticky title column).
export const dayAt = (windowStart: number, scrollLeft: number, px: number, dayWidth: number) =>
  windowStart + (scrollLeft + px) / dayWidth;
export const scrollFor = (windowStart: number, day: number, px: number, dayWidth: number) =>
  Math.max(0, (day - windowStart) * dayWidth - px);
// Zooming from `from` to `to` px/day keeps the day under the cursor (`px`)
// where it is.
export const zoomScroll = (scrollLeft: number, px: number, from: number, to: number) =>
  Math.max(0, ((scrollLeft + px) * to) / from - px);
// ‹ and › move by about 80 % of what is visible.
export const arrowStep = (visible: number) => Math.max(40, Math.round(visible * 0.8));
// Where a view opens without a remembered position: the start of a saved
// range, else the start of today's period (as before #390).
export function initialLeft({ window, ranged, today, scale }: { window: DayRange; ranged: boolean; today: number; scale: Scale }) {
  return ranged ? window.start : periodBounds(today, scale).start;
}
// "Heute": today at 15 % of the visible width.
export const todayLeft = (today: number, visible: number, dayWidth: number) => today - (visible * 0.15) / dayWidth;

// ISO 8601 calendar week (weeks start on Monday, week 1 holds the first
// Thursday of the year).
export function isoWeek(day: number) {
  const thursday = day - parts(day).weekday + 3,
    year = parts(thursday).year;
  return { year, week: Math.floor((thursday - epoch(year, 0, 1)) / 7) + 1 };
}

export type AxisUnit = "year" | "quarter" | "month" | "week" | "day";
export type AxisSegment = {
  unit: AxisUnit;
  // Where the unit starts and ends (exclusive), cut to the window.
  start: number;
  end: number;
  year: number;
  // Month 0–11, quarter 1–4, ISO week, day of the month – by unit.
  value: number;
};
// The two rows of the axis for a zoom: from ISO weeks at 10 px a day,
// single days from 24 px; years and quarters below 1.5 px.
export function axisUnits(dayWidth: number): [AxisUnit, AxisUnit] {
  return dayWidth >= 24
    ? ["month", "day"]
    : dayWidth >= 10
      ? ["month", "week"]
      : dayWidth >= 4
        ? ["quarter", "month"]
        : dayWidth >= 1.5
          ? ["year", "month"]
          : ["year", "quarter"];
}
function unitStart(day: number, unit: AxisUnit) {
  if (unit === "day") return day;
  if (unit === "week") return day - parts(day).weekday;
  const { year, month } = parts(day);
  return unit === "month" ? epoch(year, month, 1) : unit === "quarter" ? epoch(year, Math.floor(month / 3) * 3, 1) : epoch(year, 0, 1);
}
function unitNext(start: number, unit: AxisUnit) {
  if (unit === "day") return start + 1;
  if (unit === "week") return start + 7;
  const { year, month } = parts(start);
  return epoch(year, month + (unit === "month" ? 1 : unit === "quarter" ? 3 : 12), 1);
}
// The segments of one unit that touch [from, to), cut to the window –
// only the visible part is built, however long the window is.
export function unitSegments(unit: AxisUnit, window: DayRange, from: number, to: number): AxisSegment[] {
  const a = Math.max(window.start, Math.floor(from)),
    b = Math.min(window.end, Math.ceil(to));
  const out: AxisSegment[] = [];
  for (let s = unitStart(a, unit); s < b && out.length < 2000; s = unitNext(s, unit)) {
    const e = unitNext(s, unit),
      p = parts(s);
    const w = unit === "week" ? isoWeek(s) : null;
    out.push({
      unit,
      start: Math.max(s, window.start),
      end: Math.min(e, window.end),
      year: w ? w.year : p.year,
      value: unit === "day" ? p.date : unit === "week" ? w!.week : unit === "quarter" ? Math.floor(p.month / 3) + 1 : unit === "month" ? p.month : p.year,
    });
  }
  return out;
}
export function axisSegments(window: DayRange, dayWidth: number, from: number, to: number) {
  const [top, bottom] = axisUnits(dayWidth);
  return { top: unitSegments(top, window, from, to), bottom: unitSegments(bottom, window, from, to) };
}
// A top label stays readable while its segment is scrolled half away: it
// sits at the left edge of the visible part, but inside its segment.
export function stickyLabelLeft(segmentLeft: number, segmentRight: number, visibleLeft: number, labelWidth: number) {
  return Math.max(segmentLeft, Math.min(visibleLeft, segmentRight - labelWidth));
}

// Where a bar's title goes: inside when it fits, else beside the bar where
// there is room for it (estimated at 11 px text, about 6.3 px a letter).
export function outsideLabel(bar: { left: number; width: number }, name: string, lane: number): "right" | "left" | null {
  const text = Math.min(name.length * 6.3, 220);
  if (bar.width >= text + 26) return null;
  if (lane - bar.left - bar.width >= text + 16) return "right";
  if (bar.left >= text + 16) return "left";
  return null;
}

// A record shown as a milestone (◆): one day long, or marked by the
// view's checkbox property (then on its last day).
export const MILESTONE_SIZE = 18;
export function milestoneDay(range: { start: number; end: number }, flagged: boolean) {
  return flagged ? range.end : range.start === range.end ? range.start : null;
}
// The diamond's box, centred on its day; null outside the window.
export function milestoneBox(day: number, period: { start: number; end: number; dayWidth: number }) {
  if (day < period.start || day >= period.end) return null;
  return {
    left: (day - period.start) * period.dayWidth + period.dayWidth / 2 - MILESTONE_SIZE / 2,
    width: MILESTONE_SIZE,
    clippedStart: false,
    clippedEnd: false,
  };
}

export type ArrowBox = { left: number; right: number; top: number; height: number };
export type LinkType = "fs" | "ss" | "ff" | "sf";
// A dependency arrow from the linked end of one bar to the other's.
export function arrowPath(a: ArrowBox, b: ArrowBox, type: LinkType) {
  const fromEnd = type === "fs" || type === "ff",
    toStart = type === "fs" || type === "ss";
  const x1 = fromEnd ? a.right : a.left,
    y1 = a.top + a.height / 2,
    x2 = toStart ? b.left : b.right,
    y2 = b.top + b.height / 2,
    bend = Math.max(12, Math.min(40, Math.abs(x2 - x1) / 2)),
    out = fromEnd ? bend : -bend,
    into = toStart ? -bend : bend;
  return `M ${x1} ${y1} C ${x1 + out} ${y1}, ${x2 + into} ${y2}, ${x2 + (toStart ? -6 : 6)} ${y2}`;
}

// The scroll position of a view, remembered on this device: the first
// visible day (survives zooming). Storage may be missing or throw.
type Store = Pick<Storage, "getItem" | "setItem"> | undefined | null;
export const scrollKey = (id: string) => `flowplan:timeline-scroll:${id}`;
export function readScrollDay(store: Store, id: string): number | null {
  try {
    const value = JSON.parse(store?.getItem(scrollKey(id)) || "null");
    return typeof value?.day === "number" && Number.isFinite(value.day) && value.day >= FIRST_DAY && value.day < LAST_END ? value.day : null;
  } catch {
    return null;
  }
}
export function writeScrollDay(store: Store, id: string, day: number) {
  try {
    store?.setItem(scrollKey(id), JSON.stringify({ day: Math.round(day * 100) / 100 }));
  } catch {}
}
