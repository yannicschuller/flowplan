// Calendar sync with CalDAV servers (#460, lib/calendar-sync.ts and
// lib/caldav-client.ts) against the local mock in tests/caldav-server-mock.ts:
// connecting with discovery, sync-collection and ctag/etag, If-Match /
// If-None-Match, conflicts, rejected credentials. Real requests through the
// SSRF-safe transport, to 127.0.0.1 only (FLOWPLAN_CALDAV_ALLOW_PRIVATE).
import { nowText } from "../lib/db-driver/dialect";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Identity } from "../lib/types";
import { Temporal } from "@js-temporal/polyfill";
import { CalDavMock } from "./caldav-server-mock";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-calendar-caldav-"));
process.env.APP_URL = "https://flowplan.test";
process.env.FLOWPLAN_CALDAV_ALLOW_PRIVATE = "true";
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { openSecret } = await import("../lib/secret-box");
const sync = await import("../lib/calendar-sync");
const client = await import("../lib/caldav-client");

// No waiting between retries.
sync.calendarSyncTesting({ sleep: async () => {} });

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "CalDAV"),
  boot = await bootstrap(owner, wid);
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
async function calendarDatabase(title: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
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
  return pageId;
}
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const compact = (date: string) => date.replace(/-/g, "");
const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const ics = (lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");

// Throwaway credentials, made up for this run.
const username = `anna${randomBytes(3).toString("hex")}`;
const password = randomBytes(18).toString("base64url");
const mock = new CalDavMock(username, password);
await mock.start();
after(async () => await mock.stop());
// Everything the server logs: the password must never be in it.
const logged: string[] = [];
const original = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};
after(() => {
  console.error = original;
});

test("iCalendar: time zones, durations, all-day ends, series and attendees", () => {
  const berlin = client.parseIcsEvent(
    ics([
      "BEGIN:VTIMEZONE",
      "TZID:W. Europe Standard Time",
      "X-LIC-LOCATION:Europe/Berlin",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART;TZID=W. Europe Standard Time:20261006T100000",
      "DURATION:PT1H30M",
      "SUMMARY:Planung\\, Runde 2",
      "DESCRIPTION:Erste Zeile\\nZweite",
      "ATTENDEE;CN=Bo;CUTYPE=INDIVIDUAL:mailto:Bo@Example.org",
      "ATTENDEE;CUTYPE=ROOM:mailto:room@example.org",
      "BEGIN:VALARM",
      "DESCRIPTION:Alarm",
      "END:VALARM",
      "END:VEVENT",
    ]),
    "UTC",
  )!;
  assert.deepEqual([berlin.start, berlin.end, berlin.allDay, berlin.title, berlin.description], ["2026-10-06T08:00Z", "2026-10-06T09:30Z", false, "Planung, Runde 2", "Erste Zeile\nZweite"]);
  assert.deepEqual(berlin.attendees, [{ email: "bo@example.org", name: "Bo" }]);
  // A floating time is in the view's zone; a quoted TZID with a path.
  assert.equal(client.parseIcsEvent(ics(["BEGIN:VEVENT", "DTSTART:20260106T100000", "END:VEVENT"]), "Europe/Berlin")!.start, "2026-01-06T09:00Z");
  assert.equal(
    client.parseIcsEvent(ics(["BEGIN:VEVENT", 'DTSTART;TZID="/mozilla.org/20050126_1/America/New_York":20260106T100000', "END:VEVENT"]), "UTC")!.start,
    "2026-01-06T15:00Z",
  );
  const allDay = client.parseIcsEvent(ics(["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261013", "END:VEVENT"]), "UTC")!;
  assert.deepEqual([allDay.allDay, allDay.start, allDay.end], [true, "2026-10-10", "2026-10-12"]);
  assert.equal(client.parseIcsEvent(ics(["BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261010", "END:VEVENT"]), "UTC")!.end, "2026-10-10");
  assert.equal(client.parseIcsEvent(ics(["BEGIN:VEVENT", "DTSTART:20261010T080000Z", "RRULE:FREQ=WEEKLY", "END:VEVENT"]), "UTC")!.recurring, true);
  assert.equal(client.parseIcsEvent(ics(["BEGIN:VTODO", "DTSTART:20261010T080000Z", "END:VTODO"]), "UTC"), null);
  assert.equal(client.parseIcsEvent(ics(["BEGIN:VEVENT", "DTSTART:20261010T080000Z", "STATUS:CANCELLED", "END:VEVENT"]), "UTC")!.cancelled, true);

  // A change keeps what Flowplan does not know: alarm, location, repeat rule, occurrences.
  const original = ics([
    "BEGIN:VEVENT",
    "UID:s",
    "DTSTART;TZID=Europe/Berlin:20261006T100000",
    "DTEND;TZID=Europe/Berlin:20261006T110000",
    "RRULE:FREQ=WEEKLY",
    "SUMMARY:Alt",
    "LOCATION:Raum 4",
    "SEQUENCE:3",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Erinnerung",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:s",
    "RECURRENCE-ID;TZID=Europe/Berlin:20261013T100000",
    "DTSTART;TZID=Europe/Berlin:20261013T120000",
    "SUMMARY:Verschoben",
    "END:VEVENT",
  ]);
  const patched = client.patchIcsEvent(original, { title: "Neu; mit Komma, ja", description: "Text", allDay: false, start: "2026-10-06T09:00Z", end: "2026-10-06T10:00Z" });
  assert.match(patched, /SUMMARY:Neu\\; mit Komma\\, ja\r\n/);
  assert.match(patched, /DTSTART:20261006T090000Z\r\n/);
  assert.match(patched, /LOCATION:Raum 4/);
  assert.match(patched, /RRULE:FREQ=WEEKLY/);
  assert.match(patched, /SEQUENCE:4/);
  assert.match(patched, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Erinnerung\r\nEND:VALARM/);
  assert.match(patched, /RECURRENCE-ID;TZID=Europe\/Berlin:20261013T100000\r\nDTSTART;TZID=Europe\/Berlin:20261013T120000\r\nSUMMARY:Verschoben/);
  assert.equal(patched.match(/^SUMMARY:/gm)!.length, 2);
  const fresh = client.newIcsEvent({ title: "Ganztag", description: "x", allDay: true, start: "2026-10-10", end: "2026-10-12" }, { uid: "u1", link: "https://flowplan.test/#page=p", rowId: "r1" });
  assert.match(fresh, /DTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261013/);
  assert.ok(fresh.split("\r\n").every((line) => Buffer.byteLength(line) <= 75));
});

test("WebDAV answers: any prefix or default namespace, 404 responses, hrefs in one spelling", () => {
  const body = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/cal/a%40b.ics</href><propstat><prop><getetag>"1"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><x:calendar-data xmlns:x="urn:ietf:params:xml:ns:caldav"/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response><response><href>/cal/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response><sync-token>t-2</sync-token></multistatus>`;
  const parsed = client.parseMultistatus(body);
  assert.equal(parsed.syncToken, "t-2");
  assert.deepEqual(parsed.entries.map((e) => [e.href, e.status, [...e.props.keys()]]), [["/cal/a%40b.ics", 200, ["getetag"]], ["/cal/gone.ics", 404, []]]);
  assert.equal(client.canonicalUrl("/cal/a@b.ics", "https://dav.example.org/cal/"), client.canonicalUrl("https://dav.example.org/cal/a%40b.ics", "https://dav.example.org/"));
  assert.equal(client.canonicalUrl("https://elsewhere.example/cal/x.ics", "https://dav.example.org/cal/"), null);
  // CDATA and entities.
  const cdata = client.parseMultistatus(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/x.ics</d:href><d:propstat><d:prop><c:calendar-data><![CDATA[BEGIN:VCALENDAR & more]]></c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`);
  assert.equal(cdata.entries[0].props.get("calendar-data")!.text, "BEGIN:VCALENDAR & more");
});

test("connecting: discovery from the server address, only writable event calendars, the password sealed", async () => {
  // Wrong password: nothing stored.
  await assert.rejects(sync.connectCalDav(owner, { url: mock.origin, username, password: "falsch" }), /abgelehnt/);
  assert.equal(await one("SELECT 1 FROM calendar_connections WHERE provider='caldav'"), undefined);
  // Not over the API or for demo accounts.
  await assert.rejects(sync.connectCalDav({ ...owner, apiScope: "write" } as Identity, { url: mock.origin, username, password }), /nur im Browser/);

  const connected = await sync.connectCalDav(owner, { url: mock.origin, username, password });
  assert.equal(connected.account, `${username}@${new URL(mock.origin).host}`);
  // Tasks only, read-only calendars and the inbox are left out.
  assert.deepEqual(connected.calendars.map((c) => [c.id, c.name]), [[mock.calendarUrl("work"), "Arbeit"]]);
  assert.ok(mock.requests.some((r) => r.path === "/.well-known/caldav"));
  const stored = (await one<{ id: string; refresh_token: string; access_token: string | null }>("SELECT id,refresh_token,access_token FROM calendar_connections WHERE provider='caldav'"))!;
  assert.ok(!stored.refresh_token.includes(password));
  assert.equal(stored.access_token, null);
  const secret = JSON.parse(openSecret(stored.refresh_token, `calendar-sync-caldav:${stored.id}`));
  assert.deepEqual([secret.home, secret.username, secret.password], [`${mock.origin}${mock.home}`, username, password]);
  // Again with the same account: the same connection.
  assert.equal((await sync.connectCalDav(owner, { url: `${mock.origin}/dav/`, username, password })).id, stored.id);
  assert.equal((await all("SELECT id FROM calendar_connections WHERE provider='caldav'")).length, 1);
  const listed = await sync.listExternalCalendars(owner, stored.id);
  assert.deepEqual(listed, [{ id: mock.calendarUrl("work"), name: "Arbeit", primary: true, color: "#3366CC" }]);
  const status = await sync.calendarSyncStatus(owner);
  assert.deepEqual(status.providers.find((p) => p.id === "caldav"), { id: "caldav", configured: true });

  // Credentials in the address, other schemes, and http without the instance's permission.
  await assert.rejects(sync.connectCalDav(owner, { url: `http://u:p@127.0.0.1:1/`, username, password }), /Zugangsdaten/);
  await assert.rejects(sync.connectCalDav(owner, { url: "ftp://dav.example.org/", username, password }), /https/);
  delete process.env.FLOWPLAN_CALDAV_ALLOW_PRIVATE;
  try {
    await assert.rejects(sync.connectCalDav(owner, { url: mock.origin, username, password }), /https/);
    // https to an internal address: refused before anything is sent.
    const before = mock.requests.length;
    await assert.rejects(sync.connectCalDav(owner, { url: "https://127.0.0.1:9/", username, password }), /Interne Adressen/);
    assert.equal(mock.requests.length, before);
  } finally {
    process.env.FLOWPLAN_CALDAV_ALLOW_PRIVATE = "true";
  }
  assert.ok(!logged.some((line) => line.includes(password)));
});

const connection = async () => (await one<{ id: string }>("SELECT id FROM calendar_connections WHERE provider='caldav' AND user_id=?", owner.id))!.id;
const fileOf = (eventId: string) => eventId.split("/").pop()!;

test("sync-collection: records go out, events come in, changes and deletions both ways with etags", async () => {
  const pageId = await calendarDatabase("Termine CalDAV");
  const cid = await connection();
  const day = soon(3);
  const planning = (await act({ action: "row.create", pageId, cells: { title: "Planung", start: `${day}T08:00Z`, end: `${day}T09:30Z` } })).id;
  const mapping = (await act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: mock.calendarUrl("work"), calendarName: "Arbeit" })).id;
  // Already in the calendar: all-day, and one in a time zone.
  mock.putEvent("work", "holiday.ics", ics(["BEGIN:VEVENT", "UID:holiday", `DTSTAMP:${stamp()}`, `DTSTART;VALUE=DATE:${compact(soon(10))}`, `DTEND;VALUE=DATE:${compact(soon(13))}`, "SUMMARY:Urlaub", "DESCRIPTION:Strand\\n\\nSonne", "END:VEVENT"]));
  mock.putEvent("work", "call.ics", ics(["BEGIN:VEVENT", "UID:call", `DTSTAMP:${stamp()}`, `DTSTART;TZID=Europe/Berlin:${compact(soon(5))}T140000`, `DTEND;TZID=Europe/Berlin:${compact(soon(5))}T150000`, "SUMMARY:Call", "END:VEVENT"]));
  mock.putEvent("work", "series.ics", ics(["BEGIN:VEVENT", "UID:series", `DTSTART:${compact(soon(2))}T080000Z`, "RRULE:FREQ=DAILY", "SUMMARY:Daily", "END:VEVENT"]));

  let result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.pushed], [2, 1]);
  const holiday = (await one<{ row_id: string }>("SELECT row_id FROM calendar_sync_items WHERE event_id=?", `${mock.home}work/holiday.ics`))!.row_id;
  assert.deepEqual([(await cells(holiday)).title, (await cells(holiday)).start, (await cells(holiday)).end], ["Urlaub", soon(10), soon(12)]);
  assert.match((await one<{ content: string }>("SELECT content FROM rows WHERE id=?", holiday))!.content, /<p>Strand<\/p><p><\/p><p>Sonne<\/p>/);
  const call = (await one<{ row_id: string }>("SELECT row_id FROM calendar_sync_items WHERE event_id=?", `${mock.home}work/call.ics`))!.row_id;
  const berlin = Temporal.PlainDateTime.from(`${soon(5)}T14:00`).toZonedDateTime("Europe/Berlin").toInstant().toString().slice(0, 16);
  assert.equal((await cells(call)).start, `${berlin}Z`);
  // Series are not imported.
  assert.equal(await one("SELECT 1 FROM calendar_sync_items WHERE event_id LIKE '%series.ics'"), undefined);
  // The record went out as a new resource (If-None-Match: *) with its link.
  const item = (await one<{ event_id: string; etag: string }>("SELECT event_id,etag FROM calendar_sync_items WHERE row_id=?", planning))!;
  const put = mock.requests.find((r) => r.method === "PUT" && r.path === item.event_id)!;
  assert.equal(put.ifNoneMatch, "*");
  const pushed = mock.event("work", fileOf(item.event_id))!;
  assert.equal(item.etag, pushed.etag);
  assert.match(pushed.ics, /SUMMARY:Planung/);
  assert.match(pushed.ics, new RegExp(`DTSTART:${compact(day)}T080000Z`));
  assert.match(pushed.ics.replace(/\r\n /g, ""), new RegExp(`DESCRIPTION:— Flowplan: https://flowplan.test/#page=${pageId}&row=${planning}`));
  assert.match(pushed.ics, new RegExp(`X-FLOWPLAN-ROW:${planning}`));
  // The sync token is kept; a second run only asks for changes and is quiet.
  assert.match((await one<{ sync_token: string }>("SELECT sync_token FROM calendar_sync_mappings WHERE id=?", mapping))!.sync_token, /"token":"s:/);
  mock.requests.length = 0;
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.updated, result.pushed, result.conflicts], [0, 0, 0, 0]);
  assert.ok(mock.requests.every((r) => r.method === "REPORT"));

  // Moved in the calendar app (with an alarm): the record follows.
  mock.putEvent(
    "work",
    fileOf(item.event_id),
    pushed.ics.replace("SUMMARY:Planung", "SUMMARY:Planung neu\r\nLOCATION:Raum 4\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Bald\r\nEND:VALARM").replace(`DTSTART:${compact(day)}T080000Z`, `DTSTART:${compact(day)}T120000Z`).replace(/DTEND:\d+T\d+Z/, `DTEND:${compact(day)}T130000Z`),
  );
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.updated, 1);
  assert.deepEqual([(await cells(planning)).title, (await cells(planning)).start, (await cells(planning)).end], ["Planung neu", `${day}T12:00Z`, `${day}T13:00Z`]);

  // Changed here: written with If-Match; alarm and location stay.
  await act({ action: "row.update", pageId, rowId: planning, version: await version(planning), cells: { start: day, end: soon(4) } });
  const seen = mock.event("work", fileOf(item.event_id))!.etag;
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.pushed, 1);
  assert.equal(mock.requests.filter((r) => r.method === "PUT").at(-1)!.ifMatch, seen);
  const allDay = mock.event("work", fileOf(item.event_id))!.ics;
  assert.match(allDay, new RegExp(`DTSTART;VALUE=DATE:${compact(day)}\r\nDTEND;VALUE=DATE:${compact(soon(5))}`));
  assert.match(allDay, /LOCATION:Raum 4/);
  assert.match(allDay, /BEGIN:VALARM/);
  assert.equal((await one<{ etag: string }>("SELECT etag FROM calendar_sync_items WHERE row_id=?", planning))!.etag, mock.event("work", fileOf(item.event_id))!.etag);

  // Both sides changed: the later change wins.
  await act({ action: "row.update", pageId, rowId: planning, version: await version(planning), cells: { title: "Hier geändert" } });
  await run("UPDATE rows SET updated_at=? WHERE id=?", nowText(Date.now() - 3_600_000), planning);
  mock.putEvent("work", fileOf(item.event_id), allDay.replace(/SUMMARY:[^\r]*/, "SUMMARY:Dort geändert").replace(/LAST-MODIFIED:[^\r]*/, `LAST-MODIFIED:${stamp()}`));
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.conflicts, 1);
  assert.equal((await cells(planning)).title, "Dort geändert");

  // Changed in the calendar between Flowplan's read and its write: 412, left for the next run.
  await act({ action: "row.update", pageId, rowId: planning, version: await version(planning), cells: { title: "Lokal" } });
  mock.options.afterGet = (cal, file) => {
    mock.options.afterGet = undefined;
    const current = mock.event(cal, file)!;
    mock.putEvent(cal, file, current.ics.replace(/SUMMARY:[^\r]*/, "SUMMARY:Gleichzeitig").replace(/LAST-MODIFIED:[^\r]*/, `LAST-MODIFIED:${stamp(Date.now() + 60_000)}`));
  };
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.pushed, result.conflicts], [0, 1]);
  assert.equal(mock.requests.filter((r) => r.method === "PUT").length > 0 && mock.requests.at(-1)!.method, "PUT");
  assert.match(mock.event("work", fileOf(item.event_id))!.ics, /SUMMARY:Gleichzeitig/);
  // The next run reads the calendar's change, which is the later one.
  result = await sync.syncCalendarMapping(mapping);
  assert.equal((await cells(planning)).title, "Gleichzeitig");

  // Cancelled in the calendar: the record goes to the trash.
  const holidayEvent = mock.event("work", "holiday.ics")!;
  mock.putEvent("work", "holiday.ics", holidayEvent.ics.replace("SUMMARY:Urlaub", "SUMMARY:Urlaub\r\nSTATUS:CANCELLED"));
  // Deleted in the calendar: also.
  mock.deleteEvent("work", "call.ics");
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.deleted, 2);
  assert.ok(await one("SELECT 1 FROM row_trash WHERE id=?", holiday));
  assert.ok(await one("SELECT 1 FROM row_trash WHERE id=?", call));

  // Deleted here: the event goes, with If-Match.
  const last = mock.event("work", fileOf(item.event_id))!.etag;
  await act({ action: "row.delete", pageId, rowId: planning });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.removed, 1);
  assert.equal(mock.event("work", fileOf(item.event_id)), undefined);
  const removal = mock.requests.filter((r) => r.method === "DELETE").at(-1)!;
  assert.equal(removal.ifMatch, last);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM calendar_sync_items WHERE mapping_id=?", mapping))!.n, 0);
  await act({ action: "calendarSync.unmap", id: mapping });
});

test("without sync-collection: ctag first, then etags; an expired token lists everything again", async () => {
  mock.options.syncCollection = false;
  mock.options.omitEtagOnPut = true;
  for (const file of [...mock.calendars.get("work")!.events.keys()]) mock.deleteEvent("work", file);
  const pageId = await calendarDatabase("Termine ctag");
  const cid = await connection();
  const row = (await act({ action: "row.create", pageId, cells: { title: "Review", start: soon(6) } })).id;
  mock.putEvent("work", "team.ics", ics(["BEGIN:VEVENT", "UID:team", `DTSTART:${compact(soon(8))}T090000Z`, `DTEND:${compact(soon(8))}T100000Z`, "SUMMARY:Team", "END:VEVENT"]));
  const mapping = (await act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: mock.calendarUrl("work") })).id;
  let result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.pushed], [1, 1]);
  assert.match((await one<{ sync_token: string }>("SELECT sync_token FROM calendar_sync_mappings WHERE id=?", mapping))!.sync_token, /"token":"c:ctag-/);
  // No ETag on the PUT: read with PROPFIND.
  const item = (await one<{ event_id: string; etag: string }>("SELECT event_id,etag FROM calendar_sync_items WHERE row_id=?", row))!;
  assert.equal(item.etag, mock.event("work", fileOf(item.event_id))!.etag);

  // The own write changed the ctag: listed once, our etag known – nothing fetched.
  mock.requests.length = 0;
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual(mock.requests.map((r) => r.method), ["PROPFIND", "REPORT"]);
  assert.deepEqual([result.created, result.updated, result.pushed], [0, 0, 0]);
  // Nothing changed: one PROPFIND for the ctag, no REPORT.
  mock.requests.length = 0;
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual(mock.requests.map((r) => r.method), ["PROPFIND"]);

  // Changed and deleted there: found by etag and by multiget.
  const team = (await one<{ row_id: string }>("SELECT row_id FROM calendar_sync_items WHERE event_id LIKE '%team.ics'"))!.row_id;
  mock.putEvent("work", "team.ics", mock.event("work", "team.ics")!.ics.replace("SUMMARY:Team", "SUMMARY:Team-Runde"));
  mock.deleteEvent("work", fileOf(item.event_id));
  result = await sync.syncCalendarMapping(mapping);
  assert.equal((await cells(team)).title, "Team-Runde");
  assert.equal(result.deleted, 1);
  assert.ok(await one("SELECT 1 FROM row_trash WHERE id=?", row));
  await act({ action: "calendarSync.unmap", id: mapping });

  // sync-collection with a token the server no longer knows: a full listing.
  mock.options.syncCollection = true;
  mock.options.omitEtagOnPut = false;
  const again = (await act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: mock.calendarUrl("work") })).id;
  await sync.syncCalendarMapping(again);
  mock.options.expiredBefore = 1_000_000;
  mock.putEvent("work", "late.ics", ics(["BEGIN:VEVENT", "UID:late", `DTSTART;VALUE=DATE:${compact(soon(9))}`, "SUMMARY:Spät", "END:VEVENT"]));
  result = await sync.syncCalendarMapping(again);
  assert.equal(result.created, 1);
  assert.ok(mock.requests.some((r) => r.method === "REPORT"));
  mock.options.expiredBefore = 0;
  await act({ action: "calendarSync.unmap", id: again });
});

test("a refused password ends the run with an error on the connection; the password is never logged", async () => {
  const pageId = await calendarDatabase("Termine 401");
  const cid = await connection();
  const mapping = (await act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: mock.calendarUrl("work") })).id;
  // A calendar on another server is refused for the mapping.
  await assert.rejects(act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: "https://elsewhere.example/cal/" }), /Unbekannter Kalender/);
  // The app password was revoked at the provider.
  mock.password = "anders";
  try {
    await assert.rejects(sync.syncCalendarMapping(mapping), /abgelehnt/);
    const status = await sync.calendarSyncStatus(owner, pageId);
    assert.match(status.mappings[0].lastError!, /abgelehnt/);
    assert.match(status.connections.find((c) => c.id === cid)!.lastError!, /abgelehnt/);
  } finally {
    mock.password = password;
  }
  // Connected again: the error is gone after the next run.
  await sync.connectCalDav(owner, { url: mock.origin, username, password });
  await sync.syncCalendarMapping(mapping);
  const status = await sync.calendarSyncStatus(owner, pageId);
  assert.equal(status.connections.find((c) => c.id === cid)!.lastError, null);
  assert.equal(status.mappings[0].lastError, null);
  assert.ok(!logged.some((line) => line.includes(password) || line.includes(Buffer.from(`${username}:${password}`).toString("base64"))));
});
