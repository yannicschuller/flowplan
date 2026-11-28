// The shared Markdown import: checkboxes in table cells (#658), embedded
// PDFs, audio and video as their blocks (#664), callout titles with their
// formatting and links (#666).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-md-import-blocks-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource } = await import("../lib/importers");
const { markdownToHtml } = await import("../lib/markdown-import");
const { htmlToMarkdown, markdownSource } = await import("../lib/markdown");
const { htmlState, stateHtml } = await import("../lib/document-server");
const Y = await import("yjs");

const canonical = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};
const context = { url: (url: string) => url, linked: () => null };
const cells = (html: string) => [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

/* ---------- #658: checkboxes in table cells ---------- */

const TASK_TABLE = [
  "| Aufgabe | Notiz |",
  "| --- | --- |",
  "| [ ] | - [x] Zwei **fett** |",
  "| [ ] Eins<br>[X] Zwei | [Link](https://example.com) |",
  "| [/] läuft 📅 2026-05-04 | [?] Frage |",
  "| \\[ \\] escaped | `[ ]` |",
  "| [1] Quelle | [-] gestrichen [Seite](https://example.com/a) |",
].join("\n");

test("checkboxes in table cells become the cell's task list", () => {
  const html = markdownToHtml(TASK_TABLE);
  const [empty, bold, two, link, progress, question, escaped, code, digit, cancelled] = cells(html);
  assert.match(empty, /^<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p><\/p><\/li><\/ul>$/);
  assert.match(bold, /data-checked="true"><p>Zwei <strong>fett<\/strong><\/p>/);
  assert.equal((two.match(/data-type="taskItem"/g) || []).length, 2, "lines split by <br> are separate tasks");
  assert.match(two, /data-checked="false"><p>Eins<\/p><\/li><li data-type="taskItem" data-checked="true"><p>Zwei<\/p>/);
  assert.doesNotMatch(link, /taskList/, "a link starting with [ is no checkbox");
  assert.match(progress, /data-status="progress" data-due="2026-05-04"><p>läuft<\/p>/);
  assert.match(question, /data-symbol="\?"><p>Frage<\/p>/);
  assert.equal(escaped, "[ ] escaped", "escaped brackets stay text");
  assert.equal(code, "<code>[ ]</code>", "inline code stays text");
  assert.equal(digit, "[1] Quelle", "a digit is no task state");
  assert.match(cancelled, /data-checked="true" data-status="cancelled"><p>gestrichen <a href="https:\/\/example\.com\/a"[^>]*>Seite<\/a><\/p>/);
  // Header cells stay text.
  assert.match(markdownToHtml("| [ ] Kopf |\n| --- |\n| x |"), /<th>\[ \] Kopf<\/th>/);
});

test("a cell mixes text and tasks; the table survives the editor", () => {
  const html = markdownToHtml("| a |\n| --- |\n| Notiz<br>[x] erledigt<br>danach |");
  assert.match(cells(html)[0], /^<p>Notiz<\/p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>erledigt<\/p><\/li><\/ul><p>danach<\/p>$/);
  const stored = canonical(markdownToHtml(TASK_TABLE));
  assert.equal((stored.match(/<td>(?:<p><\/p>)?<ul data-type="taskList">/g) || []).length, 6, "every task cell holds a task list in the editor");
});

test("task lists in cells round-trip through the Markdown export (Git sync)", () => {
  const html = markdownToHtml(TASK_TABLE);
  const markdown = htmlToMarkdown(html, context);
  assert.match(markdown, /\| - \[ \] Eins<br>- \[x\] Zwei \|/);
  assert.match(markdown, /\| - \[\/\] läuft 📅 2026-05-04 \| - \[\?\] Frage \|/);
  assert.match(markdown, /\| \\\[ \\\] escaped \|/);
  assert.equal(markdownToHtml(markdown), html, "nothing lost on the way back");
  // Text and tasks in one cell: written as lines, read back as such.
  const mixed = markdownToHtml("| a |\n| --- |\n| Notiz<br>[x] erledigt<br>danach |");
  const written = htmlToMarkdown(mixed, context);
  assert.match(written, /\| Notiz<br><br>- \[x\] erledigt<br><br>danach \|/);
  assert.equal(markdownToHtml(written), mixed);
});

test("the source view keeps a task table a pipe table, other cells as a kept block", () => {
  const html = canonical(markdownToHtml(TASK_TABLE));
  const source = markdownSource(html);
  assert.equal(source.blocks.length, 0, "no block kept aside");
  assert.match(source.markdown, /^\| Aufgabe \| Notiz \|/);
  assert.equal(canonical(markdownToHtml(source.markdown, (href) => href, { source: true })), html);
  // Text beside tasks in a cell is more than a pipe table holds: kept as HTML.
  const mixed = canonical(markdownToHtml("| a |\n| --- |\n| Notiz<br>[x] erledigt |"));
  const kept = markdownSource(mixed);
  assert.equal(kept.blocks.length, 1);
  const back = markdownToHtml(kept.markdown, (href) => href, { source: true, blocks: (index) => kept.blocks[index]?.html ?? null });
  assert.equal(canonical(back), mixed);
  // So is a subtask.
  const nested = canonical(
    '<table><tbody><tr><td><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>a</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>b</p></li></ul></li></ul></td></tr></tbody></table>',
  );
  assert.equal(markdownSource(nested).blocks.length, 1);
});

/* ---------- #666: callout titles ---------- */

test("callout titles keep their inline formatting and links", () => {
  const tip = markdownToHtml("> [!tip]+ Mit **fett**, *kursiv*, `code` und [Link](https://example.com)\n> Inhalt");
  assert.match(tip, /^<aside data-callout="tip"><p><strong>Mit <strong>fett<\/strong>, <em>kursiv<\/em>, <code>code<\/code> und <a href="https:\/\/example\.com"[^>]*>Link<\/a><\/strong><\/p>\s*<p>Inhalt<\/p>/);
  // GitHub alerts: no title, the text below.
  assert.match(markdownToHtml("> [!NOTE]\n> Hinweis"), /^<aside data-callout="note"><p>Hinweis<\/p>/);
  // A folded callout with an empty title; a title alone in the callout.
  assert.match(markdownToHtml("> [!warning]-\n> Text"), /^<aside data-callout="warning"><p>Text<\/p>/);
  assert.match(markdownToHtml("> [!danger] Nur [Titel](https://example.com)"), /^<aside data-callout="caution"><p><strong>Nur <a href="https:\/\/example\.com"[^>]*>Titel<\/a><\/strong><\/p><p><\/p><\/aside>/);
  // A hard line break ends the title.
  assert.match(markdownToHtml("> [!info] **Titel**  \n> Zeile"), /^<aside data-callout="note"><p><strong><strong>Titel<\/strong><\/strong><\/p>|^<aside data-callout="note"><p><strong>Titel<\/strong><\/p>/);
  // Formatting that runs on into the next line stays in the text.
  const open = markdownToHtml("> [!note] **lang\n> weiter** Text");
  assert.match(open, /^<aside data-callout="note"><p><strong>lang\s+weiter<\/strong> Text<\/p>/);
});

test("callout titles stay sanitized", () => {
  const html = markdownToHtml('> [!note] <img src=x onerror="alert(1)"> [x](javascript:alert(1)) <b>fett</b>\n> Text');
  assert.doesNotMatch(html, /<img|javascript:|<b>/);
  assert.match(html, /^<aside data-callout="note"><p><strong>&lt;img/);
});

/* ---------- #664: embedded PDFs, audio and video ---------- */

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("embedded PDFs, audio and video from an import become their blocks", async () => {
  const owner = await account("md-blocks-owner");
  const wid = await createWorkspace(owner.id, "Einbettungen");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ae0000000049454e44ae426082", "hex");
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
  const note = [
    "# Medien",
    "",
    "![[spec.pdf]]",
    "",
    "![[memo.mp3]]",
    "",
    "![[clip.mp4]]",
    "",
    "![[bild.png]]",
    "",
    "![[archiv.zip]]",
    "",
    "![[kaputt.pdf]]",
    "",
    "Siehe ![[spec.pdf]] im Text.",
  ].join("\n");
  const bytes = await writeZip(
    new Map([
      ["Tresor/Medien.md", Buffer.from(note)],
      ["Tresor/Anhänge/spec.pdf", Buffer.from("%PDF-1.4\n%%EOF\n")],
      ["Tresor/Anhänge/memo.mp3", Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32)])],
      ["Tresor/Anhänge/clip.mp4", mp4],
      ["Tresor/Anhänge/bild.png", png],
      ["Tresor/Anhänge/archiv.zip", Buffer.from("PK\u0005\u0006" + "\0".repeat(18))],
      // Says PDF, is none: stays a download link.
      ["Tresor/Anhänge/kaputt.pdf", Buffer.from("not a pdf")],
      ["Tresor/.obsidian/app.json", Buffer.from("{}")],
    ]),
  );
  const preview = await importFromSource(owner, wid, space, { name: "Tresor.zip", bytes }, { dryRun: true });
  assert.equal(preview.files, 6, "every embedded file counts towards the import's size");
  await importFromSource(owner, wid, space, { name: "Tresor.zip", bytes });
  const page = (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Medien' AND deleted_at IS NULL", wid))!;
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id))!.html;
  const files = new Map((await all<{ id: string; name: string }>("SELECT id,name FROM files WHERE page_id=?", page.id)).map((f) => [f.name, `/api/files/${f.id}`]));
  assert.equal(files.size, 6);
  const pdf = files.get("spec.pdf")!;
  assert.equal(html.split(`data-pdf="${pdf}"`).length - 1, 2, "the PDF preview, also for the embed inside text");
  assert.match(html, new RegExp(`<audio src="${files.get("memo.mp3")}"[^>]*controls`));
  assert.match(html, new RegExp(`<video src="${files.get("clip.mp4")}"[^>]*controls`));
  assert.match(html, new RegExp(`<img src="${files.get("bild.png")}"`));
  assert.match(html, new RegExp(`<a href="${files.get("archiv.zip")}"[^>]*>archiv\\.zip</a>`));
  assert.match(html, new RegExp(`<a href="${files.get("kaputt.pdf")}"[^>]*>kaputt\\.pdf</a>`));
  assert.doesNotMatch(html, new RegExp(`data-pdf="${files.get("kaputt.pdf")}"`));
  assert.doesNotMatch(html, /fp-import:/);
  // The text around an embed inside a paragraph stays, in the editor too.
  const editor = canonical(html);
  assert.match(editor, /<p>Siehe ?<\/p><div data-pdf="[^"]+" data-title="spec\.pdf"[^>]*>.*?<\/div><p> ?im Text\.<\/p>$/, "no empty paragraph is left behind");
  assert.equal(editor.split(`data-pdf="${pdf}"`).length - 1, 2);
  assert.match(editor, /<audio [^>]*class="media-block"/);
  assert.match(editor, /<video [^>]*class="media-block"/);
});
