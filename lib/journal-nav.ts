// Finding one's way through a journal without listing every day (#49):
// what the page tree shows below a journal, the neighbours of a day and the
// days of a month. Pure functions, used by the browser (the sidebar, the day
// header) and the server (the setting's schema), tested in
// tests/journal-nav.test.ts.

// How a journal's days appear in the page tree ("Tage in der Seitenleiste"):
// none – no days; recent – today and the last 7 days (the default);
// grouped – the same, older days in folders per year and month; all – every
// day, as before.
export const SIDEBAR_MODES = ["none", "recent", "grouped", "all"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];
export const DEFAULT_SIDEBAR_MODE: SidebarMode = "recent";
export const RECENT_DAYS = 7;
export const sidebarMode = (value: unknown): SidebarMode =>
  SIDEBAR_MODES.includes(value as SidebarMode) ? (value as SidebarMode) : DEFAULT_SIDEBAR_MODE;

export type DayLike = { id: string; journal_date?: string | null };

export function shiftDate(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Virtual folders: only in the tree, never pages. Their keys stay the same
// across renders, so a folder keeps being open.
export const yearKey = (journalId: string, year: string) => `journal:${journalId}:${year}`;
export const monthKey = (journalId: string, month: string) => `journal:${journalId}:${month}`;
export const isFolderKey = (key: string) => key.startsWith("journal:");

export type MonthFolder<D> = {
  kind: "month";
  key: string;
  // YYYY-MM
  month: string;
  count: number;
  open: boolean;
  // Only filled while the folder is open: hidden days are not rendered.
  days: D[];
};
export type YearFolder<D> = {
  kind: "year";
  key: string;
  year: string;
  count: number;
  open: boolean;
  months: MonthFolder<D>[];
};
export type SidebarEntry<D> =
  // Today – also when its page does not exist (yet).
  | { kind: "today"; day: D | null }
  | { kind: "day"; day: D }
  | YearFolder<D>
  // "Alle Tage …": opens the journal's own overview.
  | { kind: "all"; count: number };

// The entries below a journal in the page tree. `days` are the journal's day
// pages in any order; `openId` is the page open right now (a day of this
// journal stays visible wherever it is: its year and month unfold); the
// folders opened and closed by hand win over that. Cost: one pass over the
// days plus sorting, nothing per hidden day.
export function journalSidebar<D extends DayLike>(
  days: D[],
  options: {
    journalId: string;
    mode: SidebarMode;
    today: string;
    openId?: string | null;
    expanded?: ReadonlySet<string>;
    collapsed?: ReadonlySet<string>;
  },
): SidebarEntry<D>[] {
  const { journalId, mode, today, openId, expanded, collapsed } = options;
  const isOpen = (key: string, reveal: boolean) => !collapsed?.has(key) && (!!expanded?.has(key) || reveal);
  const dated = days.filter((d): d is D & { journal_date: string } => !!d.journal_date);
  const sorted = [...dated].sort((a, b) => (a.journal_date < b.journal_date ? 1 : a.journal_date > b.journal_date ? -1 : 0));
  const open = openId ? sorted.find((d) => d.id === openId) : undefined;
  const todayPage = sorted.find((d) => d.journal_date === today) || null;
  if (mode === "none") return open ? [{ kind: "day", day: open }] : [];
  if (mode === "all")
    return [{ kind: "today", day: todayPage }, ...sorted.filter((d) => d !== todayPage).map((day) => ({ kind: "day" as const, day }))];
  const since = shiftDate(today, -RECENT_DAYS);
  // Days after today (a clock ahead) count as recent.
  const recent = sorted.filter((d) => d !== todayPage && d.journal_date >= since);
  const older = sorted.filter((d) => d.journal_date < since);
  const entries: SidebarEntry<D>[] = [{ kind: "today", day: todayPage }, ...recent.map((day) => ({ kind: "day" as const, day }))];
  if (mode === "recent") {
    // An older day that is open shows up after the recent ones.
    if (open && open.journal_date < since) entries.push({ kind: "day", day: open });
  } else {
    const years = new Map<string, Map<string, D[]>>();
    for (const day of older) {
      const year = day.journal_date.slice(0, 4),
        month = day.journal_date.slice(0, 7);
      let months = years.get(year);
      if (!months) years.set(year, (months = new Map()));
      const list = months.get(month);
      if (list) list.push(day);
      else months.set(month, [day]);
    }
    const openMonth = open && open.journal_date < since ? open.journal_date.slice(0, 7) : null;
    for (const [year, months] of years) {
      const key = yearKey(journalId, year);
      const yearOpen = isOpen(key, openMonth?.slice(0, 4) === year);
      let count = 0;
      const folders: MonthFolder<D>[] = [];
      for (const [month, list] of months) {
        count += list.length;
        const mKey = monthKey(journalId, month);
        const monthOpen = yearOpen && isOpen(mKey, openMonth === month);
        folders.push({ kind: "month", key: mKey, month, count: list.length, open: monthOpen, days: monthOpen ? list : [] });
      }
      entries.push({ kind: "year", key, year, count, open: yearOpen, months: yearOpen ? folders : [] });
    }
  }
  entries.push({ kind: "all", count: sorted.length });
  return entries;
}

export const todayKey = (journalId: string) => `journal:${journalId}:today`;
export const allDaysKey = (journalId: string) => `journal:${journalId}:all`;
// What an entry list renders: ids of day pages and keys of virtual items
// (for the tree's one Tab stop, which must be an item that is shown).
export function shownTreeIds<D extends DayLike>(entries: SidebarEntry<D>[], journalId: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "today") ids.add(entry.day ? entry.day.id : todayKey(journalId));
    else if (entry.kind === "day") ids.add(entry.day.id);
    else if (entry.kind === "all") ids.add(allDaysKey(journalId));
    else {
      ids.add(entry.key);
      for (const month of entry.months) {
        ids.add(month.key);
        for (const day of month.days) ids.add(day.id);
      }
    }
  }
  return ids;
}

// The previous and next day with an entry, from a day (that may have none).
export function neighbourDays<D extends DayLike>(days: D[], date: string): { previous: D | null; next: D | null } {
  let previous: D | null = null,
    next: D | null = null;
  for (const day of days) {
    const at = day.journal_date;
    if (!at) continue;
    if (at < date && (!previous || at > previous.journal_date!)) previous = day;
    if (at > date && (!next || at < next.journal_date!)) next = day;
  }
  return { previous, next };
}

// The weeks of a month for a picker: dates (YYYY-MM-DD) or null for the
// gaps before the first and after the last day; Monday first.
export function monthGrid(month: string): (string | null)[][] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
export function shiftMonth(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

// The month summary of a journal (one per month): a normal sub page of the
// journal, remembered under this key so it is not created twice.
export const summaryKey = (month: string) => `month-summary:${month}`;
export const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
// The month a period covers exactly, else null.
export function wholeMonth(from: string, to: string): string | null {
  const month = from.slice(0, 7);
  if (!monthPattern.test(month)) return null;
  const range = monthRange(month);
  return range.from === from && range.to === to ? month : null;
}

// Lists of recently edited pages (the start page): of each journal only its
// latest day, so a year of entries does not push every other page out.
export function oneDayPerJournal<P extends { parent_id?: string | null; journal_date?: string | null }>(pages: P[]): P[] {
  const seen = new Set<string>();
  return pages.filter((p) => {
    if (!p.journal_date || !p.parent_id) return true;
    if (seen.has(p.parent_id)) return false;
    seen.add(p.parent_id);
    return true;
  });
}
