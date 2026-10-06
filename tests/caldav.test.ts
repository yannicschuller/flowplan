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

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  viewer = user("viewer");
const wid = createWorkspace(owner.id, "Cal"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, who = owner): any => command(who, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Termine" }).id as string;
act({
  action: "database.update",
  pageId,
  version: database(pageId).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "start", name: "Start", type: "date" },
    { id: "end", name: "End", type: "date" },
  ],
  views: [{ id: "cal", name: "Kalender", type: "calendar", dateField: "start", endDateField: "end", calendar: { mode: "month", timeZone: "Europe/Berlin" }, filters: [], sorts: [] }],
});
const meeting = act({ action: "row.create", pageId, cells: { title: "Planung", start: "2026-10-06T08:00Z", end: "2026-10-06T09:00Z" } }).id;
act({ action: "row.create", pageId, cells: { title: "Ohne Datum" } });
const access = act({ action: "calendar.caldav", pageId, viewId: "cal" });
const auth = (password = access.password) => `Basic ${Buffer.from(`${access.username}:${password}`).toString("base64")}`;
const dav = (method: string, path: string, body = "", headers: Record<string, string> = {}, password?: string) =>
  handleCalDav(new Request(`https://flowplan.test${path}`, { method, body: body || undefined, headers: { authorization: auth(password), ...headers } }));
const calendar = new URL(access.calendar).pathname;
const cells = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);

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
  assert.deepEqual([cells(meeting).title, cells(meeting).start, cells(meeting).end], ["Planung neu", "2026-10-07T12:00Z", "2026-10-07T13:00Z"]);
  const uid = "6f1c2a1e-4b9d-4c3a-9a51-1d2e3f4a5b6c";
  const created = await dav("PUT", `${calendar}${uid}.ics`, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Urlaub\r\nDTSTART;VALUE=DATE:20261012\r\nDTEND;VALUE=DATE:20261017\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", { "if-none-match": "*" });
  assert.equal(created.status, 201);
  assert.deepEqual([cells(uid).title, cells(uid).start, cells(uid).end], ["Urlaub", "2026-10-12", "2026-10-16"]);
  assert.equal((await dav("DELETE", `${calendar}${uid}.ics`)).status, 204);
  assert.equal(one("SELECT 1 FROM rows WHERE id=?", uid), undefined);
});

test("readers cannot write; accesses are personal", async () => {
  const mine = act({ action: "calendar.caldav", pageId, viewId: "cal" }, viewer);
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
