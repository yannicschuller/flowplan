import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-graph-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { pageGraph, unlinkedMentions } = await import("../lib/page-graph");
const { layoutGraph } = await import("../components/page-graph");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Anna", "anna@example.test");
const anna = { id: uid, name: "Anna", email: "anna@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = createWorkspace(anna.id, "Team");
const space = bootstrap(anna, wid).spaces[0].id;
const create = (title: string, parentId?: string) =>
  (command(anna, { action: "page.create", workspaceId: wid, spaceId: space, title, kind: "document", ...(parentId ? { parentId } : {}) }) as { id: string }).id;
const write = (pageId: string, html: string) =>
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const roadmap = create("Roadmap 2027");
const notes = create("Teamnotizen");
const child = create("Unterseite", notes);
const html = (pageId: string) => String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html);

test("links between pages become edges of the graph", () => {
  write(notes, `<p>Siehe <a href="/#page=${roadmap}">Plan</a></p>`);
  const graph = pageGraph(anna, wid);
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

test("unlinked mentions are found and turned into a link", () => {
  write(child, "<p>Wir reden morgen über die roadmap 2027 und mehr.</p>");
  const found = unlinkedMentions(anna, one("SELECT * FROM pages WHERE id=?", roadmap)!);
  assert.deepEqual(found.map((m) => m.id), [child]);
  assert.match(found[0].snippet, /roadmap 2027/);
  command(anna, { action: "mention.link", pageId: child, targetId: roadmap });
  assert.match(html(child), new RegExp(`<a[^>]*href="/#page=${roadmap}"[^>]*>roadmap 2027</a>`));
  assert.deepEqual(unlinkedMentions(anna, one("SELECT * FROM pages WHERE id=?", roadmap)!), []);
  assert.throws(() => command(anna, { action: "mention.link", pageId: child, targetId: roadmap }), /nicht mehr im Text/);
});
