// "My activity" on the start page (#114): how many pages the signed-in
// person created and edited this week, month or year, against the same
// stretch of the period before, and per day (per month for a year).
//
// Only what Flowplan stores anyway, nothing is recorded for this:
//   created  pages.created_by and pages.created_at
//   edited   the page's version history (automatic versions, snapshots.created_by),
//            the activity log (audit, the content commands of lib/api.ts
//            editActions: titles, properties, records …) and the last edit
//            per person and page (page_edits)
// An edited page counts once per day however often it was saved. Only
// pages of this workspace the person can still open: not in the trash, not
// behind a journal PIN that was not entered, not in an end-to-end encrypted
// space (lockedPageIds), no synced blocks. Days are the person's days (the
// browser's time zone, as for every start page widget). Nobody else's
// numbers are ever read or shown.
//
// Automatic versions older than a week are thinned to one per page and day
// (lib/version-history.ts), so far back an edit can be missing when someone
// else saved the same page later that day.
import { Temporal } from "@js-temporal/polyfill";
import { all, one, sql } from "./db";
import { editActions } from "./api";
import { lockedPageIds } from "./journal-extras";
import { pageRole } from "./permissions";
import type { ActivityPeriod } from "./home-layout-schema";
import type { Identity, Page } from "./types";

export type PeriodRange = {
  // The period (first and last day) and today inside it.
  from: string;
  to: string;
  today: string;
  // The same stretch of the period before: its first day up to the day
  // that matches today (Monday to Wednesday against Monday to Wednesday).
  previousFrom: string;
  previousTo: string;
  unit: "day" | "month";
  // Days (YYYY-MM-DD) or months (YYYY-MM) of the chart.
  buckets: string[];
};

export function periodRange(today: string, period: ActivityPeriod): PeriodRange {
  const day = Temporal.PlainDate.from(today);
  let from: Temporal.PlainDate, to: Temporal.PlainDate, previousFrom: Temporal.PlainDate, previousTo: Temporal.PlainDate;
  if (period === "week") {
    from = day.subtract({ days: day.dayOfWeek - 1 });
    to = from.add({ days: 6 });
    previousFrom = from.subtract({ weeks: 1 });
    previousTo = day.subtract({ weeks: 1 });
  } else if (period === "month") {
    from = day.with({ day: 1 });
    to = from.add({ months: 1 }).subtract({ days: 1 });
    previousFrom = from.subtract({ months: 1 });
    // 31 March against 28 (29) February: the shorter month ends earlier.
    previousTo = day.subtract({ months: 1 });
  } else {
    from = day.with({ month: 1, day: 1 });
    to = day.with({ month: 12, day: 31 });
    previousFrom = from.subtract({ years: 1 });
    previousTo = day.subtract({ years: 1 });
  }
  const buckets: string[] = [];
  if (period === "year") for (let m = 1; m <= 12; m++) buckets.push(`${day.year}-${String(m).padStart(2, "0")}`);
  else for (let d = from; Temporal.PlainDate.compare(d, to) <= 0; d = d.add({ days: 1 })) buckets.push(d.toString());
  return {
    from: from.toString(),
    to: to.toString(),
    today: day.toString(),
    previousFrom: previousFrom.toString(),
    previousTo: previousTo.toString(),
    unit: period === "year" ? "month" : "day",
    buckets,
  };
}

// Stretches of [from, until) with one UTC offset each (summer time
// changes split a year in three), so SQLite can name the local day itself:
// date(utc, '+3600 seconds').
export function offsetSpans(from: string, until: string, zone: string) {
  const stop = Temporal.PlainDate.from(until).toZonedDateTime({ timeZone: zone }).epochMilliseconds;
  let start = Temporal.PlainDate.from(from).toZonedDateTime({ timeZone: zone });
  const spans: { start: number; end: number; offset: string }[] = [];
  while (start.epochMilliseconds < stop && spans.length < 50) {
    const next = start.getTimeZoneTransition("next");
    const end = next && next.epochMilliseconds < stop ? next.epochMilliseconds : stop;
    const seconds = Math.round(start.offsetNanoseconds / 1e9);
    spans.push({ start: start.epochMilliseconds, end, offset: `${seconds < 0 ? "-" : "+"}${Math.abs(seconds)} seconds` });
    start = Temporal.Instant.fromEpochMilliseconds(end).toZonedDateTimeISO(zone);
  }
  return spans;
}
// The stored form of CURRENT_TIMESTAMP (UTC).
const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// The commands of the activity log that change a page; the content
// itself (document.sync and its kin) is not logged and comes from the
// version history and page_edits.
const loggedEdits = () => [...editActions].filter((a) => !a.endsWith(".sync"));

type PageDay = { page_id: string; day: string };

// Pages created and page-days edited by the person in [from, until).
export function activityDays(user: Identity, workspaceId: string, from: string, until: string, zone: string) {
  const created: PageDay[] = [];
  const edited: PageDay[] = [];
  const actions = loggedEdits();
  for (const span of offsetSpans(from, until, zone)) {
    const start = sqlTime(span.start),
      end = sqlTime(span.end);
    created.push(
      ...all<PageDay>(
        `SELECT id page_id,${sql.dayOf("created_at")} AS day FROM pages
         WHERE created_by=? AND created_at>=? AND created_at<? AND workspace_id=? AND deleted_at IS NULL AND COALESCE(synced,0)=0`,
        span.offset,
        user.id,
        start,
        end,
        workspaceId,
      ),
    );
    // UNION: one row per page and day, whichever source saw it.
    edited.push(
      ...all<PageDay>(
        `SELECT e.page_id,e.day FROM (
           SELECT page_id,${sql.dayOf("created_at")} AS day FROM snapshots WHERE created_by=? AND created_at>=? AND created_at<? AND kind='auto'
           UNION SELECT resource_id,${sql.dayOf("created_at")} FROM audit WHERE actor_id=? AND created_at>=? AND created_at<? AND action IN (${actions.map(() => "?").join(",")})
           UNION SELECT page_id,${sql.dayOfMs("at")} FROM page_edits WHERE user_id=? AND at>=? AND at<?
         ) e JOIN pages p ON p.id=e.page_id
         WHERE p.workspace_id=? AND p.deleted_at IS NULL AND COALESCE(p.synced,0)=0`,
        span.offset,
        user.id,
        start,
        end,
        span.offset,
        user.id,
        start,
        end,
        ...actions,
        span.offset,
        user.id,
        span.start,
        span.end,
        workspaceId,
      ),
    );
  }
  // Only pages the person may still open.
  const hidden = lockedPageIds(user, workspaceId);
  const readable = new Map<string, boolean>();
  const canRead = (pageId: string) => {
    if (!readable.has(pageId)) {
      const page = hidden.has(pageId) ? undefined : one<Page>("SELECT * FROM pages WHERE id=?", pageId);
      readable.set(pageId, !!page && !!pageRole(user, page));
    }
    return readable.get(pageId)!;
  };
  const unique = (rows: PageDay[]) => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const key = `${r.page_id}|${r.day}`;
      if (seen.has(key) || !canRead(r.page_id)) return false;
      seen.add(key);
      return true;
    });
  };
  return { created: unique(created), edited: unique(edited) };
}

export type ActivityFigure = { total: number; previous: number; series: (number | null)[] };
export type MyActivity = PeriodRange & {
  period: ActivityPeriod;
  created: ActivityFigure;
  edited: ActivityFigure;
};

export function myActivity(user: Identity, workspaceId: string, today: string, zone: string, period: ActivityPeriod): MyActivity {
  const range = periodRange(today, period);
  const until = Temporal.PlainDate.from(range.today).add({ days: 1 }).toString();
  const { created, edited } = activityDays(user, workspaceId, range.previousFrom, until, zone);
  const bucketOf = (day: string) => (range.unit === "month" ? day.slice(0, 7) : day);
  const now = bucketOf(range.today);
  const figure = (rows: PageDay[]): ActivityFigure => {
    const counts = new Map<string, number>();
    let total = 0,
      previous = 0;
    for (const { day } of rows) {
      if (day >= range.from && day <= range.today) {
        total++;
        counts.set(bucketOf(day), (counts.get(bucketOf(day)) || 0) + 1);
      } else if (day >= range.previousFrom && day <= range.previousTo) previous++;
    }
    // Days still to come have no value yet.
    return { total, previous, series: range.buckets.map((b) => (b > now ? null : counts.get(b) || 0)) };
  };
  return { period, ...range, created: figure(created), edited: figure(edited) };
}
