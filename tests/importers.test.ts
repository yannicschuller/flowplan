import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-importers-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource, parseImport, detectSource, zipEntries } = await import("../lib/importers");
const { convertWikilinks, noteTags } = await import("../lib/importers/obsidian");
const { unwrapGoogleLink } = await import("../lib/importers/google-docs");
const { docxEntriesToHtml } = await import("../lib/importers/docx");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("importers-owner"),
  viewer = account("importers-viewer");
const wid = createWorkspace(owner.id, "Importe");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = bootstrap(owner, wid).spaces[0].id;

const fixtures = join(import.meta.dirname, "fixtures", "import");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const zipDir = (dir: string, extra: Record<string, Buffer> = {}) =>
  writeZip(new Map([...walk(join(fixtures, dir)).map((f) => [relative(join(fixtures, dir), f), readFileSync(f)] as [string, Buffer]), ...Object.entries(extra)]));
const pageHtml = (pageId: string) => one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html;
const pageByTitle = (title: string) =>
  one<{ id: string; parent_id: string | null; aliases: string | null; updated_at: string }>(
    "SELECT id,parent_id,aliases,updated_at FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 1",
    wid,
    title,
  )!;
const fileCount = () => Number(one<{ n: number }>("SELECT COUNT(*) n FROM files")!.n);

test("formats are recognised from the file and its contents", async () => {
  const enex = readFileSync(join(fixtures, "evernote/Notizbuch.enex"));
  assert.equal(detectSource("export.xml", enex), "evernote");
  assert.equal(detectSource("Notizbuch.enex", Buffer.from("x")), "evernote");
  assert.equal(detectSource("space.zip", Buffer.from("PK"), await zipEntries(await zipDir("confluence-html"))), "confluence");
  assert.equal(detectSource("space.zip", Buffer.from("PK"), await zipEntries(await zipDir("confluence-xml"))), "confluence");
  assert.equal(detectSource("vault.zip", Buffer.from("PK"), await zipEntries(await zipDir("obsidian"))), "obsidian");
  assert.equal(detectSource("takeout.zip", Buffer.from("PK"), await zipEntries(await zipDir("google-takeout"))), "gdocs");
  assert.equal(detectSource("Bericht.docx", Buffer.from("PK"), await zipEntries(await zipDir("docx"))), "gdocs");
  await assert.rejects(parseImport("bild.png", Buffer.from("not a known format")), /nicht erkannt/);
});

test("Evernote: notes with ENML, tasks, resources by hash, tags and dates", async () => {
  const bytes = readFileSync(join(fixtures, "evernote/Notizbuch.enex"));
  const preview = await importFromSource(owner, wid, space, { name: "Notizbuch.enex", bytes }, { dryRun: true });
  assert.equal(preview.pages, 2);
  assert.equal(preview.files, 2);
  assert.equal(preview.tags, 2);
  assert.ok(preview.warnings.some((w) => /Verschlüsselt/.test(w)));
  const files = fileCount();
  assert.equal(all("SELECT id FROM pages WHERE title='Einkaufsliste & Ideen'").length, 0, "the preview writes nothing");
  const result = await importFromSource(owner, wid, space, { name: "Notizbuch.enex", bytes });
  assert.equal(result.rootIds.length, 2);
  const page = pageByTitle("Einkaufsliste & Ideen");
  const html = pageHtml(page.id);
  assert.match(html, /#privat #listen/);
  assert.match(html, /https:\/\/example\.com\/rezept/);
  assert.match(html, /<strong>Wichtig:<\/strong> Milch kaufen/);
  assert.match(html, /data-type="taskList"/);
  assert.equal((html.match(/data-type="taskItem"/g) || []).length, 2, "both checkboxes form one list");
  assert.match(html, /data-checked="true"/);
  assert.match(html, /<img src="\/api\/files\/[0-9a-f-]{36}"/);
  assert.match(html, /<a href="\/api\/files\/[0-9a-f-]{36}"[^>]*>rechnung\.pdf<\/a>/);
  assert.doesNotMatch(html, /javascript:|<script/);
  assert.equal(fileCount(), files + 2);
  const pdf = one<{ mime: string; name: string }>("SELECT mime,name FROM files WHERE page_id=? AND name='rechnung.pdf'", page.id)!;
  assert.equal(pdf.mime, "application/pdf");
  assert.match(page.updated_at, /^2026-01-03 10:11:12/);
});

test("Evernote into a database: tags, dates and source as properties", async () => {
  const bytes = readFileSync(join(fixtures, "evernote/Notizbuch.enex"));
  const result = await importFromSource(owner, wid, space, { name: "Notizbuch.enex", bytes }, { mode: "database" });
  assert.ok(result.databaseId);
  assert.equal(result.rows, 2);
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", result.databaseId)!.fields) as { id: string; type: string; options?: string[] }[];
  assert.deepEqual(fields.find((f) => f.id === "imp_tags")?.options?.sort(), ["listen", "privat"]);
  assert.ok(fields.some((f) => f.id === "imp_url" && f.type === "url"));
  const rows = all<{ cells: string; created_at: string }>("SELECT cells,created_at FROM rows WHERE page_id=? ORDER BY position", result.databaseId!);
  const first = JSON.parse(rows[0].cells);
  assert.equal(first.title, "Einkaufsliste & Ideen");
  assert.deepEqual(first.imp_tags, ["privat", "listen"]);
  assert.equal(first.imp_created, "2026-01-02");
  assert.equal(first.imp_url, "https://example.com/rezept");
  assert.match(rows[0].created_at, /^2026-01-02 08:09:10/);
  assert.equal(JSON.parse(rows[1].cells).imp_created, "2025-05-05");
});

test("Confluence HTML export: page tree, callouts, code, tasks, attachments", async () => {
  const bytes = await zipDir("confluence-html");
  const result = await importFromSource(owner, wid, space, { name: "DOC.zip", bytes });
  assert.equal(result.pages, 3);
  const home = pageByTitle("Home"),
    guide = pageByTitle("Anleitung"),
    details = pageByTitle("Details");
  assert.equal(guide.parent_id, home.id);
  assert.equal(details.parent_id, guide.id);
  const html = pageHtml(home.id);
  assert.match(html, new RegExp(`href="/#page=${guide.id}"`));
  assert.match(html, /<aside data-callout="caution">/);
  assert.match(html, /<pre><code>npm install<\/code><\/pre>/);
  assert.match(html, /data-checked="true"/);
  assert.doesNotMatch(html, /javascript:|onclick|<script/);
  assert.match(pageHtml(guide.id), /<img src="\/api\/files\//);
  assert.match(pageHtml(guide.id), /<table>/);
  assert.match(pageHtml(details.id), /<details><summary>Mehr anzeigen<\/summary>/);
});

test("Confluence XML export: current versions, storage format, page links and attachments", async () => {
  const bytes = await zipDir("confluence-xml");
  const preview = await importFromSource(owner, wid, space, { name: "xml.zip", bytes }, { dryRun: true });
  assert.equal(preview.pages, 2, "the historical version is skipped");
  assert.ok(preview.warnings.some((w) => /toc/.test(w)));
  await importFromSource(owner, wid, space, { name: "xml.zip", bytes });
  const start = pageByTitle("Start"),
    sub = pageByTitle("Unterseite");
  assert.equal(sub.parent_id, start.id);
  const html = pageHtml(start.id);
  assert.match(html, new RegExp(`<a href="/#page=${sub.id}"[^>]*>hier</a>`));
  assert.match(html, /<aside data-callout="note"><p><strong>Hinweis<\/strong><\/p><p>Info-Text<\/p><\/aside>/);
  assert.match(html, /let a = 1 &lt; 2;/);
  assert.match(html, /data-checked="true"/);
  assert.match(pageHtml(sub.id), /<img src="\/api\/files\/[0-9a-f-]{36}" alt="diagramm\.png"/);
});

test("Google Docs: Takeout HTML with classes, nested lists, images and a DOCX", async () => {
  const docx = await zipDir("docx");
  const bytes = await zipDir("google-takeout", { "Takeout/Drive/Bericht.docx": docx });
  const result = await importFromSource(owner, wid, space, { name: "takeout.zip", bytes }, { source: "gdocs" });
  assert.equal(result.pages, 2);
  assert.equal(result.folders, 1);
  const plan = pageByTitle("Plan");
  assert.equal(plan.parent_id, pageByTitle("Projekte").id);
  const html = pageHtml(plan.id);
  assert.match(html, /<strong>Fett<\/strong> und <em>kursiv<\/em>/);
  assert.match(html, /href="https:\/\/example\.org\/ziel"/);
  assert.match(html, /<ul><li><p>Punkt A<\/p><ul><li><p>Unterpunkt<\/p><\/li><\/ul><\/li><li><p>Punkt B<\/p><\/li><\/ul>/);
  assert.equal((html.match(/<img src="\/api\/files\//g) || []).length, 2, "file and data: images are stored");
  assert.doesNotMatch(html, /data:image/);
  const report = pageHtml(pageByTitle("Bericht").id);
  assert.match(report, /<h1>Bericht<\/h1>/);
  assert.match(report, /<ol><li><p>Erstens<\/p><ol><li><p>Unterpunkt<\/p><\/li><\/ol><\/li><li><p>Aufzählung<\/p><\/li><\/ol>/);
  assert.match(report, /<td colspan="2"/);
  assert.match(report, /<a href="https:\/\/example\.net\/"[^>]*>Webseite<\/a>/);
  assert.match(report, /<img src="\/api\/files\//);
  assert.equal(unwrapGoogleLink("https://www.google.com/url?q=https://a.example/x&sa=D"), "https://a.example/x");
  assert.equal(docxEntriesToHtml(new Map(), "x").html, "");
});

test("Obsidian: wikilinks, embeds, callouts, tags, aliases and folders as page tree", async () => {
  const bytes = await zipDir("obsidian");
  const result = await importFromSource(owner, wid, space, { name: "Tresor.zip", bytes });
  assert.equal(result.files, 1);
  const start = pageByTitle("Start"),
    alpha = pageByTitle("Alpha"),
    notes = pageByTitle("Notizen"),
    projects = pageByTitle("Projekte");
  assert.equal(alpha.parent_id, projects.id, "the folder note stands for its folder");
  assert.equal(notes.parent_id, alpha.id);
  assert.equal(pageByTitle("Übersicht").parent_id, projects.id);
  assert.deepEqual(JSON.parse(start.aliases!), ["Startseite"]);
  const html = pageHtml(start.id);
  assert.match(html, new RegExp(`<a href="/#page=${alpha.id}"[^>]*>Alpha</a>`));
  assert.match(html, new RegExp(`<a href="/#page=${notes.id}"[^>]*>die Notizen</a>`));
  assert.match(html, /sowie Fehlt\./);
  assert.match(html, /<img src="\/api\/files\/[0-9a-f-]{36}"/);
  assert.match(html, /<aside data-callout="warning">/);
  assert.match(html, /#projekt #wichtig #idee/);
  assert.match(pageHtml(notes.id), /data-type="taskList"/);
  // The same picture, referenced twice, is stored once.
  assert.equal(all("SELECT id FROM files WHERE name='diagramm.png' AND page_id IN (?,?)", start.id, notes.id).length, 1);
  // Into a database: the tags become a property.
  const db = await importFromSource(owner, wid, space, { name: "Tresor.zip", bytes }, { mode: "database" });
  const rows = all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", db.databaseId!).map((r) => JSON.parse(r.cells));
  assert.deepEqual(rows.find((r) => r.title === "Start").imp_tags, ["projekt", "wichtig", "idee"]);
  assert.equal(rows.find((r) => r.title === "Notizen").imp_folder, "Projekte / Alpha");
});

test("wikilinks and tags: code stays untouched, labels and sizes", () => {
  const lookup = (target: string) => (target === "Seite" ? { href: "fp-import://page/Seite.md", kind: "page" as const } : target === "a.png" ? { href: "fp-import://file/a.png", kind: "file" as const } : null);
  assert.equal(convertWikilinks("[[Seite|Text]] `[[Seite]]` ![[a.png|300]] [[#Abschnitt]]", lookup), "[Text](fp-import://page/Seite.md) `[[Seite]]` ![a.png](fp-import://file/a.png) Abschnitt");
  assert.equal(convertWikilinks("```\n[[Seite]]\n```", lookup), "```\n[[Seite]]\n```");
  assert.deepEqual(noteTags({ tags: "a, #b" }, "Text #c und #123 `#d`"), ["a", "b", "c"]);
});

test("rights, page limit and quota are checked before anything is written", async () => {
  const bytes = readFileSync(join(fixtures, "evernote/Notizbuch.enex"));
  await assert.rejects(importFromSource(viewer, wid, space, { name: "n.enex", bytes }), /Rechte|Schreibrechte|editor|Keine/);
  const pages = Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n);
  const many = `<en-export>${"<note><title>x</title><content><![CDATA[<en-note><div>x</div></en-note>]]></content></note>".repeat(501)}</en-export>`;
  const preview = await importFromSource(owner, wid, space, { name: "viele.enex", bytes: Buffer.from(many) }, { dryRun: true });
  assert.ok(preview.warnings.some((w) => /500/.test(w)));
  await assert.rejects(importFromSource(owner, wid, space, { name: "viele.enex", bytes: Buffer.from(many) }), /500/);
  run("UPDATE workspaces SET quota_mb=? WHERE id=?", 0.000001, wid);
  try {
    const limited = await importFromSource(owner, wid, space, { name: "n.enex", bytes }, { dryRun: true });
    assert.ok(limited.warnings.length > 0);
    await assert.rejects(importFromSource(owner, wid, space, { name: "n.enex", bytes }));
  } finally {
    run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  }
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages")!.n), pages);
  // End-to-end encrypted spaces take no plaintext.
  run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  try {
    await assert.rejects(importFromSource(owner, wid, space, { name: "n.enex", bytes }, { dryRun: true }), (e: { status?: number }) => e.status === 409);
  } finally {
    run("UPDATE spaces SET encrypted=0 WHERE id=?", space);
  }
});
