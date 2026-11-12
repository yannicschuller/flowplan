// The official templates that exist only in the Flowplan Marketplace
// (lib/marketplace-official-extra/, packaged by lib/marketplace-official.ts):
// every one is read back by the server's package reader and imported
// through its kind's own import, workflows check without errors once their
// gaps are filled, looks keep the contrast in light and dark, link rules
// are valid and link what they promise, slugs are unique, every category
// ends up with 10–20 official templates, and no client code imports the
// module (it would ship with the app).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as Y from "yjs";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-official-extra-"));
delete process.env.FLOWPLAN_MARKETPLACE_URL;
const setup = await import("./helpers/workflow-setup");
const { owner, wid, space, act, makeDatabase } = setup;
const { one, all } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { readZip } = await import("../lib/archive");
const pkgs = await import("../lib/marketplace-package");
const { officialPackages } = await import("../lib/marketplace-official");
const { extraOfficial } = await import("../lib/marketplace-official-extra");
const { templateCategoryIds } = await import("../lib/template-categories");
const { stateHtml } = await import("../lib/document-server");
const { fillTokens } = await import("../lib/workflows/templates");
const { checkGraph, parseGraph } = await import("../lib/workflows/graph");
const { nodeSpec } = await import("../lib/workflows/catalog");
const { drainWorkflows } = await import("../lib/workflows/queue");
const theme = await import("../lib/workspace-theme");
const { BUNDLED_FONT_IDS } = await import("../lib/theme-fonts");
const { ruleProblems, compileRules, findAutoLinks } = await import("../lib/auto-link");
import type { Field } from "../lib/types";

const root = new URL("..", import.meta.url).pathname;
const all1 = await officialPackages("0.9.4");
const extraKeys = new Set(extraOfficial.map((x) => `${x.kind}:${x.id}`));
const extras = all1.filter((p) => extraKeys.has(`${p.kind}:${p.id}`));
const docHtml = async (pageId: string) => {
  const state = (await one<{ state: Uint8Array }>("SELECT state FROM documents WHERE page_id=?", pageId))!.state;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return stateHtml(doc);
};

test("every category ends up with 10–20 official templates; slugs are unique and stable", async () => {
  assert.equal(extras.length, extraOfficial.length, "every extra template is packaged");
  const perCategory = new Map<string, number>();
  for (const p of all1) {
    const m = (await pkgs.readPackage(p.bytes)).manifest;
    perCategory.set(m.category, (perCategory.get(m.category) ?? 0) + 1);
  }
  for (const c of templateCategoryIds) {
    const n = perCategory.get(c) ?? 0;
    assert.ok(n >= 10 && n <= 20, `${c}: ${n} official templates`);
  }
  assert.equal(new Set(all1.map((p) => p.file)).size, all1.length, "unique file names");
  // The marketplace takes the file name as the slug: a-z, 0-9 and -, at most 60.
  for (const p of all1) assert.match(p.file, /^[a-z0-9][a-z0-9-]{0,59}\.flowplan-template$/, p.file);
  for (const x of extraOfficial) assert.match(x.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${x.id}: kebab case`);
  for (const p of extras) assert.match(p.file, /^(document|database|whiteboard|workflow|appearance|link-rules)-[a-z0-9-]+\.flowplan-template$/, p.file);
  // Every kind has official templates now, appearance and link rules included.
  assert.deepEqual([...new Set(all1.map((p) => p.kind))].sort(), ["appearance", "database", "document", "link-rules", "whiteboard", "workflow"]);
});

test("the manifests: both languages, CC0, a description, a fitting language", async () => {
  for (const x of extraOfficial) {
    const p = extras.find((e) => e.kind === x.kind && e.id === x.id)!;
    const m = (await pkgs.readPackage(p.bytes)).manifest;
    assert.equal(m.license, "CC0-1.0");
    assert.equal(m.author?.handle, "flowplan");
    assert.equal(m.category, x.category);
    assert.equal(m.language, x.language ?? "de");
    assert.ok(m.summary.de && m.summary.en && m.summary.de.length <= 300 && m.summary.en.length <= 300, `${p.file}: summaries`);
    assert.ok(m.description?.de?.includes(x.description.de) && m.description?.en?.includes(x.description.en), `${p.file}: descriptions`);
    assert.ok(m.tags.length >= 4 && m.tags.length <= 10, `${p.file}: tags`);
    assert.ok(x.title.de && x.title.en, `${p.file}: titles`);
  }
});

test("documents and databases import and create valid pages", async () => {
  for (const p of extras.filter((e) => e.kind === "document" || e.kind === "database")) {
    const parsed = await pkgs.readPackage(p.bytes);
    const result = await pkgs.importPackage(owner, parsed, { workspaceId: wid, spaceId: space });
    assert.ok(result.templateId, p.file);
    const page = (await act({ action: "page.create", workspaceId: wid, spaceId: space, templateId: result.templateId })).id as string;
    const x = extraOfficial.find((e) => e.kind === p.kind && e.id === p.id)!;
    if (x.kind === "document") {
      // The HTML survives the editor schema: every longer word is still there.
      const kept = await docHtml(page);
      const words = [...new Set(x.html.replace(/<[^>]+>/g, " ").split(/[\s…,.:;!?()„“"–/]+/).filter((w) => w.length > 7))];
      const missing = words.filter((w) => !kept.includes(w));
      assert.deepEqual(missing, [], `${p.file}: content kept`);
      continue;
    }
    if (x.kind !== "database") continue;
    const db = (await one<{ fields: string; views: string; version: number }>("SELECT fields,views,version FROM databases WHERE page_id=?", page))!;
    assert.equal(JSON.parse(db.fields).length, x.fields.length, `${p.file}: fields`);
    assert.equal(JSON.parse(db.views).length, x.views.length, `${p.file}: views`);
    // The same validation as a change in the app.
    await act({ action: "database.update", pageId: page, version: db.version, fields: JSON.parse(db.fields), views: JSON.parse(db.views) });
    const rows = await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", page);
    assert.equal(rows.length, x.rows.length, `${p.file}: example entries`);
    for (const row of rows) assert.doesNotMatch(row.cells, /"@[+-]\d+"/, `${p.file}: dates resolved`);
  }
});

test("whiteboards import with every item", async () => {
  for (const p of extras.filter((e) => e.kind === "whiteboard")) {
    const parsed = await pkgs.readPackage(p.bytes);
    assert.equal(parsed.payload.kind, "whiteboard");
    const x = extraOfficial.find((e) => e.kind === "whiteboard" && e.id === p.id)!;
    if (parsed.payload.kind === "whiteboard" && x.kind === "whiteboard") {
      assert.equal(parsed.payload.dropped, 0, `${p.file}: nothing dropped`);
      assert.equal(parsed.payload.items.length, x.items.length, `${p.file}: all items`);
      const ids = x.items.map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, `${p.file}: unique item ids`);
    }
    const result = await pkgs.importPackage(owner, parsed, { workspaceId: wid, spaceId: space });
    assert.ok(result.templateId, p.file);
  }
});

// What the person importing a workflow would pick.
const fields: Field[] = [
  { id: "title", name: "Titel", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
  { id: "owner", name: "Verantwortlich", type: "person" },
  { id: "due", name: "Fällig", type: "date" },
  { id: "mail", name: "E-Mail", type: "email" },
];
const dbId = await makeDatabase("Anfragen", fields);
await act({ action: "form.update", pageId: dbId, enabled: true, internal: true });
const minutes = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "document", title: "Protokolle" })).id as string;
const journal = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "journal", title: "Tagebuch" })).id as string;
const answers: Record<string, string> = { database: dbId, status: "status", assignee: "owner", due: "due", done: "Erledigt", person: owner.id, parent: minutes, host: owner.id, journal, email: "mail", team: owner.id };

test("workflows: only catalogue nodes, gaps filled they check without errors, cleared they import as a draft", async () => {
  for (const p of extras.filter((e) => e.kind === "workflow")) {
    const x = extraOfficial.find((e) => e.kind === "workflow" && e.id === p.id)!;
    if (x.kind !== "workflow") continue;
    for (const n of x.nodes) assert.ok(nodeSpec(n.type), `${p.file}: ${n.type} is a catalogue node`);
    const entries = await readZip(p.bytes, { foreign: true });
    const raw = JSON.parse(entries.get("payload/workflow.json")!.toString("utf8"));
    const tokens = new Set([...JSON.stringify(raw.graph.nodes).matchAll(/\$ask:([a-z0-9_]+)/gi)].map((m) => m[1]));
    assert.deepEqual([...tokens].sort(), x.gaps.map((g) => g.id).sort(), `${p.file}: every gap is used, no token without a gap`);
    const meta = JSON.parse(entries.get("payload/workflow-meta.json")!.toString("utf8"));
    assert.deepEqual(Object.keys(meta.nodes).sort(), [...new Set(x.nodes.map((n) => n.type))].sort(), `${p.file}: meta names every node type`);
    assert.equal(meta.gaps.length, x.gaps.length);
    // Filled in: the structural check and the server's check with references.
    const graph = fillTokens(parseGraph(raw.graph), answers);
    assert.doesNotMatch(JSON.stringify(graph.nodes), /\$ask:/);
    assert.deepEqual(checkGraph(graph).filter((i) => i.level === "error"), [], p.file);
    const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: x.title.de })).id as string;
    const saved = await act({ action: "workflow.draft", pageId, graph });
    assert.deepEqual(saved.issues.filter((i: { level: string }) => i.level === "error"), [], `${p.file}: ${JSON.stringify(saved.issues)}`);
    // A dry run with sample data goes through (the journal's sample day is
    // no real page: that one runs for real below), and it can be activated.
    if (x.id !== "journal-prompts") {
      const dry = await act({ action: "workflow.test", pageId, mode: "dry", data: { kind: "sample" } });
      assert.equal(dry.ok, true, p.file);
      await drainWorkflows();
      const dryRun = await one<{ status: string; error: string | null }>("SELECT status,error FROM workflow_runs WHERE id=?", dry.runId);
      assert.equal(dryRun!.status, "succeeded", `${p.file}: ${dryRun!.error}`);
    }
    const activated = await act({ action: "workflow.activate", pageId });
    assert.equal(activated.ok, true, `${p.file}: ${JSON.stringify(activated.issues)}`);
    if (x.id === "journal-prompts") {
      await act({ action: "journal.roll", pageId: journal, date: new Date().toISOString().slice(0, 10), write: true });
      await drainWorkflows();
      const runs = await all<{ status: string; error: string | null }>("SELECT status,error FROM workflow_runs WHERE page_id=?", pageId);
      assert.deepEqual(runs.map((r) => r.status), ["succeeded"], `${p.file}: ${runs.map((r) => r.error).join()}`);
      const day = (await one<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND deleted_at IS NULL", journal))!.id;
      assert.match(await docHtml(day), /dankbar/, "the prompts are on the day's page");
    }
    // Through the marketplace import: a paused draft, open gaps cleared and counted.
    const parsed = await pkgs.readPackage(p.bytes);
    const result = await pkgs.importPackage(owner, parsed, { workspaceId: wid, spaceId: space });
    assert.ok(result.pageId, p.file);
    assert.equal(result.gaps, x.gaps.length, `${p.file}: gaps listed`);
    const imported = await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", result.pageId as string);
    if (imported) assert.notEqual(imported.status, "active", `${p.file}: not active after the import`);
  }
});

test("looks: bundled faces only, readable accents in light and dark on their background", async () => {
  for (const p of extras.filter((e) => e.kind === "appearance")) {
    const parsed = await pkgs.readPackage(p.bytes);
    assert.equal(parsed.payload.kind, "appearance");
    if (parsed.payload.kind !== "appearance") continue;
    const look = parsed.payload.theme;
    assert.deepEqual(parsed.payload.fonts, [], `${p.file}: no uploaded fonts`);
    assert.deepEqual(theme.themeCustomFonts(look), []);
    for (const f of Object.values(look.fonts ?? {})) assert.ok(BUNDLED_FONT_IDS.includes(f!), `${p.file}: ${f} is bundled`);
    assert.ok(look.accent, `${p.file}: an accent`);
    for (const mode of ["light", "dark"] as const) {
      const palette = theme.derivePalette(look.accent!, mode, look.background);
      const s = theme.backgroundPreset(look.background)[mode];
      const where = `${p.file} ${mode}`;
      assert.ok(theme.contrast(palette.blue, palette.onAccent) >= theme.MIN_CONTRAST, `${where}: text on the accent`);
      for (const bg of [s.bg, s.surface, s.sidebar, palette.blueLight]) assert.ok(theme.contrast(palette.blue, bg) >= theme.MIN_CONTRAST, `${where}: accent on ${bg}`);
      // In light mode the accent is used as picked, not darkened.
      if (mode === "light") assert.equal(palette.adjusted, false, `${where}: readable as picked`);
    }
    // Imported into a workspace of its own (it replaces the look).
    const ws = await createWorkspace(owner.id, `Look ${p.id}`);
    const result = await pkgs.importPackage(owner, parsed, { workspaceId: ws, spaceId: null });
    assert.equal(result.imported, true, p.file);
    assert.equal(result.droppedFonts, 0);
    const stored = theme.parseTheme((await one<{ theme: string }>("SELECT theme FROM workspaces WHERE id=?", ws))!.theme);
    assert.deepEqual(stored, theme.normalizeTheme(look), `${p.file}: stored as packaged`);
  }
});

// A text per rule package and links it must produce.
const samples: Record<string, [string, string[]]> = {
  "jira-issues": ["Siehe ABC-123 und XYZ-7, nicht ISO-9001.", ["https://jira.example.com/browse/ABC-123", "https://jira.example.com/browse/XYZ-7"]],
  "github-references": ["Behoben in acme/web#42, Folge von #7 (commit 1a2b3c4d).", ["https://github.com/acme/web/issues/42", "https://github.com/OWNER/REPO/issues/7", "https://github.com/OWNER/REPO/commit/1a2b3c4d"]],
  "gitlab-references": ["Review in team/app!12, Ursache team/app#3.", ["https://gitlab.com/team/app/-/merge_requests/12", "https://gitlab.com/team/app/-/issues/3"]],
  "sentry-issues": ["Fehler WEBAPP-3K tritt wieder auf.", ["https://example.sentry.io/issues/?query=WEBAPP-3K"]],
  "research-references": [
    "Vgl. 10.1000/xyz123. und arXiv:2101.00001, RFC 9110 sowie CVE-2024-1234.",
    ["https://doi.org/10.1000/xyz123", "https://arxiv.org/abs/2101.00001", "https://www.rfc-editor.org/rfc/rfc9110", "https://nvd.nist.gov/vuln/detail/CVE-2024-1234"],
  ],
  "wikipedia-links": ["Mehr unter [[w:Kanban]] und [[en:Kanban (development)]].", ["https://de.wikipedia.org/wiki/Kanban", "https://en.wikipedia.org/wiki/Kanban%20(development)"]],
  "german-laws": ["Nach § 312g BGB und Art. 5 GG, außerdem §433 HGB.", ["https://www.gesetze-im-internet.de/bgb/__312g.html", "https://www.gesetze-im-internet.de/gg/art_5.html", "https://www.gesetze-im-internet.de/hgb/__433.html"]],
  "zendesk-tickets": ["Kunde meldet sich zu Ticket #12345 erneut.", ["https://example.zendesk.com/agent/tickets/12345"]],
};

test("link rules: valid, they link what they promise, and they import", async () => {
  const rulePackages = extras.filter((e) => e.kind === "link-rules");
  assert.deepEqual(rulePackages.map((p) => p.id).sort(), Object.keys(samples).sort());
  for (const p of rulePackages) {
    const parsed = await pkgs.readPackage(p.bytes);
    assert.equal(parsed.payload.kind, "link-rules");
    if (parsed.payload.kind !== "link-rules") continue;
    assert.equal(parsed.payload.invalid, 0, p.file);
    for (const r of parsed.payload.rules) assert.deepEqual(ruleProblems(r), [], `${p.file}: ${r.name}`);
    const compiled = compileRules(parsed.payload.rules.map((r, i) => ({ id: String(i), name: r.name ?? "", pattern: r.pattern, template: r.template, enabled: r.enabled ?? true })));
    const [text, hrefs] = samples[p.id];
    assert.deepEqual(findAutoLinks(text, compiled).map((m) => m.href), hrefs, p.file);
    const ws = await createWorkspace(owner.id, `Links ${p.id}`);
    const result = await pkgs.importPackage(owner, parsed, { workspaceId: ws, spaceId: null });
    assert.equal(result.added, parsed.payload.rules.length, p.file);
    assert.equal(result.dropped, 0);
  }
});

test("no client code imports the marketplace-only templates", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".git", "tests", "scripts", "public", ".claude"].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|mjs|js)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const importers = (needle: RegExp) =>
    files
      .filter((f) => needle.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => !f.startsWith("lib/marketplace-official-extra/"))
      .sort();
  assert.deepEqual(importers(/["'][./]*(?:lib\/)?marketplace-official-extra(?:\/[\w-]+)?["']/), ["lib/marketplace-official.ts"]);
  // And that module itself is for the generator script only.
  assert.deepEqual(importers(/["'][./]*(?:lib\/)?marketplace-official["']/), []);
});
