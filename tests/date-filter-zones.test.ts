// Absolute date conditions (is, before, after, between) read timestamps as
// the day they fall on in the condition's time zone (#176).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conditionTimeZone,
  filterSchema,
  matches,
  matchesFilterGroup,
} from "../lib/database-filters";
import { filterCellDay } from "../lib/relative-dates";
import { queryRows } from "../lib/database";
import type { Field, Filter, FilterGroup, Identity, View } from "../lib/types";

const LA = "America/Los_Angeles";
const created: Field = { id: "c", name: "Created", type: "created_at" },
  edited: Field = { id: "e", name: "Edited", type: "updated_at" },
  due: Field = { id: "d", name: "Due", type: "date" };
// 6:00 pm Pacific on Nov 6, as SQLite stores it (UTC, no zone).
const evening = "2026-11-07 02:00:00";
const is = (cells: Record<string, unknown>, field: Field, f: Partial<Filter>) =>
  matches(cells, { field: field.id, op: "eq", value: "", ...f } as Filter, field);

test("the issue's cases: a 6 pm Pacific record belongs to Nov 6 in the condition's zone", () => {
  const cells = { c: evening };
  const zoned = (f: Partial<Filter>) => is(cells, created, { timeZone: LA, ...f });
  assert.equal(zoned({ value: "2026-11-06" }), true);
  assert.equal(zoned({ value: "2026-11-07" }), false);
  assert.equal(zoned({ op: "neq", value: "2026-11-06" }), false);
  assert.equal(zoned({ op: "neq", value: "2026-11-07" }), true);
  assert.equal(zoned({ op: "before", value: "2026-11-07" }), true);
  assert.equal(zoned({ op: "on_or_before", value: "2026-11-06" }), true);
  assert.equal(zoned({ op: "after", value: "2026-11-06" }), false);
  assert.equal(zoned({ op: "on_or_after", value: "2026-11-07" }), false);
  assert.equal(zoned({ op: "on_or_after", value: "2026-11-06" }), true);
  assert.equal(zoned({ op: "between", value: "2026-11-01", to: "2026-11-06" }), true);
  assert.equal(zoned({ op: "between", value: "2026-11-07", to: "2026-11-30" }), false);
  // ISO instants count the same as the stored SQL text.
  assert.equal(is({ c: "2026-11-07T02:00:00Z" }, created, { timeZone: LA, value: "2026-11-06" }), true);
});

test("between across a month end keeps the last evening and drops the evening before the 1st", () => {
  const october = { op: "between" as const, value: "2026-10-01", to: "2026-10-31", timeZone: LA };
  // Oct 31, 8 pm Pacific (PDT, UTC-7) = Nov 1, 03:00 UTC.
  assert.equal(is({ c: "2026-11-01 03:00:00" }, created, october), true);
  // Sep 30, 8 pm Pacific = Oct 1, 03:00 UTC: September, not October.
  assert.equal(is({ c: "2026-10-01 03:00:00" }, created, october), false);
  // Reversed bounds still work.
  assert.equal(is({ c: "2026-11-01 03:00:00" }, created, { ...october, value: "2026-10-31", to: "2026-10-01" }), true);
});

test("Edited time and Date properties with a time use the zone; date-only values stay calendar days", () => {
  assert.equal(is({ e: evening }, edited, { timeZone: LA, value: "2026-11-06" }), true);
  assert.equal(is({ e: evening }, edited, { timeZone: LA, value: "2026-11-07" }), false);
  assert.equal(is({ d: "2026-11-07T02:00:00Z" }, due, { timeZone: LA, value: "2026-11-06" }), true);
  assert.equal(is({ d: "2026-11-07T03:00:00+01:00" }, due, { timeZone: LA, value: "2026-11-06" }), true);
  assert.equal(is({ d: "2026-11-07T02:00:00Z" }, due, { timeZone: LA, op: "before", value: "2026-11-07" }), true);
  // Date-only: unchanged whatever the zone (east or west of UTC).
  for (const timeZone of [LA, "Pacific/Kiritimati", "UTC", undefined]) {
    assert.equal(is({ d: "2026-11-07" }, due, { timeZone, value: "2026-11-07" }), true);
    assert.equal(is({ d: "2026-11-07" }, due, { timeZone, value: "2026-11-06" }), false);
    assert.equal(is({ d: "2026-11-07" }, due, { timeZone, op: "between", value: "2026-11-07", to: "2026-11-07" }), true);
    assert.equal(is({ d: "2026-11-07" }, due, { timeZone, op: "after", value: "2026-11-06" }), true);
  }
});

test("conditions saved without a zone keep comparing the UTC day", () => {
  const cells = { c: evening };
  assert.equal(is(cells, created, { value: "2026-11-07" }), true);
  assert.equal(is(cells, created, { value: "2026-11-06" }), false);
  assert.equal(is(cells, created, { op: "on_or_after", value: "2026-11-07" }), true);
  assert.equal(is(cells, created, { op: "between", value: "2026-11-01", to: "2026-11-06" }), false);
  // The schema still takes them (and absolute conditions with a zone).
  assert.equal(filterSchema.safeParse({ field: "c", op: "eq", value: "2026-11-06" }).success, true);
  assert.equal(filterSchema.safeParse({ field: "c", op: "eq", value: "2026-11-06", timeZone: LA }).success, true);
  assert.equal(filterSchema.safeParse({ field: "c", op: "eq", value: "2026-11-06", timeZone: "Mars/Base" }).success, false);
});

test("DST boundaries: the day follows the zone's offset on each side of the switch", () => {
  // US fall back: Nov 1, 2026, 02:00 PDT -> 01:00 PST.
  // 11:30 pm PDT on Oct 31 = Nov 1, 06:30 UTC.
  assert.equal(is({ c: "2026-11-01 06:30:00" }, created, { timeZone: LA, value: "2026-10-31" }), true);
  // 11:30 pm PST on Nov 1 = Nov 2, 07:30 UTC.
  assert.equal(is({ c: "2026-11-02 07:30:00" }, created, { timeZone: LA, value: "2026-11-01" }), true);
  // 00:30 am PST on Nov 2 = Nov 2, 08:30 UTC.
  assert.equal(is({ c: "2026-11-02 08:30:00" }, created, { timeZone: LA, value: "2026-11-02" }), true);
  // Europe spring forward: Mar 29, 2026. 23:30 CEST on Mar 29 = 21:30 UTC.
  assert.equal(is({ c: "2026-03-29 21:30:00" }, created, { timeZone: "Europe/Berlin", value: "2026-03-29" }), true);
  // 00:30 CET on Mar 29 = Mar 28, 23:30 UTC.
  assert.equal(is({ c: "2026-03-28 23:30:00" }, created, { timeZone: "Europe/Berlin", value: "2026-03-29" }), true);
});

test("one function for the day: relative and absolute conditions agree, and the view, automations and editor share it", () => {
  const now = new Date("2026-11-07T02:30:00Z");
  const today: Filter = { field: "c", op: "in_relative", value: "today", timeZone: LA };
  const onDay: Filter = { field: "c", op: "eq", value: "2026-11-06", timeZone: LA };
  assert.equal(matches({ c: evening }, today, created, now), true);
  assert.equal(matches({ c: evening }, onDay, created, now), true);
  assert.equal(filterCellDay(evening, LA), filterCellDay("2026-11-06"));
  assert.equal(filterCellDay(evening), filterCellDay("2026-11-07"));
  // Automations evaluate their conditions as a group.
  const group: FilterGroup = { kind: "group", join: "and", rules: [{ ...onDay, kind: "condition" }] };
  assert.equal(matchesFilterGroup({ c: evening }, group, [created]), true);
  // The editor keeps a zone on date conditions and relative ones only.
  assert.equal(conditionTimeZone({ op: "eq" }, created, LA), LA);
  assert.equal(conditionTimeZone({ op: "between", timeZone: "UTC" }, due, LA), "UTC");
  assert.equal(conditionTimeZone({ op: "in_relative" }, due, LA), LA);
  assert.equal(conditionTimeZone({ op: "eq", timeZone: LA }, { type: "text" }, LA), undefined);
  assert.equal(conditionTimeZone({ op: "empty", timeZone: LA }, created, LA), undefined);
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-date-zones-"));
const { id, run } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");

test("a saved view keeps the zone and filters stored Created times by the local day", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
  const owner: Identity = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
  const wid = await createWorkspace(owner.id, "Date zones"),
    boot = await bootstrap(owner, wid);
  const page = (await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Intakes", kind: "database" })) as { id: string };
  const fields: Field[] = [{ id: "title", name: "Name", type: "text" }, created];
  const view: View = {
    id: "v",
    name: "Nov 6",
    type: "table",
    filters: [],
    sorts: [],
    filterGroup: { kind: "group", join: "and", rules: [{ kind: "condition", field: "c", op: "eq", value: "2026-11-06", timeZone: LA }] },
  };
  await command(owner, { action: "database.update", pageId: page.id, version: (await database(page.id)).version, fields, views: [view] });
  const saved = (await database(page.id)).views[0];
  assert.deepEqual(saved.filterGroup, view.filterGroup);
  for (const [title, at] of [["evening", evening], ["morning after", "2026-11-07 16:00:00"], ["morning", "2026-11-06 16:00:00"]]) {
    const { id: rid } = (await command(owner, { action: "row.create", pageId: page.id, cells: { title } })) as { id: string };
    await run("UPDATE rows SET created_at=? WHERE id=?", at, rid);
  }
  const all = await rows(page.id);
  const shown = (v: View) => queryRows(all, fields, v).map((r) => r.cells.title).sort();
  assert.deepEqual(shown(saved), ["evening", "morning"]);
  // An old condition without a zone: the UTC day, as before.
  const old: View = { ...saved, filterGroup: { kind: "group", join: "and", rules: [{ kind: "condition", field: "c", op: "eq", value: "2026-11-06" }] } };
  assert.deepEqual(shown(old), ["morning"]);
});
