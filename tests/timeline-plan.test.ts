// Planning rules of the timeline (#394, #395): shift modes, weekends,
// redundant links, settings migration, arrow routing, the outline and its
// summary periods.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addWorkingDays,
  followShifts,
  isWeekend,
  linkedDelta,
  migrateTimeline,
  nextWorkday,
  offWeekend,
  planShifts,
  rangePatch,
  redundantLinks,
  shiftModeOf,
  timelineSettings,
  weekday,
  workingDays,
} from "../lib/timeline-plan";
import { anchoredLinks, descendants, groupRange, readCollapsed, summaryRanges, timelineOutline, writeCollapsed } from "../lib/timeline-tree";
import { arrowGeometry, milestoneDay, orthogonalPoints, roundedPath } from "../lib/timeline-scale";
import { dateDay, dayKey, timelineSchema, NEW_TIMELINE } from "../lib/database-timeline";
import { barColor, timelineGroups } from "../lib/timeline-groups";
import type { Field, Row, View } from "../lib/types";

const d = (key: string) => dateDay(key)!;
const r = (a: string, b: string) => ({ start: d(a), end: d(b) });
const keys = (m: Map<string, { start: number; end: number }> | null) =>
  m && Object.fromEntries([...m].map(([id, x]) => [id, `${dayKey(x.start)}..${dayKey(x.end)}`]));

test("the old checkbox reads as a shift mode and is replaced when saved", () => {
  assert.equal(shiftModeOf(undefined), "off");
  assert.equal(shiftModeOf({ moveSuccessors: true }), "keep");
  assert.equal(shiftModeOf({ moveSuccessors: false }), "off");
  assert.equal(shiftModeOf({ moveSuccessors: true, shiftMode: "overlap" }), "overlap");
  const old = { scale: "month" as const, showWeekends: true, moveSuccessors: true, dependencyField: "deps" };
  const saved = migrateTimeline(old);
  assert.deepEqual(saved, { scale: "month", showWeekends: true, dependencyField: "deps", shiftMode: "keep" });
  assert.deepEqual(migrateTimeline({ scale: "month", showWeekends: true, moveSuccessors: false }), { scale: "month", showWeekends: true, shiftMode: "off" });
  // Settings without the new values look as before; new views are calm.
  assert.deepEqual(timelineSettings(old), { shiftMode: "keep", avoidWeekends: false, arrowVisibility: "all", arrowOverlap: "opaque", arrowRouting: "curved" });
  assert.equal(timelineSettings(NEW_TIMELINE).arrowOverlap, "transparent");
  assert.equal(timelineSettings(NEW_TIMELINE).arrowRouting, "orthogonal");
  assert.ok(timelineSchema.safeParse({ ...NEW_TIMELINE, shiftMode: "overlap", arrowVisibility: "critical", hierarchyField: "parent", colorField: "level", milestoneOnlyField: true, summaryBaseline: true, avoidWeekends: true }).success);
  assert.ok(!timelineSchema.safeParse({ ...NEW_TIMELINE, shiftMode: "sometimes" }).success);
});

test("weekdays, working days and the weekend rule", () => {
  // 2026-11-16 is a Monday.
  assert.equal(weekday(d("2026-11-16")), 0);
  assert.equal(weekday(d("1970-01-01")), 3);
  assert.ok(isWeekend(d("2026-11-21")) && isWeekend(d("2026-11-22")) && !isWeekend(d("2026-11-20")));
  assert.equal(dayKey(nextWorkday(d("2026-11-21"))), "2026-11-23");
  assert.equal(dayKey(nextWorkday(d("2026-11-22"))), "2026-11-23");
  assert.equal(dayKey(nextWorkday(d("2026-11-20"))), "2026-11-20");
  assert.equal(workingDays(d("2026-11-16"), d("2026-11-22")), 5);
  assert.equal(workingDays(d("2026-11-20"), d("2026-11-23")), 2);
  assert.equal(workingDays(d("2026-11-21"), d("2026-11-22")), 0);
  assert.equal(dayKey(addWorkingDays(d("2026-11-19"), 3)), "2026-11-23");
  assert.equal(dayKey(addWorkingDays(d("2026-11-16"), 10)), "2026-11-27");
  // Mon–Fri moved by two days starts on Wednesday and keeps five working days.
  assert.deepEqual(offWeekend(r("2026-11-18", "2026-11-22"), r("2026-11-16", "2026-11-20")), r("2026-11-18", "2026-11-24"));
  // A start on Saturday goes on to Monday; a one-day record stays one day.
  assert.deepEqual(offWeekend(r("2026-11-21", "2026-11-21"), r("2026-11-20", "2026-11-20")), r("2026-11-23", "2026-11-23"));
  // A record only on a weekend keeps its calendar length from Monday.
  assert.deepEqual(offWeekend(r("2026-11-28", "2026-11-29"), r("2026-11-21", "2026-11-22")), r("2026-11-30", "2026-12-01"));
});

// a → b → c, a → c; d waits for c.
const ranges = () =>
  new Map([
    ["a", r("2026-11-02", "2026-11-06")],
    ["b", r("2026-11-09", "2026-11-10")],
    ["c", r("2026-11-16", "2026-11-18")],
    ["d", r("2026-11-19", "2026-11-20")],
    ["x", r("2026-11-02", "2026-11-03")],
  ]);
const predecessors = new Map([
  ["b", ["a"]],
  ["c", ["b", "a"]],
  ["d", ["c"]],
]);

test("shift modes: only as far as needed, keeping the gaps, weekends", () => {
  // a ends three days later (Monday): b must start Tuesday; c keeps its slack.
  const moved = new Map([["a", r("2026-11-02", "2026-11-09")]]);
  assert.deepEqual(keys(planShifts({ ranges: ranges(), predecessors, changed: moved })), { b: "2026-11-10..2026-11-11" });
  // Further: c and then d are pushed as well, exactly as far as needed.
  assert.deepEqual(keys(planShifts({ ranges: ranges(), predecessors, changed: new Map([["a", r("2026-11-02", "2026-11-15")]]) })), {
    b: "2026-11-16..2026-11-17",
    c: "2026-11-18..2026-11-20",
    d: "2026-11-21..2026-11-22",
  });
  // The same off weekends: d would start on Saturday and goes to Monday.
  assert.deepEqual(keys(planShifts({ ranges: ranges(), predecessors, changed: new Map([["a", r("2026-11-02", "2026-11-15")]]), avoidWeekends: true })), {
    b: "2026-11-16..2026-11-17",
    c: "2026-11-18..2026-11-20",
    d: "2026-11-23..2026-11-24",
  });
  // Earlier: nothing has to move.
  assert.equal(planShifts({ ranges: ranges(), predecessors, changed: new Map([["a", r("2026-10-26", "2026-10-30")]]) })!.size, 0);
  // Keeping the gaps: every successor by the same days, either way.
  assert.deepEqual(keys(planShifts({ ranges: ranges(), predecessors, changed: new Map([["a", r("2026-10-30", "2026-11-03")]]), keep: -3 })), {
    b: "2026-11-06..2026-11-07",
    c: "2026-11-13..2026-11-15",
    d: "2026-11-16..2026-11-17",
  });
  // … off weekends: b (Fri–Sat) keeps its two working days, Fri–Mon; c
  // would start on Friday the 13th and end on Sunday: Fri–Tue, d follows.
  assert.deepEqual(keys(planShifts({ ranges: ranges(), predecessors, changed: new Map([["a", r("2026-10-30", "2026-11-03")]]), keep: -3, avoidWeekends: true })), {
    b: "2026-11-06..2026-11-09",
    c: "2026-11-13..2026-11-17",
    d: "2026-11-18..2026-11-19",
  });
  // Resolve all: every conflict as far as needed.
  const late = new Map([...ranges(), ["b", r("2026-11-04", "2026-11-05")]]);
  assert.deepEqual(keys(planShifts({ ranges: late, predecessors, scope: "all" })), { b: "2026-11-07..2026-11-08" });
  assert.deepEqual(keys(planShifts({ ranges: late, predecessors, scope: "all", avoidWeekends: true })), { b: "2026-11-09..2026-11-10" });
  // One record only (the conflict button).
  assert.deepEqual(keys(planShifts({ ranges: late, predecessors, scope: ["b"] })), { b: "2026-11-07..2026-11-08" });
  // Circles are refused.
  assert.equal(planShifts({ ranges: ranges(), predecessors: new Map([...predecessors, ["a", ["d"]]]), changed: new Map([["a", r("2026-11-02", "2026-11-15")]]) }), null);
  // Start-to-start links measure from the start.
  assert.equal(linkedDelta("ss", r("2026-11-02", "2026-11-06"), r("2026-11-04", "2026-11-06")), 2);
  assert.equal(linkedDelta("fs", r("2026-11-02", "2026-11-06"), r("2026-11-04", "2026-11-06")), 0);
});

test("followShifts reads the view's mode and rangePatch keeps times and lengths", () => {
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "start", name: "Beginn", type: "date" },
    { id: "end", name: "Ende", type: "date" },
    { id: "deps", name: "Nach", type: "relation", relationPage: "p" },
  ];
  const rows = [
    { id: "a", cells: { start: "2026-11-02", end: "2026-11-06" } },
    { id: "b", cells: { start: "2026-11-09T09:00", end: "2026-11-10", deps: ["a"] } },
  ];
  const view = { id: "t", name: "T", type: "timeline", filters: [], sorts: [], dateField: "start", endDateField: "end" } as View;
  const moved = { id: "a", range: r("2026-11-02", "2026-11-09") };
  assert.equal(followShifts(rows, fields[3], fields[1], fields[2], { scale: "month", showWeekends: true }, moved, 3)!.size, 0);
  assert.deepEqual(keys(followShifts(rows, fields[3], fields[1], fields[2], { scale: "month", showWeekends: true, moveSuccessors: true }, moved, 3)), { b: "2026-11-12..2026-11-13" });
  assert.deepEqual(keys(followShifts(rows, fields[3], fields[1], fields[2], { scale: "month", showWeekends: true, shiftMode: "overlap" }, moved, 3)), { b: "2026-11-10..2026-11-11" });
  assert.deepEqual(rangePatch(rows[1], fields, view, r("2026-11-09", "2026-11-10"), r("2026-11-12", "2026-11-13")), { start: "2026-11-12T09:00", end: "2026-11-13" });
  assert.deepEqual(rangePatch(rows[1], fields, view, r("2026-11-09", "2026-11-10"), r("2026-11-13", "2026-11-16")), { start: "2026-11-13T09:00", end: "2026-11-16" });
});

test("redundant links are found, never more", () => {
  const links = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
    { from: "c", to: "d" },
    { from: "a", to: "d" },
    { from: "x", to: "d" },
  ];
  assert.deepEqual(redundantLinks(links), [
    { from: "a", to: "c", via: ["b"] },
    // The shortest other way is named.
    { from: "a", to: "d", via: ["c"] },
  ]);
  assert.deepEqual(redundantLinks([{ from: "a", to: "b" }, { from: "b", to: "a" }]), []);
  assert.equal(redundantLinks(links, 1).length, 1);
});

const box = (left: number, right: number, top: number) => ({ left, right, top, height: 28 });
test("orthogonal arrows: out of the end, down, into the start; an elbow when the successor starts earlier", () => {
  // Room between the bars: down at the stub, then into the start.
  assert.deepEqual(orthogonalPoints(box(0, 100, 10), box(200, 300, 58), "fs"), [
    { x: 100, y: 24 },
    { x: 110, y: 24 },
    { x: 110, y: 72 },
    { x: 194, y: 72 },
  ]);
  // The successor starts the next day (bars touch): straight down onto it.
  assert.deepEqual(orthogonalPoints(box(0, 100, 10), box(100, 200, 58), "fs"), [
    { x: 100, y: 24 },
    { x: 110, y: 24 },
    { x: 110, y: 52 },
  ]);
  // It starts before the predecessor ends: an elbow above it.
  const elbow = orthogonalPoints(box(0, 100, 10), box(50, 150, 58), "fs");
  assert.equal(elbow.length, 6);
  assert.deepEqual(elbow[2], { x: 110, y: 49 });
  assert.deepEqual(elbow[3], { x: 40, y: 49 });
  assert.deepEqual(elbow[5], { x: 44, y: 72 });
  // Upwards and end-to-end links mirror it.
  assert.deepEqual(orthogonalPoints(box(200, 300, 58), box(0, 100, 10), "ff").at(-1), { x: 106, y: 24 });
  assert.match(roundedPath(elbow), /^M 100 24 L .* Q .* L 44 72$/);
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]), "M 0 0 L 10 0");
});

test("arrows with an end out of sight become stubs", () => {
  const view = { left: 200, right: 800 };
  const full = arrowGeometry(box(250, 300, 10), box(400, 500, 58), "fs", "orthogonal", view)!;
  assert.equal(full.stub, false);
  // The predecessor is scrolled away to the left: a stub into the successor.
  assert.deepEqual(arrowGeometry(box(0, 100, 10), box(400, 500, 58), "fs", "orthogonal", view), { d: "M 378 72 L 394 72", stub: true });
  // … and clamped to the edge when the successor starts right there.
  assert.deepEqual(arrowGeometry(box(0, 100, 10), box(205, 500, 58), "fs", "curved", view), { d: "M 200 72 L 199 72", stub: true });
  // The successor is outside the window (no bar): a stub out of the predecessor.
  assert.deepEqual(arrowGeometry(box(250, 300, 10), null, "fs", "curved", view), { d: "M 300 24 L 322 24", stub: true });
  // Both out of sight: nothing.
  assert.equal(arrowGeometry(box(0, 100, 10), box(900, 950, 58), "fs", "curved", view), null);
  // Without a view (all in sight) the curve as before.
  assert.match(arrowGeometry(box(0, 100, 10), box(200, 300, 58), "fs", "curved")!.d, /^M 100 24 C /);
});

test("only the milestone property makes milestones when asked", () => {
  assert.equal(milestoneDay({ start: 5, end: 5 }, false), 5);
  assert.equal(milestoneDay({ start: 5, end: 5 }, false, true), null);
  assert.equal(milestoneDay({ start: 5, end: 9 }, true, true), 9);
});

test("the outline: parents, groups, collapsing, summary periods and links", () => {
  const items = [
    { id: "p1", group: "g1" },
    { id: "a", parent: "p1", group: "g1" },
    { id: "a1", parent: "a", group: "g1" },
    { id: "b", parent: "p1", group: "g1" },
    { id: "p2", group: "g2" },
    // A parent in another group: top-level in its own group.
    { id: "c", parent: "p1", group: "g2" },
    // A loop and a missing parent: top-level.
    { id: "l1", parent: "l2", group: "g2" },
    { id: "l2", parent: "l1", group: "g2" },
    { id: "m", parent: "gone", group: "g2" },
  ];
  const groups = [
    { key: "g1", label: "Phase 1" },
    { key: "g2", label: "Phase 2" },
    { key: "g3", label: "Empty" },
  ];
  const open = timelineOutline(items, { groups });
  assert.deepEqual(
    open.lines.map((l) => `${l.id}:${l.depth}`),
    ["group:g1:0", "p1:1", "a:2", "a1:3", "b:2", "group:g2:0", "p2:1", "c:1", "l1:1", "l2:2", "m:1"],
  );
  assert.deepEqual(descendants(open.childrenOf, "p1"), ["a", "b", "a1"]);
  // Collapsed: the children hide and show on their parent's line.
  const closed = timelineOutline(items, { groups, collapsed: new Set(["p1", "group:g2"]) });
  assert.deepEqual(closed.lines.map((l) => l.id), ["group:g1", "p1", "group:g2"]);
  assert.equal(closed.anchor.get("a1"), "p1");
  assert.equal(closed.anchor.get("c"), "group:g2");
  const links = anchoredLinks(
    [
      { from: "a1", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ],
    closed.anchor,
  );
  assert.deepEqual(links.map((l) => `${l.line.from}>${l.line.to}`), ["p1>group:g2"]);
  // Without groups.
  assert.deepEqual(timelineOutline([{ id: "x" }, { id: "y", parent: "x" }]).lines.map((l) => [l.id, l.depth, l.type === "row" && l.children]), [
    ["x", 0, 1],
    ["y", 1, 0],
  ]);
  // Summary periods: from the earliest start to the latest end below.
  const dates: Record<string, { start: number; end: number }> = { p1: { start: 0, end: 1 }, a: { start: 5, end: 8 }, a1: { start: 3, end: 12 }, b: { start: 9, end: 10 } };
  const sums = summaryRanges(open.childrenOf, (id) => dates[id]);
  assert.deepEqual(sums.get("p1"), { start: 3, end: 12 });
  assert.deepEqual(sums.get("a"), { start: 3, end: 12 });
  assert.equal(sums.has("b"), false);
  assert.deepEqual(groupRange(["a", "b", "zz"], (id) => dates[id]), { start: 5, end: 10 });
  assert.equal(groupRange(["zz"], (id) => dates[id]), null);
});

test("collapsed parents are kept per view on the device", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  writeCollapsed(storage, "p:v", new Set(["a", "group:x"]));
  assert.deepEqual([...readCollapsed(storage, "p:v")], ["a", "group:x"]);
  assert.equal(readCollapsed(storage, "other").size, 0);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readCollapsed(broken, "p:v").size, 0);
  writeCollapsed(broken, "p:v", new Set(["a"]));
});

test("groups and colours by a property", () => {
  const level: Field = { id: "level", name: "Level", type: "select", options: ["Phase", "Aktivität", "Meilenstein"], optionColors: { Phase: "purple" } };
  const tags: Field = { id: "tags", name: "Tags", type: "multiselect", options: ["x", "y"] };
  const rows = [
    { id: "1", cells: { level: "Phase", tags: ["y", "x"] } },
    { id: "2", cells: { level: "Aktivität" } },
    { id: "3", cells: {} },
  ] as unknown as Row[];
  assert.equal(barColor(level, rows[0]), "purple");
  // Without a colour of its own: the colour of its place.
  assert.equal(barColor(level, rows[1]), "green");
  assert.equal(barColor(level, rows[2]), undefined);
  assert.equal(barColor(level, { cells: { level: "Other" } }), "gray");
  assert.equal(barColor(tags, rows[0]), "green");
  const grouped = timelineGroups(rows, tags, (de) => de);
  assert.deepEqual(grouped.groups.map((g) => g.label), ["x", "y", "Ohne Gruppe"]);
  assert.equal(grouped.keyOf.get("1"), JSON.stringify("y"));
  assert.equal(grouped.keyOf.get("3"), "empty");
});
