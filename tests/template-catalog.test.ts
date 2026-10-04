import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as Y from "yjs";

process.env.FLOWPLAN_PUBLIC_SITE = "true"; // the demo exists only on the official instance
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-catalog-"));
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { templateCatalog } = await import("../lib/template-catalog");
const { templateCategoryIds } = await import("../lib/template-categories");
const { stateHtml } = await import("../lib/document-server");
const { startDemo } = await import("../lib/demo");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { computedCells } = await import("../lib/database");
const { rollJournal } = await import("../lib/journal");
const { whiteboardItems } = await import("../lib/whiteboard");

function session(uid: string) {
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ana", "ana@example.test");
const ana = session(uid);
const wid = createWorkspace(uid, "Vorlagen");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const html = (pageId: string) => {
  const state = one<{ state: Uint8Array }>("SELECT state FROM documents WHERE page_id=?", pageId)!.state;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return stateHtml(doc);
};

test("every category has several templates", () => {
  for (const category of templateCategoryIds)
    assert.ok(
      Object.values(templateCatalog).filter((t) => t.category === category).length >= 3,
      `${category} has at least three templates`,
    );
});

test("every template creates a valid page", () => {
  for (const [key, t] of Object.entries(templateCatalog)) {
    const { id: page } = command(ana, {
      action: "page.create",
      workspaceId: wid,
      spaceId: space,
      title: t.name,
      kind: t.kind,
      starterTemplate: key,
    }) as { id: string };
    assert.equal(one<{ icon: string }>("SELECT icon FROM pages WHERE id=?", page)!.icon, t.icon);
    if (t.kind === "document") {
      // The HTML survives the editor schema (nothing dropped silently).
      const text = (t.html || "").replace(/<[^>]+>/g, " ").split(/\s+/).find((w) => w.length > 6)!;
      assert.ok(html(page).includes(text), `${key}: content kept`);
      continue;
    }
    const db = one<{ fields: string; views: string; version: number }>("SELECT fields,views,version FROM databases WHERE page_id=?", page)!;
    // The same validation as a change in the app.
    command(ana, { action: "database.update", pageId: page, version: db.version, fields: JSON.parse(db.fields), views: JSON.parse(db.views) });
    const rows = all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", page);
    assert.equal(rows.length, t.rows?.length || 0, `${key}: example entries`);
    for (const row of rows) assert.doesNotMatch(row.cells, /"@[+-]\d+"/, `${key}: dates resolved`);
  }
});

test("the demo workspace shows every part of Flowplan", () => {
  saveInstanceSettings({ publicDemo: true });
  const demo = startDemo("10.9.9.9");
  const pages = all<{ id: string; title: string; kind: string }>(
    "SELECT p.id,p.title,p.kind FROM pages p JOIN members m ON m.workspace_id=p.workspace_id WHERE m.user_id=? AND p.deleted_at IS NULL",
    demo,
  );
  const byTitle = (title: string) => pages.find((p) => p.title === title)!;
  for (const title of ["Willkommen in der Demo", "Editor-Rundgang", "Projekte", "Team", "Whiteboard: Ideen sammeln", "Journal", "Wissen", "FAQ", "Anleitung"])
    assert.ok(byTitle(title), title);
  // Editor tour: every block kind survives the schema.
  const tour = html(byTitle("Editor-Rundgang").id);
  for (const marker of ["data-mermaid", "data-math", "data-spoiler", "data-columns", "data-linked-database", "data-whiteboard", "data-callout", "<details", "language-typescript", "data-type=\"taskList\"", "<table", "<iframe", "<sup>", "data-mention", "data-due", "data-reactions", "data-suggestion=\"insert\"", "data-suggestion=\"delete\"", "data-synced-block"])
    assert.ok(tour.includes(marker), `tour keeps ${marker}`);
  // Projects: all nine views, a relation with rollup and a formula.
  const projects = byTitle("Projekte").id;
  const db = one<{ fields: string; views: string }>("SELECT fields,views FROM databases WHERE page_id=?", projects)!;
  assert.deepEqual(
    JSON.parse(db.views).map((v: { type: string }) => v.type).sort(),
    ["board", "calendar", "chart", "feed", "form", "gallery", "list", "table", "timeline"],
  );
  const fields = JSON.parse(db.fields);
  const team = all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", byTitle("Team").id).map((r) => ({ ...r, cells: JSON.parse(r.cells) }));
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND cells LIKE '%Suche beschleunigen%'", projects)!;
  const cells = computedCells({ cells: JSON.parse(row.cells) } as never, fields, { [byTitle("Team").id]: team as never }, { [byTitle("Team").id]: JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", byTitle("Team").id)!.fields) });
  assert.equal(cells.rate, 95, "rollup");
  assert.equal(cells.cost, 24 * 95, "formula on the rollup");
  // Whiteboard items and the journal carrying yesterday's open tasks.
  const board = one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", byTitle("Whiteboard: Ideen sammeln").id)!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, board.state);
  const items = whiteboardItems(doc);
  assert.equal(items.length, 22);
  assert.ok(items.some((i) => i.covered));
  assert.ok(items.some((i) => i.stamps && Object.keys(i.stamps).length), "stamps");
  assert.ok(items.some((i) => i.type === "card" && i.rowId), "record card");
  assert.ok(items.some((i) => i.emoji?.startsWith("icon:")), "symbol");
  // The synced block appears on the tour and the welcome page, its tasks in "Meine Aufgaben".
  assert.ok(html(byTitle("Willkommen in der Demo").id).includes("data-synced-block"));
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM doc_tasks WHERE page_id=? AND assignee=?", byTitle("Editor-Rundgang").id, demo)!.n, 1);
  const connector = items.find((i) => i.type === "connector")!;
  assert.ok(items.some((i) => i.id === connector.from?.id), "connectors point at shapes");
  const identity = session(demo);
  const journal = one("SELECT * FROM pages WHERE id=?", byTitle("Journal").id) as never;
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const rolled = rollJournal(identity, journal, iso, iso) as { dayId: string };
  const todayHtml = html(rolled.dayId);
  assert.ok(todayHtml.includes("Interviewtermine vereinbaren"), "open task carried over");
  assert.ok(!todayHtml.includes("Protokoll verschicken"), "done task stays");
});
