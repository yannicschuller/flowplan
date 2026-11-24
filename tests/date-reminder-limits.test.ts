// Date reminders respect field read rules (#490) and stay cheap for
// repeating entries begun long ago (#492).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-reminder-limits-"));
const { one, all, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { processDateReminders, dateReminderRound, listDateReminders } = await import("../lib/date-reminders");
const { occurrenceDates } = await import("../lib/recurrence");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("limits-owner"),
  viewer = await account("limits-viewer");
const wid = await createWorkspace(owner.id, "Limits workspace");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = (await bootstrap(owner, wid)).spaces[0];
const newDatabase = async (title: string, fields: unknown[]) => {
  const page = (await command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title, kind: "database" })) as { id: string };
  await command(owner, {
    action: "database.update",
    pageId: page.id,
    version: (await database(page.id)).version,
    fields,
    views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  return page.id;
};
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const viewerReminders = async () =>
  await all<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='reminder'", viewer.id);

test("a date property hidden by a read rule cannot be reminded of, and reminders on it stay silent", async () => {
  const pid = await newDatabase("Geheime Termine", [
    { id: "title", name: "Name", type: "text" },
    { id: "open", name: "Offen", type: "date" },
    { id: "secret", name: "Geheimdatum", type: "date", access: { read: "editors" } },
  ]);
  const now = Date.now();
  const rowId = ((await command(owner, {
    action: "row.create",
    pageId: pid,
    cells: { title: "Rec", open: iso(now + 60000), secret: "2026-01-02T03:04:00Z" },
  })) as { id: string }).id;
  const set = (fieldId: string, offset: number | null, user = viewer) =>
    command(user, { action: "reminder.set", pageId: pid, rowId, fieldId, offset, timeZone: "UTC" });

  // Refused like a missing property: no hint about its value.
  await assert.rejects(set("secret", 0), (e: Error & { status?: number }) => e.status === 400 && /Datumseigenschaft fehlt/.test(e.message));
  await assert.rejects(set("secret", null), /Datumseigenschaft fehlt/);
  await assert.rejects(set("missing", 0), /Datumseigenschaft fehlt/);
  // Visible properties and the owner are unaffected.
  await set("open", 0);
  await set("secret", 0, owner);

  // A reminder set while the property was readable, then the rule narrowed:
  // it does not fire while hidden, and can still be removed by its owner.
  await run(
    "INSERT INTO date_reminders(user_id,page_id,row_id,field_id,offset_minutes,time_zone,armed_at) VALUES(?,?,?,?,?,?,?)",
    viewer.id, pid, rowId, "secret", 0, "UTC", now,
  );
  await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ title: "Rec", open: iso(now + 60000), secret: iso(now + 60000) }), rowId);
  await processDateReminders(now);
  await processDateReminders(now + 2 * 60000);
  const bodies = (await viewerReminders()).map((n) => n.body);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Offen/);
  assert.ok(!bodies.some((b) => /Geheimdatum/.test(b)));
  assert.equal((await all("SELECT 1 FROM notifications WHERE user_id=? AND body LIKE '%Geheimdatum%'", owner.id)).length, 1);
  assert.ok(await one("SELECT 1 FROM date_reminders WHERE user_id=? AND field_id='secret'", viewer.id));
  await set("secret", null);
  assert.deepEqual((await listDateReminders(viewer, pid)).map((r) => r.fieldId), ["open"]);
});

test("monthly and yearly series begun in year 0001 skip ahead to the window", () => {
  // Warm up (the first Temporal calls are slow); walking from 0001 took
  // ~300 ms before the skip-ahead.
  occurrenceDates("2026-01-31", { freq: "monthly", interval: 1 }, "2026-11-20", "2027-03-01");
  for (const freq of ["monthly", "yearly"] as const) {
    const started = performance.now();
    const dates = occurrenceDates("0001-01-31", { freq, interval: 1 }, "2026-11-20", "2027-03-01", 400, "UTC");
    assert.ok(performance.now() - started < 150, `${freq} took too long`);
    assert.deepEqual(
      dates,
      freq === "monthly" ? ["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"] : ["2027-01-31"],
    );
  }
  // Clamped month ends and the series' own day are kept after skipping.
  assert.deepEqual(
    occurrenceDates("1990-02-28", { freq: "monthly", interval: 3, day: 31 }, "2026-01-01", "2026-12-31"),
    ["2026-02-28", "2026-05-31", "2026-08-31", "2026-11-30"],
  );
  // count still ends the series.
  assert.deepEqual(occurrenceDates("0001-01-15", { freq: "monthly", interval: 1, count: 12 }, "2026-01-01", "2026-12-31"), []);
  assert.deepEqual(occurrenceDates("2026-01-15", { freq: "monthly", interval: 1, count: 3 }, "2026-01-01", "2026-12-31"), ["2026-02-15", "2026-03-15"]);
});

test("a round with reminders on ancient repeating records stays fast and does not overlap", async () => {
  const pid = await newDatabase("Uralt", [
    { id: "title", name: "Name", type: "text" },
    { id: "due", name: "Fällig", type: "date" },
  ]);
  for (let i = 0; i < 5; i++) {
    const rowId = ((await command(owner, { action: "row.create", pageId: pid, cells: { title: `Alt ${i}`, due: "0001-01-15" } })) as { id: string }).id;
    const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version;
    await command(owner, { action: "row.recurrence", pageId: pid, rowId, version, recurrence: { freq: i % 2 ? "yearly" : "monthly", interval: 1 } });
    await command(owner, { action: "reminder.set", pageId: pid, rowId, fieldId: "due", offset: 0, timeZone: "UTC" });
  }
  const now = Date.now();
  await processDateReminders(now);
  for (const at of [now, now + 9 * 86400000, now + 400 * 86400000]) {
    const started = performance.now();
    await processDateReminders(at);
    assert.ok(performance.now() - started < 500, `round took ${performance.now() - started} ms`);
  }
  // Two overlapping ticks: the second is left out.
  const [first, second] = await Promise.all([dateReminderRound(), dateReminderRound()]);
  assert.deepEqual([first, second], [true, false]);
  assert.equal(await dateReminderRound(), true);
});

test("a round out of time goes on where it stopped", async () => {
  const pid = await newDatabase("Budget", [
    { id: "title", name: "Name", type: "text" },
    { id: "due", name: "Fällig", type: "date" },
  ]);
  const now = Date.now();
  const rows: string[] = [];
  for (let i = 0; i < 3; i++) {
    const rowId = ((await command(owner, { action: "row.create", pageId: pid, cells: { title: `B${i}`, due: iso(now + 60000) } })) as { id: string }).id;
    await command(viewer, { action: "reminder.set", pageId: pid, rowId, fieldId: "due", offset: 0, timeZone: "UTC" });
    rows.push(rowId);
  }
  const before = (await viewerReminders()).length;
  // A budget of zero handles one reminder per round, each round the next one.
  let total = await processDateReminders(now + 2 * 60000, 0);
  assert.ok(total <= 1);
  for (let i = 0; i < 30; i++) total += await processDateReminders(now + 2 * 60000, 0);
  assert.equal(total, 3);
  assert.equal((await viewerReminders()).length - before, 3);
});
