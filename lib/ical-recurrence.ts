// The repeat rules of CalDAV events (RFC 5545 §3.3.10, §3.8.5.3) expanded
// into single occurrences for the calendar sync (#460): FREQ DAILY, WEEKLY,
// MONTHLY and YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with ordinals such
// as 2MO or -1FR in monthly and yearly rules), BYMONTHDAY, BYMONTH, BYSETPOS
// and WKST. Occurrences keep the wall-clock time of DTSTART in its time zone
// (across daylight saving changes). Anything else (BYHOUR, BYWEEKNO,
// BYYEARDAY, sub-daily frequencies, EXRULE) is reported, not guessed.
//
// Lib/recurrence.ts is the app's own, smaller repeat model of records; this
// file only reads what calendar servers send.
import { Temporal } from "@js-temporal/polyfill";

export type RuleStart = { allDay: true; date: Temporal.PlainDate } | { allDay: false; dateTime: Temporal.PlainDateTime; zone: string };
// An occurrence start: a date (all-day) or an instant.
export type Occurrence = { allDay: true; date: Temporal.PlainDate } | { allDay: false; instant: Temporal.Instant };
export type Expansion = { starts: Occurrence[]; complete: boolean; unsupported: string | null };

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const KNOWN = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"]);
// Periods looked at at most (a daily rule over 270 years), so a rule that
// never matches (BYMONTHDAY=31;BYMONTH=2) cannot spin.
const MAX_PERIODS = 100_000;

type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: string | null;
  byDay: { n: number; day: number }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
};
const list = (value: string | undefined) => (value ? value.split(",").map((v) => v.trim()).filter(Boolean) : []);
const int = (v: string, min: number, max: number) => {
  if (!/^[+-]?\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max && n !== 0 ? n : null;
};

export function parseRule(text: string): Rule | string {
  const parts = new Map<string, string>();
  for (const part of text.trim().split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = (eq > 0 ? part.slice(0, eq) : part).toUpperCase();
    if (parts.has(key)) return `${key} twice`;
    parts.set(key, eq > 0 ? part.slice(eq + 1).toUpperCase() : "");
  }
  for (const key of parts.keys()) if (!KNOWN.has(key)) return key;
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return `FREQ=${freq || ""}`;
  const interval = parts.has("INTERVAL") ? int(parts.get("INTERVAL")!, 1, 10_000) : 1;
  if (!interval) return "INTERVAL";
  const count = parts.has("COUNT") ? int(parts.get("COUNT")!, 1, 1_000_000) : null;
  if (parts.has("COUNT") && !count) return "COUNT";
  const byDay: Rule["byDay"] = [];
  for (const token of list(parts.get("BYDAY"))) {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token);
    if (!m) return `BYDAY=${token}`;
    const n = m[1] ? int(m[1], -53, 53) : 0;
    if (n === null) return `BYDAY=${token}`;
    // Ordinals only where a month or year gives them a meaning.
    if (n && freq !== "MONTHLY" && freq !== "YEARLY") return `BYDAY=${token}`;
    byDay.push({ n, day: DAYS.indexOf(m[2]) + 1 });
  }
  const byMonthDay: number[] = [];
  for (const v of list(parts.get("BYMONTHDAY"))) {
    const n = int(v, -31, 31);
    if (n === null) return `BYMONTHDAY=${v}`;
    byMonthDay.push(n);
  }
  const byMonth: number[] = [];
  for (const v of list(parts.get("BYMONTH"))) {
    const n = int(v, 1, 12);
    if (n === null) return `BYMONTH=${v}`;
    byMonth.push(n);
  }
  const bySetPos: number[] = [];
  for (const v of list(parts.get("BYSETPOS"))) {
    const n = int(v, -366, 366);
    if (n === null) return `BYSETPOS=${v}`;
    bySetPos.push(n);
  }
  const wkst = parts.has("WKST") ? DAYS.indexOf(parts.get("WKST")!) + 1 : 1;
  if (wkst < 1) return "WKST";
  const until = parts.get("UNTIL") || null;
  if (until && !/^\d{8}(T\d{6}Z?)?$/.test(until)) return "UNTIL";
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, bySetPos, wkst };
}

// The n-th (or, negative, n-th last) `day` of the dates in [first, last].
function nthWeekday(first: Temporal.PlainDate, last: Temporal.PlainDate, day: number, n: number): Temporal.PlainDate[] {
  const all: Temporal.PlainDate[] = [];
  let d = first.add({ days: (day - first.dayOfWeek + 7) % 7 });
  while (Temporal.PlainDate.compare(d, last) <= 0) {
    all.push(d);
    d = d.add({ days: 7 });
  }
  if (!n) return all;
  const pick = n > 0 ? all[n - 1] : all[all.length + n];
  return pick ? [pick] : [];
}
function monthDays(month: Temporal.PlainYearMonth, rule: Rule, anchor: Temporal.PlainDate) {
  const first = month.toPlainDate({ day: 1 }),
    last = month.toPlainDate({ day: month.daysInMonth });
  let byDays: Temporal.PlainDate[] | null = null,
    byDates: Temporal.PlainDate[] | null = null;
  if (rule.byDay.length) byDays = rule.byDay.flatMap((b) => nthWeekday(first, last, b.day, b.n));
  if (rule.byMonthDay.length)
    byDates = rule.byMonthDay
      .map((n) => (n > 0 ? n : month.daysInMonth + n + 1))
      .filter((n) => n >= 1 && n <= month.daysInMonth)
      .map((day) => month.toPlainDate({ day }));
  if (byDays && byDates) return byDays.filter((d) => byDates!.some((x) => x.equals(d)));
  if (byDays || byDates) return (byDays || byDates)!;
  // Neither: the day of DTSTART, when the month has it (the 31st skips short months).
  return anchor.day <= month.daysInMonth ? [month.toPlainDate({ day: anchor.day })] : [];
}
// The candidate dates of the period that starts at `period`.
function candidates(rule: Rule, period: Temporal.PlainDate, anchor: Temporal.PlainDate): Temporal.PlainDate[] {
  const inMonths = (d: Temporal.PlainDate) => !rule.byMonth.length || rule.byMonth.includes(d.month);
  let out: Temporal.PlainDate[];
  if (rule.freq === "DAILY") {
    const d = period;
    const monthDayOk =
      !rule.byMonthDay.length || rule.byMonthDay.some((n) => (n > 0 ? d.day === n : d.day === d.daysInMonth + n + 1));
    const dayOk = !rule.byDay.length || rule.byDay.some((b) => b.day === d.dayOfWeek);
    out = monthDayOk && dayOk && inMonths(d) ? [d] : [];
  } else if (rule.freq === "WEEKLY") {
    const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [anchor.dayOfWeek];
    out = days.map((day) => period.add({ days: (day - rule.wkst + 7) % 7 })).filter(inMonths);
  } else if (rule.freq === "MONTHLY") {
    out = inMonths(period) ? monthDays(period.toPlainYearMonth(), rule, anchor) : [];
  } else {
    const year = period.year;
    if (rule.byDay.length && !rule.byMonth.length && !rule.byMonthDay.length) {
      // Ordinals count within the year ("20MO": the 20th Monday).
      const first = Temporal.PlainDate.from({ year, month: 1, day: 1 }),
        last = Temporal.PlainDate.from({ year, month: 12, day: 31 });
      out = rule.byDay.flatMap((b) => nthWeekday(first, last, b.day, b.n));
    } else {
      const months = rule.byMonth.length ? rule.byMonth : [anchor.month];
      out = months.flatMap((month) => monthDays(Temporal.PlainYearMonth.from({ year, month }), rule, anchor));
    }
  }
  out = [...new Map(out.map((d) => [d.toString(), d])).values()].sort(Temporal.PlainDate.compare);
  if (rule.bySetPos.length) {
    const picked = rule.bySetPos.map((p) => (p > 0 ? out[p - 1] : out[out.length + p])).filter(Boolean) as Temporal.PlainDate[];
    out = [...new Map(picked.map((d) => [d.toString(), d])).values()].sort(Temporal.PlainDate.compare);
  }
  return out;
}
function periodStart(rule: Rule, anchor: Temporal.PlainDate, k: number) {
  const step = k * rule.interval;
  if (rule.freq === "DAILY") return anchor.add({ days: step });
  if (rule.freq === "WEEKLY") return anchor.subtract({ days: (anchor.dayOfWeek - rule.wkst + 7) % 7 }).add({ weeks: step });
  if (rule.freq === "MONTHLY") return anchor.with({ day: 1 }).add({ months: step });
  return anchor.with({ month: 1, day: 1 }).add({ years: step });
}

const toInstant = (start: Extract<RuleStart, { allDay: false }>, date: Temporal.PlainDate) =>
  date.toPlainDateTime(start.dateTime.toPlainTime()).toZonedDateTime(start.zone).toInstant();

// The starts of a rule from DTSTART (always the first, counted by COUNT) up
// to `to`, keeping only those from `from` on and at most `max` of them.
export function expandRule(text: string, start: RuleStart, from: Occurrence, to: Occurrence, max: number): Expansion {
  const rule = parseRule(text);
  if (typeof rule === "string") return { starts: [], complete: false, unsupported: rule };
  const anchor = start.allDay ? start.date : start.dateTime.toPlainDate();
  const instantOf = (o: Occurrence) => (o.allDay ? o.date.toPlainDateTime().toZonedDateTime(start.allDay ? "UTC" : start.zone).toInstant() : o.instant);
  const occurrence = (date: Temporal.PlainDate): Occurrence => (start.allDay ? { allDay: true, date } : { allDay: false, instant: toInstant(start, date) });
  const after = (a: Occurrence, b: Occurrence) => Temporal.Instant.compare(instantOf(a), instantOf(b)) > 0;
  // UNTIL: inclusive; a date-time without Z is local to DTSTART.
  let until: Occurrence | null = null;
  if (rule.until) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(rule.until)!;
    const date = Temporal.PlainDate.from(`${m[1]}-${m[2]}-${m[3]}`);
    if (!m[4]) until = start.allDay ? { allDay: true, date } : { allDay: false, instant: date.toPlainDateTime({ hour: 23, minute: 59, second: 59 }).toZonedDateTime(start.zone).toInstant() };
    else {
      const local = Temporal.PlainDateTime.from(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
      const instant = m[7] ? Temporal.Instant.from(`${local}Z`) : local.toZonedDateTime(start.allDay ? "UTC" : start.zone).toInstant();
      until = start.allDay ? { allDay: true, date: instant.toZonedDateTimeISO("UTC").toPlainDate() } : { allDay: false, instant };
    }
  }
  const starts: Occurrence[] = [];
  const first = occurrence(anchor);
  let count = 1;
  if (!after(from, first) && !after(first, to)) starts.push(first);
  for (let k = 0; k < MAX_PERIODS; k++) {
    const period = periodStart(rule, anchor, k);
    // Every candidate of a period is on or after its start.
    if (after(occurrence(period), to)) return { starts, complete: true, unsupported: null };
    for (const date of candidates(rule, period, anchor)) {
      if (Temporal.PlainDate.compare(date, anchor) <= 0) continue;
      const o = occurrence(date);
      if (until && after(o, until)) return { starts, complete: true, unsupported: null };
      if (rule.count !== null && count >= rule.count) return { starts, complete: true, unsupported: null };
      if (after(o, to)) return { starts, complete: true, unsupported: null };
      count++;
      if (after(from, o)) continue;
      if (starts.length >= max) return { starts, complete: false, unsupported: null };
      starts.push(o);
    }
  }
  return { starts, complete: false, unsupported: null };
}
