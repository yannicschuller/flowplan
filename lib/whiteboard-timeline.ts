// Timeline (roadmap) elements on whiteboards: a time scale (weeks, months,
// quarters), lanes and bars. The data lives in the item (`timeline`, see
// lib/whiteboard-diagram-model.ts); a timeline can instead show the records
// of a database with date properties (reusing lib/database-timeline.ts).
// Everything here is pure: layout, dragging, bound records and the SVG.
import { DAY, dateDay, dayKey, rowRange } from "./database-timeline";
import { cellText } from "./cell-text";
import type { Field, Row } from "./types";
import type { TimelineBar, TimelineData, TimelineLane, TimelineScale, TimelineSource } from "./whiteboard-diagram-model";

export const TIMELINE_HEADER = 46;
export const TIMELINE_LABELS = 130;
export const barColors = ["#4c6ef5", "#12b886", "#f59f00", "#e64980", "#7950f2", "#15aabf", "#fa5252", "#82c91e"];

const utc = (day: number) => new Date(day * DAY);
const epoch = (year: number, month: number, date = 1) => Date.UTC(year, month, date) / DAY;
// The first day of the month of `key`, and the last day `months` later.
export function defaultTimeline(today: string, laneNames: [string, string], barTitles: [string, string]): TimelineData {
  const d = utc(dateDay(today) ?? Date.now() / DAY);
  const start = epoch(d.getUTCFullYear(), d.getUTCMonth());
  const end = epoch(d.getUTCFullYear(), d.getUTCMonth() + 3) - 1;
  return {
    scale: "month",
    start: dayKey(start),
    end: dayKey(end),
    lanes: [
      { id: "l1", name: laneNames[0] },
      { id: "l2", name: laneNames[1] },
    ],
    bars: [
      { id: "b1", lane: "l1", title: barTitles[0], start: dayKey(start + 3), end: dayKey(start + 30), color: barColors[0] },
      { id: "b2", lane: "l2", title: barTitles[1], start: dayKey(start + 24), end: dayKey(start + 62), color: barColors[1] },
    ],
  };
}

// ISO 8601 week number.
export function isoWeek(day: number) {
  const d = utc(day);
  const weekday = (d.getUTCDay() + 6) % 7;
  const thursday = day - weekday + 3;
  const year = utc(thursday).getUTCFullYear();
  return { week: 1 + Math.floor((thursday - epoch(year, 0, 1)) / 7), year };
}
export type TimelineColumn = { start: number; end: number; label: string };
// The columns of the scale between the first and the last day (inclusive).
export function timelineColumns(data: Pick<TimelineData, "scale" | "start" | "end">, locale = "de-DE", weekLabel = "KW") {
  const first = dateDay(data.start)!,
    last = dateDay(data.end)!;
  const columns: TimelineColumn[] = [];
  const month = new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit", timeZone: "UTC" });
  let at = first;
  for (let guard = 0; at <= last && guard < 400; guard++) {
    const d = utc(at);
    let next: number, label: string;
    if (data.scale === "week") {
      next = at - ((d.getUTCDay() + 6) % 7) + 7;
      label = `${weekLabel} ${isoWeek(at).week}`;
    } else if (data.scale === "quarter") {
      const q = Math.floor(d.getUTCMonth() / 3);
      next = epoch(d.getUTCFullYear(), q * 3 + 3);
      label = `Q${q + 1} ${d.getUTCFullYear()}`;
    } else {
      next = epoch(d.getUTCFullYear(), d.getUTCMonth() + 1);
      label = month.format(d);
    }
    columns.push({ start: at, end: Math.min(next, last + 1), label });
    at = next;
  }
  return columns;
}

export type LaidBar = TimelineBar & { x: number; y: number; w: number; h: number; clippedStart: boolean; clippedEnd: boolean };
export type TimelineLayout = {
  labelW: number;
  headerH: number;
  dayW: number;
  first: number;
  days: number;
  columns: (TimelineColumn & { x: number; w: number })[];
  lanes: (TimelineLane & { y: number; h: number })[];
  bars: LaidBar[];
  today: number | null;
};
// Where everything goes in a w×h element.
export function timelineLayout(
  box: { w: number; h: number },
  data: TimelineData,
  options: { today?: string; locale?: string; weekLabel?: string } = {},
): TimelineLayout {
  const labelW = Math.min(TIMELINE_LABELS, box.w * 0.3);
  const headerH = Math.min(TIMELINE_HEADER, box.h * 0.4);
  const first = dateDay(data.start)!,
    last = dateDay(data.end)!;
  const days = last - first + 1;
  const dayW = Math.max(0.01, (box.w - labelW) / days);
  const columns = timelineColumns(data, options.locale, options.weekLabel).map((c) => ({
    ...c,
    x: labelW + (c.start - first) * dayW,
    w: (c.end - c.start) * dayW,
  }));
  const lanes = data.lanes.length ? data.lanes : [{ id: "", name: "" }];
  const laneOf = (bar: TimelineBar) => (lanes.some((l) => l.id === bar.lane) ? bar.lane : lanes[0].id);
  // Overlapping bars of a lane go below each other.
  const rows = new Map<string, Map<string, number>>();
  const rowCount = new Map<string, number>();
  for (const lane of lanes) {
    const ends: number[] = [];
    const own = data.bars
      .filter((b) => laneOf(b) === lane.id)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    const map = new Map<string, number>();
    for (const bar of own) {
      const s = dateDay(bar.start)!;
      let row = ends.findIndex((e) => e < s);
      if (row < 0) row = ends.push(0) - 1;
      ends[row] = dateDay(bar.end)!;
      map.set(bar.id, row);
    }
    rows.set(lane.id, map);
    rowCount.set(lane.id, Math.max(1, ends.length));
  }
  const totalRows = lanes.reduce((s, l) => s + rowCount.get(l.id)!, 0);
  const free = Math.max(0, box.h - headerH);
  let y = headerH;
  const laid = lanes.map((lane) => {
    const h = (free * rowCount.get(lane.id)!) / totalRows;
    const out = { ...lane, y, h };
    y += h;
    return out;
  });
  const bars: LaidBar[] = [];
  for (const bar of data.bars) {
    const lane = laid.find((l) => l.id === laneOf(bar))!;
    const count = rowCount.get(lane.id)!;
    const slot = lane.h / count;
    const height = Math.max(4, Math.min(30, slot - 10));
    const s = dateDay(bar.start)!,
      e = dateDay(bar.end)!;
    const a = Math.max(s, first),
      b = Math.min(e + 1, last + 1);
    if (b <= a) continue;
    bars.push({
      ...bar,
      x: labelW + (a - first) * dayW,
      w: (b - a) * dayW,
      y: lane.y + rows.get(lane.id)!.get(bar.id)! * slot + (slot - height) / 2,
      h: height,
      clippedStart: s < first,
      clippedEnd: e > last,
    });
  }
  const today = options.today ? dateDay(options.today) : null;
  return {
    labelW,
    headerH,
    dayW,
    first,
    days,
    columns,
    lanes: laid,
    bars,
    today: today !== null && today >= first && today <= last ? labelW + (today - first + 0.5) * dayW : null,
  };
}

// ---- editing ----

const shift = (key: string, days: number) => dayKey(dateDay(key)! + days);
export type BarChange = { operation: "move" | "resize-start" | "resize-end"; days: number; lane?: string };
// A bar moved or resized by whole days (and maybe into another lane); the
// end never lies before the start.
export function changeBar(data: TimelineData, id: string, change: BarChange): TimelineData {
  return {
    ...data,
    bars: data.bars.map((bar) => {
      if (bar.id !== id) return bar;
      let start = bar.start,
        end = bar.end;
      if (change.operation === "move") {
        start = shift(start, change.days);
        end = shift(end, change.days);
      } else if (change.operation === "resize-start") start = shift(start, Math.min(change.days, dateDay(end)! - dateDay(start)!));
      else end = shift(end, Math.max(change.days, dateDay(start)! - dateDay(end)!));
      return { ...bar, start, end, ...(change.lane !== undefined && change.operation === "move" ? { lane: change.lane } : {}) };
    }),
  };
}
// Days for a horizontal movement of `dx` board units.
export const daysFor = (dx: number, layout: Pick<TimelineLayout, "dayW">) => Math.round(dx / layout.dayW);
// The lane at a height inside the element.
export function laneAt(layout: TimelineLayout, y: number) {
  return (layout.lanes.find((l) => y >= l.y && y < l.y + l.h) || (y < layout.headerH ? layout.lanes[0] : layout.lanes[layout.lanes.length - 1]))?.id;
}
export const newId = (prefix: string, taken: { id: string }[]) => {
  for (let i = taken.length + 1; ; i++) if (!taken.some((t) => t.id === `${prefix}${i}`)) return `${prefix}${i}`;
};

// ---- bound to a database ----

// Lanes and bars from the records: the select property's options are the
// lanes, records without a valid period are left out.
export function boundTimeline(source: TimelineSource, fields: Field[], rows: Row[], noLane = "–") {
  const start = fields.find((f) => f.id === source.startField && f.type === "date");
  const end = source.endField ? fields.find((f) => f.id === source.endField && f.type === "date" && f.id !== start?.id) : undefined;
  const laneField = source.laneField ? fields.find((f) => f.id === source.laneField && f.type === "select") : undefined;
  const title = fields[0];
  const options = laneField?.options || [];
  const lanes: TimelineLane[] = laneField ? [...options.map((o) => ({ id: `o:${o}`, name: o })), { id: "o:", name: noLane }] : [{ id: "all", name: "" }];
  const bars: TimelineBar[] = [];
  if (!start) return { lanes, bars, valid: false };
  for (const row of rows) {
    const range = rowRange(row, start, end);
    if (!range) continue;
    const value = laneField ? String(row.cells[laneField.id] ?? "") : "";
    const lane = laneField ? (options.includes(value) ? `o:${value}` : "o:") : "all";
    bars.push({
      id: row.id,
      rowId: row.id,
      lane,
      title: (title ? cellText(row.cells[title.id]) : "").slice(0, 200),
      start: dayKey(range.start),
      end: dayKey(range.end),
      color: barColors[Math.max(0, lanes.findIndex((l) => l.id === lane)) % barColors.length],
    });
    if (bars.length >= 400) break;
  }
  // Lanes without records stay out, except the only one.
  const used = lanes.filter((l) => bars.some((b) => b.lane === l.id));
  return { lanes: used.length ? used : lanes.slice(0, 1), bars, valid: true };
}
// The cells to write when a bound bar was moved or resized.
export function boundPatch(source: TimelineSource, bar: Pick<TimelineBar, "start" | "end">, row: Row) {
  const keep = (field: string, key: string) => {
    const previous = row.cells[field];
    return key + (typeof previous === "string" && dateDay(previous) !== null ? previous.slice(10) : "");
  };
  return {
    [source.startField]: keep(source.startField, bar.start),
    ...(source.endField && source.endField !== source.startField ? { [source.endField]: keep(source.endField, bar.end) } : {}),
  };
}

// ---- SVG ----

const r = (n: number) => Math.round(n * 100) / 100;
const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// Text cut to the room it has (about 0.56 em per character).
export const fitText = (text: string, width: number, size: number) => {
  const max = Math.floor((width - 8) / (size * 0.56));
  if (max <= 0) return "";
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join("") + "…";
};
// Grid, labels and the today line (everything but the bars).
export function timelineBackground(box: { w: number; h: number }, layout: TimelineLayout, title: string) {
  const parts: string[] = [];
  parts.push(`<rect width="${r(box.w)}" height="${r(box.h)}" rx="8" fill="#ffffff" stroke="#adb5bd" stroke-width="1"/>`);
  parts.push(`<rect width="${r(box.w)}" height="${r(layout.headerH)}" rx="8" fill="#f1f3f5"/><rect y="${r(layout.headerH - 8)}" width="${r(box.w)}" height="8" fill="#f1f3f5"/>`);
  layout.lanes.forEach((lane, i) => {
    if (i % 2) parts.push(`<rect x="0" y="${r(lane.y)}" width="${r(box.w)}" height="${r(lane.h)}" fill="#f8f9fa"/>`);
  });
  for (const c of layout.columns) {
    parts.push(`<path d="M ${r(c.x)} 0 V ${r(box.h)}" stroke="#dee2e6" stroke-width="1"/>`);
    parts.push(
      `<text x="${r(c.x + 6)}" y="${r(layout.headerH / 2 + 4)}" font-family="system-ui,sans-serif" font-size="12" fill="#495057">${esc(fitText(c.label, c.w, 12))}</text>`,
    );
  }
  for (const lane of layout.lanes) {
    parts.push(`<path d="M 0 ${r(lane.y)} H ${r(box.w)}" stroke="#dee2e6" stroke-width="1"/>`);
    if (lane.name)
      parts.push(
        `<text x="10" y="${r(lane.y + Math.min(lane.h / 2, 22) + 4)}" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#343a40">${esc(fitText(lane.name, layout.labelW - 6, 13))}</text>`,
      );
  }
  parts.push(`<path d="M ${r(layout.labelW)} 0 V ${r(box.h)}" stroke="#ced4da" stroke-width="1"/>`);
  if (title)
    parts.push(
      `<text x="10" y="${r(layout.headerH / 2 + 5)}" font-family="system-ui,sans-serif" font-size="14" font-weight="700" fill="#1f2937">${esc(fitText(title, layout.labelW - 6, 14))}</text>`,
    );
  if (layout.today !== null)
    parts.push(
      `<path d="M ${r(layout.today)} ${r(layout.headerH - 6)} V ${r(box.h)}" stroke="#e03131" stroke-width="2"/><circle cx="${r(layout.today)}" cy="${r(layout.headerH - 6)}" r="4" fill="#e03131"/>`,
    );
  return parts.join("");
}
export function barSvg(bar: LaidBar) {
  const color = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(bar.color || "") ? bar.color! : barColors[0];
  return (
    `<rect x="${r(bar.x + 1)}" y="${r(bar.y)}" width="${r(Math.max(2, bar.w - 2))}" height="${r(bar.h)}" rx="${r(Math.min(6, bar.h / 2))}" fill="${esc(color)}"/>` +
    `<text x="${r(bar.x + 8)}" y="${r(bar.y + bar.h / 2 + 4)}" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="#ffffff">${esc(fitText(bar.title, bar.w, 12))}</text>`
  );
}
export function timelineSvg(box: { w: number; h: number; text?: string }, data: TimelineData, options: { today?: string; locale?: string; weekLabel?: string } = {}) {
  const layout = timelineLayout(box, data, options);
  return timelineBackground(box, layout, box.text || "") + layout.bars.map(barSvg).join("");
}
export type { TimelineData, TimelineScale };
