import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validDateValue,
  validZone,
  localToInstant,
  localValue,
  formatDateValue,
} from "../lib/date-values";
import {
  calendarDays,
  calendarPatch,
  calendarRange,
  rangeOnDay,
  daySegments,
} from "../lib/database-calendar";
import { formConfigSchema, validateFormValues } from "../lib/form-settings";
import type { Field, View, Row, Identity } from "../lib/types";
import { htmlState, escaped } from "../lib/document-server";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-calendar-"),
);
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "start", name: "Beginn", type: "date" },
  { id: "end", name: "Ende", type: "date" },
];
const view: View = {
  id: "calendar",
  name: "Kalender",
  type: "calendar",
  filters: [],
  sorts: [],
  dateField: "start",
  endDateField: "end",
  calendar: { mode: "week", timeZone: "Europe/Berlin" },
};
async function user(): Promise<Identity> {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "Calendar",
    `${uid}@test.invalid`,
  );
  return {
    id: uid,
    name: "Calendar",
    email: `${uid}@test.invalid`,
    disabled: 0,
    created_at: "",
    isAdmin: false,
    groups: [],
  };
}
const owner = await user(),
  viewer = await user(),
  outsider = await user(),
  wid = await createWorkspace(owner.id, "Calendar tests"),
  sid = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (input: Record<string, unknown>, actor = owner): Promise<any> =>
  await command(actor, input);
async function fixture() {
  const pid = (await act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    kind: "database",
    title: "Calendar fixture",
  })).id as string;
  await act({
    action: "database.update",
    pageId: pid,
    version: 1,
    fields,
    views: [view],
  });
  const rid = (await act({
    action: "row.create",
    pageId: pid,
    cells: {
      title: "Meeting",
      start: "2026-03-28T09:00:00+01:00",
      end: "2026-03-28T10:30:00+01:00",
    },
  })).id as string;
  const schedule = async (
    change: Record<string, unknown>,
    extra = {},
    actor = owner,
  ) =>
    await act(
      {
        action: "row.schedule",
        pageId: pid,
        viewId: view.id,
        version: (await database(pid)).version,
        rowId: rid,
        rowVersion: (await rows(pid))[0].version,
        change: { timeZone: "Europe/Berlin", ...change },
        ...extra,
      },
      actor,
    );
  return { pid, rid, schedule };
}
test("date values reject impossible dates and times and resolve DST gaps and folds explicitly", () => {
  for (const value of [
    "2026-02-29",
    "2024-02-30",
    "0000-01-01",
    "2026-01-01T24:00",
    "2026-01-01T12:60",
    "2026-01-01T12:00:60Z",
    "2026-01-01T12:00+99:00",
    "2026-01-01 garbage",
  ])
    assert.equal(validDateValue(value), false, value);
  for (const value of [
    "0001-01-01",
    "0099-01-01",
    "9999-12-31",
    "2024-02-29",
    "2026-01-01T12:30",
    "2026-01-01T12:30:15.123+05:45",
  ])
    assert.equal(validDateValue(value), true, value);
  assert.equal(validZone("Mars/Olympus"), false);
  assert.equal(validZone("+02:00"), false);
  assert.throws(
    () => localToInstant("2026-03-29T02:30", "Europe/Berlin"),
    /existiert/,
  );
  assert.throws(
    () => localToInstant("2026-03-29T02:30", "Europe/Berlin", "later"),
    /existiert/,
  );
  assert.throws(
    () => localToInstant("2026-10-25T02:30", "Europe/Berlin"),
    /zweimal/,
  );
  assert.equal(
    localToInstant("2026-10-25T02:30", "Europe/Berlin", "earlier"),
    "2026-10-25T00:30:00Z",
  );
  assert.equal(
    localToInstant("2026-10-25T02:30", "Europe/Berlin", "later"),
    "2026-10-25T01:30:00Z",
  );
  assert.equal(
    localToInstant("2026-09-23T09:00", "Asia/Kathmandu"),
    "2026-09-23T03:15:00Z",
  );
  assert.equal(
    localValue("2026-09-23T00:15:00Z", "America/Los_Angeles").slice(0, 16),
    "2026-09-22T17:15",
  );
  assert.match(formatDateValue("2026-09-23", "America/Los_Angeles"), /^23\./);
  assert.match(
    formatDateValue("2026-09-23T00:15:00Z", "America/Los_Angeles"),
    /22\..*17:15/,
  );
  assert.match(
    formatDateValue("2026-10-25T02:30", "Europe/Berlin"),
    /Zeitzone prüfen/,
  );
  assert.match(
    formatDateValue("2026-03-29T02:30", "Europe/Berlin"),
    /Zeitzone prüfen/,
  );
});
test("hour grids reflect actual day lengths, half-hour DST and exclusive timed midnight ends", () => {
  assert.equal(
    calendarDays("2026-03-29", "day", "Europe/Berlin")[0].minutes,
    1380,
  );
  assert.equal(
    calendarDays("2026-10-25", "day", "Europe/Berlin")[0].minutes,
    1500,
  );
  assert.equal(
    calendarDays("2026-10-04", "day", "Australia/Lord_Howe")[0].minutes,
    1410,
  );
  const week = calendarDays("2026-09-23", "week", "UTC");
  assert.equal(week[0].date, "2026-09-21");
  assert.equal(week.length, 7);
  assert.equal(calendarDays("2026-09-23", "month", "UTC").length, 42);
  const range = calendarRange(
    { cells: { start: "2026-09-22T22:00Z", end: "2026-09-23T00:00Z" } },
    fields,
    view,
    "UTC",
  )!;
  assert.equal(rangeOnDay(range, week[1]), true);
  assert.equal(rangeOnDay(range, week[2]), false);
  const full = calendarRange(
    { cells: { start: "2026-09-22", end: "2026-09-23" } },
    fields,
    view,
    "UTC",
  )!;
  assert.equal(rangeOnDay(full, week[2]), true);
  assert.equal(
    calendarRange(
      { cells: { start: "2026-09-22T12:00Z", end: "2026-09-23" } },
      fields,
      view,
      "UTC",
    ),
    null,
  );
  assert.equal(
    calendarRange(
      { cells: { start: "2026-09-22T12:00Z", end: "2026-09-22T11:00Z" } },
      fields,
      view,
      "UTC",
    ),
    null,
  );
});
test("timed moves preserve elapsed duration across DST while day moves preserve local start time", () => {
  const row = {
    cells: { start: "2026-03-28T09:00+01:00", end: "2026-03-28T10:30+01:00" },
  };
  assert.deepEqual(
    calendarPatch(row, fields, view, {
      operation: "move-calendar",
      days: 1,
      timeZone: "Europe/Berlin",
    }),
    { start: "2026-03-29T07:00:00Z", end: "2026-03-29T08:30:00Z" },
  );
  assert.deepEqual(
    calendarPatch(row, fields, view, {
      operation: "move-time",
      at: "2026-03-29T00:30Z",
      timeZone: "Europe/Berlin",
    }),
    { start: "2026-03-29T00:30:00Z", end: "2026-03-29T02:00:00Z" },
  );
  assert.throws(
    () =>
      calendarPatch(
        { cells: { start: "2026-03-28T02:30+01:00" } },
        fields,
        view,
        { operation: "move-calendar", days: 1, timeZone: "Europe/Berlin" },
      ),
    /existiert/,
  );
  assert.throws(
    () =>
      calendarPatch(row, fields, view, {
        operation: "resize-time-end",
        at: "2026-03-28T07:00Z",
        timeZone: "Europe/Berlin",
      }),
    /Ende/,
  );
  assert.deepEqual(
    calendarPatch(
      { cells: { start: "2026-09-23T09:00Z", end: "" } },
      fields,
      view,
      {
        operation: "move-time",
        at: "2026-09-24T10:00Z",
        timeZone: "Europe/Berlin",
      },
    ),
    { start: "2026-09-24T10:00:00Z", end: "" },
  );
  assert.deepEqual(
    calendarPatch({ cells: { start: "2026-09-23T09:00Z" } }, fields, view, {
      operation: "resize-time-start",
      at: "2026-09-23T08:30Z",
      timeZone: "Europe/Berlin",
    }),
    { start: "2026-09-23T08:30:00Z", end: "2026-09-23T10:00:00Z" },
  );
});
test("overlap columns include short hit areas and reset after connected event groups", () => {
  const make = (id: string, start: string, end: string): Row => ({
    id,
    page_id: "calendar",
    position: 0,
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
    version: 1,
    cells: { start: `2026-09-23T${start}Z`, end: `2026-09-23T${end}Z` },
  });
  const segments = daySegments(
    [
      make("A", "09:00", "10:00"),
      make("B", "09:30", "10:30"),
      make("C", "10:00", "11:00"),
      make("D", "12:00", "12:01"),
      make("E", "12:05", "12:10"),
      make("F", "13:00", "14:00"),
    ],
    fields,
    view,
    "UTC",
    calendarDays("2026-09-23", "day", "UTC")[0],
  );
  assert.deepEqual(
    segments.map((s) => [s.row.id, s.column, s.columns]),
    [
      ["A", 0, 2],
      ["B", 1, 2],
      ["C", 0, 2],
      ["D", 0, 2],
      ["E", 1, 2],
      ["F", 0, 1],
    ],
  );
});
test("atomic time commands enforce rights, locks, range consistency and optimistic versions", async () => {
  const f = await fixture(),
    before = (await rows(f.pid))[0],
    move = { operation: "move-time", at: "2026-03-29T07:00Z" };
  for (const actor of [viewer, outsider])
    await assert.rejects(async () => await f.schedule(move, {}, actor), /Berechtigung/);
  await assert.rejects(async () => await f.schedule(move, { rowVersion: 0 }), /Datensatz/);
  await assert.rejects(async () => await f.schedule(move, { version: 0 }), /Ansicht/);
  await assert.rejects(
    async () => await f.schedule({ ...move, timeZone: "Mars/Olympus" }),
    /Zeitzone/,
  );
  await assert.rejects(
    async () => await f.schedule({ ...move, at: "2026-03-29T09:00" }),
    /eindeutiger/,
  );
  await assert.rejects(
    async () =>
      await f.schedule({
        operation: "set-range",
        start: "2026-03-29T09:00Z",
        end: "2026-03-29",
      }),
    /Ende/,
  );
  assert.deepEqual((await rows(f.pid))[0], before);
  await run("UPDATE pages SET locked=1 WHERE id=?", f.pid);
  await assert.rejects(async () => await f.schedule(move), /gesperrt/);
  await run("UPDATE pages SET locked=0 WHERE id=?", f.pid);
  await f.schedule(move);
  assert.deepEqual((await rows(f.pid))[0].cells, {
    title: "Meeting",
    start: "2026-03-29T07:00:00Z",
    end: "2026-03-29T08:30:00Z",
  });
  assert.equal((await rows(f.pid))[0].version, before.version + 1);
  await f.schedule({
    operation: "set-range",
    start: "2026-03-29",
    end: "2026-03-30",
  });
  assert.deepEqual((await rows(f.pid))[0].cells, {
    title: "Meeting",
    start: "2026-03-29",
    end: "2026-03-30",
  });
  await assert.rejects(
    async () =>
      await act({
        action: "row.update",
        pageId: f.pid,
        rowId: f.rid,
        version: (await rows(f.pid))[0].version,
        cells: { start: "2026-02-30T09:00Z" },
      }),
    /Datum/,
  );
  const values = { start: "2026-03-29T07:00:00Z", end: "2026-03-29T08:30:00Z" };
  assert.deepEqual(
    validateFormValues(fields, formConfigSchema.parse({}), values),
    { cells: values, errors: {} },
  );
});
test("linked calendars use independent time zones and protect source and embed versions", async () => {
  const f = await fixture(),
    host = (await act({
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      kind: "document",
      title: "Linked calendar",
    })).id,
    blockId = id(),
    linked = {
      ...view,
      calendar: { mode: "day", timeZone: "America/New_York" },
    };
  const html = `<div data-linked-database="${blockId}" data-linked-source="${f.pid}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify([linked]))}">Linked</div>`;
  await run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
  const input = async () => ({
    action: "linked.command",
    pageId: host,
    blockId,
    generation: "1",
    sourceVersion: (await database(f.pid)).version,
    mutation: {
      action: "row.schedule",
      viewId: view.id,
      version: 1,
      rowId: f.rid,
      rowVersion: (await rows(f.pid))[0].version,
      change: {
        operation: "move-time",
        at: "2026-03-29T12:00Z",
        timeZone: "America/New_York",
      },
    },
  });
  await assert.rejects(async () => await act({ ...(await input()), sourceVersion: 0 }), /Datenquelle/);
  await assert.rejects(async () => await act(await input(), viewer), /Berechtigung/);
  await run("UPDATE pages SET locked=1 WHERE id=?", host);
  await act(await input());
  assert.equal((await rows(f.pid))[0].cells.start, "2026-03-29T12:00:00Z");
  assert.equal((await database(f.pid)).views[0].calendar?.timeZone, "Europe/Berlin");
  await run("UPDATE pages SET locked=1 WHERE id=?", f.pid);
  await assert.rejects(async () => await act(await input()), /gesperrt/);
});
test("calendar preferences and timed values survive copies, templates, snapshots and ZIP restoration", async () => {
  const f = await fixture(),
    expected = (await database(f.pid)).views[0].calendar;
  const check = async (pid: string) => {
    assert.deepEqual((await database(pid)).views[0].calendar, expected);
    assert.equal((await rows(pid))[0].cells.start, "2026-03-28T09:00:00+01:00");
  };
  await check((await act({ action: "page.duplicate", pageId: f.pid })).id);
  const tid = (await act({
    action: "template.save",
    pageId: f.pid,
    name: "Calendar",
  })).id;
  await check(
    (await act({
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      title: "Calendar copy",
      templateId: tid,
    })).id,
  );
  await act({ action: "page.snapshot", pageId: f.pid });
  const snap = (await one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY seq DESC",
    f.pid,
  ))!.id;
  await f.schedule({ operation: "move-time", at: "2026-09-23T12:00Z" });
  await act({ action: "snapshot.restore", pageId: f.pid, snapshotId: snap });
  await check(f.pid);
  const restored = await createWorkspace(owner.id, "Calendar restore"),
    result = await importArchive(
      owner,
      restored,
      await exportArchive(owner, wid),
    );
  await check(result.pageIds[f.pid]);
  await assert.rejects(async () =>
    await act({
      action: "database.update",
      pageId: f.pid,
      version: (await database(f.pid)).version,
      fields,
      views: [
        { ...view, calendar: { mode: "week", timeZone: "Mars/Olympus" } },
      ],
    }),
  );
});
