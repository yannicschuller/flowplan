// The recurrence and the repeating task below a record's first date (#521,
// design review): a row only once something is set; otherwise the date's
// own panel offers them and shows the row. The repeating task only where
// the database has a done rule (or the record already repeats). With
// "Leere Eigenschaften ausblenden" they count as empty properties and come
// back with them. And the labels of the reminder rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDateExtras, reminderRowLabel } from "../lib/record-properties";
import { doneRule } from "../lib/database-settings-schema";
import type { Field } from "../lib/types";

const none = { hasRecurrence: false, hasRepeat: false };

test("a documents database (empty ones hidden, no done rule) shows neither until the empty ones are shown", () => {
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "date", name: "Datum", type: "date" },
    { id: "tags", name: "Schlagwörter", type: "multiselect", options: ["Vertrag"] },
  ];
  const canRepeat = !!doneRule(fields, undefined);
  assert.equal(canRepeat, false);
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: false, canRepeat }), {
    recurrence: false,
    repeat: false,
    hiddenEmpty: 1,
    canAddRecurrence: true,
    canAddRepeat: false,
  });
  // "1 leere Eigenschaft anzeigen": the recurrence comes back; the repeating task does not apply.
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: true, canRepeat }), {
    recurrence: true,
    repeat: false,
    hiddenEmpty: 1,
    canAddRecurrence: false,
    canAddRepeat: false,
  });
  // A rule set shows its row in any case.
  assert.deepEqual(recordDateExtras({ hasRecurrence: true, hasRepeat: true, hideEmpty: true, showEmpty: false, canRepeat }), {
    recurrence: true,
    repeat: true,
    hiddenEmpty: 0,
    canAddRecurrence: false,
    canAddRepeat: false,
  });
});

test("a task database (status with a done option) offers both from the date, rows only once set", () => {
  const fields: Field[] = [
    { id: "title", name: "Aufgabe", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    { id: "due", name: "Fällig", type: "date" },
  ];
  const canRepeat = !!doneRule(fields, undefined);
  assert.equal(canRepeat, true);
  // Nothing set: no "Keine" / "Nein" rows, both offered in the date's panel.
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: false, showEmpty: false, canRepeat }), {
    recurrence: false,
    repeat: false,
    hiddenEmpty: 0,
    canAddRecurrence: true,
    canAddRepeat: true,
  });
  // Chosen there: the row shows (its controls open).
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: false, showEmpty: false, canRepeat, revealed: { repeat: true } }), {
    recurrence: false,
    repeat: true,
    hiddenEmpty: 0,
    canAddRecurrence: true,
    canAddRepeat: false,
  });
  assert.deepEqual(recordDateExtras({ ...none, hasRepeat: true, hideEmpty: false, showEmpty: false, canRepeat }).repeat, true);
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: false, canRepeat }), {
    recurrence: false,
    repeat: false,
    hiddenEmpty: 2,
    canAddRecurrence: true,
    canAddRepeat: true,
  });
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: true, canRepeat }), {
    recurrence: true,
    repeat: true,
    hiddenEmpty: 2,
    canAddRecurrence: false,
    canAddRepeat: false,
  });
});

test("reminder rows: the date's name only when there are several", () => {
  assert.equal(reminderRowLabel("Erinnerung", "Fällig", 1), "Erinnerung");
  assert.equal(reminderRowLabel("Erinnerung", "Fällig", 2), "Erinnerung (Fällig)");
  assert.equal(reminderRowLabel("Reminder", "Start", 3), "Reminder (Start)");
});
