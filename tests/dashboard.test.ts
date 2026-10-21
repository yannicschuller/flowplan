import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, Page, View } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-dashboard-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap, pageData } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { rollJournal } = await import("../lib/journal");
const { tilesSchema, parseTiles, MAX_TILES } = await import("../lib/dashboard-schema");
const { dashboardData, dashboardSummary } = await import("../lib/dashboard");
const { exportMarkdown } = await import("../lib/markdown-export");
const { currentStreak } = await import("../components/journal-view");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  editor = user("editor"),
  viewer = user("viewer"),
  stranger = user("stranger");
const wid = createWorkspace(owner.id, "Dashboards"),
  space = bootstrap(owner, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>, who = owner): any => command(who, body);
const page = (pid: string) => one<Page>("SELECT * FROM pages WHERE id=?", pid)!;

const tickets = act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Tickets" }).id as string;
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  { id: "hours", name: "Hours", type: "number" },
];
const views: View[] = [
  { id: "all", name: "All", type: "table", filters: [], sorts: [] },
  { id: "open", name: "Open", type: "table", filters: [{ field: "status", op: "eq", value: "Open" }], sorts: [] },
];
act({ action: "database.update", pageId: tickets, version: database(tickets).version, fields, views });
for (const [title, status, hours] of [
  ["A", "Open", 2],
  ["B", "Open", 6],
  ["C", "Done", 10],
] as const)
  act({ action: "row.create", pageId: tickets, cells: { title, status, hours } });

// A database in the owner's private space: nobody else may read it.
const privateSpace = act({ action: "space.create", workspaceId: wid, name: "Privat", private: true }).id as string;
const secret = act({ action: "page.create", workspaceId: wid, spaceId: privateSpace, kind: "database", title: "Geheime Gehälter" }).id as string;

const dashboard = act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "dashboard", title: "Übersicht" }).id as string;

test("tiles are validated: known types, defaults, unique ids, a maximum", () => {
  const [tile] = tilesSchema.parse([{ id: "a", type: "number", source: tickets }]);
  assert.deepEqual(tile, { id: "a", type: "number", size: "medium", title: "", source: tickets, view: "", aggregate: "count", field: "", target: null });
  assert.throws(() => tilesSchema.parse([{ id: "a", type: "iframe" }]));
  assert.throws(() => tilesSchema.parse([{ id: "a", type: "text", size: "huge" }]));
  assert.throws(() => tilesSchema.parse([{ id: "a", type: "number", source: "not-a-uuid" }]));
  assert.throws(() => tilesSchema.parse([{ id: "a", type: "tasks" }, { id: "a", type: "text" }]), /doppelt/);
  assert.throws(() => tilesSchema.parse(Array.from({ length: MAX_TILES + 1 }, (_, i) => ({ id: `t${i}`, type: "tasks" }))));
  // Stored JSON that no longer validates loses only the broken tiles.
  assert.deepEqual(
    parseTiles(JSON.stringify([{ id: "x", type: "gone" }, { id: "y", type: "tasks" }, { id: "y", type: "text" }])).map((t) => t.id),
    ["y"],
  );
  assert.deepEqual(parseTiles("{broken"), []);
});

test("a new dashboard page starts empty with the gauge icon", () => {
  assert.equal(page(dashboard).kind, "dashboard");
  assert.equal(page(dashboard).icon, "dashboard");
  const data = pageData(owner, dashboard) as any;
  assert.deepEqual(data.dashboard.tiles, []);
  assert.ok(data.dashboard.sources.databases.some((d: { id: string }) => d.id === tickets));
  // Viewers get no list of sources.
  assert.equal((pageData(viewer, dashboard) as any).dashboard.sources, undefined);
});

test("editors save tiles, viewers and strangers cannot", () => {
  const tiles = [{ id: "t1", type: "text", size: "full", text: "**Hallo** <script>x()</script>" }];
  assert.throws(() => act({ action: "dashboard.save", pageId: dashboard, tiles }, viewer), (e: any) => e.status === 403);
  assert.throws(() => act({ action: "dashboard.save", pageId: dashboard, tiles }, stranger));
  const saved = act({ action: "dashboard.save", pageId: dashboard, tiles }, editor);
  assert.equal(saved.tiles[0].size, "full");
  const data = pageData(viewer, dashboard) as any;
  assert.equal(data.dashboard.tiles.length, 1);
  assert.match(data.dashboard.data.t1.html, /<strong>Hallo<\/strong>/);
  assert.doesNotMatch(data.dashboard.data.t1.html, /<script/);
  // Invalid tiles change nothing.
  assert.throws(() => act({ action: "dashboard.save", pageId: dashboard, tiles: [{ id: "t1", type: "bogus" }] }, editor));
  assert.equal(pageData(owner, dashboard).dashboard!.tiles.length, 1);
  // Only dashboards take tiles; locked pages none.
  assert.throws(() => act({ action: "dashboard.save", pageId: tickets, tiles }), /Kein Dashboard/);
  act({ action: "page.update", pageId: dashboard, patch: { locked: true } });
  assert.throws(() => act({ action: "dashboard.save", pageId: dashboard, tiles }, editor), (e: any) => e.status === 409);
  act({ action: "page.update", pageId: dashboard, patch: { locked: false } });
});

test("number tiles count records of a view and roll up numbers towards a target", () => {
  act({
    action: "dashboard.save",
    pageId: dashboard,
    tiles: [
      { id: "count", type: "number", source: tickets, view: "open" },
      { id: "sum", type: "number", source: tickets, aggregate: "sum", field: "hours", target: 36 },
      { id: "max", type: "number", source: tickets, aggregate: "max", field: "hours", view: "open" },
    ],
  });
  const data = (pageData(viewer, dashboard) as any).dashboard.data;
  assert.equal(data.count.value, 2);
  assert.equal(data.count.view, "Open");
  assert.equal(data.sum.value, 18);
  assert.equal(data.sum.progress, 0.5);
  assert.equal(data.max.value, 6);
});

test("chart tiles carry the filtered records and a chart view", () => {
  act({
    action: "dashboard.save",
    pageId: dashboard,
    tiles: [{ id: "chart", type: "chart", source: tickets, view: "open", kind: "donut", xField: "status", aggregate: "sum", yField: "hours" }],
  });
  const chart = (pageData(owner, dashboard) as any).dashboard.data.chart;
  assert.equal(chart.rows.length, 2);
  assert.equal(chart.view.type, "chart");
  assert.equal(chart.view.chart.kind, "donut");
  assert.equal(chart.view.chart.yField, "hours");
});

test("journal tiles give the streak and today's entry; locked journals stay closed", () => {
  const journal = act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "journal", title: "Tagebuch" }).id as string;
  for (const [day, text] of [
    ["2026-10-18", "Erster Tag"],
    ["2026-10-19", "Zweiter Tag"],
    ["2026-10-20", ""],
    ["2026-10-21", "Heute geschrieben"],
  ]) {
    const { dayId } = rollJournal(owner, page(journal), day, day);
    const html = text ? `<p>${text}</p>` : "";
    run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(html), html, dayId);
  }
  act({ action: "dashboard.save", pageId: dashboard, tiles: [{ id: "j", type: "journal", source: journal }] });
  const tile = (pageData(owner, dashboard) as any).dashboard.data.j;
  assert.equal(tile.journalId, journal);
  const written = new Set<string>(tile.days.filter((d: any) => d.written).map((d: any) => d.date));
  assert.deepEqual([...written].sort(), ["2026-10-18", "2026-10-19", "2026-10-21"]);
  assert.equal(currentStreak(written, "2026-10-21"), 1);
  assert.equal(currentStreak(written, "2026-10-19"), 2);
  assert.equal(tile.days.find((d: any) => d.date === "2026-10-21").excerpt, "Heute geschrieben");
  // Behind a PIN the editor has not entered: nothing about the journal.
  act({ action: "journal.lock", pageId: journal, pin: "123456" });
  const locked = (pageData(editor, dashboard) as any).dashboard.data.j;
  assert.deepEqual(locked, { available: false });
});

test("a tile over a database the viewer cannot read yields no data and no hint", () => {
  act({
    action: "dashboard.save",
    pageId: dashboard,
    tiles: [
      { id: "n", type: "number", source: secret, title: "" },
      { id: "c", type: "chart", source: secret },
      { id: "v", type: "view", source: secret },
      { id: "gone", type: "number", source: id() },
      { id: "ok", type: "number", source: tickets },
    ],
  });
  const viewerData = (pageData(viewer, dashboard) as any).dashboard;
  for (const key of ["n", "c", "v", "gone"]) assert.deepEqual(viewerData.data[key], { available: false });
  assert.equal(viewerData.data.ok.value, 3);
  assert.doesNotMatch(JSON.stringify(viewerData), /Geheime Gehälter/);
  // The owner reads the same tiles.
  const ownerData = (pageData(owner, dashboard) as any).dashboard.data;
  assert.equal(ownerData.n.value, 0);
  assert.equal(ownerData.v.title, "Geheime Gehälter");
  assert.equal((dashboardData(owner, page(dashboard), "owner").data.v as { available: boolean }).available, true);
  // Exports name the source only for people who can read it.
  assert.ok(dashboardSummary(owner, page(dashboard)).some((t) => t.source === "Geheime Gehälter"));
  assert.ok(!dashboardSummary(viewer, page(dashboard)).some((t) => t.source === "Geheime Gehälter"));
});

test("tasks and recent pages tiles, duplication, export and trash", async () => {
  act({
    action: "dashboard.save",
    pageId: dashboard,
    tiles: [
      { id: "tasks", type: "tasks", size: "small" },
      { id: "recent", type: "recent", limit: 3 },
      { id: "text", type: "text", title: "Notiz", text: "Ein *Text*" },
      { id: "local", type: "number", source: tickets },
    ],
  });
  const data = (pageData(owner, dashboard) as any).dashboard.data;
  assert.ok(Array.isArray(data.tasks.tasks));
  assert.equal(data.recent.pages.length, 3);
  assert.ok(!data.recent.pages.some((p: { id: string }) => p.id === dashboard));
  assert.equal(typeof data.recent.unread, "number");
  // A copy keeps the tiles (and copies of copied sources).
  const copy = act({ action: "page.duplicate", pageId: dashboard }).id as string;
  assert.equal(page(copy).kind, "dashboard");
  assert.deepEqual((pageData(owner, copy) as any).dashboard.tiles.map((t: { id: string }) => t.id), ["tasks", "recent", "text", "local"]);
  // Markdown export: a text summary.
  const exported = await exportMarkdown(owner, { pageId: dashboard, format: "markdown" } as any);
  const text = Buffer.from((exported as { bytes: Uint8Array }).bytes).toString("utf8");
  assert.match(text, /## Notiz\n\nEin \*Text\*/);
  assert.match(text, /Tickets/);
  // Trash and restore keep the tiles.
  act({ action: "page.delete", pageId: copy });
  act({ action: "page.restore", pageId: copy });
  assert.equal((pageData(owner, copy) as any).dashboard.tiles.length, 4);
});
