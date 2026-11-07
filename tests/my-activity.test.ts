import { test } from "node:test";
import { sqliteOnly } from "./helpers/backend";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

// "My activity" on the start page (#114, lib/my-activity.ts): pages the
// person created and edited per week, month or year, from what Flowplan
// stores anyway – once per page and day, the person's own days, only pages
// they can still open, never anyone else's numbers.
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-mine-"));
const { all, id, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { withContentLocale } = await import("../lib/content-locale");
const { homeLayout } = await import("../lib/home-layout");
const { homeData } = await import("../lib/home-widgets");
const S = await import("../lib/home-layout-schema");
const { periodRange, offsetSpans, myActivity } = await import("../lib/my-activity");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("mine-owner"),
  me = await account("mine-me");
const wid = await createWorkspace(owner.id, "Mine");
const sid = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, me.id, "editor");
const elsewhere = await createWorkspace(me.id, "Elsewhere");
const elsewhereSpace = (await bootstrap(me, elsewhere)).spaces[0].id;
const page = async (user: Identity, title: string, opts: { workspaceId?: string; spaceId?: string; kind?: string; parentId?: string } = {}) =>
  ((await command(user, { action: "page.create", workspaceId: opts.workspaceId ?? wid, spaceId: opts.spaceId ?? sid, title, kind: opts.kind ?? "document", ...(opts.parentId ? { parentId: opts.parentId } : {}) })) as { id: string }).id;
// Only the rows each test writes: commands log their own edits at "now".
const clean = async () => {
  await run("DELETE FROM snapshots");
  await run("DELETE FROM audit");
  await run("DELETE FROM page_edits");
  await run("UPDATE pages SET created_at='2000-01-01 00:00:00'");
};
const created = async (pageId: string, at: string) => await run("UPDATE pages SET created_at=? WHERE id=?", at, pageId);
const snapshot = async (pageId: string, by: string, at: string, kind = "auto") =>
  await run("INSERT INTO snapshots(id,page_id,html,title,created_by,created_at,kind) VALUES(?,?,?,?,?,?,?)", id(), pageId, "<p>x</p>", "x", by, at, kind);
const logged = async (pageId: string, by: string, at: string, action = "page.update") =>
  await run("INSERT INTO audit(id,actor_id,action,resource_id,detail,created_at) VALUES(?,?,?,?,?,?)", id(), by, action, pageId, "", at);
const lastEdit = async (pageId: string, by: string, at: string) =>
  await run("INSERT INTO page_edits(page_id,user_id,at) VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET at=excluded.at", pageId, by, Date.parse(`${at.replace(" ", "T")}Z`));

const TODAY = "2026-11-04"; // a Wednesday

test("periods: this week, month or year against the same stretch before", () => {
  const week = periodRange(TODAY, "week");
  assert.deepEqual([week.from, week.to, week.previousFrom, week.previousTo], ["2026-11-02", "2026-11-08", "2026-10-26", "2026-10-28"]);
  assert.equal(week.buckets.length, 7);
  assert.equal(week.unit, "day");
  // Sunday still belongs to the week that began on Monday.
  assert.equal(periodRange("2026-11-08", "week").from, "2026-11-02");
  const march = periodRange("2026-03-31", "month");
  assert.deepEqual([march.from, march.to, march.previousFrom, march.previousTo], ["2026-03-01", "2026-03-31", "2026-02-01", "2026-02-28"]);
  assert.equal(march.buckets.length, 31);
  const leap = periodRange("2028-02-29", "year");
  assert.deepEqual([leap.from, leap.to, leap.previousFrom, leap.previousTo], ["2028-01-01", "2028-12-31", "2027-01-01", "2027-02-28"]);
  assert.deepEqual([leap.buckets[0], leap.buckets[11], leap.unit], ["2028-01", "2028-12", "month"]);
});

test("summer time splits a year into stretches of one offset", () => {
  const spans = offsetSpans("2026-01-01", "2027-01-01", "Europe/Berlin");
  assert.deepEqual(spans.map((s) => s.offset), ["+3600 seconds", "+7200 seconds", "+3600 seconds"]);
  assert.equal(spans[0].start, Date.parse("2025-12-31T23:00:00Z"));
  assert.equal(spans[2].end, Date.parse("2026-12-31T23:00:00Z"));
  assert.deepEqual(offsetSpans("2026-11-02", "2026-11-05", "America/New_York").map((s) => s.offset), ["-18000 seconds"]);
});

test("created and edited pages, once per page and day, on the person's days", async () => {
  const a = await page(me, "A"),
    b = await page(me, "B"),
    c = await page(owner, "C by someone else");
  await clean();
  await created(a, "2026-11-02 08:00:00");
  await created(b, "2026-10-27 09:00:00"); // last week, before "today" of last week
  await created(c, "2026-11-03 09:00:00"); // not mine
  // Autosaves: many versions of one page on one day count once.
  for (const hour of ["08", "09", "10", "11"]) await snapshot(a, me.id, `2026-11-03 ${hour}:00:00`);
  // The same page edited through the activity log and page_edits that day: still once.
  await logged(a, me.id, "2026-11-03 12:00:00");
  await lastEdit(a, me.id, "2026-11-03 13:00:00");
  // Another day: once more.
  await logged(a, me.id, "2026-11-04 07:00:00", "row.update");
  // B on two days of last week, one after "today" of last week (Thursday).
  await snapshot(b, me.id, "2026-10-27 10:00:00");
  await snapshot(b, me.id, "2026-10-29 10:00:00");
  // Someone else's edits never count, nor versions brought in by an import.
  await snapshot(c, owner.id, "2026-11-03 10:00:00");
  await logged(c, owner.id, "2026-11-03 10:00:00");
  await snapshot(c, me.id, "2026-11-03 10:00:00", "manual");
  // Commands that are not edits do not count.
  await logged(c, me.id, "2026-11-03 10:00:00", "page.follow");

  const week = await myActivity(me, wid, TODAY, "UTC", "week");
  assert.equal(week.created.total, 1);
  assert.equal(week.created.previous, 1);
  assert.deepEqual(week.created.series, [1, 0, 0, null, null, null, null]);
  assert.equal(week.edited.total, 2);
  assert.deepEqual(week.edited.series, [0, 1, 1, null, null, null, null]);
  assert.equal(week.edited.previous, 1);

  // Late on Sunday in UTC is Monday in Berlin: the edit moves into this week.
  await lastEdit(b, me.id, "2026-11-01 23:30:00");
  assert.equal((await myActivity(me, wid, TODAY, "UTC", "week")).edited.total, 2);
  const berlin = await myActivity(me, wid, TODAY, "Europe/Berlin", "week");
  assert.equal(berlin.edited.total, 3);
  assert.equal(berlin.edited.series[0], 1);

  // A month and a year sum the days; a year has twelve months.
  const month = await myActivity(me, wid, TODAY, "UTC", "month");
  assert.equal(month.buckets.length, 30);
  // A on the 3rd and 4th, B late on the 1st; B's October days are after the 4th.
  assert.equal(month.edited.total, 3);
  assert.equal(month.edited.previous, 0);
  const year = await myActivity(me, wid, TODAY, "UTC", "year");
  assert.equal(year.buckets.length, 12);
  assert.equal(year.created.total, 2);
  assert.deepEqual(year.created.series.slice(9), [1, 1, null]);
  assert.equal(year.edited.series[9], 2);
  assert.equal(year.edited.series[10], 3);
  assert.equal(year.created.previous, 0);
});

test("only pages the person can still open, in this workspace", async () => {
  await clean();
  const trashed = await page(me, "Trashed");
  const foreign = await page(me, "Elsewhere", { workspaceId: elsewhere, spaceId: elsewhereSpace });
  // A page the person edited that has since gone private to someone else.
  const privateSpace = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Private", private: true })) as { id: string }).id;
  const secret = await page(owner, "Salary review", { spaceId: privateSpace });
  // An own journal behind a PIN that was not entered.
  const journal = await page(me, "Diary", { kind: "journal" });
  const entry = await page(me, "4 November", { parentId: journal });
  const visible = await page(me, "Visible");
  await command(me, { action: "page.delete", pageId: trashed });
  await command(me, { action: "journal.lock", pageId: journal, pin: "482915" });
  await run("DELETE FROM journal_unlocks WHERE page_id=?", journal);
  await clean();
  for (const p of [trashed, foreign, entry, journal, visible]) await created(p, "2026-11-03 09:00:00");
  for (const p of [trashed, foreign, secret, entry, visible]) await snapshot(p, me.id, "2026-11-03 10:00:00");
  const week = await myActivity(me, wid, TODAY, "UTC", "week");
  assert.equal(week.created.total, 1);
  assert.equal(week.edited.total, 1);
  // Unlocked, the journal and its day count again.
  await run("INSERT INTO journal_unlocks(page_id,user_id,until) VALUES(?,?,?)", journal, me.id, Date.now() + 60_000);
  const unlocked = await myActivity(me, wid, TODAY, "UTC", "week");
  assert.equal(unlocked.created.total, 3);
  assert.equal(unlocked.edited.total, 2);
  // The owner sees none of this person's work as their own.
  assert.equal((await myActivity(owner, wid, TODAY, "UTC", "week")).edited.total, 0);
});

test("the widget on the start page and its period, kept in its settings", async () => {
  await clean();
  const fresh = await account("mine-new");
  await run("INSERT INTO members VALUES(?,?,?)", wid, fresh.id, "editor");
  const ask = async (user: Identity, config: Record<string, unknown>) =>
    (await withContentLocale("en", async () => await homeData(user, { workspaceId: wid, today: TODAY, zone: "Europe/Berlin", widgets: [{ id: "mine", kind: "myActivity", config }] }))).widgets[0] as unknown as {
      ok: boolean;
      data: { period: string; created: { total: number; previous: number }; edited: { total: number }; buckets: string[] };
    };
  // A new account: zeros, which the widget shows as its empty state.
  const empty = await ask(fresh, {});
  assert.equal(empty.ok, true);
  assert.equal(empty.data.period, "week");
  assert.deepEqual([empty.data.created.total, empty.data.created.previous, empty.data.edited.total], [0, 0, 0]);
  assert.equal((await ask(fresh, { period: "year" })).data.buckets.length, 12);
  assert.equal((await ask(fresh, { period: "decade" })).ok, false);

  // The period chosen on the widget is saved with the layout, nothing else.
  const layout = S.defaultLayout();
  layout.widgets.push(S.makeWidget("myActivity", "mine"), S.makeWidget("notes", "note"));
  await command(fresh, { action: "home.save", workspaceId: wid, layout });
  await command(fresh, { action: "home.config", workspaceId: wid, widgetId: "mine", config: { period: "month" } });
  const saved = (await homeLayout(fresh, wid)).layout.widgets.find((w) => w.id === "mine");
  assert.deepEqual(saved?.config, { period: "month" });
  await assert.rejects(async () => await command(fresh, { action: "home.config", workspaceId: wid, widgetId: "mine", config: { period: "decade" } }));
  await assert.rejects(async () => await command(fresh, { action: "home.config", workspaceId: wid, widgetId: "mine", config: { title: "Hacked" } }));
  await assert.rejects(async () => await command(fresh, { action: "home.config", workspaceId: wid, widgetId: "note", config: { text: "x" } }));
  // The stored layout parses back with the period.
  assert.equal((S.parseLayout({ version: 1, widgets: [{ id: "m", kind: "myActivity", size: "m", config: { period: "year" } }] }).widgets[0].config as { period?: string }).period, "year");
});

// SQLite's query planner (Postgres decides by statistics).
test("schema 89: one person's rows are found by index, not by scanning", { skip: sqliteOnly }, async () => {
  for (const [table, where] of [
    ["pages", "created_by=? AND created_at>=? AND created_at<?"],
    ["snapshots", "created_by=? AND created_at>=? AND created_at<?"],
    ["audit", "actor_id=? AND created_at>=? AND created_at<?"],
    ["page_edits", "user_id=? AND at>=? AND at<?"],
  ]) {
    const plan = (await all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${where}`, "x", "a", "b")).map((r) => r.detail).join(" ");
    assert.match(plan, /USING INDEX (pages_creator|snapshots_author|audit_actor|page_edits_user)/, `${table}: ${plan}`);
  }
});
