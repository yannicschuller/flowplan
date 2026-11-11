// The reminder when a meeting block's calendar event starts (#199,
// lib/meeting-reminders.ts): once per event occurrence, only while the
// block still has that event and the person may read the page, respecting
// the inbox setting, and opening the page at the block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-meeting-reminders-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { htmlState } = await import("../lib/document-server");
const { meetingHtml } = await import("../lib/meeting-schema");
const reminders = await import("../lib/meeting-reminders");
const { notificationUrl } = await import("../lib/page-location");
const { meetingStatusOrNew } = await import("../lib/meetings");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const ada = await person("Ada"),
  ben = await person("Ben"),
  vic = await person("Vic");
const wid = await createWorkspace(ada.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;

const START = "2026-11-20T10:00:00Z";
const AT = Date.parse(START);
async function block(event: string, title = "Kick-off", spaceId = space) {
  const pageId = await createPage(wid, spaceId, ada.id, title);
  const meetingId = id();
  const html = meetingHtml({ meetingId, blockId: "meet1234", title, date: "2026-11-20", event, eventStart: START });
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  return { pageId, meetingId };
}
const link = (user: Identity, meetingId: string, pageId: string, event: string | null, start = START, timed = true) =>
  reminders.linkMeetingEvent(user, meetingId, { pageId, event, title: "Kick-off", start, timed, zone: "Europe/Berlin" });
const notes = async (userId: string, pageId: string) =>
  await all<{ body: string; kind: string; link: string; row_id: string | null; page_id: string; thread_id: null }>(
    "SELECT body,kind,link,row_id,page_id,thread_id FROM notifications WHERE user_id=? AND page_id=?",
    userId,
    pageId,
  );

test("timed events remind 5 minutes before, all-day ones at 09:00 in the person's zone", () => {
  assert.equal(reminders.meetingReminderAt(START, true, "Europe/Berlin"), AT - 5 * 60_000);
  assert.equal(reminders.meetingReminderAt("2026-11-20", false, "Europe/Berlin"), Date.parse("2026-11-20T08:00:00Z"));
  assert.equal(reminders.meetingReminderAt("kein Datum", true, "UTC"), null);
});

test("fires once per event occurrence, at the block, for whoever linked it", async () => {
  const event = "row:abc@2026-11-20";
  const { pageId, meetingId } = await block(event);
  const linked = await link(ben, meetingId, pageId, event);
  assert.equal(linked.reminder, AT - 5 * 60_000);
  assert.equal(await reminders.processMeetingReminders(AT - 10 * 60_000), 0);
  assert.equal(await reminders.processMeetingReminders(AT - 4 * 60_000), 1);
  assert.equal(await reminders.processMeetingReminders(AT), 0);
  const sent = await notes(ben.id, pageId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "reminder");
  assert.equal(sent[0].body, "Die Besprechung „Kick-off“ beginnt gleich.");
  assert.equal(notificationUrl(sent[0]), `/#page=${pageId}&block=meet1234`);
  assert.equal((await notes(ada.id, pageId)).length, 0);
  // Linking the same event again does not remind twice.
  await link(ben, meetingId, pageId, event);
  assert.equal(await reminders.processMeetingReminders(AT + 60_000), 0);
});

test("a block linked to another event, or removed, does not remind", async () => {
  const { pageId, meetingId } = await block("row:new@2026-11-20");
  // The reminder names an event the block no longer has.
  await link(ada, meetingId, pageId, "row:old@2026-11-20");
  assert.equal(await reminders.processMeetingReminders(AT), 0);
  assert.equal(await one("SELECT 1 FROM meeting_reminders WHERE meeting_id=?", meetingId), undefined);
  // Unlinking removes it.
  await link(ada, meetingId, pageId, "row:new@2026-11-20");
  await link(ada, meetingId, pageId, null);
  assert.equal(await one("SELECT 1 FROM meeting_reminders WHERE meeting_id=?", meetingId), undefined);
});

test("no read rights, no reminder (kept until access returns); viewers cannot link", async () => {
  const privateSpace = id();
  await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", ada.id);
  const event = "ics:x@2026-11-20";
  const { pageId, meetingId } = await block(event, "Vertraulich", privateSpace);
  await link(ada, meetingId, pageId, event);
  // The reminder belongs to someone who lost access meanwhile.
  await run("UPDATE meeting_reminders SET user_id=? WHERE meeting_id=?", ben.id, meetingId);
  assert.equal(await reminders.processMeetingReminders(AT), 0);
  assert.ok(await one("SELECT 1 FROM meeting_reminders WHERE meeting_id=? AND fired_at IS NULL", meetingId));
  const shared = await block("row:v@2026-11-20");
  await assert.rejects(() => link(vic, shared.meetingId, shared.pageId, "row:v@2026-11-20"), /Berechtigung/);
});

test("the inbox setting for reminders applies; reminders long past are dropped", async () => {
  await run("INSERT INTO notification_prefs(user_id,kind,inbox,push,email,messenger) VALUES(?,?,?,?,?,?)", vic.id, "reminder", 0, 0, 0, 0);
  const event = "row:pref@2026-11-20";
  const { pageId, meetingId } = await block(event);
  await link(ada, meetingId, pageId, event);
  await run("UPDATE meeting_reminders SET user_id=? WHERE meeting_id=?", vic.id, meetingId);
  await reminders.processMeetingReminders(AT);
  assert.equal((await notes(vic.id, pageId)).length, 0);
  // Three hours late (server down): no message, not again.
  const late = await block("row:late@2026-11-20");
  await link(ada, late.meetingId, late.pageId, "row:late@2026-11-20");
  assert.equal(await reminders.processMeetingReminders(AT + 3 * 3600_000), 0);
  assert.equal((await notes(ada.id, late.pageId)).length, 0);
  assert.ok(await one("SELECT 1 FROM meeting_reminders WHERE meeting_id=? AND fired_at IS NOT NULL", late.meetingId));
});

test("a block nobody recorded with yet answers an empty status, not 404", async () => {
  const { meetingId } = await block("row:s@2026-11-20");
  const status = await meetingStatusOrNew(ada, meetingId);
  assert.equal(status.status, "new");
  assert.deepEqual(status.sessions, []);
});
