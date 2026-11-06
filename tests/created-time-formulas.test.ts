// Issue #129: formulas and rollups read "Created time" and "Edited time"
// (stored as SQLite CURRENT_TIMESTAMP text, UTC) as ISO instants.
process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";
import { computedCells } from "../lib/database";
import { sqlTimestampToIso } from "../lib/date-values";
import type { Field, Row } from "../lib/types";

const record = (id: string, page_id: string, created_at: string, updated_at: string, cells: Record<string, unknown> = {}): Row => ({
  id,
  page_id,
  cells,
  position: 0,
  created_at,
  updated_at,
  created_by: "u1",
  updated_by: "u1",
  version: 1,
});

test("SQLite timestamps become ISO instants; other values pass unchanged", () => {
  assert.equal(sqlTimestampToIso("2026-11-05 17:39:02"), "2026-11-05T17:39:02Z");
  assert.equal(sqlTimestampToIso("2026-11-05 17:39:02.123"), "2026-11-05T17:39:02.123Z");
  assert.equal(sqlTimestampToIso("2026-11-05T17:39:02"), "2026-11-05T17:39:02Z");
  assert.equal(sqlTimestampToIso("2026-11-05T17:39:02.000Z"), "2026-11-05T17:39:02.000Z");
  assert.equal(sqlTimestampToIso("2026-11-05"), "2026-11-05");
  assert.equal(sqlTimestampToIso(""), "");
  assert.equal(sqlTimestampToIso(null), null);
});

test("formula date functions work on Created time and Edited time", () => {
  const fields: Field[] = [
    { id: "title", name: "Name", type: "text" },
    { id: "created", name: "Created At", type: "created_at" },
    { id: "edited", name: "Edited", type: "updated_at" },
    { id: "f1", name: "Short", type: "formula", formula: 'formatDate(prop("Created At"), "MM/DD")' },
    { id: "f2", name: "Clock", type: "formula", formula: 'formatDate(prop("Created At"), "YYYY-MM-DD HH:mm", "Europe/Berlin")' },
    { id: "f3", name: "Days", type: "formula", formula: 'dateBetween(prop("Edited"), prop("Created At"), "days")' },
    { id: "f4", name: "Raw", type: "formula", formula: 'prop("Created At")' },
  ];
  const row = record("r1", "p1", "2026-11-05 17:39:02", "2026-11-08 17:39:02");
  const cells = computedCells(row, fields);
  assert.equal(cells.f1, "11/05");
  assert.equal(cells.f2, "2026-11-05 18:39");
  assert.equal(cells.f3, 3);
  assert.equal(cells.f4, "2026-11-05T17:39:02Z");
  // The stored value and the property's own cell stay unchanged.
  assert.equal(row.created_at, "2026-11-05 17:39:02");
  assert.equal(cells.created, "2026-11-05 17:39:02");
});

test("rollups over Created time return UTC instants regardless of the server's zone", () => {
  const taskFields: Field[] = [
    { id: "title", name: "Task", type: "text" },
    { id: "created", name: "Created", type: "created_at" },
  ];
  const projectFields: Field[] = [
    { id: "title", name: "Project", type: "text" },
    { id: "tasks", name: "Tasks", type: "relation", relationPage: "tasks" },
    { id: "first", name: "First", type: "rollup", relationField: "tasks", rollupField: "created", aggregate: "earliest_date" },
    { id: "last", name: "Last", type: "rollup", relationField: "tasks", rollupField: "created", aggregate: "latest_date" },
    { id: "span", name: "Span", type: "rollup", relationField: "tasks", rollupField: "created", aggregate: "date_range" },
    { id: "day", name: "Day", type: "formula", formula: 'formatDate(prop("First"), "YYYY-MM-DD")' },
  ];
  const tasks = [
    record("t1", "tasks", "2026-11-05 23:30:00", "2026-11-05 23:30:00"),
    record("t2", "tasks", "2026-11-03 11:30:00", "2026-11-03 11:30:00"),
  ];
  const project = record("p", "projects", "2026-11-01 00:00:00", "2026-11-01 00:00:00", { tasks: ["t1", "t2"] });
  const cells = computedCells(project, projectFields, { tasks }, { tasks: taskFields });
  assert.equal(cells.first, "2026-11-03T11:30:00Z");
  assert.equal(cells.last, "2026-11-05T23:30:00Z");
  assert.equal(cells.span, 2.5);
  assert.equal(cells.day, "2026-11-03");
  assert.equal(Date.parse(cells.last as string), Date.UTC(2026, 10, 5, 23, 30));
});
