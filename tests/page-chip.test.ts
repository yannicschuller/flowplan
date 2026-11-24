// Page links as chips (#466): the node, the conversion of stored link
// marks (on open, as a Yjs change), the Markdown round trip, renames,
// the export walkers and pinned tabs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-chip-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, one, run } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { bootstrap, command, pageData } = await import("../lib/api");
const { cleanHtml, htmlJson, jsonHtml } = await import("../lib/document-server");
const { documentSchema } = await import("../lib/document-schema");
const chip = await import("../lib/page-chip");
const { retitleLinks } = await import("../lib/link-titles");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { documentNode } = await import("../lib/export-content");
const tabs = await import("../lib/frame-tabs");
const Y = await import("yjs");

const A = "11111111-2222-4333-8444-555555555555";
const schema = documentSchema();
const parse = (html: string) => schema.nodeFromJSON(htmlJson(cleanHtml(html)));
const chipsIn = (doc: ReturnType<typeof parse>) => {
  const found: { href: string; title: string; marks: string[] }[] = [];
  doc.descendants((node) => {
    if (node.type.name === "pageLink") found.push({ href: node.attrs.href, title: node.attrs.title, marks: node.marks.map((m) => m.type.name) });
  });
  return found;
};
const linkMarks = (doc: ReturnType<typeof parse>) => {
  const found: string[] = [];
  doc.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === "link")) found.push(node.text!);
  });
  return found;
};
// A document as it was stored before #466: page links as link marks.
const oldJson = (title: string, href = `/#page=${A}`) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Siehe " },
        { type: "text", text: title, marks: [{ type: "link", attrs: { href } }, { type: "bold" }] },
        { type: "text", text: " und " },
        { type: "text", text: "Web", marks: [{ type: "link", attrs: { href: "https://example.org/" } }] },
        { type: "text", text: " und " },
        { type: "text", text: "ge", marks: [{ type: "link", attrs: { href } }, { type: "italic" }] },
        { type: "text", text: "mischt", marks: [{ type: "link", attrs: { href } }] },
      ],
    },
  ],
});

test("the node: page links with plain text parse as chips, others stay links", () => {
  assert.ok(chip.isPageChipHref(`/#page=${A}`));
  assert.ok(chip.isPageChipHref(`#page=${A}&block=b1`));
  assert.ok(chip.isPageChipHref(`https://flowplan.example.test/#page=${A}&row=${A}`));
  assert.ok(!chip.isPageChipHref("/api/files/x.pdf#page=3"), "a PDF page is no page link");
  assert.ok(!chip.isPageChipHref(`javascript:alert(1)//#page=${A}`));
  assert.ok(!chip.isPageChipHref("https://example.org/"));

  const doc = parse(
    `<p>a <a href="/#page=${A}">Unterseite</a> b <a href="https://example.org/">Web</a> c <a href="/#page=${A}"><strong>Fe</strong>tt</a> d <strong><a href="/#page=${A}">Ganz fett</a></strong></p>`,
  );
  assert.deepEqual(chipsIn(doc), [
    { href: `/#page=${A}`, title: "Unterseite", marks: [] },
    { href: `/#page=${A}`, title: "Ganz fett", marks: ["bold"] },
  ]);
  assert.deepEqual(linkMarks(doc), ["Web", "Fe", "tt"], "formatting inside a link keeps it a link");
  // One character of the text, its title in textContent.
  const para = doc.firstChild!;
  assert.equal(para.child(1).nodeSize, 1);
  assert.match(doc.textContent, /a Unterseite b Web c Fett d Ganz fett/);
  // Stored as the <a> it was, marked; sanitising keeps the mark.
  const html = jsonHtml(doc.toJSON());
  assert.match(html, new RegExp(`<a href="/#page=${A}" data-page-link="" target="_blank" rel="noopener noreferrer">Unterseite</a>`));
  assert.match(cleanHtml(html), /<a href="[^"]+" data-page-link target="_blank" rel="noopener noreferrer">Unterseite<\/a>/);
  assert.equal(JSON.stringify(parse(cleanHtml(html)).toJSON()), JSON.stringify(doc.toJSON()), "HTML round trip");
  // Icons drawn into read-only links (copied from a published page) are no text.
  const pasted = parse(`<p><a href="/#page=${A}"><span class="page-link-icon"><span class="page-link-glyph">📘</span></span>Buch</a></p>`);
  assert.deepEqual(chipsIn(pasted).map((c) => c.title), ["Buch"]);
});

test("stored link marks become chips: whole runs with the same marks, as a Yjs change", () => {
  const old = schema.nodeFromJSON(oldJson("Plan"));
  const next = chip.chipsFromLinks(old)!;
  assert.deepEqual(chipsIn(next), [{ href: `/#page=${A}`, title: "Plan", marks: ["bold"] }]);
  assert.deepEqual(linkMarks(next), ["Web", "ge", "mischt"], "web links and mixed runs stay links");
  assert.equal(next.textContent, old.textContent, "no text lost");
  assert.equal(chip.chipsFromLinks(next), null, "nothing left to do");
  assert.ok(chip.hasLinkMarkChips(jsonHtml(old.toJSON())));
  assert.ok(chip.hasLinkMarkChips(jsonHtml(next.toJSON())), "the mixed run is still a link mark");
  assert.ok(!chip.hasLinkMarkChips(jsonHtml(parse(`<p><a href="/#page=${A}">X</a></p>`).toJSON())));
  // Spaces at the ends stay beside the chip; text a chip would change stays a link.
  const spaced = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: " Plan ", marks: [{ type: "link", attrs: { href: `/#page=${A}` } }] },
          { type: "text", text: "b " },
          { type: "text", text: "zwei  Leer", marks: [{ type: "link", attrs: { href: `/#page=${A}` } }] },
          { type: "text", text: " " },
          { type: "text", text: "x".repeat(chip.MAX_CHIP_TITLE + 1), marks: [{ type: "link", attrs: { href: `/#page=${A}` } }] },
        ],
      },
    ],
  });
  const converted = chip.chipsFromLinks(spaced)!;
  assert.equal(converted.textContent, spaced.textContent, "not a character lost");
  assert.deepEqual(chipsIn(converted).map((c) => c.title), ["Plan"]);
  assert.equal(converted.firstChild!.child(0).text, "a ");
  assert.equal(converted.firstChild!.child(1).type.name, "pageLink");
  assert.equal(converted.firstChild!.child(2).text, " b ");
  assert.deepEqual(chipsIn(parse(`<p>a<a href="/#page=${A}"> Plan</a></p>`)), [], "a pasted link with a space at its end stays a link");
  // And back, for the export walkers.
  const back = chip.linksFromChips(next);
  assert.deepEqual(chipsIn(back), []);
  assert.equal(back.textContent, old.textContent);
  assert.deepEqual(linkMarks(back), ["Plan", "Web", "ge", "mischt"]);
});

test("Markdown: a chip is written as its link and read back as a chip", () => {
  const html = jsonHtml(parse(`<p>Siehe <strong><a href="/#page=${A}">Plan</a></strong> und <a href="/#page=${A}&amp;block=b1">Plan › Absatz</a></p>`).toJSON());
  const md = htmlToMarkdown(html, { url: (u) => u, linked: () => null });
  assert.equal(md.trim(), `Siehe **[Plan](</#page=${A}>)** und [Plan › Absatz](</#page=${A}&block=b1>)`);
  const back = parse(markdownToHtml(md));
  assert.deepEqual(
    chipsIn(back).map((c) => [c.title, c.href, c.marks.join()]),
    [
      ["Plan", `/#page=${A}`, "bold"],
      ["Plan › Absatz", `/#page=${A}&block=b1`, ""],
    ],
  );
  // The export walkers see links.
  assert.deepEqual(linkMarks(documentNode(html)), ["Plan", "Plan › Absatz"]);
});

test("renames: chips with the old title get the new one, block chips keep their block part", () => {
  const doc = parse(
    `<p><a href="/#page=${A}">Alt</a> <a href="/#page=${A}">Eigener Text</a> <a href="/#page=${A}&amp;block=b1">Alt › Erster Absatz</a></p>`,
  );
  const next = retitleLinks(doc, { pageId: A }, "Alt", "Neu")!;
  assert.deepEqual(chipsIn(next).map((c) => c.title), ["Neu", "Eigener Text", "Neu › Erster Absatz"]);
});

test("keys: arrows pass a chip in one step, Backspace deletes it whole", async () => {
  const { Editor } = await import("@tiptap/core");
  const { documentExtensions } = await import("../lib/document-schema");
  // The keyboard handlers of the node, without a browser: run them on a state.
  const ext = documentExtensions.find((e) => e.name === "pageLink")!;
  const doc = parse(`<p>ab<a href="/#page=${A}">Plan</a>cd</p>`);
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
  const view = {
    get state() {
      return state;
    },
    dispatch: (tr: ReturnType<typeof state.tr.setMeta>) => (state = state.apply(tr)),
    domAtPos: () => ({ node: { nodeType: 3, parentElement: null } }),
  };
  const shortcuts = (ext.config.addKeyboardShortcuts as () => Record<string, () => boolean>).call({ editor: { get state() { return state; }, view } as unknown as InstanceType<typeof Editor> });
  assert.ok(shortcuts.ArrowRight());
  assert.equal(state.selection.from, 4, "past the chip in one press");
  assert.ok(shortcuts.ArrowLeft());
  assert.equal(state.selection.from, 3);
  state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 3)));
  assert.ok(shortcuts.ArrowRight());
  assert.ok(state.selection instanceof TextSelection && state.selection.from === 4, "a selected chip: the caret after it");
  assert.ok(shortcuts.Backspace());
  assert.equal(state.doc.textContent, "abcd", "deleted whole");
  assert.ok(!shortcuts.Backspace(), "plain text: the default");
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("opening a stored document converts its page links once, without changing its time, text or other links", async () => {
  const owner = await account("chip-owner");
  const reader = await account("chip-reader");
  const wid = await createWorkspace(owner.id, "Chips");
  await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const target = await createPage(wid, space, owner.id, "Plan", "document", null);
  const source = await createPage(wid, space, owner.id, "Quelle", "document", null);
  // As stored before #466: link marks in the Yjs state and the HTML.
  const ydoc = prosemirrorJSONToYDoc(schema, oldJson("Plan", `/#page=${target}`), "default");
  const state = Y.encodeStateAsUpdate(ydoc);
  const oldHtml = jsonHtml(oldJson("Plan", `/#page=${target}`));
  await run("UPDATE documents SET state=?,html=? WHERE page_id=?", state, cleanHtml(oldHtml), source);
  await run("UPDATE pages SET updated_at='2020-01-01 00:00:00' WHERE id=?", source);

  const data = (await pageData(reader, source)) as { state: string | null };
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Buffer.from(data.state!, "base64"));
  const doc = schema.nodeFromJSON(yDocToProsemirrorJSON(loaded, "default"));
  assert.deepEqual(chipsIn(doc).map((c) => c.title), ["Plan"], "the reader gets chips");
  assert.equal(doc.textContent, "Siehe Plan und Web und gemischt");
  // Merges with what editors that loaded the old state still send.
  const stale = new Y.Doc();
  Y.applyUpdate(stale, state);
  stale.getXmlFragment("default").insert(0, [new Y.XmlElement("paragraph")]);
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(stale));
  assert.deepEqual(chipsIn(schema.nodeFromJSON(yDocToProsemirrorJSON(loaded, "default"))).map((c) => c.title), ["Plan"]);

  const stored = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", source))!.html;
  assert.match(stored, new RegExp(`href="/#page=${target}" data-page-link`));
  assert.equal((await one<{ updated_at: string }>("SELECT updated_at FROM pages WHERE id=?", source))!.updated_at, "2020-01-01 00:00:00");
  // Opened again: nothing more to do (the mixed link stays a link).
  const again = (await pageData(owner, source)) as { state: string | null };
  assert.equal(again.state, (await pageData(owner, source) as { state: string | null }).state);
  // Renames reach the chip.
  await command(owner, { action: "page.update", pageId: target, patch: { title: "Fahrplan" } });
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", source))!.html, /data-page-link[^>]*>Fahrplan<\/a>/);
  // HTML without a state (an import): chips right away.
  const imported = await createPage(wid, space, owner.id, "Import", "document", null);
  await run("UPDATE documents SET state=NULL,html=? WHERE page_id=?", `<p><a href="/#page=${target}">Fahrplan</a></p>`, imported);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Buffer.from(((await pageData(owner, imported)) as { state: string }).state, "base64"));
  assert.deepEqual(chipsIn(schema.nodeFromJSON(yDocToProsemirrorJSON(fresh, "default"))).map((c) => c.title), ["Fahrplan"]);
});

test("pinned tabs keep their page: links, back and forward open a new tab beside it", () => {
  const p = (pid: string, extra = "") => `page=${pid}${extra}`;
  const B = "22222222-2222-4333-8444-555555555555";
  const C = "33333333-2222-4333-8444-555555555555";
  let l = tabs.singleLayout(p(A), "t1");
  l = tabs.open(l, p(C), { id: "t2" });
  l = tabs.activate(l, 0, "t1");
  l = tabs.pin(l, 0, "t1");
  // A link out of the pinned tab: a new tab beside it (after the pinned ones).
  const out = tabs.navigate(l, 0, p(B));
  assert.equal(tabs.placeOf(out.frames[0].tabs.find((t) => t.id === "t1")!), p(A), "the pinned tab keeps its page");
  assert.equal(tabs.activePlace(out), p(B));
  assert.deepEqual(out.frames[0].tabs.map((t) => tabs.placeOf(t)), [p(A), p(B), p(C)]);
  // Again to a place another tab shows: still a new tab.
  assert.equal(tabs.navigate(l, 0, p(C)).frames[0].tabs.length, 3);
  // A record of its database: out as well.
  assert.equal(tabs.navigate(l, 0, p(A, `&row=${B}`)).frames[0].tabs.length, 3);
  // Within its page (a block, a view): stays.
  const within = tabs.navigate(l, 0, p(A, "&block=b1"), "replace");
  assert.equal(within.frames[0].tabs.length, 2);
  assert.equal(tabs.activePlace(within), p(A, "&block=b1"));
  // Back and forward through its history: a new tab too.
  let h = tabs.singleLayout(p(B), "h1");
  h = tabs.follow(h, 0, p(A));
  h = tabs.pin(h, 0, "h1");
  const back = tabs.step(h, 0, -1);
  assert.equal(back.frames[0].tabs.length, 2);
  assert.equal(tabs.placeOf(back.frames[0].tabs[0]), p(A));
  assert.equal(tabs.activePlace(back), p(B));
  assert.equal(tabs.navigate(h, 0, p(B), "back").frames[0].tabs.length, 2);
  // Unpinned tabs go as before.
  const plain = tabs.singleLayout(p(A), "u1");
  assert.equal(tabs.navigate(plain, 0, p(B)).frames[0].tabs.length, 1);
  assert.equal(tabs.step(tabs.follow(plain, 0, p(B)), 0, -1).frames[0].tabs.length, 1);
});
