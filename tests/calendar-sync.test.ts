import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-calendar-sync-"));
process.env.APP_URL = "https://flowplan.test";
process.env.GOOGLE_CALENDAR_CLIENT_ID = "google-client";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "google-secret";
process.env.MS_CALENDAR_CLIENT_ID = "ms-client";
process.env.MS_CALENDAR_CLIENT_SECRET = "ms-secret";
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { hash } = await import("../lib/auth");
const { rollJournal } = await import("../lib/journal");
const { myTasks } = await import("../lib/doc-tasks");
const { parseIcs, icsEventsOn } = await import("../lib/journal-extras");
const { withMeetingNotes } = await import("../lib/meeting-notes");
const sync = await import("../lib/calendar-sync");
type CalendarRequest = import("../lib/calendar-sync").CalendarRequest;

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  viewer = user("viewer");
const wid = createWorkspace(owner.id, "Sync"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, who = owner): any => command(who, body);
function calendarDatabase(title: string) {
  const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title }).id as string;
  act({
    action: "database.update",
    pageId,
    version: database(pageId).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "start", name: "Start", type: "date" },
      { id: "end", name: "End", type: "date" },
      { id: "people", name: "People", type: "person" },
    ],
    views: [{ id: "cal", name: "Kalender", type: "calendar", dateField: "start", endDateField: "end", calendar: { mode: "month", timeZone: "Europe/Berlin" }, filters: [], sorts: [] }],
  });
  return pageId;
}
const version = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;
const cells = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);
const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/* ---------- A fake network ---------- */

type Handler = (r: CalendarRequest) => { status: number; body?: unknown } | undefined;
const requests: CalendarRequest[] = [];
let handlers: Handler[] = [];
const waits: number[] = [];
sync.calendarSyncTesting({
  transport: async (r) => {
    requests.push(r);
    for (const h of handlers) {
      const answer = h(r);
      if (answer) return { status: answer.status, body: answer.body === undefined ? "" : JSON.stringify(answer.body) };
    }
    return { status: 599, body: "" };
  },
  sleep: async (ms) => {
    waits.push(ms);
  },
});
const idToken = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
let tokenCount = 0;
// The token endpoints of both providers.
function tokenEndpoint(nonce: () => string): Handler {
  return (r) => {
    if (!/oauth2\.googleapis\.com\/token|login\.microsoftonline\.com\/.+\/token/.test(r.url)) return;
    const form = new URLSearchParams(r.body);
    const google = r.url.includes("google");
    if (form.get("grant_type") === "refresh_token") return { status: 200, body: { access_token: `access-${++tokenCount}`, expires_in: 3600 } };
    assert.equal(form.get("code"), "the-code");
    assert.ok(form.get("code_verifier"));
    return {
      status: 200,
      body: {
        access_token: `access-${++tokenCount}`,
        refresh_token: "refresh-secret-value",
        expires_in: 3600,
        id_token: idToken({
          iss: google ? "https://accounts.google.com" : "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
          aud: google ? "google-client" : "ms-client",
          nonce: nonce(),
          exp: Math.floor(Date.now() / 1000) + 600,
          email: google ? "owner@gmail.test" : undefined,
          preferred_username: google ? undefined : "owner@contoso.test",
        }),
      },
    };
  };
}
async function connect(provider: "google" | "microsoft", who = owner) {
  const { url, flow } = sync.startCalendarConnection(who, provider);
  const stored = one<{ nonce: string; state: string }>("SELECT nonce,state FROM calendar_oauth_flows WHERE id=?", hash(flow))!;
  handlers = [tokenEndpoint(() => stored.nonce)];
  const params = new URLSearchParams({ code: "the-code", state: new URL(url).searchParams.get("state")! });
  return sync.finishCalendarConnection(who, provider, flow, params);
}

test("connecting: PKCE, state and nonce are checked; the refresh token is sealed", async () => {
  const { url, flow } = sync.startCalendarConnection(owner, "google");
  const target = new URL(url);
  assert.equal(target.origin + target.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("redirect_uri"), "https://flowplan.test/api/calendar-sync/callback/google");
  assert.equal(target.searchParams.get("access_type"), "offline");
  // A wrong state ends the flow.
  await assert.rejects(sync.finishCalendarConnection(owner, "google", flow, new URLSearchParams({ code: "the-code", state: "forged" })), /Ungültige Antwort/);
  await assert.rejects(sync.finishCalendarConnection(owner, "google", flow, new URLSearchParams({ code: "the-code", state: target.searchParams.get("state")! })), /abgelaufen/);
  // Someone else's flow does not count for this person.
  const other = sync.startCalendarConnection(owner, "google");
  await assert.rejects(sync.finishCalendarConnection(viewer, "google", other.flow, new URLSearchParams({ state: "x" })), /abgelaufen/);
  // A token whose nonce does not match is refused.
  const third = sync.startCalendarConnection(owner, "google");
  handlers = [tokenEndpoint(() => "other-nonce")];
  await assert.rejects(
    sync.finishCalendarConnection(owner, "google", third.flow, new URLSearchParams({ code: "the-code", state: new URL(third.url).searchParams.get("state")! })),
    /Ungültige Antwort/,
  );
  const cid = await connect("google");
  const stored = one<{ refresh_token: string; account: string }>("SELECT refresh_token,account FROM calendar_connections WHERE id=?", cid)!;
  assert.equal(stored.account, "owner@gmail.test");
  assert.ok(!stored.refresh_token.includes("refresh-secret-value"));
  // Connecting the same account again keeps one connection.
  assert.equal(await connect("google"), cid);
  assert.equal(all("SELECT 1 FROM calendar_connections WHERE user_id=?", owner.id).length, 1);
  // Demo accounts and API tokens cannot connect.
  assert.throws(() => sync.startCalendarConnection({ ...owner, apiScope: "write" }, "google"), /nur im Browser/);
});

/* ---------- Google ---------- */

type GoogleEvent = Record<string, any>;
function fakeGoogle() {
  const events = new Map<string, GoogleEvent>();
  const changed = new Set<string>();
  let n = 0;
  const state = { events, changed, gone: false, limited: 0 };
  const touch = (e: GoogleEvent) => {
    e.updated = new Date(Date.now() + n * 1000).toISOString();
    events.set(e.id, e);
    changed.add(e.id);
  };
  const handler: Handler = (r) => {
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    if (r.url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList"))
      return { status: 200, body: { items: [{ id: "primary", summary: "Owner", primary: true }, { id: "team@group", summary: "Team" }] } };
    if (!r.url.startsWith(base)) return;
    assert.match(r.headers.authorization, /^Bearer access-/);
    if (state.limited > 0) {
      state.limited--;
      return { status: 429, body: { error: { message: "rate" } } };
    }
    const url = new URL(r.url);
    const eventId = decodeURIComponent(url.pathname.split("/events")[1]?.slice(1) || "");
    if (r.method === "GET") {
      const token = url.searchParams.get("syncToken");
      if (token && state.gone) {
        state.gone = false;
        return { status: 410, body: {} };
      }
      assert.equal(url.searchParams.get("singleEvents"), "true");
      const items = token ? [...changed].map((k) => events.get(k)!) : [...events.values()];
      changed.clear();
      return { status: 200, body: { items, nextSyncToken: `sync-${++n}` } };
    }
    if (r.method === "POST") {
      const body = JSON.parse(r.body!);
      const e = { ...body, id: `g${++n}`, status: "confirmed" };
      touch(e);
      return { status: 200, body: e };
    }
    if (r.method === "PATCH") {
      const e = events.get(eventId);
      if (!e || e.status === "cancelled") return { status: 404, body: {} };
      const body = JSON.parse(r.body!);
      const merged = { ...e, ...body, start: { ...e.start, ...body.start }, end: { ...e.end, ...body.end } };
      for (const k of ["start", "end"]) for (const [key, value] of Object.entries(merged[k])) if (value === null) delete merged[k][key];
      touch(merged);
      return { status: 200, body: merged };
    }
    if (r.method === "DELETE") {
      const e = events.get(eventId);
      if (e) touch({ ...e, status: "cancelled" });
      return { status: 204 };
    }
  };
  return { ...state, state, handler, touch };
}

test("Google: records go out, events come in, changes and deletions both ways", async () => {
  const pageId = calendarDatabase("Termine Google");
  const cid = one<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id=? AND provider='google'", owner.id)!.id;
  const google = fakeGoogle();
  handlers = [tokenEndpoint(() => ""), google.handler];
  const calendars = await sync.listExternalCalendars(owner, cid);
  assert.deepEqual(calendars.map((c) => c.name), ["Owner", "Team"]);
  // Only editors of the database map it.
  assert.throws(() => act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: "primary" }, viewer), /Kalenderverbindung nicht gefunden|Keine Berechtigung/);
  const day = soon(3);
  const planning = act({ action: "row.create", pageId, cells: { title: "Planung", start: `${day}T08:00Z`, end: `${day}T09:30Z` } }).id;
  const mapping = act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: "primary", calendarName: "Owner" }).id;
  // An event that already is in the calendar.
  google.touch({ id: "ext1", status: "confirmed", summary: "Urlaub", description: "Strand\n\nSonne", start: { date: soon(10) }, end: { date: soon(13) } });

  let result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.created, 1);
  assert.equal(result.pushed, 1);
  const holiday = one<{ row_id: string }>("SELECT row_id FROM calendar_sync_items WHERE event_id='ext1'")!.row_id;
  assert.deepEqual([cells(holiday).title, cells(holiday).start, cells(holiday).end], ["Urlaub", soon(10), soon(12)]);
  assert.match(one<{ content: string }>("SELECT content FROM rows WHERE id=?", holiday)!.content, /<p>Strand<\/p><p><\/p><p>Sonne<\/p>/);
  const pushed = [...google.events.values()].find((e) => e.summary === "Planung")!;
  assert.equal(pushed.start.dateTime, `${day}T08:00:00Z`);
  assert.equal(pushed.start.timeZone, "Europe/Berlin");
  assert.equal(pushed.extendedProperties.private.flowplanRow, planning);
  assert.ok(pushed.description.endsWith(`— Flowplan: https://flowplan.test/#page=${pageId}&row=${planning}`));

  // Our own changes coming back change nothing; a second run is quiet.
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.updated, result.pushed, result.conflicts], [0, 0, 0, 0]);

  // Moved in the calendar (other time zone): the record follows.
  google.touch({ ...pushed, summary: "Planung neu", start: { dateTime: `${day}T14:00:00+02:00` }, end: { dateTime: `${day}T15:00:00+02:00` } });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.updated, 1);
  assert.deepEqual([cells(planning).title, cells(planning).start, cells(planning).end], ["Planung neu", `${day}T12:00Z`, `${day}T13:00Z`]);

  // Changed here: the event follows, all-day with an exclusive end.
  act({ action: "row.update", pageId, rowId: planning, version: version(planning), cells: { start: day, end: soon(4) } });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.pushed, 1);
  const allDay = google.events.get(pushed.id)!;
  assert.deepEqual([allDay.start.date, allDay.end.date, allDay.start.dateTime], [day, soon(5), undefined]);

  // Both sides changed: the later change wins, with an audit line.
  act({ action: "row.update", pageId, rowId: planning, version: version(planning), cells: { title: "Hier geändert" } });
  run("UPDATE rows SET updated_at=datetime('now','-1 hour') WHERE id=?", planning);
  google.touch({ ...google.events.get(pushed.id)!, summary: "Dort geändert" });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.conflicts, 1);
  assert.equal(cells(planning).title, "Dort geändert");
  const line = one<{ detail: string }>("SELECT detail FROM audit WHERE action='calendar.sync.conflict' AND resource_id=?", planning)!;
  assert.equal(JSON.parse(line.detail).winner, "remote");

  // Deleted in the calendar: the record goes to the trash.
  google.touch({ ...google.events.get("ext1")!, status: "cancelled" });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.deleted, 1);
  assert.equal(one("SELECT 1 FROM rows WHERE id=?", holiday), undefined);
  assert.ok(one("SELECT 1 FROM row_trash WHERE id=?", holiday));

  // Deleted here: the event goes.
  act({ action: "row.delete", pageId, rowId: planning });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.removed, 1);
  assert.equal(google.events.get(pushed.id)!.status, "cancelled");
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM calendar_sync_items WHERE mapping_id=?", mapping)!.n, 0);
});

test("Google: rate limits back off, an expired sync token starts over, errors back off the mapping", async () => {
  const pageId = calendarDatabase("Termine Retry");
  const cid = one<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id=? AND provider='google'", owner.id)!.id;
  run("DELETE FROM calendar_sync_mappings WHERE connection_id=?", cid);
  const google = fakeGoogle();
  handlers = [tokenEndpoint(() => ""), google.handler];
  const mapping = act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: "primary" }).id;
  google.touch({ id: "r1", status: "confirmed", summary: "Eins", start: { dateTime: `${soon(2)}T10:00:00Z` }, end: { dateTime: `${soon(2)}T11:00:00Z` } });
  google.state.limited = 2;
  waits.length = 0;
  let result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.created, 1);
  assert.deepEqual(waits, [1000, 2000]);
  google.state.gone = true;
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.pulled, 1, "full listing after 410");
  assert.equal(result.created, 0, "known events are not created twice");
  // The provider fails: the run ends, the mapping waits longer.
  handlers = [tokenEndpoint(() => ""), () => ({ status: 400, body: {} })];
  await assert.rejects(sync.syncCalendarMapping(mapping), /Kalenderanbieter meldet einen Fehler/);
  const stored = one<{ failures: number; next_at: number; last_error: string }>("SELECT failures,next_at,last_error FROM calendar_sync_mappings WHERE id=?", mapping)!;
  assert.equal(stored.failures, 1);
  assert.ok(stored.next_at > Date.now() + 15 * 60_000);
  assert.match(stored.last_error, /Kalenderanbieter/);
  run("DELETE FROM calendar_sync_mappings WHERE id=?", mapping);
});

test("records the person may only read are not synced", async () => {
  const pageId = calendarDatabase("Nur lesen");
  const day = soon(5);
  act({ action: "row.create", pageId, cells: { title: "Geheim", start: day } });
  // The viewer connects an account of their own; mapping a database they cannot edit fails.
  const viewerCid = await connect("google", viewer);
  const google = fakeGoogle();
  handlers = [tokenEndpoint(() => ""), google.handler];
  assert.throws(() => act({ action: "calendarSync.map", connectionId: viewerCid, pageId, viewId: "cal", calendarId: "primary" }, viewer), /Keine Berechtigung/);
  // Losing edit rights later: nothing is pushed, nothing comes in.
  const mid = id();
  run(
    "INSERT INTO calendar_sync_mappings(id,connection_id,user_id,page_id,view_id,calendar_id,created_at) VALUES(?,?,?,?,?,?,?)",
    mid,
    viewerCid,
    viewer.id,
    pageId,
    "cal",
    "primary",
    Date.now(),
  );
  google.touch({ id: "v1", status: "confirmed", summary: "Von außen", start: { date: day }, end: { date: soon(6) } });
  const result = await sync.syncCalendarMapping(mid);
  assert.deepEqual([result.pushed, result.created], [0, 0]);
  assert.equal(google.events.size, 1);
});

/* ---------- Microsoft ---------- */

test("Microsoft Graph: delta link, UTC times, all-day events and removals", async () => {
  const pageId = calendarDatabase("Termine Outlook");
  const cid = await connect("microsoft");
  const events = new Map<string, Record<string, any>>();
  let delta: Record<string, any>[] = [];
  let n = 0;
  const graph: Handler = (r) => {
    if (!r.url.startsWith("https://graph.microsoft.com/v1.0/")) return;
    if (!r.url.includes("/me/calendars?")) assert.match(r.headers.prefer || "", /outlook\.timezone="UTC"/);
    const url = new URL(r.url);
    if (url.pathname.endsWith("/me/calendars")) return { status: 200, body: { value: [{ id: "cal-1", name: "Kalender", canEdit: true, isDefaultCalendar: true }, { id: "ro", name: "Feiertage", canEdit: false }] } };
    if (url.pathname.endsWith("/calendarView/delta") || url.searchParams.has("$deltatoken")) {
      const value = url.searchParams.has("$deltatoken") ? delta : [...events.values()];
      delta = [];
      return { status: 200, body: { value, "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=t${++n}` } };
    }
    if (r.method === "POST") {
      const e = { ...JSON.parse(r.body!), id: `m${++n}`, lastModifiedDateTime: new Date().toISOString() };
      events.set(e.id, e);
      delta.push(e);
      return { status: 201, body: e };
    }
    const eventId = decodeURIComponent(url.pathname.split("/me/events/")[1] || "");
    if (r.method === "DELETE") {
      events.delete(eventId);
      delta.push({ id: eventId, "@removed": { reason: "deleted" } });
      return { status: 204 };
    }
  };
  handlers = [tokenEndpoint(() => ""), graph];
  assert.deepEqual((await sync.listExternalCalendars(owner, cid)).map((c) => c.name), ["Kalender"]);
  const day = soon(2);
  events.set("x1", {
    id: "x1",
    subject: "Kundentermin",
    body: { contentType: "text", content: "Agenda folgt" },
    isAllDay: false,
    start: { dateTime: `${day}T07:30:00.0000000`, timeZone: "UTC" },
    end: { dateTime: `${day}T08:15:00.0000000`, timeZone: "UTC" },
    lastModifiedDateTime: new Date().toISOString(),
    attendees: [{ emailAddress: { address: "Viewer@test.invalid", name: "Viewer" }, type: "required" }, { emailAddress: { address: "guest@example.test", name: "Gast" } }],
  });
  const local = act({ action: "row.create", pageId, cells: { title: "Messe", start: soon(7), end: soon(8) } }).id;
  const mapping = act({ action: "calendarSync.map", connectionId: cid, pageId, viewId: "cal", calendarId: "cal-1" }).id;
  let result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.pushed], [1, 1]);
  const customer = one<{ row_id: string }>("SELECT row_id FROM calendar_sync_items WHERE event_id='x1'")!.row_id;
  assert.deepEqual([cells(customer).title, cells(customer).start, cells(customer).end], ["Kundentermin", `${day}T07:30Z`, `${day}T08:15Z`]);
  assert.deepEqual(sync.syncedAttendees(customer).map((a) => a.email), ["viewer@test.invalid", "guest@example.test"]);
  const fair = [...events.values()].find((e) => e.subject === "Messe")!;
  assert.deepEqual([fair.isAllDay, fair.start.dateTime, fair.end.dateTime, fair.start.timeZone], [true, `${soon(7)}T00:00:00`, `${soon(9)}T00:00:00`, "UTC"]);
  assert.ok(fair.body.content.includes(`row=${local}`));
  // The echo of the created event changes nothing.
  result = await sync.syncCalendarMapping(mapping);
  assert.deepEqual([result.created, result.updated, result.pushed], [0, 0, 0]);
  // Removed in Outlook.
  events.delete("x1");
  delta.push({ id: "x1", "@removed": { reason: "deleted" } });
  result = await sync.syncCalendarMapping(mapping);
  assert.equal(result.deleted, 1);
  // The status lists the mapping for the settings.
  const status = sync.calendarSyncStatus(owner, pageId);
  assert.equal(status.mappings[0].events, 1);
  assert.ok(status.providers.every((p) => p.configured));
  // Disconnecting removes the mappings.
  act({ action: "calendarSync.disconnect", connectionId: cid });
  assert.equal(one("SELECT 1 FROM calendar_sync_mappings WHERE id=?", mapping), undefined);
});

/* ---------- Meeting notes ---------- */

test("meeting notes from a synced record and from an ICS event", async () => {
  const pageId = calendarDatabase("Meetings");
  const journalId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Journal", kind: "journal" }).id;
  const journal = one<Page>("SELECT * FROM pages WHERE id=?", journalId)!;
  const date = "2026-10-06";
  const dayId = rollJournal(owner, journal, date, date).dayId;
  const rowId = act({ action: "row.create", pageId, cells: { title: "Jour fixe", start: `${date}T08:00Z`, end: `${date}T09:00Z`, people: [owner.id] } }).id;
  // Attendees known from the calendar (lib/calendar-sync.ts).
  const mid = id();
  const cid = one<{ id: string }>("SELECT id FROM calendar_connections WHERE user_id=?", owner.id)!.id;
  run("INSERT INTO calendar_sync_mappings(id,connection_id,user_id,page_id,view_id,calendar_id,created_at) VALUES(?,?,?,?,?,?,?)", mid, cid, owner.id, pageId, "cal", "notes-cal", Date.now());
  run(
    "INSERT INTO calendar_sync_items(mapping_id,row_id,event_id,hash,attendees,synced_at) VALUES(?,?,?,?,?,?)",
    mid,
    rowId,
    "e1",
    "h",
    JSON.stringify([{ email: "viewer@test.invalid", name: "V" }, { email: "extern@example.test", name: "Extern" }]),
    Date.now(),
  );
  const note = act({ action: "meeting.note", pageId: dayId, zone: "Europe/Berlin", event: { title: "ignored", start: `${date}T08:00Z`, end: `${date}T09:00Z`, timed: true, pageId, rowId } });
  const page = one<Page>("SELECT * FROM pages WHERE id=?", note.id)!;
  assert.equal(page.parent_id, journalId);
  assert.equal(page.title, "Jour fixe – 06.10.2026");
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", note.id)!.html;
  assert.match(html, /10:00–11:00/);
  assert.ok(html.includes(`data-mention="${owner.id}"`));
  assert.ok(html.includes(`data-mention="${viewer.id}"`));
  assert.ok(html.includes("Extern &lt;extern@example.test&gt;"));
  assert.ok(html.includes(`href="/#page=${pageId}&amp;row=${rowId}"`));
  for (const heading of ["Teilnehmende", "Agenda", "Notizen", "Aufgaben"]) assert.ok(html.includes(`<h2>${heading}</h2>`), heading);
  // Asked again: the same note.
  assert.deepEqual(act({ action: "meeting.note", pageId: dayId, event: { start: date, pageId, rowId } }), { id: note.id, existing: true });
  // The day lists the note next to the appointment.
  const day = one<Page>("SELECT * FROM pages WHERE id=?", dayId)!;
  const listed = withMeetingNotes(owner, day, [{ title: "Jour fixe", start: `${date}T08:00Z`, end: "", timed: true, source: "Meetings", pageId, rowId }]);
  assert.equal(listed[0].noteId, note.id);

  // A task with an assignee in the note shows up in "Meine Aufgaben".
  const withTask = html.replace(
    '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p></p></div></li>',
    `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Protokoll schicken <span data-mention="${viewer.id}" class="mention">@viewer</span></p></div></li>`,
  );
  assert.notEqual(withTask, html);
  const { htmlState } = await import("../lib/document-server");
  const { indexPageTasks } = await import("../lib/doc-tasks");
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", withTask, htmlState(withTask), note.id);
  indexPageTasks(note.id, false);
  assert.deepEqual(myTasks(viewer, wid).map((t) => t.text), ["Protokoll schicken @viewer"]);

  // An ICS event: UID and attendees from the feed.
  const ics = parseIcs(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:abc-123@example.test",
      "DTSTART:20261006T120000Z",
      "DTEND:20261006T130000Z",
      "SUMMARY:Review",
      'ATTENDEE;CN="Owner";ROLE=REQ-PARTICIPANT:mailto:owner@test.invalid',
      "ATTENDEE;CN=Fremd:mailto:fremd@example.test",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  const [event] = icsEventsOn(ics, date, "Europe/Berlin");
  assert.equal(event.uid, "abc-123@example.test");
  assert.deepEqual(event.attendees, [
    { email: "owner@test.invalid", name: "Owner" },
    { email: "fremd@example.test", name: "Fremd" },
  ]);
  const icsNote = act({ action: "meeting.note", pageId: dayId, zone: "Europe/Berlin", event });
  const icsHtml = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", icsNote.id)!.html;
  assert.ok(icsHtml.includes(`data-mention="${owner.id}"`));
  assert.ok(icsHtml.includes("Fremd &lt;fremd@example.test&gt;"));
  assert.equal(withMeetingNotes(owner, day, [event])[0].noteId, icsNote.id);
  // Readers of the journal cannot create notes in it.
  assert.throws(() => act({ action: "meeting.note", pageId: dayId, event }, viewer), /Keine Berechtigung|nicht gefunden/);
});

test("the template catalogue has the meeting note", async () => {
  const { templateCatalog } = await import("../lib/template-catalog");
  const { templateCatalogEn } = await import("../lib/template-catalog-en");
  assert.equal(templateCatalog.meetingNote.name, "Besprechungsnotiz");
  assert.equal(templateCatalogEn.meetingNote.name, "Meeting note");
  assert.match(templateCatalog.meetingNote.html!, /data-type="taskList"/);
});
