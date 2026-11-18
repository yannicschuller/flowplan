// The study day (docs/specs/flashcards.md §4.5): it starts at 04:00 in the
// person's zone – across clock changes, half-hour offsets, a skipped day –
// and does not depend on the server's TZ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, studyClock, studyDay, studyDayStart, studyZone, virtualDay, virtualTime } from "../lib/study-day";

const at = (iso: string) => Date.parse(iso);
const local = (ms: number, zone: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

test("04:00 local is the cut, in Berlin and in Kolkata (+5:30)", () => {
  assert.equal(studyDay(at("2026-11-18T02:59:00Z"), "Europe/Berlin"), "2026-11-17"); // 03:59
  assert.equal(studyDay(at("2026-11-18T03:00:00Z"), "Europe/Berlin"), "2026-11-18"); // 04:00
  assert.equal(studyDay(at("2026-11-17T22:29:00Z"), "Asia/Kolkata"), "2026-11-17"); // 03:59
  assert.equal(studyDay(at("2026-11-17T22:30:00Z"), "Asia/Kolkata"), "2026-11-18"); // 04:00
  assert.equal(local(studyDayStart("2026-11-18", "Asia/Kolkata"), "Asia/Kolkata"), "2026-11-18 04:00");
  // Another hour for the day change.
  assert.equal(studyDay(at("2026-11-18T05:00:00Z"), "UTC", 6), "2026-11-17");
});

test("clock changes: a day of 23 and of 25 hours", () => {
  for (const [zone, spring, autumn] of [
    ["Europe/Berlin", "2026-03-29", "2026-10-25"],
    ["America/New_York", "2026-03-08", "2026-11-01"],
  ] as const) {
    const short = studyClock(studyDayStart(spring, zone), zone);
    assert.equal(short.day, spring);
    assert.equal((short.end - short.start) / 3_600_000, 24, `${zone}: 04:00 to 04:00 after the change at 02:00`);
    // The day before the change holds the lost hour.
    const before = studyClock(studyDayStart(addDays(spring, -1), zone), zone);
    assert.equal((before.end - before.start) / 3_600_000, 23, zone);
    const long = studyClock(studyDayStart(addDays(autumn, -1), zone), zone);
    assert.equal((long.end - long.start) / 3_600_000, 25, zone);
    for (const day of [spring, autumn]) assert.equal(local(studyDayStart(day, zone), zone), `${day} 04:00`);
    // Every instant of a day belongs to it.
    for (let t = before.start; t < short.end; t += 15 * 60_000) assert.equal(studyDay(t, zone), t < before.end ? before.day : short.day);
  }
});

test("Lord Howe (half-hour change) and Apia (a skipped day)", () => {
  // Lord Howe moves by 30 minutes at 02:00 – the day start stays 04:00.
  const zone = "Australia/Lord_Howe";
  assert.equal(local(studyDayStart("2026-10-04", zone), zone), "2026-10-04 04:00");
  const day = studyClock(studyDayStart("2026-10-03", zone), zone);
  assert.equal((day.end - day.start) / 60_000, 24 * 60 - 30);
  // Samoa skipped 30 December 2011: the day before runs into the 31st.
  const apia = studyClock(at("2011-12-29T22:00:00Z"), "Pacific/Apia");
  assert.equal(apia.day, "2011-12-29");
  assert.equal(studyDay(apia.end, "Pacific/Apia"), "2011-12-31");
  assert.equal((apia.end - apia.start) / 3_600_000, 24);
});

test("the server's own zone does not matter", () => {
  const before = process.env.TZ;
  const values = () => [studyDay(at("2026-03-29T01:30:00Z"), "Europe/Berlin"), studyDayStart("2026-03-29", "America/New_York"), virtualTime(at("2026-03-29T12:00:00Z"), "Asia/Kolkata")];
  const utc = values();
  process.env.TZ = "Pacific/Kiritimati";
  try {
    assert.deepEqual(values(), utc);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test("a person who changes the zone; invalid zones fall back", () => {
  const t = at("2026-11-18T01:00:00Z");
  assert.equal(studyDay(t, "Europe/Berlin"), "2026-11-17");
  assert.equal(studyDay(t, "Asia/Tokyo"), "2026-11-18");
  assert.equal(studyZone("Mars/Base", "Europe/Berlin"), "Europe/Berlin");
  assert.equal(studyZone("", null), "UTC");
  assert.equal(studyZone("+02:00"), "UTC");
});

test("the virtual clock counts study days as UTC days", () => {
  const zone = "America/New_York";
  const a = virtualTime(at("2026-03-07T12:00:00Z"), zone);
  const b = virtualTime(at("2026-03-09T12:00:00Z"), zone);
  assert.equal(virtualDay(a), "2026-03-07");
  assert.equal(virtualDay(b), "2026-03-09");
  assert.equal(daysBetween(virtualDay(a), virtualDay(b)), 2);
  // 02:00 local is still the previous study day.
  assert.equal(virtualDay(virtualTime(at("2026-03-09T06:00:00Z"), zone)), "2026-03-08");
});
