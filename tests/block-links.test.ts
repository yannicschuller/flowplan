// Block links (#88): stable block ids, the link format, the preview and
// search on the server, renames, the Markdown export with its markers and
// the re-import, and the anchors of AFFiNE, Obsidian, Notion, Confluence and
// Google Docs imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateJSON } from "@tiptap/html/server";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import { AttrStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-block-links-"));
process.env.APP_URL = "https://flowplan.example.test";
const { all, id, one, run } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { bootstrap, command } = await import("../lib/api");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const ids = await import("../lib/block-ids");
const { blockIdsPlugin } = await import("../lib/block-ids-plugin");
const { blockPreview, ensureBlockIds, searchBlocks, linkedBlockIds } = await import("../lib/block-links");
const { parsePageLocation, pageLocationHash } = await import("../lib/page-location");
const { retitleLinks } = await import("../lib/link-titles");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { exportMarkdown } = await import("../lib/markdown-export");
const { importZip } = await import("../lib/zip-import");
const { readZip, writeZip } = await import("../lib/archive");
const { importFromSource } = await import("../lib/importers");
const { documentAnchors, anchorKeys, findAnchor, resolvePendingAnchors } = await import("../lib/import-anchors");
const { exportedLink } = await import("../lib/git-export");
const { changeBlocks, documentBlocks } = await import("../lib/document-blocks");
const Y = await import("yjs");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("block-owner"),
  viewer = account("block-viewer");
const wid = createWorkspace(owner.id, "Blöcke");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = bootstrap(owner, wid).spaces[0].id;
const html = (pageId: string) => one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html;
function documentPage(title: string, body: string, parent: string | null = null, inSpace = space) {
  const pid = createPage(wid, inSpace, owner.id, title, "document", parent);
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", body, htmlState(body), pid);
  return pid;
}
const canonical = (body: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(body));
  return stateHtml(doc);
};
const schema = documentSchema();
const pmDoc = (body: string) => schema.nodeFromJSON(generateJSON(body, documentExtensions));
const blockIdsOf = (doc: ReturnType<typeof pmDoc>) => ids.linkableBlocks(doc).map((b) => b.node.attrs.blockId as string | null);
const UUID = "0d5e1c3a-1111-4222-8333-944455556666";

test("block links: format, parsing and page locations", () => {
  assert.match(ids.newBlockId(), /^[a-z0-9]{8}$/);
  assert.equal(ids.blockLinkHref({ pageId: UUID, blockId: "abc12345" }), `/#page=${UUID}&block=abc12345`);
  const row = "7a5e1c3a-1111-4222-8333-944455556666";
  assert.equal(ids.blockLinkHref({ pageId: UUID, rowId: row, blockId: "x" }), `/#page=${UUID}&row=${row}&block=x`);
  // Relative, as stored (also HTML-escaped), and as a full address of this Flowplan.
  assert.deepEqual(ids.parseBlockLink(`/#page=${UUID}&block=abc`), { pageId: UUID, blockId: "abc" });
  assert.deepEqual(ids.parseBlockLink(`/#page=${UUID}&amp;block=abc`), { pageId: UUID, blockId: "abc" });
  assert.deepEqual(ids.parseBlockLink(`https://flowplan.example.test/#page=${UUID}&row=${row}&block=abc`, "https://flowplan.example.test"), {
    pageId: UUID,
    rowId: row,
    blockId: "abc",
  });
  // Another site, another path, a page link, broken ids, unknown parameters.
  assert.equal(ids.parseBlockLink(`https://evil.example/#page=${UUID}&block=abc`, "https://flowplan.example.test"), null);
  assert.equal(ids.parseBlockLink(`https://flowplan.example.test/x/#page=${UUID}&block=abc`, "https://flowplan.example.test"), null);
  assert.equal(ids.parseBlockLink(`/#page=${UUID}`), null);
  assert.equal(ids.parseBlockLink(`/#page=${UUID}&block=a%20b`), null);
  assert.equal(ids.parseBlockLink(`/#page=nope&block=abc`), null);
  assert.equal(ids.parseBlockLink(`/#page=${UUID}&block=abc&x=1`), null);
  assert.equal(ids.parseBlockLink(`/#page=${UUID}&block=a&block=b`), null);
  // The app's router keeps the block in the address.
  assert.deepEqual(parsePageLocation(`#page=${UUID}&block=abc`), { pageId: UUID, blockId: "abc" });
  assert.equal(pageLocationHash({ pageId: UUID, blockId: "abc" }), `#page=${UUID}&block=abc`);
  assert.equal(parsePageLocation(`#page=${UUID}&block=<script>`), null);
  // "Page › start of the block", shortened.
  assert.equal(ids.blockLinkLabel(" Plan ", "Ziele"), "Plan › Ziele");
  assert.equal(ids.blockLinkLabel("Plan", ""), "Plan");
  const long = pmDoc(`<p>${"wort ".repeat(30)}</p>`).firstChild!;
  assert.ok(ids.blockText(long).endsWith("…") && [...ids.blockText(long)].length <= 60);
});

test("block ids live in the stored HTML; invalid ones are dropped", () => {
  const stored = canonical(
    '<h2 data-block-id="h1">Kopf</h2><p data-block-id="p-1">Text</p><ul><li data-block-id="li1"><p>Punkt</p></li></ul>' +
      '<table data-block-id="tb"><tr><td><p data-block-id="cell">Zelle</p></td></tr></table><pre data-block-id="cd"><code>x</code></pre><p data-block-id="kein id!">y</p>',
  );
  for (const id of ["h1", "p-1", "li1", "tb", "cd"]) assert.match(stored, new RegExp(`data-block-id="${id}"`));
  assert.doesNotMatch(stored, /kein id/);
  // Linkable: not the text of a list item, nothing inside a table.
  const doc = pmDoc(stored);
  const linkable = ids.linkableBlocks(doc).map((b) => `${b.node.type.name}:${b.node.attrs.blockId}`);
  assert.deepEqual(linkable, ["heading:h1", "paragraph:p-1", "bulletList:null", "listItem:li1", "table:tb", "codeBlock:cd", "paragraph:null"]);
  assert.equal(ids.findBlock(doc, "li1")?.node.type.name, "listItem");
  assert.equal(ids.findBlock(doc, "cell"), null);
  assert.equal(ids.linkableBlockAt(doc, ids.findBlock(doc, "li1")!.pos + 3)?.node.attrs.blockId, "li1");
});

test("the editor gives new and copied blocks ids; remote changes and untouched blocks stay as they are", async () => {
  const plugin = blockIdsPlugin();
  let state = EditorState.create({ doc: pmDoc('<p data-block-id="first">Eins</p><p>Alt</p>'), plugins: [plugin] });
  // The plugin's view, as the editor runs it: ids follow in a transaction
  // of their own, right after the change.
  const dispatched: Transaction[] = [];
  const view = {
    get state() {
      return state;
    },
    composing: false,
    isDestroyed: false,
    dispatch(tr: Transaction) {
      dispatched.push(tr);
      state = state.apply(tr);
    },
  };
  const pluginView = plugin.spec.view!(view as never);
  const change = async (tr: Transaction) => {
    state = state.applyTransaction(tr).state;
    pluginView.update!(view as never, state);
    await new Promise((done) => setTimeout(done, 5));
    return blockIdsOf(state.doc);
  };
  // Typing in an old block without id gives it one; the other stays.
  let found = await change(state.tr.insertText("!", 1 + 4));
  assert.deepEqual(found, ["first", null], "an untouched older block keeps no id");
  // A new paragraph and a divider (a leaf) get ids – in attribute steps,
  // which suggestions (lib/suggestions.ts) leave alone.
  found = await change(state.tr.insert(state.doc.content.size, [schema.nodes.paragraph.create(null, schema.text("Neu")), schema.nodes.horizontalRule.create()]));
  assert.match(found[2]!, /^[a-z0-9]{8}$/);
  assert.match(found[3]!, /^[a-z0-9]{8}$/);
  assert.ok(dispatched.at(-1)!.steps.every((step) => step instanceof AttrStep));
  // Splitting a block (Enter) copies its attributes: the first part keeps the id.
  const pos = 1 + 2;
  found = await change(state.tr.setSelection(TextSelection.create(state.doc, pos)).split(pos));
  assert.equal(found[0], "first");
  assert.ok(found[1] && found[1] !== "first", "the second part gets its own id");
  assert.equal(new Set(found.filter(Boolean)).size, found.filter(Boolean).length);
  // A copy of a block (same id) added elsewhere: the copy gets a new id.
  found = await change(state.tr.insert(state.doc.content.size, state.doc.firstChild!));
  assert.equal(found.filter((x) => x === "first").length, 1, "a pasted copy gets a new id");
  assert.equal(found[0], "first", "the original keeps its id");
  // Changes from other people (Yjs) are not touched.
  const remote = state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create(null, schema.text("Fremd")));
  remote.setMeta(ySyncPluginKey, { isChangeOrigin: true });
  const count = dispatched.length;
  found = await change(remote);
  assert.equal(found.at(-1), null);
  assert.equal(dispatched.length, count);
  // Nothing missing: no transaction at all.
  await change(state.tr.insertText("x", 2));
  assert.equal(dispatched.length, count);
  pluginView.destroy!();
});

test("pasting and duplicating: copies lose ids the document has, moved blocks keep theirs", () => {
  const doc = pmDoc('<p data-block-id="a">A</p><p data-block-id="b">B</p>');
  const slice = new Slice(pmDoc('<p data-block-id="a">A</p><p data-block-id="z">Z</p>').content, 0, 0);
  const pasted = ids.withoutTakenBlockIds(slice, doc);
  assert.equal(pasted.content.child(0).attrs.blockId, null);
  assert.equal(pasted.content.child(1).attrs.blockId, "z");
  assert.equal(ids.withoutBlockIds(slice).content.child(1).attrs.blockId, null);
  // "Duplizieren" in the block menu.
  const state = EditorState.create({ doc });
  const first = documentBlocks(doc)[0];
  const duplicated = state.apply(changeBlocks(state, [first.pos], "duplicate")).doc;
  assert.deepEqual(blockIdsOf(duplicated), ["a", null, "b"]);
  // Moving keeps the id.
  const moved = state.apply(changeBlocks(state, [first.pos], "move", doc.content.size)).doc;
  assert.deepEqual(blockIdsOf(moved), ["b", "a"]);
});

test("preview, ids for older documents, search and the linked ids – only what the reader may read", () => {
  const plan = documentPage("Plan", '<h2 data-block-id="goals">Ziele 2027</h2><p data-block-id="body">Mehr Kunden gewinnen</p><p>Alter Absatz ohne Id</p>');
  const preview = blockPreview(viewer, plan, "body");
  assert.equal(preview.title, "Plan");
  assert.equal(preview.text, "Mehr Kunden gewinnen");
  assert.equal(preview.found, true);
  assert.equal(preview.workspaceId, wid);
  assert.equal(blockPreview(viewer, plan, "gone").found, false);
  assert.throws(() => blockPreview(viewer, plan, "bad id"), /Ungültiger Blocklink/);
  // A private page: nothing for others, not even the title.
  const privateSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true }) as { id: string }).id;
  const secret = documentPage("Geheim", '<p data-block-id="s">Geheimer Text</p>', null, privateSpace);
  assert.throws(() => blockPreview(viewer, secret, "s"), (e: { status?: number }) => e.status === 403 || e.status === 404);
  assert.equal(searchBlocks(viewer, wid, "Geheimer").length, 0);
  // A reader copies a link to a block without id: the server names it.
  run("UPDATE pages SET updated_at='2020-01-01 00:00:00' WHERE id=?", plan);
  const ensured = ensureBlockIds(viewer, plan, null, 2, "Alter Absatz ohne Id");
  assert.match(ensured.blockId, /^[a-z0-9]{8}$/);
  assert.match(html(plan), new RegExp(`<p data-block-id="${ensured.blockId}">Alter Absatz ohne Id</p>`));
  // Not an edit: the page keeps its "changed" time.
  assert.equal(one<{ updated_at: string }>("SELECT updated_at FROM pages WHERE id=?", plan)!.updated_at, "2020-01-01 00:00:00");
  // The same block again: the same id.
  assert.equal(ensureBlockIds(viewer, plan, null, 2, "Alter Absatz ohne Id").blockId, ensured.blockId);
  // The "@" search: "Page › Heading" and plain words.
  const other = documentPage("Notizen", "<p>nichts</p>");
  const headings = searchBlocks(owner, wid, "Plan › Ziele", other);
  assert.deepEqual(headings.map((h) => [h.pageTitle, h.text, h.blockId, h.level]), [["Plan", "Ziele 2027", "goals", 2]]);
  const words = searchBlocks(owner, wid, "Kunden");
  assert.ok(words.some((h) => h.blockId === "body" && h.level === null));
  assert.equal(searchBlocks(owner, wid, "Kunden", plan).length, 0, "the open page is left out");
  // Texts linking to blocks.
  documentPage("Verweis", `<p><a href="/#page=${plan}&amp;block=body">Plan › Mehr</a></p>`);
  assert.ok(linkedBlockIds(wid).get(plan)?.has("body"));
});

test("renames: block link texts keep their block part", () => {
  const target = { pageId: UUID };
  const doc = pmDoc(
    `<p><a href="/#page=${UUID}&amp;block=b1">Alt › Erster Absatz</a> und <a href="/#page=${UUID}&amp;block=b2">eigener Text</a> und <a href="/#page=${UUID}">Alt</a></p>`,
  );
  const next = retitleLinks(doc, target, "Alt", "Neu")!;
  assert.equal(next.textContent, "Neu › Erster Absatz und eigener Text und Neu");
  // Through the command: the linking page follows.
  const plan = documentPage("Roadmap", '<p data-block-id="x1">Q1</p>');
  const source = documentPage("Quelle", `<p><a href="/#page=${plan}&amp;block=x1">Roadmap › Q1</a></p>`);
  command(owner, { action: "page.update", pageId: plan, patch: { title: "Fahrplan" } });
  assert.match(html(source), /Fahrplan › Q1/);
});

test("Markdown: markers for linked blocks, block links as file anchors, and back", async () => {
  const md = htmlToMarkdown(
    '<h2 data-block-id="h1">Kopf</h2><p data-block-id="p1">Text</p><p data-block-id="free">Frei</p><ul><li data-block-id="i1"><p>Punkt</p></li></ul><pre data-block-id="c1"><code>x</code></pre>',
    { url: (u) => u, linked: () => null, blockIds: (id) => id !== "free" },
  );
  assert.match(md, /^## Kopf \^h1$/m);
  assert.match(md, /^Text \^p1$/m);
  assert.match(md, /^Frei$/m, "blocks nobody links to stay clean");
  assert.match(md, /^- Punkt \^i1$/m);
  assert.match(md, /```\n\n\^c1/);
  // And back: the markers become ids again (also Obsidian's).
  const back = canonical(markdownToHtml(md));
  for (const id of ["h1", "p1", "i1", "c1"]) assert.match(back, new RegExp(`data-block-id="${id}"`));
  assert.doesNotMatch(back, /\^/);
  assert.match(canonical(markdownToHtml("- [ ] Anrufen 📅 2026-05-04 ^t1")), /data-due="2026-05-04"/);
  // A footnote-like or code text is no marker.
  assert.doesNotMatch(canonical(markdownToHtml("Hoch^2 und `a ^b`")), /data-block-id="(2|b)"/);

  // The ZIP export of a page with a sub-page that links to its block…
  const root = documentPage("Handbuch", '<h2 data-block-id="intro1">Einleitung</h2><p data-block-id="para1">Erster Absatz</p>');
  documentPage("Kapitel", `<p>Siehe <a href="/#page=${root}&amp;block=para1">Handbuch › Erster Absatz</a></p>`, root);
  const { bytes } = await exportMarkdown(owner, { pageId: root, format: "zip", includeSubpages: true });
  const files = await readZip(bytes, { foreign: true });
  const index = files.get("index.md")!.toString("utf8");
  assert.match(index, /Erster Absatz \^para1/);
  assert.doesNotMatch(index, /\^intro1/);
  const chapter = [...files].find(([name]) => /^pages\/Kapitel-/.test(name))![1].toString("utf8");
  assert.match(chapter, /\(<\.\.\/index\.md#\^para1>\)/);
  // …imported again: the link points to the block of the new page.
  const kapitelId = one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Kapitel'", wid)!.id;
  const before = one<{ n: number }>("SELECT MAX(rowid) n FROM pages")!.n;
  await importZip(owner, wid, space, bytes);
  const imported = all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND rowid>?", wid, before);
  const kapitel = imported.find((p) => html(p.id).includes("Siehe"))!;
  const link = /href="\/#page=([0-9a-f-]{36})&amp;block=([\w-]+)"/.exec(html(kapitel.id));
  assert.ok(link, html(kapitel.id));
  assert.notEqual(link![1], root);
  assert.equal(link![2], "para1");
  assert.match(html(link![1]), /<p data-block-id="para1">Erster Absatz<\/p>/);
  // Not in a ZIP: the address in Flowplan with the block.
  const single = await exportMarkdown(owner, { pageId: kapitelId, format: "markdown", includeSubpages: false });
  assert.match(single.bytes.toString("utf8"), /https:\/\/flowplan\.example\.test\/#page=[0-9a-f-]{36}&block=para1/);
});

test("Git export: links between exported files come back as page and block links", () => {
  const root = "11111111-2222-4333-8444-555555555555",
    sub = "aaaaaaaa-2222-4333-8444-555555555555";
  const folders = new Map([["11111111", root]]);
  const file = "Handbuch-11111111/pages/Kapitel-aaaaaaaa-2222-4333-8444-555555555555.md";
  assert.equal(exportedLink("../index.md#^para1", file, folders), `/#page=${root}&block=para1`);
  assert.equal(exportedLink(`Kapitel-${sub}.md`, file, folders), `/#page=${sub}`);
  assert.equal(exportedLink("#^own", file, folders), `/#page=${sub}&block=own`);
  assert.equal(exportedLink("https://example.test/x", file, folders), "https://example.test/x");
  assert.equal(exportedLink("../../Anderes-99999999/index.md", file, folders), null);
  assert.equal(exportedLink("javascript:alert(1)", file, folders), null);
});

test("import anchors: block ids and headings of a converted document", () => {
  const { html: out, anchors } = documentAnchors('<h2 id="x">Mein Ziel!</h2><p data-block-id="src-1">A</p><h3>Plan</h3>', "Seite");
  const fresh = [...out.matchAll(/data-block-id="([a-z0-9]{8})"/g)].map((m) => m[1]);
  assert.equal(fresh.length, 3);
  assert.equal(findAnchor(anchors, "src-1"), fresh[1]);
  assert.equal(findAnchor(anchors, "^src-1"), fresh[1]);
  assert.equal(findAnchor(anchors, "mein-ziel"), fresh[0]);
  assert.equal(findAnchor(anchors, "Mein%20Ziel"), fresh[0]);
  assert.equal(findAnchor(anchors, "Seite-MeinZiel"), fresh[0], "Confluence's page-title anchors");
  assert.equal(findAnchor(anchors, "nothing"), null);
  assert.deepEqual(anchorKeys("^abc"), ["id:abc"]);
  // Own ids stay when the source is Flowplan's (or Obsidian's) Markdown.
  assert.match(documentAnchors('<p data-block-id="keep1">K</p>', "", false).html, /data-block-id="keep1"/);
  const pending = `<a href="/#page=${UUID}&amp;anchor=mein-ziel">x</a><a href="/#page=${UUID}&amp;anchor=fehlt">y</a>`;
  assert.equal(
    resolvePendingAnchors(pending, (_page, anchor) => findAnchor(anchors, anchor)),
    `<a href="/#page=${UUID}&amp;block=${fresh[0]}">x</a><a href="/#page=${UUID}">y</a>`,
  );
});

const pageByTitle = (title: string) => one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL ORDER BY rowid DESC LIMIT 1", wid, title)!.id;
// The block a link of `from` points to, in its target page.
function linkedBlock(from: string, linkText: RegExp) {
  const source = html(from);
  const link = new RegExp(`href="/#page=([0-9a-f-]{36})(?:&amp;block=([\\w-]+))?"[^>]*>${linkText.source}`).exec(source);
  assert.ok(link, source);
  return { pageId: link![1], blockId: link![2] || null };
}
const blockTextIn = (pageId: string, blockId: string) => {
  const block = ids.findBlock(pmDoc(html(pageId)), blockId);
  return block ? block.node.textContent : null;
};

test("Obsidian: [[Page#Heading]], [[Page#^id]], [[#Heading]] and ^id markers", async () => {
  const zip = await writeZip(
    new Map([
      [".obsidian/app.json", Buffer.from("{}")],
      ["ObsA.md", Buffer.from("Intro\n\n## Planung Q3\n\nDer wichtige Satz ^satz1\n\n- Punkt mit Id ^punkt1\n")],
      ["ObsB.md", Buffer.from("Zu [[ObsA#Planung Q3|Planung]], zum [[ObsA#^satz1|Satz]], zum [[ObsA#^punkt1|Punkt]], [[#Unten|nach unten]] und [Markdown](ObsA.md#^satz1).\n\n## Unten\n\nEnde\n")],
    ]),
  );
  await importZip(owner, wid, space, zip);
  const a = pageByTitle("ObsA"),
    b = pageByTitle("ObsB");
  const heading = linkedBlock(b, /Planung/);
  assert.equal(heading.pageId, a);
  assert.equal(blockTextIn(a, heading.blockId!), "Planung Q3");
  const sentence = linkedBlock(b, /Satz/);
  assert.equal(blockTextIn(a, sentence.blockId!), "Der wichtige Satz");
  assert.equal(blockTextIn(a, linkedBlock(b, /Punkt/).blockId!), "Punkt mit Id");
  assert.equal(linkedBlock(b, /Markdown/).blockId, sentence.blockId);
  const own = linkedBlock(b, /nach unten/);
  assert.equal(own.pageId, b);
  assert.equal(blockTextIn(b, own.blockId!), "Unten");
  assert.doesNotMatch(html(a), /\^satz1|\^punkt1/);
});

test("Notion (Markdown export): heading anchors and notion.so links to pages of the export", async () => {
  const idA = "0123456789abcdef0123456789abcdef",
    idB = "fedcba9876543210fedcba9876543210";
  const zip = await writeZip(
    new Map([
      [`NotionA ${idA}.md`, Buffer.from("# NotionA\n\n## Zweiter Abschnitt\n\nText\n")],
      [
        `NotionB ${idB}.md`,
        Buffer.from(`# NotionB\n\n[Abschnitt](NotionA%20${idA}.md#zweiter-abschnitt) und [Block](https://www.notion.so/NotionA-${idA}?pvs=4#aaaaaaaabbbbccccddddeeeeeeeeeeee)\n`),
      ],
    ]),
  );
  await importZip(owner, wid, space, zip);
  const a = pageByTitle("NotionA"),
    b = pageByTitle("NotionB");
  const section = linkedBlock(b, /Abschnitt/);
  assert.equal(section.pageId, a);
  assert.equal(blockTextIn(a, section.blockId!), "Zweiter Abschnitt");
  // A block Notion's Markdown has no id for: the page.
  assert.deepEqual(linkedBlock(b, /Block/), { pageId: a, blockId: null });
});

test("Confluence (HTML export): anchors to headings of other pages and of the same page", async () => {
  const page = (title: string, body: string) =>
    Buffer.from(`<html><head><title>Raum : ${title}</title></head><body><div id="main-content">${body}</div></body></html>`);
  const zip = await writeZip(
    new Map([
      ["index.html", Buffer.from('<html><body><h2>Available Pages:</h2><ul><li><a href="Ziel_1.html">Ziel</a></li><li><a href="Quelle_2.html">Quelle</a></li></ul></body></html>')],
      ["Ziel_1.html", page("Ziel", '<h1 id="Ziel-Budgetplanung">Budgetplanung</h1><p>Zahlen</p>')],
      ["Quelle_2.html", page("Quelle", '<p><a href="Ziel_1.html#Ziel-Budgetplanung">Budget</a> und <a href="#Quelle-Hier">hier</a></p><h2 id="Quelle-Hier">Hier</h2>')],
    ]),
  );
  await importFromSource(owner, wid, space, { name: "confluence.zip", bytes: zip }, { source: "confluence" });
  const ziel = pageByTitle("Ziel"),
    quelle = pageByTitle("Quelle");
  const budget = linkedBlock(quelle, /Budget/);
  assert.equal(budget.pageId, ziel);
  assert.equal(blockTextIn(ziel, budget.blockId!), "Budgetplanung");
  const here = linkedBlock(quelle, /hier/);
  assert.equal(here.pageId, quelle);
  assert.equal(blockTextIn(quelle, here.blockId!), "Hier");
});

test("Google Docs (HTML): links to headings and bookmarks of the document", async () => {
  const doc = Buffer.from(
    '<html><head><title>GDoc</title></head><body><h1 id="h.abc">Einleitung</h1><p><a id="kix.mark"></a>Markierter Absatz</p><p><a href="#h.abc">nach oben</a> <a href="#kix.mark">zur Marke</a></p></body></html>',
  );
  await importFromSource(owner, wid, space, { name: "GDoc.html", bytes: doc }, { source: "gdocs" });
  const page = pageByTitle("GDoc");
  assert.equal(blockTextIn(page, linkedBlock(page, /nach oben/).blockId!), "Einleitung");
  assert.equal(blockTextIn(page, linkedBlock(page, /zur Marke/).blockId!), "Markierter Absatz");
});

test("AFFiNE: references and app links with blockIds lead to the block's new id", async () => {
  const snapshot = (sid: string, title: string, children: unknown[]) => ({
    type: "page",
    meta: { id: sid, title, createDate: 1, tags: [] },
    blocks: {
      type: "block",
      id: `${sid}-root`,
      flavour: "affine:page",
      props: { title: { "$blocksuite:internal:text$": true, delta: [{ insert: title }] } },
      children: [{ type: "block", id: `${sid}-note`, flavour: "affine:note", props: { xywh: "[0,0,800,95]", displayMode: "both" }, children }],
    },
  });
  const para = (blockId: string, delta: unknown[], type = "text") => ({
    type: "block",
    id: blockId,
    flavour: "affine:paragraph",
    props: { type, text: { "$blocksuite:internal:text$": true, delta } },
    children: [],
  });
  const zip = await writeZip(
    new Map([
      ["info.json", Buffer.from(JSON.stringify({ type: "info", id: "ws", properties: {} }))],
      [
        "AffQuelle-src.snapshot.json",
        Buffer.from(
          JSON.stringify(
            snapshot("src", "AffQuelle", [
              para("q1", [
                { insert: "Siehe " },
                { insert: " ", attributes: { reference: { type: "LinkedPage", pageId: "dst", params: { mode: "page", blockIds: ["blk-ziel"] } } } },
                { insert: " und " },
                { insert: "App", attributes: { link: "https://app.affine.pro/workspace/ws/dst?mode=page&blockIds=blk-kopf" } },
                { insert: " und " },
                { insert: " ", attributes: { reference: { type: "LinkedPage", pageId: "dst", params: { mode: "page", blockIds: ["weg"] } } } },
              ]),
            ]),
          ),
        ),
      ],
      ["AffZiel-dst.snapshot.json", Buffer.from(JSON.stringify(snapshot("dst", "AffZiel", [para("blk-kopf", [{ insert: "Kopf" }], "h2"), para("blk-ziel", [{ insert: "Zielabsatz" }])])))],
    ]),
  );
  await importFromSource(owner, wid, space, { name: "affine.zip", bytes: zip });
  const quelle = pageByTitle("AffQuelle"),
    ziel = pageByTitle("AffZiel");
  const links = [...html(quelle).matchAll(/href="\/#page=([0-9a-f-]{36})(?:&amp;block=([\w-]+))?"/g)].map((m) => ({ page: m[1], block: m[2] || null }));
  assert.equal(links.length, 3);
  assert.ok(links.every((l) => l.page === ziel));
  assert.equal(blockTextIn(ziel, links[0].block!), "Zielabsatz");
  assert.equal(blockTextIn(ziel, links[1].block!), "Kopf");
  assert.equal(links[2].block, null, "a block that is not there: the page");
  // New Flowplan ids, not AFFiNE's.
  assert.doesNotMatch(html(ziel), /blk-ziel|blk-kopf/);
});
