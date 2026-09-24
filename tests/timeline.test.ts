import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dateDay,
  dayKey,
  schedulePatch,
  timelinePeriod,
  clipRange,
  rowRange,
} from "../lib/database-timeline";
import { htmlState, escaped } from "../lib/document-server";
import type { Identity, Field, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-timeline-"),
);
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
function user(): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    "Timeline",
    `${uid}@test.invalid`,
  );
  return {
    id: uid,
    name: "Timeline",
    email: `${uid}@test.invalid`,
    disabled: 0,
    created_at: "",
    isAdmin: false,
    groups: [],
  };
}
const owner = user(),
  editor = user(),
  viewer = user(),
  wid = createWorkspace(owner.id, "Timeline tests"),
  sid = bootstrap(owner, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "start", name: "Beginn", type: "date" },
  { id: "end", name: "Ende", type: "date" },
];
const view: View = {
  id: "timeline",
  name: "Timeline",
  type: "timeline",
  filters: [],
  sorts: [],
  dateField: "start",
  endDateField: "end",
  timeline: { scale: "quarter", showWeekends: false },
};
const act = (input: Record<string, unknown>, actor = owner): any =>
  command(actor, input);
function create(kind = "database") {
  return act({
    action: "page.create",
    workspaceId: wid,
    spaceId: sid,
    title: "Timeline fixture",
    kind,
  }).id as string;
}
function fixture() {
  const pid = create();
  act({
    action: "database.update",
    pageId: pid,
    version: 1,
    fields,
    views: [view, { ...view, id: "calendar", type: "calendar" }],
  });
  const rid = act({
    action: "row.create",
    pageId: pid,
    cells: {
      title: "A",
      start: "2026-03-28T09:30:00+01:00",
      end: "2026-03-30T17:15:00+02:00",
    },
  }).id as string;
  return { pid, rid };
}
function schedule(
  pid: string,
  rid: string,
  change: unknown,
  extra = {},
  actor = owner,
) {
  return act(
    {
      action: "row.schedule",
      pageId: pid,
      viewId: "timeline",
      version: database(pid).version,
      rowId: rid,
      rowVersion: rows(pid).find((r) => r.id === rid)?.version ?? 1,
      change,
      ...extra,
    },
    actor,
  );
}

test("calendar-day scheduling preserves times, leap dates and duration across daylight-saving boundaries", () => {
  for (const value of [
    "2026-02-29",
    "2024-02-30",
    "2026-13-01",
    "0000-01-01",
    "x",
    "2026-01-01T99:00",
  ]) {
    assert.equal(dateDay(value), null);
  }
  for (const value of [
    "0001-01-01",
    "0099-02-28",
    "1969-12-31",
    "2024-02-29",
    "9999-12-31",
  ]) {
    assert.equal(dayKey(dateDay(value)!), value);
  }
  const row = {
    cells: {
      title: "Keep",
      start: "2026-03-28T09:30:00+01:00",
      end: "2026-03-30T17:15:00+02:00",
    },
  };
  assert.deepEqual(
    schedulePatch(row, fields, view, { operation: "move", days: 2 }),
    { start: "2026-03-30T09:30:00+01:00", end: "2026-04-01T17:15:00+02:00" },
  );
  assert.deepEqual(
    schedulePatch(
      { cells: { start: "2024-02-28", end: "2024-02-29" } },
      fields,
      view,
      { operation: "move", days: 1 },
    ),
    { start: "2024-02-29", end: "2024-03-01" },
  );
  assert.throws(
    () =>
      schedulePatch(row, fields, view, { operation: "resize-end", days: -3 }),
    /Ende/,
  );
  assert.deepEqual(
    schedulePatch({ cells: { start: "2026-01-02", end: "" } }, fields, view, {
      operation: "resize-start",
      days: -1,
    }),
    { start: "2026-01-01", end: "2026-01-02" },
  );
  assert.deepEqual(
    schedulePatch({ cells: { start: "2026-01-02", end: "" } }, fields, view, {
      operation: "move",
      days: 2,
    }),
    { start: "2026-01-04", end: "" },
  );
  assert.throws(
    () =>
      schedulePatch(
        { cells: { start: "9999-12-31" } },
        fields,
        { ...view, endDateField: undefined },
        { operation: "move", days: 1 },
      ),
    /Bereich/,
  );
  assert.equal(
    rowRange(
      { cells: { start: "2026-01-03", end: "2026-01-01" } },
      fields[1],
      fields[2],
    ),
    null,
  );
});
test("timeline periods and clipping use exact day boundaries at all scales", () => {
  const week = timelinePeriod("2026-09-23", "week");
  assert.equal(dayKey(week.start), "2026-09-21");
  assert.equal(week.days, 7);
  assert.equal(timelinePeriod("2024-02-05", "month").days, 29);
  assert.equal(timelinePeriod("2024-02-05", "quarter").days, 91);
  assert.equal(timelinePeriod("2024-02-05", "year").days, 366);
  assert.equal(timelinePeriod("2025-02-05", "year").days, 365);
  assert.equal(
    dayKey(timelinePeriod("0001-01-01", "week").start),
    "0001-01-01",
  );
  assert.equal(
    dayKey(timelinePeriod("9999-12-31", "year").end - 1),
    "9999-12-31",
  );
  assert.deepEqual(clipRange(week.start - 5, week.start + 1, week), {
    left: 0,
    width: 160,
    clippedStart: true,
    clippedEnd: false,
  });
  assert.equal(clipRange(week.end, week.end + 1, week), null);
});
test("scheduling changes both dates atomically and enforces row, view, membership and lock constraints", () => {
  const { pid, rid } = fixture();
  const move = { operation: "move", days: 3 },
    before = rows(pid)[0];
  for (const actor of [viewer, user()])
    assert.throws(() => schedule(pid, rid, move, {}, actor), /Berechtigung/);
  assert.throws(() => schedule(pid, rid, move, { version: 1 }), /Ansicht/);
  assert.throws(() => schedule(pid, rid, move, { rowVersion: 0 }), /Datensatz/);
  assert.throws(
    () => schedule(pid, rid, move, { viewId: "missing" }),
    /Ansicht/,
  );
  assert.throws(
    () =>
      schedule(pid, rid, {
        operation: "set",
        start: "2026-02-01",
        end: "2026-01-01",
      }),
    /Ende/,
  );
  assert.deepEqual(rows(pid)[0], before);
  run("UPDATE pages SET locked=1 WHERE id=?", pid);
  assert.throws(() => schedule(pid, rid, move), /gesperrt/);
  run("UPDATE pages SET locked=0 WHERE id=?", pid);
  schedule(pid, rid, move, {}, editor);
  const next = rows(pid)[0];
  assert.equal(next.cells.start, "2026-03-31T09:30:00+01:00");
  assert.equal(next.cells.end, "2026-04-02T17:15:00+02:00");
  assert.equal(next.version, before.version + 1);
  assert.equal(next.updated_by, editor.id);
  assert.equal(next.cells.title, "A");
  schedule(pid, rid, { operation: "resize-end", days: 2 });
  assert.equal(rows(pid)[0].cells.end, "2026-04-04T17:15:00+02:00");
  schedule(pid, rid, { operation: "move", days: -2 }, { viewId: "calendar" });
  assert.equal(rows(pid)[0].cells.start, "2026-03-29T09:30:00+01:00");
  assert.equal(rows(pid)[0].cells.end, "2026-04-02T17:15:00+02:00");
  const foreign = fixture();
  assert.throws(
    () => schedule(pid, foreign.rid, move, { rowVersion: 1 }),
    /Datensatz/,
  );
});
test("missing, identical and non-date fields cannot be changed; empty ranges can be scheduled explicitly", () => {
  const { pid, rid } = fixture(),
    initial = rows(pid)[0];
  for (const patch of [
    { dateField: "title" },
    { dateField: "missing" },
    { endDateField: "start" },
    { endDateField: "missing" },
  ]) {
    const d = database(pid);
    act({
      action: "database.update",
      pageId: pid,
      version: d.version,
      fields,
      views: [{ ...view, ...patch }],
    });
    assert.throws(
      () => schedule(pid, rid, { operation: "move", days: 1 }),
      /Datumsfelder/,
    );
    assert.deepEqual(rows(pid)[0], initial);
  }
  let d = database(pid);
  act({
    action: "database.update",
    pageId: pid,
    version: d.version,
    fields,
    views: [{ ...view, dateField: undefined, endDateField: undefined }],
  });
  assert.throws(
    () => schedule(pid, rid, { operation: "resize-end", days: 1 }),
    /Enddatumsfeld/,
  );
  assert.throws(
    () =>
      schedule(pid, rid, {
        operation: "set",
        start: "2026-01-01",
        end: "2026-01-03",
      }),
    /Enddatumsfeld/,
  );
  act({
    action: "row.update",
    pageId: pid,
    rowId: rid,
    version: initial.version,
    cells: { start: "", end: "" },
  });
  assert.throws(
    () => schedule(pid, rid, { operation: "move", days: 1 }),
    /gültigen Zeitraum/,
  );
  schedule(pid, rid, { operation: "set", start: "2026-01-02", end: "" });
  assert.equal(rows(pid)[0].cells.start, "2026-01-02");
});
test("linked timelines use their own field mapping and reject stale source, host and row state", () => {
  const { pid, rid } = fixture(),
    host = create("document"),
    blockId = id(),
    linkedView = { ...view, dateField: "end", endDateField: undefined };
  const html = `<div data-linked-database="${blockId}" data-linked-source="${pid}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify([linkedView]))}">Linked</div>`;
  run(
    "UPDATE documents SET html=?,state=? WHERE page_id=?",
    html,
    htmlState(html),
    host,
  );
  const mutation = () => ({
    action: "row.schedule",
    viewId: view.id,
    version: 1,
    rowId: rid,
    rowVersion: rows(pid)[0].version,
    change: { operation: "move", days: 1 },
  });
  const linked = (extra = {}, actor = owner) =>
    act(
      {
        action: "linked.command",
        pageId: host,
        blockId,
        generation: "1",
        sourceVersion: database(pid).version,
        mutation: mutation(),
        ...extra,
      },
      actor,
    );
  const before = rows(pid)[0];
  assert.throws(() => linked({ sourceVersion: 0 }), /Datenquelle/);
  assert.throws(
    () => linked({ mutation: { ...mutation(), version: 2 } }),
    /Einbettung/,
  );
  assert.throws(() => linked({ generation: "wrong" }), /Dokumentversion/);
  assert.throws(() => linked({}, viewer), /Berechtigung/);
  assert.deepEqual(rows(pid)[0], before);
  run("UPDATE pages SET locked=1 WHERE id=?", host);
  linked();
  run("UPDATE pages SET locked=0 WHERE id=?", host);
  assert.equal(rows(pid)[0].cells.start, before.cells.start);
  assert.equal(rows(pid)[0].cells.end, "2026-03-31T17:15:00+02:00");
  run("UPDATE pages SET locked=1 WHERE id=?", pid);
  assert.throws(() => linked(), /gesperrt/);
});
test("timeline configuration survives page and space copies, templates, snapshots and ZIP restoration", async () => {
  const { pid } = fixture(),
    expected = database(pid).views[0].timeline;
  const check = (p: string) =>
    assert.deepEqual(database(p).views[0].timeline, expected);
  check(act({ action: "page.duplicate", pageId: pid }).id);
  const template = act({
    action: "template.save",
    pageId: pid,
    name: "Timeline template",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: sid,
      title: "From template",
      templateId: template,
    }).id,
  );
  act({ action: "page.snapshot", pageId: pid });
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=? ORDER BY rowid DESC",
    pid,
  )!.id;
  const d = database(pid);
  act({
    action: "database.update",
    pageId: pid,
    version: d.version,
    fields,
    views: [{ ...view, timeline: { scale: "year", showWeekends: true } }],
  });
  act({ action: "snapshot.restore", pageId: pid, snapshotId: snapshot });
  check(pid);
  const destination = createWorkspace(owner.id, "Timeline restore"),
    result = await importArchive(
      owner,
      destination,
      await exportArchive(owner, wid),
    );
  check(result.pageIds[pid]);
  const area = act({
    action: "space.create",
    workspaceId: wid,
    name: "Timeline area",
    private: true,
  }).id;
  run("UPDATE pages SET space_id=? WHERE id=?", area, pid);
  const clone = act({
    action: "space.duplicate",
    spaceId: area,
    version: 1,
    name: "Timeline area copy",
    visibility: "private",
  });
  check(
    one<{ id: string }>("SELECT id FROM pages WHERE space_id=?", clone.id)!.id,
  );
  const current = database(pid);
  assert.throws(() =>
    act({
      action: "database.update",
      pageId: pid,
      version: current.version,
      fields,
      views: [{ ...view, timeline: { scale: "invalid", showWeekends: true } }],
    }),
  );
});

test("timeline dependencies compute finish-to-start shifts, cycles and survive page copies", async () => {
  const { timelineDependencies, dependencyFields } =
    await import("../lib/database-timeline");
  const { view: viewSchema } = await import("../lib/database-schema");
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "start", name: "Beginn", type: "date" },
    { id: "end", name: "Ende", type: "date" },
    { id: "after", name: "Nach", type: "relation", relationPage: "self" },
    { id: "other", name: "Extern", type: "relation", relationPage: "else" },
  ];
  assert.deepEqual(
    dependencyFields(fields, "self").map((f) => f.id),
    ["after"],
  );
  const r = (id: string, start: string, end: string, after: unknown = []) => ({
    id,
    cells: { start, end, after },
  });
  const rowsIn = [
    r("a", "2026-01-01", "2026-01-03"),
    // Starts on the predecessor's last day: one day overlap.
    r("b", "2026-01-03", "2026-01-04", ["a", "a", "b", "missing", 7]),
    // Starts right after: no conflict.
    r("c", "2026-01-05", "", ["b"]),
    // No valid range: link without shift.
    r("d", "", "", ["c"]),
  ];
  const { links, cyclic } = timelineDependencies(
    rowsIn,
    fields[3],
    fields[1],
    fields[2],
  );
  assert.deepEqual(links, [
    { from: "a", to: "b", shift: 1 },
    { from: "b", to: "c", shift: 0 },
    { from: "c", to: "d", shift: 0 },
  ]);
  assert.equal(cyclic.size, 0);
  const loop = timelineDependencies(
    [
      r("x", "2026-01-01", "", ["z"]),
      r("y", "2026-01-02", "", ["x"]),
      r("z", "2026-01-03", "", ["y"]),
      r("w", "2026-01-09", "", ["x"]),
    ],
    fields[3],
    fields[1],
  );
  assert.deepEqual([...loop.cyclic].sort(), ["x", "y", "z"]);
  assert.equal(timelineDependencies(rowsIn, undefined).links.length, 0);
  // Long chains do not overflow the stack.
  const chain = Array.from({ length: 20000 }, (_, i) =>
    r(`n${i}`, "2026-01-01", "", i ? [`n${i - 1}`] : []),
  );
  assert.equal(
    timelineDependencies(chain, fields[3], fields[1]).links.length,
    19999,
  );

  const base: View = {
    id: "t",
    name: "Timeline",
    type: "timeline",
    filters: [],
    sorts: [],
  };
  assert.equal(
    viewSchema.safeParse({
      ...base,
      timeline: { scale: "month", showWeekends: true, dependencyField: "x" },
    }).success,
    true,
  );

  // A copied database points its self-relation and dependency at the copy.
  const owner = user();
  const wid = createWorkspace(owner.id, "Dependencies");
  const space = bootstrap(owner, wid).spaces[0];
  const act = (input: Record<string, unknown>) =>
    command(owner, input) as { id: string };
  const pid = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: space.id,
    title: "Plan",
    kind: "database",
  }).id;
  command(owner, {
    action: "database.update",
    pageId: pid,
    version: database(pid).version,
    fields: fields
      .slice(0, 4)
      .map((f) => (f.id === "after" ? { ...f, relationPage: pid } : f)),
    views: [
      {
        ...base,
        dateField: "start",
        endDateField: "end",
        timeline: {
          scale: "month",
          showWeekends: true,
          dependencyField: "after",
        },
      },
    ],
  });
  const first = act({
    action: "row.create",
    pageId: pid,
    cells: { title: "A", start: "2026-02-01", end: "2026-02-05" },
  }).id;
  act({
    action: "row.create",
    pageId: pid,
    cells: {
      title: "B",
      start: "2026-02-03",
      end: "2026-02-04",
      after: [first],
    },
  });
  const copy = act({ action: "page.duplicate", pageId: pid }).id;
  const copied = database(copy);
  const view = copied.views[0];
  const relation = dependencyFields(copied.fields, copy).find(
    (f) => f.id === view.timeline?.dependencyField,
  );
  assert.ok(relation, "dependency field resolves in the copy");
  const copiedRows = rows(copy);
  const deps = timelineDependencies(
    copiedRows,
    relation,
    copied.fields.find((f) => f.id === "start"),
    copied.fields.find((f) => f.id === "end"),
  );
  assert.equal(deps.links.length, 1);
  assert.equal(deps.links[0].shift, 3);
  assert.ok(copiedRows.some((row) => row.id === deps.links[0].from));
  assert.ok(!copiedRows.some((row) => row.id === first));
});
