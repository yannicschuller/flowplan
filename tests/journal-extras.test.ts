import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-extras-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal } = await import("../lib/journal");
const {
  journalReview,
  parseIcs,
  icsEventsOn,
  databaseEvents,
  journalDayDetails,
} = await import("../lib/journal-extras");
const { searchWorkspace } = await import("../lib/search-index");
const { currentStreak, longestStreak, onThisDay } = await import("../components/journal-view");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Mia", "mia@example.test");
const user = {
  id: uid,
  name: "Mia",
  email: "mia@example.test",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
} as Identity;
const wid = await createWorkspace(user.id, "Journal-Extras");
const space = (await bootstrap(user, wid)).spaces[0].id;
const journalId = (
  (await command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" })) as { id: string }
).id;
const journal = async () => (await one<Page>("SELECT * FROM pages WHERE id=?", journalId))!;
const roll = async (day: string) => await rollJournal(user, await journal(), day, day);
const html = async (pageId: string) =>
  String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
const write = async (pageId: string, body: string) =>
  await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const settings = async (body: Record<string, unknown>) =>
  (await command(user, { action: "journal.settings", pageId: journalId, ...body })) as {
    template: string;
    trackers: { id: string; name: string; kind: string }[];
  };

test("new days start with the template; template tasks are not carried twice", async () => {
  const saved = await settings({
    template:
      '<h3>Dankbar für</h3><p></p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Meditieren</p></li></ul><script>alert(1)</script>',
  });
  assert.match(saved.template, /Dankbar für/);
  assert.doesNotMatch(saved.template, /script/);
  // Tasks in the template always start open.
  assert.match(saved.template, /data-checked="false"/);
  const first = (await roll("2026-10-01")).dayId;
  assert.match(await html(first), /Dankbar für/);
  assert.match(await html(first), /Meditieren/);
  await write(
    first,
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Steuer</p></li></ul><h3>Dankbar für</h3><p>Sonne</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Meditieren</p></li></ul>`,
  );
  const second = (await roll("2026-10-02")).dayId;
  const text = await html(second);
  assert.equal(text.match(/Meditieren/g)?.length, 1, "template task only once");
  assert.match(text, /Steuer/);
  assert.match(text, /data-journal-since="2026-10-01"/);
  // The open template task stays on the first day, the carried one left.
  assert.match(await html(first), /Meditieren/);
  assert.doesNotMatch(await html(first), /Steuer/);
});

test("a day that only holds the template is removed like an empty one", async () => {
  const before = await roll("2026-10-03");
  assert.equal(await one("SELECT id FROM pages WHERE journal_date='2026-10-02' AND parent_id=?", journalId), undefined);
  assert.match(await html(before.dayId), /Steuer/);
});

test("trackers and place are stored per day and count as an entry", async () => {
  await settings({
    trackers: [
      { id: "mood", name: "Stimmung", kind: "mood" },
      { id: "sleep", name: "Schlaf", kind: "number", unit: "h" },
      { id: "sport", name: "Sport", kind: "check" },
    ],
  });
  const day = (await one<Page>("SELECT * FROM pages WHERE journal_date='2026-10-03' AND parent_id=?", journalId))!;
  await command(user, {
    action: "journal.entry",
    pageId: day.id,
    entry: { values: { mood: 4, sleep: 7.5, sport: true }, place: "Hamburg", lat: 53.55, lon: 9.99 },
  });
  await assert.rejects(
    async () => await command(user, { action: "journal.entry", pageId: day.id, entry: { values: { mood: 9 } } }),
    /1 bis 5/,
  );
  await assert.rejects(
    async () => await command(user, { action: "journal.entry", pageId: day.id, entry: { values: { nope: 1 } } }),
    /Unbekannter Tracker/,
  );
  await assert.rejects(
    async () => await command(user, { action: "journal.entry", pageId: day.id, entry: { lat: 1, lon: null } }),
    /gehören zusammen/,
  );
  const data = (await pageData(user, day.id)) as { journalDay: { entry: { values: Record<string, unknown>; place: string } } };
  assert.deepEqual(data.journalDay.entry.values, { mood: 4, sleep: 7.5, sport: true });
  assert.equal(data.journalDay.entry.place, "Hamburg");
  // Only the tracker values were set: the day still stays.
  await roll("2026-10-04");
  assert.ok(await one("SELECT id FROM pages WHERE id=?", day.id));
  const details = (await journalDayDetails(journalId)).find((d) => d.id === day.id)!;
  assert.equal(details.place, "Hamburg");
  assert.equal(details.values.mood, 4);
});

test("a review sums up done tasks, words, trackers and places", async () => {
  const first = (await one<Page>("SELECT * FROM pages WHERE journal_date='2026-10-01' AND parent_id=?", journalId))!;
  await write(
    first.id,
    `<p>Ein langer Tag am Meer</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Koffer packen</p></li></ul><img src="/api/files/11111111-1111-4111-8111-111111111111">`,
  );
  const review = await journalReview(await journal(), "2026-09-28", "2026-10-04");
  assert.deepEqual(review.done.map((t) => t.text), ["Koffer packen"]);
  assert.ok(review.words >= 6);
  assert.equal(review.images.length, 1);
  assert.deepEqual(review.places, ["Hamburg"]);
  const mood = review.trackers.find((t) => t.id === "mood")!;
  assert.equal(mood.average, 4);
  await assert.rejects(async () => await journalReview(await journal(), "2026-01-01", "2026-12-31"), /drei Monate/);
});

test("a PIN hides the journal from pages, search and previews until entered", async () => {
  const day = (await one<Page>("SELECT * FROM pages WHERE journal_date='2026-10-01' AND parent_id=?", journalId))!;
  // New PINs have six to eight digits.
  await assert.rejects(async () => await command(user, { action: "journal.lock", pageId: journalId, pin: "4711" }), /6 bis 8 Ziffern/);
  await command(user, { action: "journal.lock", pageId: journalId, pin: "471108" });
  // Setting the PIN unlocks for the person who set it; lock again.
  await command(user, { action: "journal.relock", pageId: journalId });
  const locked = (await pageData(user, day.id)) as { locked?: unknown; html: string };
  assert.ok(locked.locked);
  assert.equal(locked.html, "");
  assert.equal(
    (await searchWorkspace(user, wid, "Meer")).some((r) => (r as { id: string }).id === day.id),
    false,
  );
  await assert.rejects(
    async () => await command(user, { action: "journal.entry", pageId: day.id, entry: { place: "x" } }),
    /gesperrt/,
  );
  await assert.rejects(async () => await command(user, { action: "journal.unlock", pageId: journalId, pin: "000000" }), /stimmt nicht/);
  await command(user, { action: "journal.unlock", pageId: journalId, pin: "471108" });
  assert.match(((await pageData(user, day.id)) as { html: string }).html, /Meer/);
  // Changing or removing needs the old PIN.
  await assert.rejects(async () => await command(user, { action: "journal.lock", pageId: journalId, pin: null, current: "1" }), /bisherige PIN/);
  await command(user, { action: "journal.lock", pageId: journalId, pin: null, current: "471108" });
  await command(user, { action: "journal.relock", pageId: journalId });
  assert.equal(((await pageData(user, day.id)) as { locked?: unknown }).locked, undefined);
});

test("wrong PINs are limited in the database, per day as well, and the owner hears about another person's attempts", async () => {
  const { unlockJournal } = await import("../lib/journal-extras");
  const otherId = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", otherId, otherId, "Ben", "ben@example.test");
  await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,'editor')", wid, otherId);
  const other = { ...user, id: otherId, name: "Ben", email: "ben@example.test" } as Identity;
  await command(user, { action: "journal.lock", pageId: journalId, pin: "246810" });
  const now = Date.now();
  // Five wrong guesses, then a pause – counted in login_failures, so a
  // restart (a fresh module) would not reset them.
  for (let i = 0; i < 5; i++) await assert.rejects(async () => await unlockJournal(other, await journal(), "111111", now + i), /stimmt nicht/);
  await assert.rejects(async () => await unlockJournal(other, await journal(), "246810", now + 10), /Zu viele Versuche\. Warte/);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=?", `pin:${otherId}:${journalId}`))?.n, 5);
  // The owner is told once per burst, in their inbox.
  const notices = async () =>
    (await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND page_id=? AND kind='security'", user.id, journalId))?.n || 0;
  assert.equal(await notices(), 1);
  // After each pause: five more, then the next pause; twenty in a day end it.
  for (let round = 1; round < 4; round++) {
    const at = now + round * 6 * 60_000;
    for (let i = 0; i < 5; i++) await assert.rejects(async () => await unlockJournal(other, await journal(), "111111", at + i), /stimmt nicht/);
  }
  await assert.rejects(async () => await unlockJournal(other, await journal(), "246810", now + 4 * 6 * 60_000), /für heute/);
  assert.equal(await notices(), 4);
  // The day after, the right PIN works again and clears the count.
  await unlockJournal(other, await journal(), "246810", now + 86_400_000 + 20 * 60_000);
  assert.equal(await one("SELECT 1 FROM login_failures WHERE key=?", `pin:${otherId}:${journalId}`), undefined);
  // The owner's own typos stay quiet.
  await assert.rejects(async () => await unlockJournal(user, await journal(), "000000", now), /stimmt nicht/);
  assert.equal(await notices(), 4);
  await command(user, { action: "journal.lock", pageId: journalId, pin: null, current: "246810" });
});

test("appointments of the day come from databases and ICS calendars", async () => {
  const db = (
    (await command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Termine", kind: "database" })) as { id: string }
  ).id;
  await run(
    "UPDATE databases SET fields=?,views=? WHERE page_id=?",
    JSON.stringify([
      { id: "t", name: "Titel", type: "text" },
      { id: "d", name: "Datum", type: "date" },
    ]),
    JSON.stringify([{ id: "v", name: "Kalender", type: "calendar", dateField: "d" }]),
    db,
  );
  const row = async (cells: Record<string, unknown>, recurrence?: unknown) =>
    await run(
      "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,recurrence) VALUES(?,?,?,?,?,?,?)",
      id(),
      db,
      JSON.stringify(cells),
      0,
      uid,
      uid,
      recurrence ? JSON.stringify(recurrence) : "",
    );
  await row({ t: "Zahnarzt", d: "2026-10-05T09:30" });
  await row({ t: "Anderer Tag", d: "2026-10-06" });
  await row({ t: "Yoga", d: "2026-09-07" }, { freq: "weekly", interval: 1 });
  const events = await databaseEvents(user, wid, "2026-10-05", "Europe/Berlin");
  assert.deepEqual(events.map((e) => e.title).sort(), ["Yoga", "Zahnarzt"]);

  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART;TZID=Europe/Berlin:20261005T140000",
    "DTEND;TZID=Europe/Berlin:20261005T150000",
    "SUMMARY:Team\\, Sync",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20261001",
    "DTEND;VALUE=DATE:20261002",
    "RRULE:FREQ=WEEKLY;INTERVAL=1",
    "EXDATE;VALUE=DATE:20261015",
    "SUMMARY:Sport",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const parsed = parseIcs(ics, "Europe/Berlin");
  assert.deepEqual(icsEventsOn(parsed, "2026-10-05", "Europe/Berlin").map((e) => e.title), ["Team, Sync"]);
  assert.deepEqual(icsEventsOn(parsed, "2026-10-08", "Europe/Berlin").map((e) => e.title), ["Sport"]);
  assert.deepEqual(icsEventsOn(parsed, "2026-10-15", "Europe/Berlin"), []);
});

test("streaks and memories are computed from the days", () => {
  const dates = new Set(["2026-10-01", "2026-10-02", "2026-10-03", "2026-09-20"]);
  assert.equal(currentStreak(dates, "2026-10-04"), 3, "today may still be open");
  assert.equal(currentStreak(dates, "2026-10-05"), 0);
  assert.equal(longestStreak([...dates]), 3);
  const day = (date: string) => ({ id: date, title: date, journal_date: date, updated_at: "" });
  const found = onThisDay([day("2025-10-04"), day("2026-09-04"), day("2026-09-27"), day("2026-09-28")], "2026-10-04");
  assert.deepEqual(found.map((f) => f.label), ["Vor einer Woche", "Vor einem Monat", "Vor einem Jahr"]);
});
