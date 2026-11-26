// The board of My tasks (#564, lib/board-due.ts): the date a card gets when
// it is moved to another column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnOf, dropDue, shiftDay, DROP_TARGETS } from "../lib/board-due";
import { groupByDue } from "../lib/due-groups";

const today = "2026-11-26";

test("each column's date", () => {
  assert.equal(dropDue("Heute", "2026-11-20", today), today);
  assert.equal(dropDue("Heute", null, today), today);
  // "Nächste 7 Tage": tomorrow.
  assert.equal(dropDue("Nächste 7 Tage", null, today), "2026-11-27");
  assert.equal(dropDue("Nächste 7 Tage", today, today), "2026-11-27");
  assert.equal(dropDue("Nächste 7 Tage", "2027-01-15", today), "2026-11-27");
  // "Später": the first day after the next 7 days.
  assert.equal(dropDue("Später", today, today), "2026-12-04");
  assert.equal(dropDue("Später", null, today), "2026-12-04");
  assert.equal(dropDue("Ohne Datum", "2026-11-20", today), null);
});

test("the same column, Überfällig and Erledigt change nothing", () => {
  assert.equal(dropDue("Nächste 7 Tage", "2026-11-30", today), undefined, "already within the next 7 days: kept");
  assert.equal(dropDue("Später", "2027-03-01", today), undefined, "already later: kept");
  assert.equal(dropDue("Heute", today, today), undefined);
  assert.equal(dropDue("Ohne Datum", null, today), undefined);
  assert.equal(dropDue("Überfällig", today, today), undefined);
  assert.equal(dropDue("Erledigt", today, today), undefined);
  assert.equal(dropDue("Unbekannt", today, today), undefined);
  assert.deepEqual(DROP_TARGETS, ["Heute", "Nächste 7 Tage", "Später", "Ohne Datum"]);
});

test("a dropped card lands in the column it was dropped on, as the list groups it", () => {
  for (const due of [null, "2026-11-01", today, "2026-11-29", "2027-05-01"])
    for (const column of DROP_TARGETS) {
      const next = dropDue(column, due, today);
      const after = next === undefined ? due : next;
      assert.equal(columnOf(after, today), column, `${due} → ${column}`);
      // The same grouping as the list's (lib/due-groups.ts).
      assert.equal(groupByDue([{ checked: false, due: after }], today)[0][0], column);
    }
});

test("days across months and years", () => {
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2028-02-28", 1), "2028-02-29");
  assert.equal(dropDue("Später", null, "2026-12-28"), "2027-01-05");
});
