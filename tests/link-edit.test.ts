// The link dialog edits a link's text and address together (#530,
// lib/link-edit.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import { applyLinkEdit, linkTarget, removeLink, targetFits } from "../lib/link-edit";

const s = documentSchema();
const link = (href: string) => s.marks.link.create({ href });
const bold = s.marks.bold.create();
// "Hello <a>world wide</a> web" with the selection from..to.
const doc = (...content: Node[]) => s.node("doc", null, [s.node("paragraph", null, content)]);
const sample = () => doc(s.text("Hello "), s.text("world ", [link("https://a.example/")]), s.text("wide", [link("https://a.example/"), bold]), s.text(" web"));
const at = (d: Node, from: number, to = from) => EditorState.create({ schema: s, doc: d, selection: TextSelection.create(d, from, to) });
// Positions: paragraph starts at 1; "Hello " 1–7, link 7–17, " web" 17–21.
const linksOf = (d: Node) => {
  const out: { text: string; href: string; bold: boolean }[] = [];
  d.descendants((n) => {
    const m = n.isText ? n.marks.find((x) => x.type.name === "link") : null;
    if (m) out.push({ text: n.text!, href: m.attrs.href, bold: n.marks.some((x) => x.type.name === "bold") });
  });
  return out;
};

test("a selection without a link: its text, no address", () => {
  const target = linkTarget(at(sample(), 1, 6));
  assert.deepEqual([target.from, target.to, target.text, target.href, target.textEditable], [1, 6, "Hello", "", true]);
});

test("a cursor in a link takes the whole link", () => {
  const target = linkTarget(at(sample(), 9));
  assert.deepEqual([target.from, target.to, target.text, target.href], [7, 17, "world wide", "https://a.example/"]);
});

test("a selection touching a link grows to the whole link", () => {
  const target = linkTarget(at(sample(), 3, 10));
  assert.deepEqual([target.from, target.to, target.text], [3, 17, "llo world wide"]);
});

test("a cursor outside a link: empty text, insert the address as text", () => {
  const state = at(sample(), 21);
  const target = linkTarget(state);
  assert.deepEqual([target.text, target.href], ["", ""]);
  const tr = applyLinkEdit(state, target, { text: "", href: "https://b.example/" })!;
  assert.equal(tr.doc.textContent, "Hello world wide webhttps://b.example/");
  assert.deepEqual(linksOf(tr.doc).at(-1), { text: "https://b.example/", href: "https://b.example/", bold: false });
  const named = applyLinkEdit(state, target, { text: "B", href: "https://b.example/" })!;
  assert.equal(named.doc.textContent, "Hello world wide webB");
});

test("unchanged text only changes the address – no replace step", () => {
  const state = at(sample(), 9);
  const tr = applyLinkEdit(state, linkTarget(state), { text: "world wide", href: "https://c.example/" })!;
  assert.ok(tr.steps.every((step) => step.constructor.name !== "ReplaceStep"));
  assert.equal(tr.doc.textContent, "Hello world wide web");
  assert.deepEqual(linksOf(tr.doc), [
    { text: "world ", href: "https://c.example/", bold: false },
    { text: "wide", href: "https://c.example/", bold: true },
  ]);
});

test("a new text replaces the whole link and keeps the first character's marks", () => {
  const boldFirst = doc(s.text("x "), s.text("old", [bold, link("https://a.example/")]));
  const state = at(boldFirst, 4);
  const tr = applyLinkEdit(state, linkTarget(state), { text: "new text", href: "https://d.example/" })!;
  assert.equal(tr.doc.textContent, "x new text");
  assert.deepEqual(linksOf(tr.doc), [{ text: "new text", href: "https://d.example/", bold: true }]);
  assert.equal(tr.selection.from, 3 + "new text".length, "cursor after the link");
});

test("selected text becomes a link with a changed text", () => {
  const state = at(sample(), 18, 21);
  const target = linkTarget(state);
  assert.equal(target.text, "web");
  const tr = applyLinkEdit(state, target, { text: "the web", href: "https://e.example/" })!;
  assert.equal(tr.doc.textContent, "Hello world wide the web");
  assert.deepEqual(linksOf(tr.doc).at(-1), { text: "the web", href: "https://e.example/", bold: false });
});

test("empty text on a selection keeps the selected text", () => {
  const state = at(sample(), 1, 6);
  const tr = applyLinkEdit(state, linkTarget(state), { text: "", href: "https://f.example/" })!;
  assert.equal(tr.doc.textContent, "Hello world wide web");
  assert.deepEqual(linksOf(tr.doc)[0], { text: "Hello", href: "https://f.example/", bold: false });
});

test("across blocks only the address is set", () => {
  const d = s.node("doc", null, [s.node("paragraph", null, [s.text("one")]), s.node("paragraph", null, [s.text("two")])]);
  const state = at(d, 2, 7);
  const target = linkTarget(state);
  assert.equal(target.textEditable, false);
  const tr = applyLinkEdit(state, target, { text: "ignored", href: "https://g.example/" })!;
  assert.equal(tr.doc.child(0).textContent + tr.doc.child(1).textContent, "onetwo");
  assert.deepEqual(linksOf(tr.doc).map((l) => l.text), ["ne", "t"]);
});

test("remove takes the whole link; a stale target is noticed", () => {
  const state = at(sample(), 9);
  const target = linkTarget(state);
  assert.deepEqual(linksOf(removeLink(state, target)!.doc), []);
  const edited = state.apply(state.tr.insertText("Hi ", 1));
  assert.equal(targetFits(state, target), true);
  assert.equal(targetFits(edited, target), false);
});
