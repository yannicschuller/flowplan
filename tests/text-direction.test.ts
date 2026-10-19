import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { generateJSON } from "@tiptap/html/server";
import { EditorState } from "@tiptap/pm/state";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
const { htmlState, stateHtml, cleanHtml } = await import("../lib/document-server");
const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { htmlToMarkdown } = await import("../lib/markdown");
const { strongDirection, autoDirections, setBlockDirection, applyTextDirections } = await import("../lib/text-direction");

const canonical = (html: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlState(html));
  return stateHtml(doc);
};
const pmDoc = (html: string) => documentSchema().nodeFromJSON(generateJSON(html, documentExtensions));

test("the first letter decides the direction", () => {
  assert.equal(strongDirection("123 مرحبا world"), "rtl");
  assert.equal(strongDirection("(שלום)"), "rtl");
  assert.equal(strongDirection("Hello مرحبا"), "ltr");
  assert.equal(strongDirection("123 — !"), null);
});

test("a set direction is a block attribute that persists through the document state and HTML", () => {
  const html = canonical(
    '<p dir="rtl">مرحبا</p><h2 dir="ltr">Title</h2><ul dir="rtl"><li dir="rtl"><p dir="rtl">بند</p></li></ul>' +
      '<blockquote dir="rtl"><p>ציטוט</p></blockquote><aside data-callout="note" dir="rtl"><p>ملاحظة</p></aside>' +
      '<table dir="rtl"><tr><td dir="rtl"><p>خلية</p></td></tr></table><p dir="auto">auto</p><p dir="sideways">x</p>',
  );
  assert.match(html, /<p dir="rtl">مرحبا<\/p>/);
  assert.match(html, /<h2 dir="ltr">Title<\/h2>/);
  assert.match(html, /<ul dir="rtl"><li dir="rtl"><p dir="rtl">بند<\/p><\/li><\/ul>/);
  assert.match(html, /<blockquote dir="rtl">/);
  assert.match(html, /<aside dir="rtl" data-callout="note" class="editor-callout">/);
  assert.match(html, /<table dir="rtl">/);
  assert.match(html, /<td dir="rtl"[^>]*>/);
  // Automatic is the default and not stored; unknown values are dropped.
  assert.match(html, /<p>auto<\/p><p>x<\/p>$/);
  assert.doesNotMatch(cleanHtml('<p dir="evil">x</p>'), /dir=/);
  // Markdown has no place for it.
  assert.equal(htmlToMarkdown(html, { url: (u) => u, linked: () => null }).includes("dir"), false);
});

test("blocks without a set direction follow their text in the editor", () => {
  const doc = pmDoc('<p>English</p><p>مرحبا بالعالم</p><ul><li><p>שלום</p></li><li><p>Hello</p></li></ul><p dir="ltr">مرحبا</p>');
  const found: string[] = [];
  autoDirections(doc)
    .find()
    .forEach((decoration) => {
      const node = doc.nodeAt(decoration.from)!;
      found.push(`${node.type.name}:${(decoration as unknown as { type: { attrs: { dir: string } } }).type.attrs.dir}:${node.textContent}`);
    });
  // The list goes right to left with its first item; the English item
  // inside goes back to left to right. A set direction is left alone.
  assert.deepEqual(found, [
    "paragraph:rtl:مرحبا بالعالم",
    "bulletList:rtl:שלוםHello",
    "listItem:ltr:Hello",
  ]);
});

test("setting a direction turns a block and everything inside it", () => {
  const doc = pmDoc("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>");
  const state = EditorState.create({ doc });
  const tr = state.tr;
  assert.equal(setBlockDirection(tr, 1, "rtl"), true);
  const html = stateHtml(prosemirrorJSONToYDoc(documentSchema(), tr.doc.toJSON(), "default"));
  assert.match(html, /<ul><li dir="rtl"><p dir="rtl">a<\/p><ul dir="rtl"><li dir="rtl"><p dir="rtl">b<\/p><\/li><\/ul><\/li><\/ul>/);
  // And back to automatic.
  const cleared = state.apply(tr).tr;
  setBlockDirection(cleared, 1, null);
  assert.equal(JSON.stringify(cleared.doc.toJSON()).includes('"dir":"rtl"'), false);
});

test("read-only pages and HTML exports get the direction of right-to-left text", () => {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = '<p>Hello</p><p>مرحبا</p><ul><li><p>שלום</p></li></ul><p dir="ltr">مرحبا</p><p dir="auto">שלום</p>';
  applyTextDirections(root as unknown as HTMLElement);
  assert.equal(
    root.innerHTML,
    '<p>Hello</p><p dir="rtl">مرحبا</p><ul dir="rtl"><li><p>שלום</p></li></ul><p dir="ltr">مرحبا</p><p dir="rtl">שלום</p>',
  );
});
