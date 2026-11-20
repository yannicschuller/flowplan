// Planning rules of the database timeline (#395): the view's arrow and
// shift settings as read (with the old "moveSuccessors" checkbox mapped to
// a shift mode), how records waiting for a moved one follow it – only as
// far as a link needs ("overlap"), by the same days ("keep") or not at all –
// optionally off weekends, and links that other links already imply.
// Shared by the browser (preview while dragging) and the server
// (lib/row-schedule.ts), pure, so the tests call it directly.
import {
  dayKey,
  requiredShift,
  rowRange,
  schedulePatch,
  type DependencyType,
  type TimelineConfig,
} from "./database-timeline";
import type { Field, Row, View } from "./types";

export type ShiftMode = "overlap" | "keep" | "off";
export type ArrowVisibility = NonNullable<TimelineConfig["arrowVisibility"]>;
export type ArrowOverlap = NonNullable<TimelineConfig["arrowOverlap"]>;
export type ArrowRouting = NonNullable<TimelineConfig["arrowRouting"]>;
type Range = { start: number; end: number };

// The old checkbox: on kept the gaps, off (or unset) moved nothing.
export function shiftModeOf(config: Pick<TimelineConfig, "shiftMode" | "moveSuccessors"> | undefined): ShiftMode {
  return config?.shiftMode ?? (config?.moveSuccessors ? "keep" : "off");
}
// The settings as the timeline uses them; unset values keep the look the
// view had before 0.11.0.
export function timelineSettings(config: TimelineConfig | undefined) {
  return {
    shiftMode: shiftModeOf(config),
    avoidWeekends: !!config?.avoidWeekends,
    arrowVisibility: (config?.arrowVisibility ?? "all") as ArrowVisibility,
    arrowOverlap: (config?.arrowOverlap ?? "opaque") as ArrowOverlap,
    arrowRouting: (config?.arrowRouting ?? "curved") as ArrowRouting,
  };
}
// Settings about to be saved: the shift mode replaces the old checkbox.
export function migrateTimeline(config: TimelineConfig): TimelineConfig {
  if (config.moveSuccessors === undefined) return config;
  const { moveSuccessors: _, ...rest } = config;
  return { ...rest, shiftMode: shiftModeOf(config) };
}

// ---- weekends ----
// Days since 1970-01-01 (a Thursday); Monday is 0.
export const weekday = (day: number) => (((day + 3) % 7) + 7) % 7;
export const isWeekend = (day: number) => weekday(day) >= 5;
// Monday after a Saturday or Sunday, else the day itself.
export const nextWorkday = (day: number) => (isWeekend(day) ? day + (7 - weekday(day)) : day);
// Monday to Friday within [start, end] (inclusive).
export function workingDays(start: number, end: number) {
  if (end < start) return 0;
  const weeks = Math.floor((end - start + 1) / 7);
  let count = weeks * 5;
  for (let d = start + weeks * 7; d <= end; d++) if (!isWeekend(d)) count++;
  return count;
}
// The day on which `count` working days from `start` (a weekday) end.
export function addWorkingDays(start: number, count: number) {
  let day = start,
    left = Math.max(1, count) - 1;
  const weeks = Math.floor(left / 5);
  day += weeks * 7;
  left -= weeks * 5;
  while (left > 0) {
    day++;
    if (!isWeekend(day)) left--;
  }
  return day;
}
// "Wochenenden meiden" for a record that was moved from `original` to
// `moved`: a start on a Saturday or Sunday goes on to Monday, and the record
// keeps as many working days as it had (a Friday–Monday record stays two
// working days long, so its end never lands on a weekend either). A record
// without a working day (only on a weekend) keeps its calendar length from
// the Monday. It only ever moves later, so no link it met is broken.
export function offWeekend(moved: Range, original: Range): Range {
  const start = nextWorkday(moved.start);
  const days = workingDays(original.start, original.end);
  if (!days) return { start, end: start + (original.end - original.start) };
  return { start, end: Math.max(addWorkingDays(start, days), start) };
}
const shifted = (r: Range, days: number): Range => ({ start: r.start + days, end: r.end + days });

// New periods for the records that follow changed ones. `changed` holds
// the records already placed (the one dragged, with its new period);
// `scope` the records allowed to move: "successors" – everything waiting
// for a changed record, directly or through others –, "all", or a list.
// `keep` moves every record in scope by that many days first (the "keep"
// mode; 0 moves only as far as a link needs). Records without a period are
// skipped, as are links to them. Null when the records involved wait for
// each other in a circle.
export function planShifts({
  ranges,
  predecessors,
  type = "fs",
  changed = new Map(),
  scope = "successors",
  keep = 0,
  avoidWeekends = false,
}: {
  ranges: Map<string, Range>;
  predecessors: Map<string, string[]>;
  type?: DependencyType;
  changed?: Map<string, Range>;
  scope?: "successors" | "all" | Iterable<string>;
  keep?: number;
  avoidWeekends?: boolean;
}): Map<string, Range> | null {
  // A record that just got its first period counts with it.
  for (const [id, r] of changed) if (!ranges.has(id)) ranges = new Map([...ranges, [id, r]]);
  const successors = new Map<string, string[]>();
  for (const [id, list] of predecessors)
    for (const p of list) if (p !== id && ranges.has(p) && ranges.has(id)) successors.set(p, [...(successors.get(p) || []), id]);
  let allowed: Set<string>;
  if (scope === "all") allowed = new Set(ranges.keys());
  else if (scope === "successors") {
    allowed = new Set();
    const queue = [...changed.keys()];
    while (queue.length) for (const next of successors.get(queue.shift()!) || []) if (!allowed.has(next)) (allowed.add(next), queue.push(next));
  } else allowed = new Set([...scope].filter((id) => ranges.has(id)));
  for (const id of changed.keys()) allowed.delete(id);
  // Kahn's order over the records involved: the changed ones, those in
  // scope and the predecessors these wait for.
  const involved = new Set([...allowed, ...changed.keys()].filter((id) => ranges.has(id)));
  const incoming = new Map([...involved].map((id) => [id, 0]));
  for (const id of involved) for (const s of successors.get(id) || []) if (involved.has(s)) incoming.set(s, incoming.get(s)! + 1);
  const order = [...involved].filter((id) => !incoming.get(id));
  for (let i = 0; i < order.length; i++)
    for (const s of successors.get(order[i]) || [])
      if (involved.has(s)) {
        incoming.set(s, incoming.get(s)! - 1);
        if (!incoming.get(s)) order.push(s);
      }
  if (order.length < involved.size) return null;
  const result = new Map<string, Range>();
  const now = (id: string) => changed.get(id) || result.get(id) || ranges.get(id);
  const needed = (id: string, r: Range) =>
    Math.max(
      0,
      ...(predecessors.get(id) || [])
        .filter((p) => p !== id && ranges.has(p))
        .map((p) => requiredShift(type, now(p)!, r)),
    );
  for (const id of order) {
    if (!allowed.has(id)) continue;
    const base = ranges.get(id)!;
    let next = keep ? shifted(base, keep) : base;
    // "keep" moves by the same days as before 0.11.0; links are only looked
    // at when the weekends could have stretched a predecessor.
    if (!keep || avoidWeekends) next = shifted(next, needed(id, next));
    if (avoidWeekends && (next.start !== base.start || next.end !== base.end))
      for (let i = 0; i < 8; i++) {
        next = offWeekend(next, base);
        const more = needed(id, next);
        if (!more) break;
        next = shifted(next, more);
      }
    if (next.start !== base.start || next.end !== base.end) result.set(id, next);
  }
  return result;
}

// ---- redundant links ----
// Links that a longer way already implies: A → C when A → B → C exists.
// Only a hint (the dependency settings list them); nothing is removed.
export type RedundantLink = { from: string; to: string; via: string[] };
export function redundantLinks(links: { from: string; to: string }[], limit = 50): RedundantLink[] {
  const out: RedundantLink[] = [];
  if (links.length > 5000) return out;
  const successors = new Map<string, string[]>();
  for (const l of links) if (l.from !== l.to) successors.set(l.from, [...new Set([...(successors.get(l.from) || []), l.to])]);
  for (const [from, list] of successors) {
    for (const to of list) {
      // A way from `from` to `to` that does not take the direct link.
      const back = new Map<string, string>();
      const queue = list.filter((x) => x !== to);
      for (const q of queue) back.set(q, from);
      let found = false;
      for (let i = 0; i < queue.length && !found && i < 20000; i++) {
        const at = queue[i];
        for (const next of successors.get(at) || []) {
          if (back.has(next) || next === from) continue;
          back.set(next, at);
          if (next === to) {
            found = true;
            break;
          }
          queue.push(next);
        }
      }
      if (!found) continue;
      const via: string[] = [];
      for (let at = back.get(to); at && at !== from; at = back.get(at)) via.unshift(at);
      out.push({ from, to, via });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---- records ----
// Periods and predecessors of the given records (links to records that are
// not given or to themselves left out).
export function planInputs(rows: Pick<Row, "id" | "cells">[], field: Field | undefined, start?: Field, end?: Field) {
  const ranges = new Map<string, Range>();
  for (const row of rows) {
    const r = rowRange(row, start, end);
    if (r) ranges.set(row.id, r);
  }
  const ids = new Set(rows.map((r) => r.id));
  const predecessors = new Map<string, string[]>();
  if (field)
    for (const row of rows) {
      const raw = row.cells[field.id];
      predecessors.set(row.id, [
        ...new Set((Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === "string" && v !== row.id && ids.has(v))),
      ]);
    }
  return { ranges, predecessors };
}
// The cells that move a record from `from` to `to`: a move when the length
// stays (times and an empty end are kept), else the new start and end.
export function rangePatch(row: Pick<Row, "cells">, fields: Field[], view: View, from: Range, to: Range) {
  return to.end - to.start === from.end - from.start
    ? schedulePatch(row, fields, view, { operation: "move", days: to.start - from.start })
    : schedulePatch(row, fields, view, { operation: "set", start: dayKey(to.start), end: dayKey(to.end) });
}
// Days the side of a predecessor that its successors are linked to moved:
// the start for "ss" and "sf", the end for "fs" and "ff" (the default).
export function linkedDelta(type: DependencyType | undefined, before: Range, after: Range) {
  return type === "ss" || type === "sf" ? after.start - before.start : after.end - before.end;
}
// What follows a changed record under the view's shift mode: the new
// periods of the records waiting for it. `delta` is how far the linked end
// of the record moved (the "keep" mode moves by that).
export function followShifts(
  rows: Pick<Row, "id" | "cells">[],
  field: Field | undefined,
  start: Field | undefined,
  end: Field | undefined,
  config: TimelineConfig | undefined,
  changed: { id: string; range: Range },
  delta: number,
): Map<string, Range> | null {
  const mode = shiftModeOf(config);
  if (!field || mode === "off") return new Map();
  if (mode === "keep" && !delta) return new Map();
  const { ranges, predecessors } = planInputs(rows, field, start, end);
  return planShifts({
    ranges,
    predecessors,
    type: config?.dependencyType || "fs",
    changed: new Map([[changed.id, changed.range]]),
    scope: "successors",
    keep: mode === "keep" ? delta : 0,
    avoidWeekends: !!config?.avoidWeekends,
  });
}
