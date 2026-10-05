import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, View } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-metric-"));
const { id, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { computeMetric, metricSchema, metricSources } = await import("../lib/dashboard-metric");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  stranger = user("stranger");
const wid = createWorkspace(owner.id, "Dashboards"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const source = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Tickets" })
  .id as string;
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "hours", name: "Hours", type: "number" },
  { id: "double", name: "Double", type: "formula", formula: "{Hours} * 2" },
];
const views: View[] = [
  { id: "all", name: "All", type: "table", filters: [], sorts: [] },
  { id: "open", name: "Open", type: "table", filters: [{ field: "status", op: "eq", value: "Open" }], sorts: [] },
];
act({ action: "database.update", pageId: source, version: database(source).version, fields, views });
for (const [title, status, hours] of [
  ["A", "Open", 2],
  ["B", "Open", 4.5],
  ["C", "Done", 10],
  ["D", "Done", ""],
] as const)
  act({ action: "row.create", pageId: source, cells: { title, status, hours } });

const metric = (query: Record<string, string>, who = owner) =>
  computeMetric(who, metricSchema.parse({ source, ...query }));

test("counts records, all or as a view filters them", () => {
  assert.equal(metric({}).value, 4);
  const open = metric({ view: "open" });
  assert.equal(open.value, 2);
  assert.equal(open.view, "Open");
  assert.equal(open.source, "Tickets");
});

test("sum, average, minimum and maximum of a number property", () => {
  assert.equal(metric({ aggregate: "sum", field: "hours" }).value, 16.5);
  assert.equal(metric({ aggregate: "average", field: "hours" }).value, 5.5);
  assert.equal(metric({ aggregate: "min", field: "hours" }).value, 2);
  assert.equal(metric({ aggregate: "max", field: "hours", view: "open" }).value, 4.5);
  assert.throws(() => metric({ aggregate: "sum" }), /Eigenschaft fehlt/);
  // Formulas are calculated before they are added up.
  assert.equal(metric({ aggregate: "sum", field: "double", view: "open" }).value, 13);
});

test("only for people who can read the database", () => {
  assert.throws(() => metric({}, stranger));
  const sources = metricSources(owner, wid);
  const tickets = sources.find((s) => s.id === source)!;
  assert.deepEqual(tickets.numbers.map((n) => n.id), ["hours", "double"]);
  assert.deepEqual(tickets.views.map((v) => v.id), ["all", "open"]);
  assert.equal(metricSources(stranger, wid).length, 0);
});
