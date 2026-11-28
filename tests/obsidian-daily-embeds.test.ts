// Obsidian import: daily notes into the journal and the templates folder as
// saved templates (#668), embedded notes inserted as content (#672). The
// vaults are built here at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-obsidian-daily-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource } = await import("../lib/importers");
const { parseObsidian } = await import("../lib/importers/obsidian");
const { compileDateFormat, vaultConfig, templateVariables } = await import("../lib/importers/obsidian-daily");
const { embedTranscluder, countNoteEmbeds } = await import("../lib/importers/obsidian-embeds");
const { importReport } = await import("../lib/importers/types");

const vault = (files: Record<string, string>) => new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
const dateOf = (format: string, name: string) => {
  const f = compileDateFormat(format);
  assert.ok("match" in f, `${format} is supported`);
  return f.match(name);
};

test("daily notes: moment.js formats as matchers of note paths", () => {
  assert.equal(dateOf("YYYY-MM-DD", "2026-11-28"), "2026-11-28");
  assert.equal(dateOf("YYYY-MM-DD", "2026-02-30"), null, "no such day");
  assert.equal(dateOf("YYYY-MM-DD", "Ideen"), null);
  assert.equal(dateOf("DD.MM.YYYY", "28.11.2026"), "2026-11-28");
  assert.equal(dateOf("D.M.YY", "3.1.26"), "2026-01-03");
  assert.equal(dateOf("YYYY/MM/YYYY-MM-DD", "2026/11/2026-11-28"), "2026-11-28");
  assert.equal(dateOf("YYYY/MMMM/YYYY-MM-DD dddd", "2026/November/2026-11-28 Saturday"), "2026-11-28");
  assert.equal(dateOf("dddd, MMMM Do YYYY", "Saturday, November 28th 2026"), "2026-11-28");
  assert.equal(dateOf("ddd D. MMM YYYY", "Sa 7. Dez. 2026"), "2026-12-07");
  assert.equal(dateOf("[Tagebuch] YYYY-MM-DD", "Tagebuch 2026-11-28"), "2026-11-28");
  assert.equal(dateOf("YYYYMMDD", "20261128"), "2026-11-28");
  // Week numbers, times and formats without a day are not daily notes.
  for (const format of ["gggg-[W]ww", "YYYY-MM-DD HH:mm", "YYYY-MM", "YYYY-[Q]Q"]) assert.ok("unsupported" in compileDateFormat(format), format);
});

test("daily notes and templates: the settings in .obsidian", () => {
  assert.deepEqual(vaultConfig(vault({ ".obsidian/daily-notes.json": '{"folder":"/Journal/","format":"DD.MM.YYYY"}', ".obsidian/templates.json": '{"folder":"Vorlagen"}' })), {
    daily: { folder: "Journal", format: "DD.MM.YYYY" },
    templates: { folder: "Vorlagen" },
  });
  // No format: YYYY-MM-DD; Periodic Notes; the core plugin switched on without settings.
  assert.deepEqual(vaultConfig(vault({ ".obsidian/daily-notes.json": "{}" })).daily, { folder: "", format: "YYYY-MM-DD" });
  assert.deepEqual(vaultConfig(vault({ ".obsidian/plugins/periodic-notes/data.json": '{"daily":{"enabled":true,"folder":"Days","format":"YYYY/YYYY-MM-DD"}}' })).daily, {
    folder: "Days",
    format: "YYYY/YYYY-MM-DD",
  });
  assert.deepEqual(vaultConfig(vault({ ".obsidian/core-plugins.json": '["file-explorer","daily-notes"]' })).daily, { folder: "", format: "YYYY-MM-DD" });
  assert.deepEqual(vaultConfig(vault({ ".obsidian/core-plugins.json": '{"daily-notes":false}', ".obsidian/templates.json": "broken" })), { daily: null, templates: null });
});

test("daily notes become journal days; other notes of the folder stay pages and are reported", () => {
  const entries = vault({
    ".obsidian/daily-notes.json": '{"folder":"Daily","format":"YYYY-MM-DD"}',
    "Daily/2026-11-28.md": "Heute",
    "Daily/2025/2025-12-31.md": "Silvester",
    "Daily/Ideen.md": "Keine Tagesnotiz",
    "2026-01-01.md": "Liegt nicht im Ordner",
    "Projekt.md": "Siehe [[2026-11-28]]",
  });
  const tree = parseObsidian(entries, "Tresor");
  const byKey = new Map(tree.pages.map((p) => [p.key, p]));
  assert.equal(byKey.get("Daily/2026-11-28.md")!.journalDate, "2026-11-28");
  assert.equal(byKey.get("Daily/2026-11-28.md")!.parent, null, "a journal day is not in the page tree");
  assert.equal(byKey.get("Daily/2025/2025-12-31.md")!.journalDate, "2025-12-31", "moved into a subfolder");
  assert.equal(byKey.get("Daily/Ideen.md")!.journalDate, undefined);
  assert.equal(byKey.get("2026-01-01.md")!.journalDate, undefined);
  assert.ok(!tree.pages.some((p) => p.key === "folder:Daily/2025"), "no empty folder page for the archive");
  assert.match(byKey.get("Projekt.md")!.html, /fp-import:\/\/page\/Daily%2F2026-11-28\.md/);
  assert.equal(tree.dailyNotes, 2);
  assert.ok(tree.report!.entries.some((e) => e.kind === "other" && e.page === "Daily/Ideen.md"));
  // Switched off: pages as before, still counted for the preview.
  const off = parseObsidian(entries, "Tresor", { dailyNotes: false });
  assert.ok(off.pages.every((p) => !p.journalDate));
  assert.equal(off.dailyNotes, 2);
  // Folders in the format.
  const nested = parseObsidian(vault({ ".obsidian/daily-notes.json": '{"folder":"Journal","format":"YYYY/MM/YYYY-MM-DD"}', "Journal/2026/11/2026-11-28.md": "x", "Journal/2026-11-27.md": "y" }));
  assert.deepEqual(nested.pages.filter((p) => p.journalDate).map((p) => p.journalDate), ["2026-11-28"]);
  // An unsupported format: a warning, no journal days.
  const weekly = parseObsidian(vault({ ".obsidian/daily-notes.json": '{"format":"gggg-[W]ww"}', "2026-W48.md": "x" }));
  assert.ok(weekly.pages.every((p) => !p.journalDate));
  assert.ok(weekly.warnings.some((w) => w.startsWith("Das Datumsformat der Daily Notes")));
  // No daily-notes settings: nothing changes.
  assert.equal(parseObsidian(vault({ "2026-11-28.md": "x", "B.md": "[[2026-11-28]]" })).pages.find((p) => p.key === "2026-11-28.md")!.journalDate, undefined);
});

test("templates folder: saved templates with Flowplan's placeholders", () => {
  const report = importReport();
  assert.equal(
    templateVariables("# {{title}}\n{{date}} · {{date:DD.MM.YYYY}} · {{time:HH:mm}} · {{ title }} · {{Projekt}} · <% tp.date.now() %>", "T.md", report),
    "# {{Title}}\n{{Today}} · {{Today}} · {{Now}} · {{Title}} · {{Projekt}} · <% tp.date.now() %>",
  );
  const details = report.entries.map((e) => e.detail);
  assert.ok(details.some((d) => d.includes("{{date:DD.MM.YYYY}}") && d.includes("statt DD.MM.YYYY")));
  assert.ok(details.some((d) => d.includes("{{time:HH:mm}}")));
  assert.ok(details.some((d) => d.includes("{{Projekt}}") && d.includes("ohne Entsprechung")));
  assert.ok(details.some((d) => d.includes("Templater")));
  const entries = vault({
    ".obsidian/templates.json": '{"folder":"Templates"}',
    ".obsidian/daily-notes.json": '{"folder":""}',
    "Templates/Besprechung.md": "---\ntags: [meeting]\n---\n## {{title}}\nAm {{date}}\n",
    "Templates/2026-01-01.md": "Eine Vorlage, kein Tag",
    "Notiz.md": "Text",
  });
  const tree = parseObsidian(entries);
  assert.deepEqual(
    tree.templates?.map((t) => ({ key: t.key, name: t.name, kind: t.kind, tags: t.tags })),
    [
      { key: "Templates/2026-01-01.md", name: "2026-01-01", kind: "document", tags: [] },
      { key: "Templates/Besprechung.md", name: "Besprechung", kind: "document", tags: ["meeting"] },
    ],
  );
  assert.match(tree.templates![1].html, /<h2>\{\{Title\}\}<\/h2>\s*<p>Am \{\{Today\}\}<\/p>/);
  assert.deepEqual(tree.pages.map((p) => p.key), ["Notiz.md"], "no pages for templates, no folder page");
  assert.equal(tree.templateNotes, 2);
  const off = parseObsidian(entries, "Obsidian", { templates: false });
  assert.equal(off.templates, undefined);
  assert.ok(off.pages.some((p) => p.key === "Templates/Besprechung.md" && p.html.includes("{{title}}")), "as written when switched off");
});

const embedVault = {
  "A.md": "Intro\n\n![[B]]\n\nText mit ![[B]] mitten drin\n\n![[B#Teil zwei]]\n\n![[B#^satz]]\n\n![[B#^liste]]\n\n![[B#^tabelle]]\n\n![[B#Fehlt]]\n\n```\n![[B]]\n```\n",
  "B.md": "# B\nErster Satz. ^satz\n\n## Teil zwei\nZweiter Teil, siehe [[#Teil zwei]].\n\n### Unterteil\nTiefer\n\n## Teil drei\nNicht dabei\n\n- Punkt eins ^liste\n  - darunter\n- Punkt zwei\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n^tabelle\n",
};

test("embeds: off by default – links as before, counted for the preview", () => {
  const tree = parseObsidian(vault(embedVault));
  const a = tree.pages.find((p) => p.key === "A.md")!;
  assert.ok(!a.html.includes("<aside"));
  assert.ok(a.html.includes('href="fp-import://page/B.md"'));
  assert.equal(tree.noteEmbeds, 7, "the one in the code block does not count");
  assert.ok(tree.report!.entries.some((e) => e.kind === "embed" && e.page === "A.md"));
});

test("embeds: whole notes, sections and blocks inserted as content with a link to the source", () => {
  const tree = parseObsidian(vault(embedVault), "Tresor", { embeds: true });
  const html = tree.pages.find((p) => p.key === "A.md")!.html;
  const asides = html.split("<aside").slice(1);
  assert.equal(asides.length, 5, "whole note, heading and three blocks");
  // The whole note, with a link to its source and its own links pointing at it.
  assert.match(asides[0], /^ data-callout="note"><p>Aus <a href="fp-import:\/\/page\/B\.md">B<\/a><\/p>/);
  assert.match(asides[0], /Erster Satz\./);
  assert.match(asides[0], /<a href="fp-import:\/\/page\/B\.md#Teil%20zwei">Teil zwei<\/a>/);
  assert.ok(!asides[0].includes("^satz") && !asides[0].includes("data-block-id"), "block ids stay with the original");
  // The section up to the next heading of the same level, its subheadings included.
  assert.match(asides[1], /href="fp-import:\/\/page\/B\.md#Teil%20zwei">B › Teil zwei</);
  assert.match(asides[1], /Zweiter Teil/);
  assert.match(asides[1], /Unterteil/);
  assert.ok(!asides[1].includes("Nicht dabei"));
  assert.ok(!asides[1].includes("Erster Satz"));
  // Blocks: a paragraph, a list item with the items below it, a table.
  assert.match(asides[2], /<p>Erster Satz\.<\/p>\s*<\/aside>/);
  assert.match(asides[3], /Punkt eins/);
  assert.match(asides[3], /darunter/);
  assert.ok(!asides[3].includes("Punkt zwei"));
  assert.match(asides[4], /<table>/);
  // In the middle of a line, a missing section and code: links or text.
  assert.match(html, /Text mit <a href="fp-import:\/\/page\/B\.md">B<\/a> mitten drin/);
  assert.match(html, /<a href="fp-import:\/\/page\/B\.md#Fehlt">B<\/a>/);
  assert.match(html, /<code>!\[\[B\]\]/);
  const report = tree.report!.entries.filter((e) => e.page === "A.md");
  assert.equal(report.filter((e) => e.kind === "synced").length, 5);
  assert.ok(report.some((e) => e.kind === "embed" && e.detail.includes("B › Fehlt") && e.detail.includes("nicht gefunden")));
  assert.equal(tree.pages.find((p) => p.key === "B.md")!.html.includes('data-block-id="satz"'), true, "the source keeps its ids");
});

test("embeds: cycles and nesting deeper than three levels fall back to links", () => {
  const tree = parseObsidian(vault({ "A.md": "a\n\n![[B]]", "B.md": "b\n\n![[A]]", "Self.md": "## H\nx\n\n![[#H]]" }), "Tresor", { embeds: true });
  const a = tree.pages.find((p) => p.key === "A.md")!.html;
  assert.equal(a.split("<aside").length - 1, 1, "B inserted once, A not again");
  assert.match(a, /<aside data-callout="note"><p>Aus <a href="fp-import:\/\/page\/B\.md">B<\/a><\/p>\s*<p>b<\/p>\s*<p><a href="fp-import:\/\/page\/A\.md">A<\/a><\/p>/);
  assert.ok(tree.report!.entries.some((e) => e.page === "A.md" && e.kind === "embed" && e.detail.includes("bettet sich selbst ein")));
  // A section that embeds itself.
  const self = tree.pages.find((p) => p.key === "Self.md")!.html;
  assert.equal(self.split("<aside").length - 1, 1);
  assert.ok(tree.warnings.some((w) => w.startsWith("Einige eingebettete Notizen bleiben Links")));
  // A chain of five: three levels inserted, the fourth a link.
  const chain = parseObsidian(vault({ "N1.md": "1\n\n![[N2]]", "N2.md": "2\n\n![[N3]]", "N3.md": "3\n\n![[N4]]", "N4.md": "4\n\n![[N5]]", "N5.md": "5" }), "T", { embeds: true });
  const n1 = chain.pages.find((p) => p.key === "N1.md")!.html;
  assert.equal(n1.split("<aside").length - 1, 3);
  assert.match(n1, /<p>4<\/p>/);
  assert.ok(!n1.includes("<p>5</p>"));
  assert.match(n1, /href="fp-import:\/\/page\/N5\.md"/);
  assert.ok(chain.report!.entries.some((e) => e.page === "N1.md" && e.detail.includes("tiefer als 3 Ebenen")));
});

test("embeds: the budget per page and per import bounds the work, however the notes multiply", () => {
  // Ten embeds of a note that embeds ten of a note that embeds ten …:
  // without a budget 10⁴ copies.
  const files: Record<string, string> = { "L4.md": "x".repeat(500) };
  for (let level = 3; level >= 0; level--) files[`L${level}.md`] = Array.from({ length: 10 }, () => `![[L${level + 1}]]`).join("\n\n");
  const notes = new Map(Object.entries(files));
  let reads = 0;
  const report = importReport();
  const embeds = embedTranscluder(
    {
      body: (path) => {
        reads++;
        return notes.get(path) ?? null;
      },
      resolve: (_from, target) => (notes.has(`${target}.md`) ? `${target}.md` : null),
    },
    report,
    { depth: 3, perPage: 20_000, perImport: 50_000 },
  );
  const out = embeds.transclude(files["L0.md"], "L0.md");
  assert.ok(Buffer.byteLength(out) < 40_000, `bounded output (${Buffer.byteLength(out)} bytes)`);
  assert.ok(embeds.fallbacks > 0);
  assert.ok(report.entries.some((e) => e.detail.includes("zu viel eingefügter Inhalt")));
  assert.ok(reads <= 5, "each note sliced once");
  // The budget per import runs out over several pages.
  embeds.transclude(files["L0.md"], "L0.md");
  embeds.transclude(files["L0.md"], "L0.md");
  const last = embeds.transclude(files["L0.md"], "L0.md");
  assert.ok(!last.includes("[!quote]"), "nothing left for the fourth page");
  assert.equal(countNoteEmbeds(files["L0.md"], "L0.md", (_f, t) => (notes.has(`${t}.md`) ? t : null)), 10);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("import: daily notes into the journal, templates saved, embeds as content – and the preview's switches", async () => {
  const owner = await account("obsidian-daily-owner");
  const wid = await createWorkspace(owner.id, "Obsidian");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const zip = await writeZip(
    vault({
      ".obsidian/daily-notes.json": '{"folder":"Daily","format":"DD.MM.YYYY"}',
      ".obsidian/templates.json": '{"folder":"Templates"}',
      "Daily/28.11.2026.md": "Tagesnotiz\n\n![[Projekt#Stand]]",
      "Templates/Tag.md": "# {{title}}\n{{date}}",
      "Projekt.md": "## Stand\nAlles gut\n\nGestern: [[28.11.2026]]",
    }),
  );
  const file = { name: "Tresor.zip", bytes: zip };
  const preview = await importFromSource(owner, wid, space, file, { dryRun: true });
  assert.equal(preview.dailyNotes, 1);
  assert.equal(preview.journalDays, 1);
  assert.equal(preview.templateNotes, 1);
  assert.equal(preview.templates, 1);
  assert.equal(preview.noteEmbeds, 1);
  assert.equal(preview.pages, 1, "only the project is a page");
  await importFromSource(owner, wid, space, file, { embeds: true });
  const day = await one<{ id: string; title: string }>("SELECT id,title FROM pages WHERE workspace_id=? AND journal_date='2026-11-28' AND deleted_at IS NULL", wid);
  assert.ok(day, "the day is in the journal");
  const dayHtml = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", day.id))!.html;
  assert.match(dayHtml, /Tagesnotiz/);
  assert.match(dayHtml, /Alles gut/, "the section is inserted");
  const project = (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Projekt' AND deleted_at IS NULL", wid))!;
  const projectHtml = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", project.id))!.html;
  assert.ok(projectHtml.includes(day.id), "links to the daily note lead to the journal day");
  const templates = await all<{ name: string; kind: string; payload: string }>("SELECT name,kind,payload FROM templates WHERE workspace_id=? AND name='Tag'", wid);
  assert.equal(templates.length, 1);
  assert.equal(templates[0].kind, "document");
  assert.match(JSON.parse(templates[0].payload).html, /\{\{Title\}\}[\s\S]*\{\{Today\}\}/);
  assert.equal((await all("SELECT id FROM pages WHERE workspace_id=? AND title IN ('Tag','Templates','Daily','28.11.2026') AND deleted_at IS NULL", wid)).length, 0);
  // Switched off: pages as before.
  const wid2 = await createWorkspace(owner.id, "Obsidian 2");
  const space2 = (await bootstrap(owner, wid2)).spaces[0].id;
  await importFromSource(owner, wid2, space2, file, { dailyNotes: false, templates: false });
  assert.equal((await all("SELECT id FROM pages WHERE workspace_id=? AND journal_date IS NOT NULL AND deleted_at IS NULL", wid2)).length, 0);
  assert.equal((await all("SELECT id FROM pages WHERE workspace_id=? AND title IN ('Tag','28.11.2026') AND deleted_at IS NULL", wid2)).length, 2);
  assert.equal((await all("SELECT id FROM templates WHERE workspace_id=? AND name='Tag'", wid2)).length, 0);
});
