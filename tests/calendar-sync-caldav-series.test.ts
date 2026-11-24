// Repeating CalDAV events in the calendar sync (#460): the RRULE expander
// (lib/ical-recurrence.ts), occurrences with RDATE, EXDATE and RECURRENCE-ID
// overrides (lib/caldav-client.ts), and against the local mock: series as
// single records, an occurrence changed or deleted from Flowplan (override,
// EXDATE), and FLOWPLAN_CALDAV_ALLOWED_HOSTS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { Identity } from "../lib/types";
import { CalDavMock } from "./caldav-server-mock";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-caldav-series-"));
process.env.APP_URL = "https://flowplan.test";
process.env.FLOWPLAN_CALDAV_ALLOW_PRIVATE = "true";
delete process.env.FLOWPLAN_CALDAV_ALLOWED_HOSTS;
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const sync = await import("../lib/calendar-sync");
const client = await import("../lib/caldav-client");
const { expandRule } = await import("../lib/ical-recurrence");

sync.calendarSyncTesting({ sleep: async () => {} });
// What the server logs (each test mocks console.error and fills this).
const logged: string[] = [];
const capture = (t: import("node:test").TestContext) => t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));

/* ---------- The expander ---------- */

const D = (s: string) => Temporal.PlainDate.from(s);
const dates = (rule: string, start: string, from = "2000-01-01", to = "2100-01-01", max = 50) =>
  expandRule(rule, { allDay: true, date: D(start) }, { allDay: true, date: D(from) }, { allDay: true, date: D(to) }, max).starts.map((o) => (o.allDay ? o.date.toString() : ""));

test("RRULE: frequencies, BYDAY with ordinals, BYMONTHDAY, BYMONTH, BYSETPOS, COUNT, UNTIL", () => {
  assert.deepEqual(dates("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", "2026-01-05"), ["2026-01-05", "2026-01-07", "2026-01-12", "2026-01-14", "2026-01-19"]);
  assert.deepEqual(dates("FREQ=DAILY;INTERVAL=3;UNTIL=20260110", "2026-01-01"), ["2026-01-01", "2026-01-04", "2026-01-07", "2026-01-10"]);
  // Every other week from a Wednesday, Mondays and Fridays (WKST=MO).
  assert.deepEqual(dates("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4", "2026-01-07"), ["2026-01-07", "2026-01-09", "2026-01-19", "2026-01-23"]);
  assert.deepEqual(dates("FREQ=MONTHLY;BYDAY=2MO;COUNT=3", "2026-01-12"), ["2026-01-12", "2026-02-09", "2026-03-09"]);
  assert.deepEqual(dates("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "2026-01-30"), ["2026-01-30", "2026-02-27", "2026-03-27"]);
  assert.deepEqual(dates("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "2026-01-31"), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  // The 31st: months without it are skipped, COUNT counts the others.
  assert.deepEqual(dates("FREQ=MONTHLY;COUNT=4", "2026-01-31"), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
  // The last weekday of the month.
  assert.deepEqual(dates("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "2026-01-30"), ["2026-01-30", "2026-02-27", "2026-03-31"]);
  assert.deepEqual(dates("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;COUNT=3", "2026-03-29"), ["2026-03-29", "2027-03-28", "2028-03-26"]);
  assert.deepEqual(dates("FREQ=YEARLY;COUNT=3", "2024-02-29"), ["2024-02-29", "2028-02-29", "2032-02-29"]);
  assert.deepEqual(dates("FREQ=YEARLY;BYDAY=20MO;COUNT=2", "2026-05-18"), ["2026-05-18", "2027-05-17"]);
  // Only what lies from `from` to `to`, at most `max` – COUNT still counts from DTSTART.
  assert.deepEqual(dates("FREQ=DAILY;COUNT=10", "2026-01-01", "2026-01-08", "2026-01-30"), ["2026-01-08", "2026-01-09", "2026-01-10"]);
  assert.equal(dates("FREQ=DAILY", "2026-01-01", "2026-01-01", "2030-01-01", 500).length, 500);
  // Unsupported parts are named, not guessed; a rule that never matches ends.
  for (const rule of ["FREQ=DAILY;BYHOUR=9", "FREQ=HOURLY", "FREQ=WEEKLY;BYDAY=2MO", "FREQ=YEARLY;BYWEEKNO=20"])
    assert.ok(expandRule(rule, { allDay: true, date: D("2026-01-01") }, { allDay: true, date: D("2026-01-01") }, { allDay: true, date: D("2027-01-01") }, 10).unsupported, rule);
  assert.deepEqual(dates("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "2026-01-30", "2026-01-01", "2030-01-01"), ["2026-01-30"]);
  // The wall-clock time stays across daylight saving time.
  const berlin = expandRule(
    "FREQ=DAILY;COUNT=3",
    { allDay: false, dateTime: Temporal.PlainDateTime.from("2026-03-28T09:00"), zone: "Europe/Berlin" },
    { allDay: false, instant: Temporal.Instant.from("2026-01-01T00:00Z") },
    { allDay: false, instant: Temporal.Instant.from("2027-01-01T00:00Z") },
    10,
  );
  assert.deepEqual(berlin.starts.map((o) => (o.allDay ? "" : o.instant.toString())), ["2026-03-28T08:00:00Z", "2026-03-29T07:00:00Z", "2026-03-30T07:00:00Z"]);
});

const ics = (lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const window = { from: Temporal.Instant.from("2026-01-01T00:00Z"), to: Temporal.Instant.from("2026-12-31T00:00Z") };
const team = ics([
  "BEGIN:VEVENT",
  "UID:team",
  "DTSTART;TZID=Europe/Berlin:20260105T100000",
  "DTEND;TZID=Europe/Berlin:20260105T110000",
  "RRULE:FREQ=WEEKLY;COUNT=5",
  "EXDATE;TZID=Europe/Berlin:20260112T100000",
  "RDATE;TZID=Europe/Berlin:20260301T100000",
  "SUMMARY:Team",
  "LOCATION:Raum 4",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Bald",
  "TRIGGER:-PT10M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:team",
  "RECURRENCE-ID;TZID=Europe/Berlin:20260119T100000",
  "DTSTART;TZID=Europe/Berlin:20260119T140000",
  "DTEND;TZID=Europe/Berlin:20260119T150000",
  "SUMMARY:Team (verschoben)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:team",
  "RECURRENCE-ID;TZID=Europe/Berlin:20260126T100000",
  "DTSTART;TZID=Europe/Berlin:20260126T100000",
  "STATUS:CANCELLED",
  "END:VEVENT",
]);

test("occurrences: EXDATE, RDATE, moved and cancelled overrides; writing an occurrence back", () => {
  const parsed = client.icsOccurrences(team, "UTC", window)!;
  assert.equal(parsed.series, true);
  assert.deepEqual(
    parsed.occurrences.map((o) => [o.rid, o.title, o.start, o.end, o.cancelled]),
    [
      ["20260105T090000Z", "Team", "2026-01-05T09:00Z", "2026-01-05T10:00Z", false],
      ["20260119T090000Z", "Team (verschoben)", "2026-01-19T13:00Z", "2026-01-19T14:00Z", false],
      // Cancelled: the title from the series, an hour as it has no end.
      ["20260126T090000Z", "Team", "2026-01-26T09:00Z", "2026-01-26T10:00Z", true],
      ["20260202T090000Z", "Team", "2026-02-02T09:00Z", "2026-02-02T10:00Z", false],
      ["20260301T090000Z", "Team", "2026-03-01T09:00Z", "2026-03-01T10:00Z", false],
    ],
  );
  // A changed occurrence: a new override in the same object, the series as it was.
  const changed = client.patchIcsEvent(team, { title: "Team extra", description: "Agenda", allDay: false, start: "2026-02-02T12:00Z", end: "2026-02-02T13:30Z" }, "20260202T090000Z");
  assert.match(changed, /BEGIN:VEVENT\r\nRECURRENCE-ID;TZID=Europe\/Berlin:20260202T100000\r\nUID:team\r\n/);
  assert.match(changed, /RRULE:FREQ=WEEKLY;COUNT=5/);
  assert.equal(changed.match(/^LOCATION:Raum 4/gm)!.length, 2);
  assert.equal(changed.match(/^BEGIN:VALARM/gm)!.length, 2);
  const after = client.icsOccurrences(changed, "UTC", window)!.occurrences.find((o) => o.rid === "20260202T090000Z")!;
  assert.deepEqual([after.title, after.start, after.end, after.description], ["Team extra", "2026-02-02T12:00Z", "2026-02-02T13:30Z", "Agenda"]);
  assert.equal(client.icsOccurrences(changed, "UTC", window)!.occurrences.find((o) => o.rid === "20260105T090000Z")!.title, "Team");
  // An existing override is changed in place.
  const moved = client.patchIcsEvent(team, { title: "Team spät", description: "", allDay: false, start: "2026-01-19T16:00Z", end: "2026-01-19T17:00Z" }, "20260119T090000Z");
  assert.equal(moved.match(/^RECURRENCE-ID/gm)!.length, 2);
  assert.match(moved, /SUMMARY:Team spät/);
  // A removed occurrence: an EXDATE like DTSTART, its override gone.
  const removed = client.excludeIcsOccurrence(team, "20260119T090000Z");
  assert.match(removed, /EXDATE;TZID=Europe\/Berlin:20260119T100000\r\n/);
  assert.doesNotMatch(removed, /Team \(verschoben\)/);
  assert.deepEqual(client.icsOccurrences(removed, "UTC", window)!.occurrences.map((o) => o.rid), ["20260105T090000Z", "20260126T090000Z", "20260202T090000Z", "20260301T090000Z"]);
  // All-day and UTC series write their dates the same way.
  const daily = ics(["BEGIN:VEVENT", "UID:d", "DTSTART;VALUE=DATE:20260105", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Urlaub", "END:VEVENT"]);
  assert.match(client.excludeIcsOccurrence(daily, "20260106"), /EXDATE;VALUE=DATE:20260106/);
  assert.match(client.patchIcsEvent(daily, { title: "Frei", description: "", allDay: true, start: "2026-01-07", end: "2026-01-07" }, "20260107"), /RECURRENCE-ID;VALUE=DATE:20260107/);
  const utc = ics(["BEGIN:VEVENT", "UID:u", "DTSTART:20260105T080000Z", "RRULE:FREQ=DAILY;COUNT=3", "END:VEVENT"]);
  assert.match(client.excludeIcsOccurrence(utc, "20260106T080000Z"), /EXDATE:20260106T080000Z/);
  // An unsupported rule: no occurrences, the reason named.
  assert.equal(client.icsOccurrences(ics(["BEGIN:VEVENT", "DTSTART:20260105T080000Z", "RRULE:FREQ=DAILY;BYHOUR=8,12", "END:VEVENT"]), "UTC", window)!.unsupported, "BYHOUR");
});

/* ---------- Against the mock ---------- */

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Serien"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const username = `bo${randomBytes(3).toString("hex")}`,
  password = randomBytes(18).toString("base64url");
const mock = new CalDavMock(username, password);
await mock.start();
after(async () => await mock.stop());

// Mondays from last week on, 10:00 in Berlin.
const today = Temporal.Now.plainDateISO("Europe/Berlin");
const firstMonday = today.subtract({ days: today.dayOfWeek - 1 + 7 });
const compact = (d: Temporal.PlainDate) => d.toString().replace(/-/g, "");
const ridAt = (d: Temporal.PlainDate) => d.toPlainDateTime({ hour: 10 }).toZonedDateTime("Europe/Berlin").toInstant().toString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const mondays = Array.from({ length: 6 }, (_, i) => firstMonday.add({ weeks: i }));

test("a series in the calendar: occurrences as records, changed or deleted one by one in both directions", async (t) => {
  capture(t);
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Jour fixe" })).id as string;
  await act({
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "start", name: "Start", type: "date" },
      { id: "end", name: "End", type: "date" },
    ],
    views: [{ id: "cal", name: "Kalender", type: "calendar", dateField: "start", endDateField: "end", calendar: { mode: "month", timeZone: "Europe/Berlin" }, filters: [], sorts: [] }],
  });
  const connected = await sync.connectCalDav(owner, { url: mock.origin, username, password });
  const series = (lines: string[] = []) =>
    ics([
      "BEGIN:VEVENT",
      "UID:jourfixe",
      `DTSTAMP:${compact(today)}T000000Z`,
      `DTSTART;TZID=Europe/Berlin:${compact(mondays[0])}T100000`,
      `DTEND;TZID=Europe/Berlin:${compact(mondays[0])}T110000`,
      "RRULE:FREQ=WEEKLY;COUNT=6",
      ...lines,
      "SUMMARY:Jour fixe",
      "LOCATION:Raum 4",
      "END:VEVENT",
    ]);
  mock.putEvent("work", "jourfixe.ics", series());
  // A rule this engine does not expand: left alone, said once.
  mock.putEvent("work", "odd.ics", ics(["BEGIN:VEVENT", "UID:odd", `DTSTART:${compact(today)}T080000Z`, "RRULE:FREQ=DAILY;BYHOUR=8,12", "SUMMARY:Odd", "END:VEVENT"]));
  const mapping = (await act({ action: "calendarSync.map", connectionId: connected.id, pageId, viewId: "cal", calendarId: mock.calendarUrl("work") })).id;
  let result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.created, 6);
  const path = `${mock.home}work/jourfixe.ics`;
  const rowOf = async (d: Temporal.PlainDate) => (await one<{ row_id: string }>("SELECT row_id FROM calendar_sync_items WHERE event_id=?", `${path}#${ridAt(d)}`))?.row_id;
  const rows = await Promise.all(mondays.map(rowOf));
  assert.ok(rows.every(Boolean));
  assert.equal((await cells(rows[2]!)).start, `${ridAt(mondays[2]).replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d).*$/, "$1-$2-$3T$4:$5")}Z`);
  assert.equal((await cells(rows[2]!)).title, "Jour fixe");
  assert.equal(await one("SELECT 1 FROM calendar_sync_items WHERE event_id LIKE '%odd.ics%'"), undefined);
  assert.equal(logged.filter((l) => /series not expanded \(BYHOUR\)/.test(l)).length, 1);

  // In the calendar: one occurrence removed (EXDATE), one moved (override).
  const moved = mondays[3];
  mock.putEvent(
    "work",
    "jourfixe.ics",
    series([`EXDATE;TZID=Europe/Berlin:${compact(mondays[2])}T100000`]).replace(
      "END:VCALENDAR",
      [
        "BEGIN:VEVENT",
        "UID:jourfixe",
        `RECURRENCE-ID;TZID=Europe/Berlin:${compact(moved)}T100000`,
        `DTSTART;TZID=Europe/Berlin:${compact(moved)}T150000`,
        `DTEND;TZID=Europe/Berlin:${compact(moved)}T160000`,
        `LAST-MODIFIED:${Temporal.Now.instant().toString().replace(/[-:]/g, "").slice(0, 15)}Z`,
        "SUMMARY:Jour fixe (später)",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    ),
  );
  // The unsupported series again: not said a second time.
  mock.putEvent("work", "odd.ics", mock.event("work", "odd.ics")!.ics.replace("SUMMARY:Odd", "SUMMARY:Odder"));
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.deleted, result.updated], [1, 1]);
  assert.ok(await one("SELECT 1 FROM row_trash WHERE id=?", rows[2]!));
  assert.equal((await cells(rows[3]!)).title, "Jour fixe (später)");
  assert.equal(logged.filter((l) => /series not expanded/.test(l)).length, 1);

  // Two occurrences changed here in one run: two overrides, each PUT with If-Match.
  await act({ action: "row.update", pageId, rowId: rows[4]!, version: await version(rows[4]!), cells: { title: "Jour fixe mit Gast" } });
  await act({ action: "row.update", pageId, rowId: rows[3]!, version: await version(rows[3]!), cells: { title: "Jour fixe kurz" } });
  const before = mock.event("work", "jourfixe.ics")!.etag;
  mock.requests.length = 0;
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.pushed, result.conflicts], [2, 0]);
  const puts = mock.requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].ifMatch, before);
  const stored = mock.event("work", "jourfixe.ics")!.ics;
  assert.match(stored, /RRULE:FREQ=WEEKLY;COUNT=6/);
  assert.match(stored, /SUMMARY:Jour fixe\r\n/);
  assert.match(stored, new RegExp(`RECURRENCE-ID;TZID=Europe/Berlin:${compact(mondays[4])}T100000`));
  assert.match(stored, /SUMMARY:Jour fixe mit Gast/);
  assert.match(stored, /SUMMARY:Jour fixe kurz/);
  assert.equal(stored.match(/^RECURRENCE-ID/gm)!.length, 2);

  // Deleted here: an EXDATE, the rest of the series stays.
  await act({ action: "row.delete", pageId, rowId: rows[5]! });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.removed, 1);
  assert.match(mock.event("work", "jourfixe.ics")!.ics, new RegExp(`EXDATE;TZID=Europe/Berlin:${compact(mondays[5])}T100000`));
  assert.equal(mock.requests.filter((r) => r.method === "DELETE").length, 0);

  // Our own writes coming back change nothing.
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.updated, result.deleted, result.pushed, result.conflicts], [0, 0, 0, 0, 0]);
  assert.equal((await cells(rows[4]!)).title, "Jour fixe mit Gast");
  assert.equal((await all("SELECT row_id FROM calendar_sync_items WHERE mapping_id=?", mapping)).length, 4);

  // The whole series deleted in the calendar: every linked occurrence goes.
  mock.deleteEvent("work", "jourfixe.ics");
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.deleted, 4);
  await act({ action: "calendarSync.unmap", id: mapping });
});

test("FLOWPLAN_CALDAV_ALLOWED_HOSTS limits connecting and every request", async () => {
  const host = new URL(mock.origin).hostname;
  process.env.FLOWPLAN_CALDAV_ALLOWED_HOSTS = "cloud.example.org, *.icloud.com";
  try {
    const before = mock.requests.length;
    await assert.rejects(sync.connectCalDav(owner, { url: mock.origin, username, password }), /nicht freigegeben/);
    assert.equal(mock.requests.length, before);
    // An existing connection stops at the next request, too.
    const cid = (await one<{ id: string }>("SELECT id FROM calendar_connections WHERE provider='caldav'"))!.id;
    await assert.rejects(sync.listExternalCalendars(owner, cid), /nicht freigegeben/);
    assert.equal(mock.requests.length, before);
    process.env.FLOWPLAN_CALDAV_ALLOWED_HOSTS = `cloud.example.org, ${host}`;
    assert.equal((await sync.connectCalDav(owner, { url: mock.origin, username, password })).calendars.length, 1);
  } finally {
    delete process.env.FLOWPLAN_CALDAV_ALLOWED_HOSTS;
  }
});
