import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-caldav-"));
process.env.APP_URL = "https://flowplan.test";
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { handleCalDav, parseEvent } = await import("../lib/caldav");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer");
const wid = await createWorkspace(owner.id, "Cal"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>, who = owner): Promise<any> => await command(who, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Termine" })).id as string;
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
const meeting = (await act({ action: "row.create", pageId, cells: { title: "Planung", start: "2026-10-06T08:00Z", end: "2026-10-06T09:00Z" } })).id;
await act({ action: "row.create", pageId, cells: { title: "Ohne Datum" } });
const access = await act({ action: "calendar.caldav", pageId, viewId: "cal" });
const auth = (password = access.password) => `Basic ${Buffer.from(`${access.username}:${password}`).toString("base64")}`;
const dav = (method: string, path: string, body = "", headers: Record<string, string> = {}, password?: string) =>
  handleCalDav(new Request(`https://flowplan.test${path}`, { method, body: body || undefined, headers: { authorization: auth(password), ...headers } }));
const calendar = new URL(access.calendar).pathname;
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);

test("discovery and listing", async () => {
  assert.equal((await dav("PROPFIND", "/api/caldav/", "", {}, "wrong")).status, 401);
  const root = await (await dav("PROPFIND", "/api/caldav/")).text();
  assert.match(root, /current-user-principal><d:href>\/api\/caldav\/principal\//);
  const home = await (await dav("PROPFIND", "/api/caldav/calendars/", "", { depth: "1" })).text();
  assert.ok(home.includes(calendar));
  assert.match(home, /<c:calendar\/>/);
  const list = await (await dav("PROPFIND", calendar, "", { depth: "1" })).text();
  assert.ok(list.includes(`${meeting}.ics`));
  assert.equal((list.match(/\.ics</g) || []).length, 1, "records without a date are not events");
  const report = await (await dav("REPORT", calendar, `<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:href>${calendar}${meeting}.ics</d:href></c:calendar-multiget>`)).text();
  assert.match(report, /SUMMARY:Planung/);
  assert.match(report, /DTSTART:20261006T080000Z/);
});

test("changes write back: move, rename, create, delete", async () => {
  const get = await dav("GET", `${calendar}${meeting}.ics`);
  const etag = get.headers.get("etag")!;
  const moved = (await get.text()).replace("SUMMARY:Planung", "SUMMARY:Planung neu").replace("DTSTART:20261006T080000Z", "DTSTART;TZID=Europe/Berlin:20261007T140000").replace("DTEND:20261006T090000Z", "DTEND;TZID=Europe/Berlin:20261007T150000");
  assert.equal((await dav("PUT", `${calendar}${meeting}.ics`, moved, { "if-match": '"0-x"' })).status, 412);
  assert.equal((await dav("PUT", `${calendar}${meeting}.ics`, moved, { "if-match": etag })).status, 204);
  assert.deepEqual([(await cells(meeting)).title, (await cells(meeting)).start, (await cells(meeting)).end], ["Planung neu", "2026-10-07T12:00Z", "2026-10-07T13:00Z"]);
  const uid = "6f1c2a1e-4b9d-4c3a-9a51-1d2e3f4a5b6c";
  const created = await dav("PUT", `${calendar}${uid}.ics`, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Urlaub\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261017\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", { "if-none-match": "*" });
  assert.equal(created.status, 201);
  assert.deepEqual([(await cells(uid)).title, (await cells(uid)).start, (await cells(uid)).end], ["Urlaub", "2026-10-12", "2026-10-16"]);
  assert.equal((await dav("DELETE", `${calendar}${uid}.ics`)).status, 204);
  assert.equal(await one("SELECT 1 FROM rows WHERE id=?", uid), undefined);
});

test("readers cannot write; accesses are personal", async () => {
  const mine = await act({ action: "calendar.caldav", pageId, viewId: "cal" }, viewer);
  const response = await handleCalDav(
    new Request(`https://flowplan.test${new URL(mine.calendar).pathname}${meeting}.ics`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`v:${mine.password}`).toString("base64")}` },
    }),
  );
  assert.equal(response.status, 403);
  // The owner's password does not open the viewer's calendar.
  assert.equal((await dav("PROPFIND", new URL(mine.calendar).pathname, "", { depth: "1" })).status, 404);
});

test("all-day and floating times", () => {
  const e = parseEvent("BEGIN:VEVENT\nDTSTART;VALUE=DATE:20261001\nDTEND;VALUE=DATE:20261002\nSUMMARY:Tag\\, ganz\nEND:VEVENT");
  assert.deepEqual([e.title, e.start.value, e.end], ["Tag, ganz", "2026-10-01", null]);
});

const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const recurrence = async (rid: string) => (await one<{ recurrence: string }>("SELECT recurrence FROM rows WHERE id=?", rid))!.recurrence;
const ics = async (rid: string) => await (await dav("GET", `${calendar}${rid}.ics`)).text();

test("a detached occurrence is skipped in the series (EXDATE)", async () => {
  const rid = (await act({ action: "row.create", pageId, cells: { title: "Jour fixe", start: "2026-11-02T09:00Z", end: "2026-11-02T10:00Z" } })).id;
  await act({ action: "row.recurrence", pageId, rowId: rid, version: await version(rid), recurrence: { freq: "weekly", interval: 1 } });
  await act({ action: "row.detachOccurrence", pageId, rowId: rid, version: await version(rid), date: "2026-11-16", startField: "start", endField: "end", timeZone: "Europe/Berlin" });
  const text = await ics(rid);
  assert.match(text, /RRULE:FREQ=WEEKLY;INTERVAL=1\r\n/);
  assert.match(text, /EXDATE:20261116T090000Z\r\n/);
});

test("month-end and leap-day series are clamped in external calendars too", async () => {
  const monthly = (await act({ action: "row.create", pageId, cells: { title: "Abrechnung", start: "2026-01-31" } })).id;
  await act({ action: "row.recurrence", pageId, rowId: monthly, version: await version(monthly), recurrence: { freq: "monthly", interval: 1, count: 4 } });
  assert.match(await ics(monthly), /RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=28,29,30,31;BYSETPOS=-1;COUNT=4\r\n/);
  const birthday = (await act({ action: "row.create", pageId, cells: { title: "Geburtstag", start: "2028-02-29" } })).id;
  await act({ action: "row.recurrence", pageId, rowId: birthday, version: await version(birthday), recurrence: { freq: "yearly", interval: 1 } });
  assert.match(await ics(birthday), /RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1\r\n/);
  const plain = (await act({ action: "row.create", pageId, cells: { title: "Mitte", start: "2026-01-15" } })).id;
  await act({ action: "row.recurrence", pageId, rowId: plain, version: await version(plain), recurrence: { freq: "monthly", interval: 1 } });
  assert.match(await ics(plain), /RRULE:FREQ=MONTHLY;INTERVAL=1\r\n/);
  // The same rule comes back unchanged.
  const get = await dav("GET", `${calendar}${monthly}.ics`);
  assert.equal((await dav("PUT", `${calendar}${monthly}.ics`, await get.text(), { "if-match": get.headers.get("etag")! })).status, 204);
  assert.deepEqual(JSON.parse(await recurrence(monthly)), { freq: "monthly", interval: 1, count: 4 });
});

test("a title with a backslash and n survives a round trip", async () => {
  const rid = (await act({ action: "row.create", pageId, cells: { title: "C:\\new\\notes", start: "2026-10-08T08:00Z" } })).id;
  const get = await dav("GET", `${calendar}${rid}.ics`);
  const body = (await get.text()).replace("DTSTART:20261008T080000Z", "DTSTART:20261009T080000Z");
  assert.equal((await dav("PUT", `${calendar}${rid}.ics`, body, { "if-match": get.headers.get("etag")! })).status, 204);
  assert.deepEqual([(await cells(rid)).title, (await cells(rid)).start], ["C:\\new\\notes", "2026-10-09T08:00Z"]);
  assert.equal(parseEvent("BEGIN:VEVENT\nDTSTART:20261001T080000Z\nSUMMARY:Zeile\\neins\\Nzwei\\\\n\nEND:VEVENT").title, "Zeile\neins\nzwei\\n");
});

test("a series created over CalDAV keeps its rule; rules the app cannot repeat are refused", async () => {
  const event = (uid: string, rrule: string, extra = "") =>
    `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Serie\r\nDTSTART;TZID=Europe/Berlin:20261103T100000\r\nDTEND;TZID=Europe/Berlin:20261103T110000\r\n${rrule ? `RRULE:${rrule}\r\n` : ""}${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
  const uid = "0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a5b";
  const created = await dav("PUT", `${calendar}${uid}.ics`, event(uid, "FREQ=WEEKLY;COUNT=10;BYDAY=TU;WKST=MO", "EXDATE;TZID=Europe/Berlin:20261110T100000\r\n"), { "if-none-match": "*" });
  assert.equal(created.status, 201);
  assert.deepEqual(JSON.parse(await recurrence(uid)), { freq: "weekly", interval: 1, count: 10, exclude: ["2026-11-10"] });
  const text = await ics(uid);
  assert.match(text, /RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=10\r\n/);
  assert.match(text, /EXDATE:20261110T090000Z\r\n/);
  // UNTIL in UTC is a local day; a rule removed in the client goes here too.
  let get = await dav("GET", `${calendar}${uid}.ics`);
  assert.equal((await dav("PUT", `${calendar}${uid}.ics`, event(uid, "FREQ=DAILY;INTERVAL=2;UNTIL=20261130T225959Z"), { "if-match": get.headers.get("etag")! })).status, 204);
  assert.deepEqual(JSON.parse(await recurrence(uid)), { freq: "daily", interval: 2, until: "2026-11-30" });
  get = await dav("GET", `${calendar}${uid}.ics`);
  assert.equal((await dav("PUT", `${calendar}${uid}.ics`, event(uid, ""), { "if-match": get.headers.get("etag")! })).status, 204);
  assert.equal(await recurrence(uid), "");
  // Unsupported rules: refused, nothing stored.
  for (const rule of ["FREQ=WEEKLY;BYDAY=MO,WE", "FREQ=MONTHLY;BYDAY=1MO", "FREQ=HOURLY", "FREQ=DAILY;INTERVAL=500"]) {
    const other = id();
    const answer = await dav("PUT", `${calendar}${other}.ics`, event(other, rule), { "if-none-match": "*" });
    assert.equal(answer.status, 403, rule);
    assert.match(await answer.text(), /Wiederholung/);
    assert.equal(await one("SELECT 1 FROM rows WHERE id=?", other), undefined);
  }
});
