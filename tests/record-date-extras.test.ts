// The recurrence and the repeating task below a record's first date (#521):
// the repeating task only where the database has a done rule (or the record
// already repeats); without a rule both count as empty properties, hidden
// with "Leere Eigenschaften ausblenden" until the empty ones are shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDateExtras } from "../lib/record-properties";
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
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: false, canRepeat }), { recurrence: false, repeat: false, hiddenEmpty: 1 });
  // "1 leere Eigenschaft anzeigen": the recurrence comes back; the repeating task does not apply.
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: true, canRepeat }), { recurrence: true, repeat: false, hiddenEmpty: 1 });
  // A rule set shows its row in any case.
  assert.deepEqual(recordDateExtras({ hasRecurrence: true, hasRepeat: true, hideEmpty: true, showEmpty: false, canRepeat }), { recurrence: true, repeat: true, hiddenEmpty: 0 });
});

test("a task database (status with a done option) offers the repeating task", () => {
  const fields: Field[] = [
    { id: "title", name: "Aufgabe", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    { id: "due", name: "Fällig", type: "date" },
  ];
  const canRepeat = !!doneRule(fields, undefined);
  assert.equal(canRepeat, true);
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: false, showEmpty: false, canRepeat }), { recurrence: true, repeat: true, hiddenEmpty: 0 });
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: false, canRepeat }), { recurrence: false, repeat: false, hiddenEmpty: 2 });
  assert.deepEqual(recordDateExtras({ ...none, hideEmpty: true, showEmpty: true, canRepeat }), { recurrence: true, repeat: true, hiddenEmpty: 2 });
});
