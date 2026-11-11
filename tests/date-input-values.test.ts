import { test } from "node:test";
import assert from "node:assert/strict";
import { dateToSave, draftDateValue, fieldValue, InvalidDateDraft, localValue } from "../lib/date-values";

const zone = "Europe/Berlin";

test("an empty date draft removes the date instead of being ignored", () => {
  assert.equal(draftDateValue("", false, "reject", "2026-11-03", zone), "");
  assert.equal(draftDateValue("", true, "reject", "2026-11-03T08:00:00Z", zone), "");
  // Removing a stored date saves "", the server's empty value.
  assert.equal(dateToSave("", "2026-11-03"), "");
  assert.equal(dateToSave("", "2026-11-03T08:00:00Z"), "");
  // An empty field stays as it is (no save on blur).
  assert.equal(dateToSave("", ""), null);
  assert.equal(dateToSave("", undefined), null);
  assert.equal(dateToSave("", null), null);
});

test("date drafts become stored values", () => {
  assert.equal(draftDateValue("2026-11-03", false, "reject", "", zone), "2026-11-03");
  assert.equal(dateToSave("2026-11-03", "2026-11-03"), null);
  assert.equal(dateToSave("2026-11-04", "2026-11-03"), "2026-11-04");
  assert.equal(dateToSave("2026-11-04", undefined), "2026-11-04");
  assert.throws(() => draftDateValue("2026-02-30", false, "reject", "", zone), InvalidDateDraft);
  assert.throws(() => draftDateValue("2026-11-03T09:00", false, "reject", "", zone), InvalidDateDraft);
  // A time in the field's zone becomes an instant.
  assert.equal(draftDateValue("2026-11-03T09:00", true, "reject", "", zone), "2026-11-03T08:00:00Z");
  // An unchanged local time keeps the stored instant (and saves nothing).
  // 02:30 CEST, the first of the two 02:30 of that night.
  const stored = "2026-10-25T00:30:00Z";
  const local = localValue(stored, zone);
  assert.equal(local, "2026-10-25T02:30:00.000");
  assert.equal(draftDateValue(local, true, "reject", stored, zone), stored);
  assert.equal(dateToSave(draftDateValue(local, true, "reject", stored, zone), stored), null);
  // The repeated hour of the clock change needs a choice.
  assert.throws(() => draftDateValue("2026-10-25T02:30", true, "reject", "", zone));
  assert.equal(draftDateValue("2026-10-25T02:30", true, "later", "", zone), "2026-10-25T01:30:00Z");
});

test("the date field shows whole minutes without seconds", () => {
  // "08:30", not "08:30:00.000": seconds only when there are some.
  assert.equal(fieldValue("2026-11-10T07:30:00Z", zone), "2026-11-10T08:30");
  assert.equal(fieldValue("2026-11-10T07:30:15Z", zone), "2026-11-10T08:30:15.000");
  assert.equal(fieldValue("2026-11-10T07:30:00.250Z", zone), "2026-11-10T08:30:00.250");
  assert.equal(fieldValue("2026-11-10", zone), "2026-11-10");
  assert.equal(fieldValue("", zone), "");
  // Unchanged, the shorter form still keeps the stored instant – also in the
  // repeated hour of the clock change.
  const stored = "2026-10-25T00:30:00Z";
  assert.equal(fieldValue(stored, zone), "2026-10-25T02:30");
  assert.equal(draftDateValue(fieldValue(stored, zone), true, "reject", stored, zone), stored);
  assert.equal(dateToSave(draftDateValue(fieldValue(stored, zone), true, "reject", stored, zone), stored), null);
});
