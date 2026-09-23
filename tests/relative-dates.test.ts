import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  relativeDateWindow,
  relativeCellDay,
  validTimeZone,
} from "../lib/relative-dates";
import {
  filterSchema,
  filterGroupSchema,
  matches,
  matchesFilterGroup,
  hasRelativeFilters,
} from "../lib/database-filters";
import { queryRows } from "../lib/database";
import type {
  Field,
  Filter,
  FilterGroup,
  View,
  Row,
  Identity,
} from "../lib/types";
const date: Field = { id: "date", name: "Termin", type: "date" };
const fields: Field[] = [{ id: "title", name: "Name", type: "text" }, date];
const relative = (value = "today", extra: Partial<Filter> = {}): Filter => ({
  field: "date",
  op: "in_relative",
  value,
  timeZone: "Europe/Berlin",
  ...extra,
});
const day = (date: string) => Date.parse(date + "T00:00:00Z") / 86400000;
function range(value: string, at: string, zone = "Europe/Berlin", n?: number) {
  const r = relativeDateWindow(value, zone, n, new Date(at))!;
  return [r.start, r.end].map((d) =>
    new Date(d * 86400000).toISOString().slice(0, 10),
  );
}
test("calendar presets use Monday weeks, full months and years across leap days and year boundaries", () => {
  const at = "2026-01-01T12:00:00Z";
  const expected = {
    today: ["2026-01-01", "2026-01-02"],
    yesterday: ["2025-12-31", "2026-01-01"],
    tomorrow: ["2026-01-02", "2026-01-03"],
    this_week: ["2025-12-29", "2026-01-05"],
    last_week: ["2025-12-22", "2025-12-29"],
    next_week: ["2026-01-05", "2026-01-12"],
    this_month: ["2026-01-01", "2026-02-01"],
    last_month: ["2025-12-01", "2026-01-01"],
    next_month: ["2026-02-01", "2026-03-01"],
    this_year: ["2026-01-01", "2027-01-01"],
    last_year: ["2025-01-01", "2026-01-01"],
    next_year: ["2027-01-01", "2028-01-01"],
  };
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(range(key, at), value, key);
  assert.deepEqual(range("last_month", "2024-03-31T12:00:00Z"), [
    "2024-02-01",
    "2024-03-01",
  ]);
  assert.deepEqual(range("this_week", "2026-01-04T12:00:00Z"), [
    "2025-12-29",
    "2026-01-05",
  ]);
});
test("rolling periods include today, stay calendar based across DST and validate arbitrary day counts", () => {
  const at = "2026-03-30T12:00:00Z";
  for (const [key, n] of [
    ["last_7_days", 7],
    ["last_30_days", 30],
    ["past_days", 90],
    ["next_7_days", 7],
    ["next_30_days", 30],
    ["next_days", 90],
  ] as const) {
    const r = relativeDateWindow(key, "Europe/Berlin", n, new Date(at))!;
    assert.equal(r.end - r.start, n);
    assert.ok(r.start <= day("2026-03-30") && r.end > day("2026-03-30"));
  }
  assert.deepEqual(range("last_7_days", at), ["2026-03-24", "2026-03-31"]);
  assert.deepEqual(range("past_days", at, "Europe/Berlin", 1), [
    "2026-03-30",
    "2026-03-31",
  ]);
  for (const n of [undefined, 0, -1, 1.5, 36601, NaN])
    assert.equal(relativeDateWindow("past_days", "UTC", n, new Date(at)), null);
});
test("saved time zones define today and timestamp days while date-only values never shift", () => {
  const at = "2026-09-22T23:30:00Z";
  assert.deepEqual(range("today", at), ["2026-09-23", "2026-09-24"]);
  assert.deepEqual(range("today", at, "America/Los_Angeles"), [
    "2026-09-22",
    "2026-09-23",
  ]);
  assert.deepEqual(
    range("today", "2026-01-01T10:30:00Z", "Pacific/Kiritimati"),
    ["2026-01-02", "2026-01-03"],
  );
  assert.equal(
    relativeCellDay("2026-09-22", "Europe/Berlin"),
    day("2026-09-22"),
  );
  assert.equal(
    relativeCellDay("2026-09-22 23:30:00", "Europe/Berlin"),
    day("2026-09-23"),
  );
  assert.equal(
    relativeCellDay("2026-09-23T00:30:00+02:00", "America/Los_Angeles"),
    day("2026-09-22"),
  );
  assert.equal(
    relativeCellDay("2026-10-25T01:30:00Z", "Europe/Berlin"),
    day("2026-10-25"),
  );
  assert.equal(
    relativeCellDay("2026-03-29T01:30:00Z", "Europe/Berlin"),
    day("2026-03-29"),
  );
  for (const value of [
    "2026-02-30",
    "2026-02-30T12:00:00Z",
    "2026-01-01T99:00",
    "",
    "#ACCESS",
    [],
    0,
  ])
    assert.ok(Number.isNaN(relativeCellDay(value, "UTC")));
  assert.equal(validTimeZone("invalid/zone"), false);
  assert.equal(
    relativeDateWindow("today", "invalid/zone", undefined, new Date(at)),
    null,
  );
});
test("relative predicates are typed, reject empty dates for both operators and recompute at midnight inside nested groups", () => {
  const today = relative(),
    before = new Date("2026-03-28T22:59:59Z"),
    after = new Date("2026-03-28T23:00:01Z");
  assert.equal(matches({ date: "2026-03-28" }, today, date, before), true);
  assert.equal(matches({ date: "2026-03-28" }, today, date, after), false);
  assert.equal(matches({ date: "2026-03-29" }, today, date, after), true);
  assert.equal(
    matches({ date: "" }, { ...today, op: "not_in_relative" }, date, after),
    false,
  );
  assert.equal(
    matches({ date: "2026-03-28" }, today, { ...date, type: "text" }, before),
    false,
  );
  const tree: FilterGroup = {
    kind: "group",
    join: "and",
    rules: [
      { kind: "condition", field: "title", op: "contains", value: "Alpha" },
      { kind: "group", join: "or", rules: [{ ...today, kind: "condition" }] },
    ],
  };
  assert.equal(hasRelativeFilters(tree), true);
  assert.equal(
    matchesFilterGroup(
      { title: "Alpha", date: "2026-03-28" },
      tree,
      fields,
      before,
    ),
    true,
  );
  assert.equal(
    matchesFilterGroup(
      { title: "Alpha", date: "2026-03-28" },
      tree,
      fields,
      after,
    ),
    false,
  );
  const row = {
    id: "r",
    page_id: "p",
    created_at: "",
    updated_at: "",
    created_by: "",
    updated_by: "",
    version: 1,
    cells: { title: "Alpha", date: "2026-03-28" },
    position: 0,
  } as Row;
  assert.equal(
    queryRows([row], fields, { ...view, filterGroup: tree }, "", {}, {}, before)
      .length,
    1,
  );
  assert.equal(
    queryRows([row], fields, { ...view, filterGroup: tree }, "", {}, {}, after)
      .length,
    0,
  );
});
test("schemas reject missing or malformed relative settings and preserve valid nested predicates", () => {
  assert.deepEqual(filterSchema.parse(relative()), relative());
  for (const f of [
    relative("unknown"),
    relative("today", { timeZone: undefined }),
    relative("today", { timeZone: "invalid/zone" }),
    relative("past_days"),
    relative("past_days", { days: 0 }),
    relative("next_days", { days: 2.5 }),
  ])
    assert.equal(filterSchema.safeParse(f).success, false);
  const tree: FilterGroup = {
    kind: "group",
    join: "or",
    rules: [{ kind: "condition", ...relative("past_days", { days: 17 }) }],
  };
  assert.deepEqual(filterGroupSchema.parse(tree), tree);
});
const view: View = {
  id: "table",
  type: "table",
  name: "Relative",
  filters: [],
  sorts: [],
};
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "flowplan-relative-"),
);
const { id, run, one } = await import("../lib/db");
const { command, database, rows, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { exportArchive, importArchive } = await import("../lib/archive");
function user(name: string): Identity {
  const uid = id();
  run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@test.invalid`,
  );
  return {
    id: uid,
    name,
    email: `${name}@test.invalid`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  };
}
const owner = user("owner"),
  viewer = user("viewer"),
  wid = createWorkspace(owner.id, "Relative dates"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, as = owner): any =>
  command(as, body);
test("relative settings survive copies, templates, JSON, ZIP and snapshots with rights and optimistic versions intact", async () => {
  const page = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: boot.spaces[0].id,
    title: "Relative dates",
    kind: "database",
  }).id;
  const tree: FilterGroup = {
    kind: "group",
    join: "and",
    rules: [{ kind: "condition", ...relative("past_days", { days: 17 }) }],
  };
  const update = {
    action: "database.update",
    pageId: page,
    version: database(page).version,
    fields,
    views: [{ ...view, filterGroup: tree }],
  };
  assert.throws(() => act(update, viewer), /Berechtigung/);
  act(update);
  assert.throws(() => act(update), /zwischenzeitlich/);
  assert.throws(() =>
    act({
      ...update,
      version: database(page).version,
      views: [{ ...view, filters: [relative("today", { timeZone: "x" })] }],
    }),
  );
  const check = (target: string) =>
    assert.deepEqual(database(target).views[0].filterGroup, tree);
  act({ action: "page.snapshot", pageId: page });
  check(act({ action: "page.duplicate", pageId: page }).id);
  const template = act({
    action: "template.save",
    pageId: page,
    name: "Relative template",
  }).id;
  check(
    act({
      action: "page.create",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      title: "Relative copy",
      templateId: template,
    }).id,
  );
  check(
    act({
      action: "workspace.import",
      workspaceId: wid,
      spaceId: boot.spaces[0].id,
      backup: {
        format: "flowplan-1",
        pages: [
          {
            id: page,
            parent_id: null,
            title: "Relative JSON",
            kind: "database",
            data: { database: database(page), rows: rows(page) },
          },
        ],
      },
    }).pageIds[page],
  );
  const dest = createWorkspace(owner.id, "Restored relative"),
    imported = await importArchive(
      owner,
      dest,
      await exportArchive(owner, wid),
    ),
    restored = imported.pageIds[page];
  check(restored);
  const snapshot = one<{ id: string }>(
    "SELECT id FROM snapshots WHERE page_id=?",
    restored,
  )!.id;
  act({
    action: "database.update",
    pageId: restored,
    version: database(restored).version,
    fields,
    views: [view],
  });
  act({ action: "snapshot.restore", pageId: restored, snapshotId: snapshot });
  check(restored);
});
