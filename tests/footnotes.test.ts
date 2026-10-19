import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { generateJSON } from "@tiptap/html/server";
import { EditorState } from "@tiptap/pm/state";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-footnotes-"));
const { id, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { footnoteList, footnoteTexts, renderFootnotes } = await import("../lib/footnotes");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { searchWorkspace, documentText } = await import("../lib/search-index");
const Y = await import("yjs");

const ctx = { url: (url: string) => url, linked: () => null };
const canonical = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};
const pmDoc = (html: string) => documentSchema().nodeFromJSON(generateJSON(html, documentExtensions));

const page =
  '<h2>Quellen</h2><p>Erstens<sup data-footnote="Siehe [Kapitel 2] *wörtlich* &amp; mehr: https://example.test/a_b"></sup> und zweitens<sup data-footnote="Zweite Notiz"></sup>.</p>' +
  '<ul><li><p>In einer Liste<sup data-footnote="Dritte"></sup></p></li></ul>' +
  '<table><tr><th><p>Kopf</p></th></tr><tr><td><p>Zelle<sup data-footnote="Vierte"></sup></p></td></tr></table>';

test("footnotes are kept in the document and its stored HTML", () => {
  const html = canonical(page);
  assert.equal((html.match(/<sup data-footnote="/g) || []).length, 4);
  assert.match(html, /<sup data-footnote="Zweite Notiz" class="footnote-ref"><\/sup>/);
  // Line breaks and surplus spaces in a note collapse; markup stays text.
  const messy = canonical('<p>x<sup data-footnote="  a\n  b <b>c</b> "></sup></p>');
  assert.match(messy, /data-footnote="a b &lt;b&gt;c&lt;\/b&gt;"/);
  // A plain <sup> stays superscript.
  assert.match(canonical("<p>x<sup>2</sup></p>"), /<p>x<sup>2<\/sup><\/p>/);
});

test("numbers follow the order of the markers and change with moves and deletions", () => {
  const doc = pmDoc(page);
  assert.deepEqual(
    footnoteList(doc).map((n) => [n.number, n.note]),
    [
      [1, "Siehe [Kapitel 2] *wörtlich* & mehr: https://example.test/a_b"],
      [2, "Zweite Notiz"],
      [3, "Dritte"],
      [4, "Vierte"],
    ],
  );
  const state = EditorState.create({ doc });
  const [first, second] = footnoteList(doc);
  // Deleting the first: the others move up.
  const deleted = state.apply(state.tr.delete(first.pos, first.pos + 1)).doc;
  assert.deepEqual(footnoteList(deleted).map((n) => [n.number, n.note]).slice(0, 2), [
    [1, "Zweite Notiz"],
    [2, "Dritte"],
  ]);
  // Moving the second in front of the first renumbers both; the note travels along.
  const node = doc.nodeAt(second.pos)!;
  const moved = state.tr.delete(second.pos, second.pos + 1);
  moved.insert(first.pos, node);
  assert.deepEqual(footnoteList(moved.doc).map((n) => n.note).slice(0, 2), [
    "Zweite Notiz",
    "Siehe [Kapitel 2] *wörtlich* & mehr: https://example.test/a_b",
  ]);
});

test("Markdown export writes [^n] references and definitions; import turns them back into footnotes", () => {
  const markdown = htmlToMarkdown(page, ctx);
  assert.match(markdown, /Erstens\[\^1\] und zweitens\[\^2\]\./);
  assert.match(markdown, /- In einer Liste\[\^3\]/);
  assert.match(markdown, /\| Zelle\[\^4\] \|/);
  assert.match(markdown, /\n\n\[\^1\]: Siehe \\\[Kapitel 2\\\] \\\*wörtlich\\\* &amp; mehr: https:\/\/example\.test\/a_b\n\[\^2\]: Zweite Notiz\n\[\^3\]: Dritte\n\[\^4\]: Vierte\n$/);
  const back = canonical(markdownToHtml(markdown));
  assert.deepEqual(
    footnoteList(pmDoc(back)).map((n) => n.note),
    footnoteList(pmDoc(page)).map((n) => n.note),
  );
  // Round trip is stable.
  assert.equal(htmlToMarkdown(back, ctx), markdown);
});

test("Markdown footnotes from other tools: labels, continuation lines, Obsidian inline notes, code untouched", () => {
  const html = markdownToHtml(
    [
      "Text[^quelle] und mehr[^2] und ^[Inline mit [Link](https://example.test)].",
      "",
      "```",
      "[^quelle] bleibt Code",
      "```",
      "",
      "Unbekannt[^nix] bleibt Text.",
      "",
      "[^quelle]: Erste **fett**",
      "    weiter geht's",
      "[^2]: [Seite](https://example.test/x)",
    ].join("\n"),
  );
  const notes = footnoteList(pmDoc(html)).map((n) => n.note);
  assert.deepEqual(notes, ["Erste fett weiter geht's", "Seite (https://example.test/x)", "Inline mit Link (https://example.test)"]);
  assert.match(html, /\[\^quelle\] bleibt Code/);
  assert.match(html, /Unbekannt\[\^nix\] bleibt Text/);
  assert.doesNotMatch(html, /\[\^quelle\]:/);
});

test("read-only pages number the markers and list the notes at the end", () => {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = canonical(page);
  renderFootnotes(root as unknown as HTMLElement);
  const markers = [...root.querySelectorAll("sup[data-footnote]")];
  assert.deepEqual(markers.map((m) => m.getAttribute("data-footnote-number")), ["1", "2", "3", "4"]);
  const items = [...root.querySelectorAll("section.footnotes li")];
  assert.equal(items.length, 4);
  assert.match(items[0].textContent || "", /^Siehe \[Kapitel 2\] \*wörtlich\* & mehr: https:\/\/example\.test\/a_b/);
  assert.equal(items[0].querySelector("a")?.getAttribute("href"), "https://example.test/a_b");
  // A second run does not add a second list.
  renderFootnotes(root as unknown as HTMLElement);
  assert.equal(root.querySelectorAll("section.footnotes").length, 1);
  // As a file of its own: numbers as text, jumps as anchors.
  const file = window.document.createElement("div");
  file.innerHTML = canonical(page);
  renderFootnotes(file as unknown as HTMLElement, { links: true });
  assert.equal(file.querySelector("sup a")?.getAttribute("href"), "#fn-1");
  assert.equal(file.querySelector("#fn-2 a[href='#fnref-2']")?.textContent, "↩");
});

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}

test("search finds the text of footnotes", () => {
  assert.deepEqual(footnoteTexts('<p>a<sup data-footnote="x &amp; y"></sup></p>'), ["x & y"]);
  assert.match(documentText(page), /Vierte/);
  const owner = user("owner");
  const wid = createWorkspace(owner.id, "Notes");
  const boot = bootstrap(owner, wid);
  const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "document", title: "Quellen" }) as { id: string }).id;
  const html = '<p>Behauptung<sup data-footnote="Belegt durch Zitronenfalter-Studie"></sup></p>';
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  const hits = searchWorkspace(owner, wid, "Zitronenfalter");
  assert.ok(hits.some((hit) => hit.id === pageId));
});

test("ZIP imports (Obsidian, Notion) bring their footnotes along", async () => {
  const { writeZip } = await import("../lib/archive");
  const { importZip } = await import("../lib/zip-import");
  const { one } = await import("../lib/db");
  const owner = user("importer");
  const wid = createWorkspace(owner.id, "Vault");
  const space = bootstrap(owner, wid).spaces[0].id;
  const archive = await writeZip(
    new Map([["Vault/Notiz.md", Buffer.from("# Notiz\n\nAussage[^a] mit ^[Randnotiz].\n\n[^a]: Quelle im Buch, S. 12\n")]]),
  );
  await importZip(owner, wid, space, archive);
  const html = one<{ html: string }>(
    "SELECT d.html FROM documents d JOIN pages p ON p.id=d.page_id WHERE p.workspace_id=? AND d.html LIKE '%data-footnote%'",
    wid,
  )?.html;
  assert.match(html || "", /Aussage<sup data-footnote="Quelle im Buch, S\. 12"[^>]*><\/sup> mit <sup data-footnote="Randnotiz"[^>]*><\/sup>\./);
});
