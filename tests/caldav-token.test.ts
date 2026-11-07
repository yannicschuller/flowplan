// A personal API token cannot mint a CalDAV access or a calendar feed: both
// are credentials of their own that would keep reading (and, for CalDAV,
// writing) the calendar after the token is revoked – as CardDAV refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-caldav-token-"));
process.env.APP_URL = "https://flowplan.test";
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { identityFromApiToken } = await import("../lib/api-tokens");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
const st = randomBytes(16).toString("hex");
await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(st).digest("hex"), uid, "[]", Date.now() + 3600_000);
const owner = (await identityFromToken(st))!;
const wid = await createWorkspace(owner.id, "Cal"),
  boot = await bootstrap(owner, wid);
const pageId = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Termine" })) as { id: string }).id;
await command(owner, {
  action: "database.update",
  pageId,
  version: (await database(pageId)).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "start", name: "Start", type: "date" },
  ],
  views: [{ id: "cal", name: "Kalender", type: "calendar", dateField: "start", calendar: { mode: "month", timeZone: "UTC" }, filters: [], sorts: [] }],
});

test("a write API token cannot create a CalDAV access or a calendar feed", async () => {
  const minted = (await command(owner, { action: "token.create", name: "script", scope: "write" })) as { id: string; token: string };
  const tokenUser = (await identityFromApiToken(`Bearer ${minted.token}`))!;
  assert.equal(tokenUser.apiScope, "write");
  for (const action of ["calendar.caldav", "calendar.feed"])
    await assert.rejects(
      async () => await command(tokenUser, { action, pageId, viewId: "cal" }),
      (e: { status?: number }) => e.status === 403,
      action,
    );
  assert.equal(await one("SELECT 1 x FROM caldav_accesses WHERE page_id=?", pageId), undefined);
  assert.equal(await one("SELECT 1 x FROM calendar_feeds WHERE page_id=?", pageId), undefined);
  // Signed in in the browser it still works.
  assert.ok(((await command(owner, { action: "calendar.caldav", pageId, viewId: "cal" })) as { password: string }).password);
  assert.match(((await command(owner, { action: "calendar.feed", pageId, viewId: "cal" })) as { url: string }).url, /\/api\/calendar\/.+\.ics$/);
});

test("a new feed link replaces the old one; revoking ends it", async () => {
  const { calendarFeed } = await import("../lib/calendar-feed");
  const token = (url: string) => decodeURIComponent(url.split("/").pop()!.replace(/\.ics$/, ""));
  const first = token(((await command(owner, { action: "calendar.feed", pageId, viewId: "cal" })) as { url: string }).url);
  assert.ok(await calendarFeed(first));
  const second = token(((await command(owner, { action: "calendar.feed", pageId, viewId: "cal" })) as { url: string }).url);
  await assert.rejects(calendarFeed(first), (e: { status?: number }) => e.status === 404);
  assert.ok(await calendarFeed(second));
  await command(owner, { action: "calendar.feed.revoke", pageId, viewId: "cal" });
  await assert.rejects(calendarFeed(second), (e: { status?: number }) => e.status === 404);
  assert.equal(await one("SELECT 1 x FROM calendar_feeds WHERE page_id=?", pageId), undefined);
});
