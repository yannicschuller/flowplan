import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Field, Row, View } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-public-timeline-"));
const { publicTimelineData } = await import("../lib/public-timeline");
const { dateDay } = await import("../lib/database-timeline");

const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "start", name: "Beginn", type: "date" },
  { id: "end", name: "Ende", type: "date" },
  { id: "deps", name: "Abhängigkeiten", type: "relation", relationPage: "plan" },
  { id: "no", name: "Nr.", type: "text" },
  { id: "goal", name: "Meilenstein", type: "checkbox" },
  { id: "owner", name: "Zuständig", type: "person" },
];
const row = (id: string, start: string, end: string, deps: string[] = []): Row =>
  ({ id, cells: { title: id, start, end, deps }, version: 1, position: 0 }) as unknown as Row;
const view: View = {
  id: "timeline",
  name: "Zeitplan",
  type: "timeline",
  filters: [],
  sorts: [],
  dateField: "start",
  endDateField: "end",
  timeline: {
    scale: "month",
    showWeekends: false,
    range: { from: "2026-11-01", to: "2027-03-31" },
    dayWidth: 6,
    dependencyField: "deps",
    criticalPath: true,
    milestoneField: "goal",
    labelFields: ["no", "owner"],
  },
};

test("the published timeline keeps every record in order with the view's window, zoom and dependencies", () => {
  const records = [
    row("Planung", "2026-11-02", "2026-12-10"),
    row("Bau", "2026-12-11", "2027-02-20", ["Planung"]),
    row("Abnahme", "2027-02-21", "2027-03-05", ["Bau"]),
    row("Später", "2027-06-01", "2027-06-30"),
    row("Ohne", "", ""),
  ];
  const data = publicTimelineData("plan", records, fields, view);
  assert.deepEqual(
    data.rows.map((r) => r.row.id),
    ["Planung", "Bau", "Abnahme", "Später", "Ohne"],
  );
  // Public properties beside the title (a person is never public), the
  // checkbox marks milestones.
  const marked = publicTimelineData(
    "plan",
    [{ ...records[1], cells: { ...records[1].cells, no: "B-2", goal: true, owner: ["u1"] } }],
    fields,
    view,
  ).rows[0];
  assert.equal(marked.detail, "B-2");
  assert.equal(marked.milestone, true);
  assert.equal(data.rows[0].milestone, false);
  // Outside the window and without a period: rows all the same.
  assert.equal(data.rows[3].start, dateDay("2027-06-01"));
  assert.equal(data.rows[4].start, undefined);
  assert.equal(data.rows[1].label, "2026-12-11 – 2027-02-20");
  assert.deepEqual(data.range, { from: "2026-11-01", to: "2027-03-31" });
  assert.equal(data.dayWidth, 6);
  assert.equal(data.weekends, false);
  assert.deepEqual(
    data.links.map((l) => `${l.from}>${l.to}`),
    ["Planung>Bau", "Bau>Abnahme"],
  );
  // "Später" ends the plan: the chain has slack.
  assert.deepEqual(data.critical, []);
  const chain = publicTimelineData("plan", records.slice(0, 3), fields, view);
  assert.deepEqual(chain.critical.sort(), ["Abnahme", "Bau", "Planung"]);
  // Links to records the reader does not get are dropped.
  const filtered = publicTimelineData("plan", records.slice(1), fields, view);
  assert.deepEqual(filtered.links.map((l) => `${l.from}>${l.to}`), ["Bau>Abnahme"]);
});

test("no dependencies when the relation is read-restricted or not a self-relation", () => {
  const records = [row("A", "2026-11-02", "2026-11-05"), row("B", "2026-11-06", "2026-11-09", ["A"])];
  const restricted = fields.map((f) =>
    f.id === "deps" ? ({ ...f, access: { read: "editors" } } as unknown as Field) : f,
  );
  assert.deepEqual(publicTimelineData("plan", records, restricted, view).links, []);
  assert.deepEqual(publicTimelineData("other", records, fields, view).links, []);
  // Old views without timeline settings.
  const plain = publicTimelineData("plan", records, fields, { ...view, timeline: undefined });
  assert.equal(plain.range, undefined);
  assert.equal(plain.scale, "month");
  assert.deepEqual(plain.links, []);
});
