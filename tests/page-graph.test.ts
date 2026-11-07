import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-graph-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { pageGraph, unlinkedMentions } = await import("../lib/page-graph");
const { layoutGraph } = await import("../components/page-graph");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Anna", "anna@example.test");
const anna = { id: uid, name: "Anna", email: "anna@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(anna.id, "Team");
const space = (await bootstrap(anna, wid)).spaces[0].id;
const create = async (title: string, parentId?: string) =>
  ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "document", ...(parentId ? { parentId } : {}) })) as { id: string }).id;
const write = async (pageId: string, html: string) =>
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const roadmap = await create("Roadmap 2027");
const notes = await create("Teamnotizen");
const child = await create("Unterseite", notes);
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);

test("links between pages become edges of the graph", async () => {
  await write(notes, `<p>Siehe <a href="/#page=${roadmap}">Plan</a></p>`);
  const graph = await pageGraph(anna, wid);
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(ids.has(roadmap) && ids.has(notes) && ids.has(child));
  assert.ok(graph.edges.some((e) => e.from === notes && e.to === roadmap && e.kind === "link"));
  assert.ok(graph.edges.some((e) => e.from === notes && e.to === child && e.kind === "parent"));
  assert.equal(graph.nodes.find((n) => n.id === roadmap)!.links, 1);
  // The layout puts linked pages closer together than unlinked ones.
  const pos = layoutGraph(graph.nodes, graph.edges.filter((e) => e.kind === "link"));
  const d = (a: string, b: string) => Math.hypot(pos.get(a)!.x - pos.get(b)!.x, pos.get(a)!.y - pos.get(b)!.y);
  assert.ok(d(notes, roadmap) < d(child, roadmap));
});

test("unlinked mentions are found and turned into a link", async () => {
  await write(child, "<p>Wir reden morgen über die roadmap 2027 und mehr.</p>");
  const found = await unlinkedMentions(anna, (await one("SELECT * FROM pages WHERE id=?", roadmap))!);
  assert.deepEqual(found.map((m) => m.id), [child]);
  assert.match(found[0].snippet, /roadmap 2027/);
  await command(anna, { action: "mention.link", pageId: child, targetId: roadmap });
  assert.match(await html(child), new RegExp(`<a[^>]*href="/#page=${roadmap}"[^>]*>roadmap 2027</a>`));
  assert.deepEqual(await unlinkedMentions(anna, (await one("SELECT * FROM pages WHERE id=?", roadmap))!), []);
  await assert.rejects(async () => await command(anna, { action: "mention.link", pageId: child, targetId: roadmap }), /nicht mehr im Text/);
});

const database = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title: "Kunden", kind: "database" })) as { id: string }).id;
const record = ((await command(anna, { action: "row.create", pageId: database, cells: { title: "Bäckerei Krause" } })) as { id: string }).id;
const other = ((await command(anna, { action: "row.create", pageId: database, cells: { title: "Weingut Sommer" } })) as { id: string }).id;
const writeRecord = async (rowId: string, text: string) =>
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET state=excluded.state,html=excluded.html",
    rowId,
    htmlState(text),
    text,
    id(),
  );
const recordHtml = async (rowId: string) => String((await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId))!.html);
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const version = async (rowId: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version;

test("records that link or are linked are part of the graph", async () => {
  await write(roadmap, `<p>Pilot mit <a href="/#page=${database}&amp;row=${record}">Bäckerei Krause</a></p>`);
  await writeRecord(other, `<p>Siehe <a href="/#page=${notes}">Teamnotizen</a></p>`);
  const graph = await pageGraph(anna, wid);
  const node = graph.nodes.find((n) => n.id === record);
  assert.equal(node?.kind, "record");
  assert.equal("pageId" in node! && node.pageId, database);
  assert.ok(graph.edges.some((e) => e.from === roadmap && e.to === record));
  assert.ok(graph.edges.some((e) => e.from === other && e.to === notes));
  // A link to a record does not count as a link to its database.
  assert.ok(!graph.edges.some((e) => e.from === roadmap && e.to === database));
});

test("records have unlinked mentions and appear as mentions", async () => {
  await write(child, "<p>Termin bei Weingut Sommer am Freitag.</p>");
  await writeRecord(record, "<p>Die Teamnotizen erwähnen uns.</p>");
  const ofRecord = await unlinkedMentions(anna, await page(database), other);
  assert.deepEqual(ofRecord.map((m) => m.id), [child]);
  await command(anna, { action: "mention.link", pageId: child, targetId: database, targetRowId: other });
  assert.match(await html(child), new RegExp(`href="/#page=${database}&amp;row=${other}"[^>]*>Weingut Sommer</a>`));
  const ofPage = await unlinkedMentions(anna, await page(notes));
  assert.deepEqual(ofPage.map((m) => [m.id, m.rowId, m.title]), [[database, record, "Bäckerei Krause"]]);
  await command(anna, { action: "mention.link", pageId: database, rowId: record, targetId: notes });
  assert.match(await recordHtml(record), new RegExp(`href="/#page=${notes}"[^>]*>Teamnotizen</a>`));
});

test("link texts follow a rename, own wordings stay", async () => {
  await write(child, `<p><a href="/#page=${roadmap}">Roadmap 2027</a> und <a href="/#page=${roadmap}">der Plan</a></p>`);
  await command(anna, { action: "page.update", pageId: roadmap, patch: { title: "Roadmap 2028" } });
  assert.match(await html(child), new RegExp(`>Roadmap 2028</a> und <a[^>]*>der Plan</a>`));
  await command(anna, { action: "row.update", pageId: database, rowId: record, version: await version(record), cells: { title: "Bäckerei Krause & Söhne" } });
  assert.match(await html(roadmap), />Bäckerei Krause &amp; Söhne<\/a>/);
  // Links to the database itself keep their text.
  assert.match(await html(child), />der Plan<\/a>/);
});
