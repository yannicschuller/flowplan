import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allDaysKey,
  journalSidebar,
  monthGrid,
  monthKey,
  neighbourDays,
  oneDayPerJournal,
  shiftDate,
  shiftMonth,
  shownTreeIds,
  sidebarMode,
  todayKey,
  wholeMonth,
  yearKey,
  type SidebarEntry,
} from "../lib/journal-nav";

const J = "j1";
const today = "2026-10-27";
// One page per day going back `n` days from `from` (inclusive).
const daysBack = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const date = shiftDate(from, -i);
    return { id: `d-${date}`, journal_date: date };
  });
type Day = { id: string; journal_date: string };
const kinds = (entries: SidebarEntry<Day>[]) => entries.map((e) => (e.kind === "day" ? e.day.journal_date : e.kind === "year" ? `year ${e.year}` : e.kind));

test("the short journal: today, the last 7 days, then all days", () => {
  const days = daysBack(today, 30);
  const entries = journalSidebar(days, { journalId: J, mode: "recent", today });
  assert.deepEqual(kinds(entries), [
    "today",
    "2026-10-26",
    "2026-10-25",
    "2026-10-24",
    "2026-10-23",
    "2026-10-22",
    "2026-10-21",
    "2026-10-20",
    "all",
  ]);
  assert.equal((entries[0] as { day: Day }).day.id, "d-2026-10-27");
  assert.equal((entries.at(-1) as { count: number }).count, 30);
});

test("today shows without a page; gaps are not filled", () => {
  const days = [
    { id: "a", journal_date: "2026-10-25" },
    { id: "b", journal_date: "2026-09-01" },
  ];
  const entries = journalSidebar(days, { journalId: J, mode: "recent", today });
  assert.deepEqual(kinds(entries), ["today", "2026-10-25", "all"]);
  assert.equal((entries[0] as { day: Day | null }).day, null);
  assert.ok(shownTreeIds(entries, J).has(todayKey(J)));
  assert.ok(shownTreeIds(entries, J).has(allDaysKey(J)));
});

test("an open older day appears in the short journal", () => {
  const days = daysBack(today, 60);
  const entries = journalSidebar(days, { journalId: J, mode: "recent", today, openId: "d-2026-09-02" });
  assert.deepEqual(kinds(entries).slice(-2), ["2026-09-02", "all"]);
  assert.ok(shownTreeIds(entries, J).has("d-2026-09-02"));
  // Not twice when it is one of the recent days anyway.
  const recent = journalSidebar(days, { journalId: J, mode: "recent", today, openId: "d-2026-10-26" });
  assert.equal(recent.filter((e) => e.kind === "day" && e.day.id === "d-2026-10-26").length, 1);
});

test("grouped: older days in closed year and month folders with counts", () => {
  const days = [...daysBack(today, 40), ...daysBack("2025-12-31", 31)];
  const entries = journalSidebar(days, { journalId: J, mode: "grouped", today });
  assert.deepEqual(kinds(entries).slice(-3), ["year 2026", "year 2025", "all"]);
  const y2026 = entries.find((e) => e.kind === "year" && e.year === "2026") as Extract<SidebarEntry<Day>, { kind: "year" }>;
  // 40 days back from 27 Oct, minus today and the 7 recent ones.
  assert.equal(y2026.count, 32);
  assert.equal(y2026.open, false);
  assert.deepEqual(y2026.months, []);
  // Opened by hand: months newest first, still without days until opened.
  const opened = journalSidebar(days, { journalId: J, mode: "grouped", today, expanded: new Set([yearKey(J, "2026")]) });
  const year = opened.find((e) => e.kind === "year" && e.year === "2026") as Extract<SidebarEntry<Day>, { kind: "year" }>;
  assert.deepEqual(
    year.months.map((m) => [m.month, m.count, m.days.length]),
    [
      ["2026-10", 19, 0],
      ["2026-09", 13, 0],
    ],
  );
  const month = journalSidebar(days, {
    journalId: J,
    mode: "grouped",
    today,
    expanded: new Set([yearKey(J, "2026"), monthKey(J, "2026-09")]),
  }).find((e) => e.kind === "year" && e.year === "2026") as Extract<SidebarEntry<Day>, { kind: "year" }>;
  assert.equal(month.months[1].days.length, 13);
  assert.equal(month.months[1].days[0].journal_date, "2026-09-30");
  assert.equal(month.months[0].days.length, 0);
  // A month folder inside a closed year stays closed.
  const closedYear = journalSidebar(days, { journalId: J, mode: "grouped", today, expanded: new Set([monthKey(J, "2026-09")]) });
  assert.deepEqual((closedYear.find((e) => e.kind === "year" && e.year === "2026") as { months: unknown[] }).months, []);
});

test("grouped: the open day unfolds its year and month, unless closed by hand", () => {
  const days = [...daysBack(today, 40), ...daysBack("2025-12-31", 31)];
  const entries = journalSidebar(days, { journalId: J, mode: "grouped", today, openId: "d-2025-12-24" });
  const year = entries.find((e) => e.kind === "year" && e.year === "2025") as Extract<SidebarEntry<Day>, { kind: "year" }>;
  assert.equal(year.open, true);
  assert.equal(year.months[0].open, true);
  assert.ok(year.months[0].days.some((d) => d.id === "d-2025-12-24"));
  assert.ok(shownTreeIds(entries, J).has("d-2025-12-24"));
  const closed = journalSidebar(days, { journalId: J, mode: "grouped", today, openId: "d-2025-12-24", collapsed: new Set([yearKey(J, "2025")]) });
  assert.equal((closed.find((e) => e.kind === "year" && e.year === "2025") as { open: boolean }).open, false);
});

test("none and all", () => {
  const days = daysBack(today, 20);
  assert.deepEqual(journalSidebar(days, { journalId: J, mode: "none", today }), []);
  assert.deepEqual(kinds(journalSidebar(days, { journalId: J, mode: "none", today, openId: "d-2026-10-10" })), ["2026-10-10"]);
  const all = journalSidebar(days, { journalId: J, mode: "all", today });
  assert.equal(all.length, 20);
  assert.equal(all[0].kind, "today");
});

test("2,000 days: only the shown ones are handed out, quickly", () => {
  const days = daysBack(today, 2000).reverse();
  const started = performance.now();
  let entries: SidebarEntry<Day>[] = [];
  for (let i = 0; i < 20; i++) entries = journalSidebar(days, { journalId: J, mode: "grouped", today, openId: "d-2023-03-14" });
  const each = (performance.now() - started) / 20;
  assert.ok(each < 25, `took ${each.toFixed(1)} ms per run`);
  const shown = shownTreeIds(entries, J);
  // Today + 7 recent + the open day's month (31 days in March 2023) + all
  // year folders + the 12 month folders of the open year.
  const dayIds = [...shown].filter((id) => id.startsWith("d-"));
  assert.equal(dayIds.length, 1 + 7 + 31);
  const years = entries.filter((e) => e.kind === "year");
  // Every day is in a folder, a recent entry or today.
  assert.equal(years.reduce((sum, y) => sum + (y.kind === "year" ? y.count : 0), 0), 2000 - 8);
  assert.deepEqual(
    years.map((y) => y.kind === "year" && [y.year, y.count]),
    [
      ["2026", 292],
      ["2025", 365],
      ["2024", 366],
      ["2023", 365],
      ["2022", 365],
      ["2021", 239],
    ],
  );
  const recent = journalSidebar(days, { journalId: J, mode: "recent", today });
  assert.equal(recent.length, 9);
});

test("the neighbours of a day skip the days without an entry", () => {
  const days = [
    { id: "a", journal_date: "2026-10-01" },
    { id: "b", journal_date: "2026-10-05" },
    { id: "c", journal_date: "2026-10-20" },
  ];
  assert.deepEqual(neighbourDays(days, "2026-10-05"), { previous: days[0], next: days[2] });
  assert.deepEqual(neighbourDays(days, "2026-10-01"), { previous: null, next: days[1] });
  // From a day without a page (today before its first word).
  assert.deepEqual(neighbourDays(days, "2026-10-27"), { previous: days[2], next: null });
});

test("month helpers", () => {
  const grid = monthGrid("2026-10");
  // 1 October 2026 is a Thursday: three gaps first.
  assert.deepEqual(grid[0], [null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.ok(grid.every((week) => week.length === 7));
  assert.equal(grid.flat().filter(Boolean).length, 31);
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(wholeMonth("2026-02-01", "2026-02-28"), "2026-02");
  assert.equal(wholeMonth("2026-02-01", "2026-02-27"), null);
  assert.equal(wholeMonth("2026-10-05", "2026-10-11"), null);
  assert.equal(sidebarMode("grouped"), "grouped");
  assert.equal(sidebarMode("nonsense"), "recent");
  assert.equal(sidebarMode(undefined), "recent");
});

test("recently edited: one day per journal, other pages untouched", () => {
  const pages = [
    { id: "d3", parent_id: "j1", journal_date: "2026-10-27" },
    { id: "d2", parent_id: "j1", journal_date: "2026-10-26" },
    { id: "p1", parent_id: null, journal_date: null },
    { id: "e1", parent_id: "j2", journal_date: "2026-10-20" },
    { id: "d1", parent_id: "j1", journal_date: "2026-10-25" },
    { id: "p2", parent_id: "j1", journal_date: null },
  ];
  assert.deepEqual(oneDayPerJournal(pages).map((p) => p.id), ["d3", "p1", "e1", "p2"]);
});
