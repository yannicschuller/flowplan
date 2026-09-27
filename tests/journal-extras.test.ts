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
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Mia", "mia@example.test");
const user = {
  id: uid,
  name: "Mia",
  email: "mia@example.test",
  groups: [],
  isAdmin: false,
  disabled: 0,
  created_at: "",
} as Identity;
const wid = createWorkspace(user.id, "Journal-Extras");
const space = bootstrap(user, wid).spaces[0].id;
const journalId = (
  command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Tagebuch", kind: "journal" }) as { id: string }
).id;
const journal = () => one<Page>("SELECT * FROM pages WHERE id=?", journalId)!;
const roll = (day: string) => rollJournal(user, journal(), day, day);
const html = (pageId: string) =>
  String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html);
const write = (pageId: string, body: string) =>
  run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const settings = (body: Record<string, unknown>) =>
  command(user, { action: "journal.settings", pageId: journalId, ...body }) as {
    template: string;
    trackers: { id: string; name: string; kind: string }[];
  };

test("new days start with the template; template tasks are not carried twice", () => {
  const saved = settings({
    template:
      '<h3>Dankbar für</h3><p></p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Meditieren</p></li></ul><script>alert(1)</script>',
  });
  assert.match(saved.template, /Dankbar für/);
  assert.doesNotMatch(saved.template, /script/);
  // Tasks in the template always start open.
  assert.match(saved.template, /data-checked="false"/);
  const first = roll("2026-10-01").dayId;
  assert.match(html(first), /Dankbar für/);
  assert.match(html(first), /Meditieren/);
  write(
    first,
    `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Steuer</p></li></ul><h3>Dankbar für</h3><p>Sonne</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Meditieren</p></li></ul>`,
  );
  const second = roll("2026-10-02").dayId;
  const text = html(second);
  assert.equal(text.match(/Meditieren/g)?.length, 1, "template task only once");
  assert.match(text, /Steuer/);
  assert.match(text, /data-journal-since="2026-10-01"/);
  // The open template task stays on the first day, the carried one left.
  assert.match(html(first), /Meditieren/);
  assert.doesNotMatch(html(first), /Steuer/);
});

test("a day that only holds the template is removed like an empty one", () => {
  const before = roll("2026-10-03");
  assert.equal(one("SELECT id FROM pages WHERE journal_date='2026-10-02' AND parent_id=?", journalId), undefined);
  assert.match(html(before.dayId), /Steuer/);
});

test("trackers and place are stored per day and count as an entry", () => {
  settings({
    trackers: [
      { id: "mood", name: "Stimmung", kind: "mood" },
      { id: "sleep", name: "Schlaf", kind: "number", unit: "h" },
      { id: "sport", name: "Sport", kind: "check" },
    ],
  });
  const day = one<Page>("SELECT * FROM pages WHERE journal_date='2026-10-03' AND parent_id=?", journalId)!;
  command(user, {
    action: "journal.entry",
    pageId: day.id,
    entry: { values: { mood: 4, sleep: 7.5, sport: true }, place: "Hamburg", lat: 53.55, lon: 9.99 },
  });
  assert.throws(
    () => command(user, { action: "journal.entry", pageId: day.id, entry: { values: { mood: 9 } } }),
    /1 bis 5/,
  );
  assert.throws(
    () => command(user, { action: "journal.entry", pageId: day.id, entry: { values: { nope: 1 } } }),
    /Unbekannter Tracker/,
  );
  assert.throws(
    () => command(user, { action: "journal.entry", pageId: day.id, entry: { lat: 1, lon: null } }),
    /gehören zusammen/,
  );
  const data = pageData(user, day.id) as { journalDay: { entry: { values: Record<string, unknown>; place: string } } };
  assert.deepEqual(data.journalDay.entry.values, { mood: 4, sleep: 7.5, sport: true });
  assert.equal(data.journalDay.entry.place, "Hamburg");
  // Only the tracker values were set: the day still stays.
  roll("2026-10-04");
  assert.ok(one("SELECT id FROM pages WHERE id=?", day.id));
  const details = journalDayDetails(journalId).find((d) => d.id === day.id)!;
  assert.equal(details.place, "Hamburg");
  assert.equal(details.values.mood, 4);
});

test("a review sums up done tasks, words, trackers and places", () => {
  const first = one<Page>("SELECT * FROM pages WHERE journal_date='2026-10-01' AND parent_id=?", journalId)!;
  write(
    first.id,
    `<p>Ein langer Tag am Meer</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Koffer packen</p></li></ul><img src="/api/files/11111111-1111-4111-8111-111111111111">`,
  );
  const review = journalReview(journal(), "2026-09-28", "2026-10-04");
  assert.deepEqual(review.done.map((t) => t.text), ["Koffer packen"]);
  assert.ok(review.words >= 6);
  assert.equal(review.images.length, 1);
  assert.deepEqual(review.places, ["Hamburg"]);
  const mood = review.trackers.find((t) => t.id === "mood")!;
  assert.equal(mood.average, 4);
  assert.throws(() => journalReview(journal(), "2026-01-01", "2026-12-31"), /drei Monate/);
});

test("a PIN hides the journal from pages, search and previews until entered", () => {
  const day = one<Page>("SELECT * FROM pages WHERE journal_date='2026-10-01' AND parent_id=?", journalId)!;
  command(user, { action: "journal.lock", pageId: journalId, pin: "4711" });
  // Setting the PIN unlocks for the person who set it; lock again.
  command(user, { action: "journal.relock", pageId: journalId });
  const locked = pageData(user, day.id) as { locked?: unknown; html: string };
  assert.ok(locked.locked);
  assert.equal(locked.html, "");
  assert.equal(
    searchWorkspace(user, wid, "Meer").some((r) => (r as { id: string }).id === day.id),
    false,
  );
  assert.throws(
    () => command(user, { action: "journal.entry", pageId: day.id, entry: { place: "x" } }),
    /gesperrt/,
  );
  assert.throws(() => command(user, { action: "journal.unlock", pageId: journalId, pin: "0000" }), /stimmt nicht/);
  command(user, { action: "journal.unlock", pageId: journalId, pin: "4711" });
  assert.match((pageData(user, day.id) as { html: string }).html, /Meer/);
  // Changing or removing needs the old PIN.
  assert.throws(() => command(user, { action: "journal.lock", pageId: journalId, pin: null, current: "1" }), /bisherige PIN/);
  command(user, { action: "journal.lock", pageId: journalId, pin: null, current: "4711" });
  command(user, { action: "journal.relock", pageId: journalId });
  assert.equal((pageData(user, day.id) as { locked?: unknown }).locked, undefined);
});

test("appointments of the day come from databases and ICS calendars", () => {
  const db = (
    command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "Termine", kind: "database" }) as { id: string }
  ).id;
  run(
    "UPDATE databases SET fields=?,views=? WHERE page_id=?",
    JSON.stringify([
      { id: "t", name: "Titel", type: "text" },
      { id: "d", name: "Datum", type: "date" },
    ]),
    JSON.stringify([{ id: "v", name: "Kalender", type: "calendar", dateField: "d" }]),
    db,
  );
  const row = (cells: Record<string, unknown>, recurrence?: unknown) =>
    run(
      "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,recurrence) VALUES(?,?,?,?,?,?,?)",
      id(),
      db,
      JSON.stringify(cells),
      0,
      uid,
      uid,
      recurrence ? JSON.stringify(recurrence) : "",
    );
  row({ t: "Zahnarzt", d: "2026-10-05T09:30" });
  row({ t: "Anderer Tag", d: "2026-10-06" });
  row({ t: "Yoga", d: "2026-09-07" }, { freq: "weekly", interval: 1 });
  const events = databaseEvents(user, wid, "2026-10-05", "Europe/Berlin");
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
