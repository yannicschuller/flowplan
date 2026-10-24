import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-caldav-profile-"));
process.env.APP_URL = "https://flowplan.test";
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { handleCalDav } = await import("../lib/caldav");
const { createProfileLink, profileCalendars, redeemProfileLink } = await import("../lib/caldav-profile");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  outsider = user("outsider");
const wid = createWorkspace(owner.id, "Kalender & Co"),
  boot = bootstrap(owner, wid);
const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Termine <Team>" }) as { id: string }).id;
command(owner, {
  action: "database.update",
  pageId,
  version: database(pageId).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "start", name: "Start", type: "date" },
  ],
  views: [
    { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    { id: "cal", name: "Kalender", type: "calendar", dateField: "start", calendar: { mode: "month", timeZone: "Europe/Berlin" }, filters: [], sorts: [] },
  ],
});
command(owner, { action: "row.create", pageId, cells: { title: "Planung", start: "2026-10-06T08:00Z" } });
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
const plist = (profile: string, key: string) => [...profile.matchAll(new RegExp(`<key>${key}</key><string>([^<]*)</string>`, "g"))].map((m) => m[1]);

test("the settings list the person's calendar views", () => {
  const calendars = profileCalendars(owner);
  assert.deepEqual(
    calendars.map((c) => [c.pageId, c.viewId, c.page, c.view, c.syncing]),
    [[pageId, "cal", "Termine <Team>", "Kalender", false]],
  );
  assert.deepEqual(profileCalendars(outsider), []);
  assert.throws(() => profileCalendars({ ...owner, apiScope: "write" }), /API-Token/);
});

test("a link downloads the profile once; its accounts sign in to CalDAV", async () => {
  // The manual access of another device keeps working.
  const manual = command(owner, { action: "calendar.caldav", pageId, viewId: "cal" }) as { username: string; password: string };
  assert.throws(() => createProfileLink(owner, { calendars: [{ pageId, viewId: "table" }] }), /Kalenderansicht/);
  assert.throws(() => createProfileLink(outsider, { calendars: [{ pageId, viewId: "cal" }] }));
  assert.throws(() => createProfileLink(owner, { calendars: [] }));
  const link = createProfileLink(owner, { calendars: [{ pageId, viewId: "cal" }] });
  assert.match(link.url, /^https:\/\/flowplan\.test\/api\/calendar-profile\?token=[A-Za-z0-9_-]{32}$/);
  // Nothing is made before the download, and only the token's hash is kept.
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM caldav_accesses WHERE user_id=?", owner.id)!.n), 1);
  assert.equal(one("SELECT 1 FROM caldav_profile_links WHERE token_hash=?", tokenOf(link.url)), undefined);

  const profile = redeemProfileLink(tokenOf(link.url))!;
  assert.ok(profile.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(profile, /<key>PayloadType<\/key><string>com\.apple\.caldav\.account<\/string>/);
  assert.match(profile, /<key>PayloadType<\/key><string>Configuration<\/string>/);
  assert.deepEqual(plist(profile, "CalDAVHostName"), ["flowplan.test"]);
  assert.deepEqual(plist(profile, "CalDAVPrincipalURL"), ["https://flowplan.test/api/caldav/principal/"]);
  assert.match(profile, /<key>CalDAVUseSSL<\/key><true\/>/);
  assert.match(profile, /<key>CalDAVPort<\/key><integer>443<\/integer>/);
  // Titles are escaped.
  assert.ok(profile.includes("Termine &lt;Team&gt; · Kalender"));
  assert.equal(redeemProfileLink(tokenOf(link.url)), null, "a link works once");

  const [username] = plist(profile, "CalDAVUsername");
  const [password] = plist(profile, "CalDAVPassword");
  const propfind = (name: string, secret: string) =>
    handleCalDav(
      new Request("https://flowplan.test/api/caldav/calendars/", {
        method: "PROPFIND",
        headers: { authorization: `Basic ${Buffer.from(`${name}:${secret}`).toString("base64")}`, depth: "1" },
      }),
    );
  assert.equal((await propfind(username, password)).status, 207);
  assert.equal((await propfind(manual.username, manual.password)).status, 207);
  assert.equal(profileCalendars(owner)[0].syncing, true);
  // "End access" in the calendar's dialog ends the profile's account too.
  command(owner, { action: "calendar.caldav.revoke", pageId, viewId: "cal" });
  assert.equal((await propfind(username, password)).status, 401);
});

test("links expire, and lost access leaves the calendar out", () => {
  const link = createProfileLink(owner, { calendars: [{ pageId, viewId: "cal" }] }, Date.now() - 11 * 60_000);
  assert.equal(redeemProfileLink(tokenOf(link.url)), null);
  assert.equal(redeemProfileLink("not-a-token"), null);
  const second = createProfileLink(owner, { calendars: [{ pageId, viewId: "cal" }] });
  command(owner, { action: "page.delete", pageId });
  assert.equal(redeemProfileLink(tokenOf(second.url)), null);
});
