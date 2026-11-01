import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Fragment, Slice, type Node } from "@tiptap/pm/model";
import { documentSchema } from "../lib/document-schema";
import {
  carryFolds,
  foldSections,
  foldableIds,
  foldedAround,
  headingId,
  hiddenRanges,
  readFolds,
  writeFolds,
  withFoldedSections,
  FOLD_STORAGE_KEY,
  MAX_FOLD_DOCUMENTS,
  type FoldBlock,
} from "../lib/heading-folds";
import { documentSections, foldedBlockPositions, headingFoldsKey, headingFoldsPlugin } from "../lib/heading-folds-plugin";
import { changeBlocks } from "../lib/document-blocks";

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const h = (level: number, text: string) => schema.nodes.heading.create({ level }, text ? schema.text(text) : undefined);
const doc = (...nodes: Node[]) => schema.nodes.doc.create(null, nodes);
const state = (...nodes: Node[]) => EditorState.create({ schema, doc: doc(...nodes), plugins: [headingFoldsPlugin("test")] });
const folds = (s: EditorState) => headingFoldsKey.getState(s)!;
const hiddenClasses = (s: EditorState) =>
  folds(s)
    .decorations.find()
    .filter((d) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class === "fold-hidden").length;
const H = (level: number, text = "") => ({ heading: { level, text }, size: 4 }) satisfies FoldBlock;
const B = { heading: null, size: 3 } satisfies FoldBlock;

test("a section reaches to the next heading of the same or a higher level", () => {
  const sections = foldSections([H(1, "A"), B, H(2, "A1"), B, B, H(3, "deep"), B, H(2, "A2"), H(1, "B"), B]);
  assert.deepEqual(
    sections.map((s) => [s.index, s.hidden]),
    [
      [0, 7], // H1 "A": everything up to H1 "B"
      [2, 4], // H2 "A1": two blocks and the H3 with its block … up to H2 "A2"
      [5, 1],
      [7, 0], // H2 "A2" right before H1 "B": nothing to hide
      [8, 1], // the last section runs to the end of the document
    ],
  );
  const a = sections[0];
  assert.equal(a.pos, 0);
  assert.equal(a.headingEnd, 4);
  assert.equal(a.end, sections[4].pos);
  assert.equal(sections[4].end, 4 + 3 + 4 + 3 + 3 + 4 + 3 + 4 + 4 + 3);
  // Blocks before the first heading belong to no section.
  assert.equal(foldSections([B, B, H(2, "x"), B])[0].pos, 6);
  assert.deepEqual(foldSections([]), []);
  // A lower level after a higher one ends nothing: H3 then H1.
  assert.deepEqual(
    foldSections([H(3, "a"), B, H(1, "b"), B]).map((s) => s.hidden),
    [1, 1],
  );
});

test("heading ids follow text and occurrence, not position or spacing", () => {
  assert.equal(headingId("Notes", 0), headingId("  notes ", 0));
  assert.equal(headingId("Meeting  notes", 0), headingId("Meeting notes", 0));
  assert.notEqual(headingId("Notes", 0), headingId("Notes", 1));
  assert.notEqual(headingId("Notes", 0), headingId("Other", 0));
  assert.match(headingId("Überschrift mit ümläuten", 3), /^[0-9a-z]+\.3$/);
  // No document text in the id (it is stored on the device).
  assert.ok(!headingId("Secret plan", 0).includes("secret"));
  // Two headings with the same text: the second counts as occurrence 1.
  const sections = foldSections([H(2, "Notes"), B, H(2, "Notes"), B, H(1, "notes")]);
  assert.deepEqual(
    sections.map((s) => s.id),
    [headingId("Notes", 0), headingId("Notes", 1), headingId("Notes", 2)],
  );
  // Blocks before a heading do not change its id.
  assert.equal(foldSections([B, B, B, H(2, "Notes")])[0].id, sections[0].id);
});

test("only top-level headings fold; headings in callouts, toggles and tables stay", () => {
  const s = state(
    h(1, "Top"),
    p("a"),
    schema.nodes.callout.create(null, [h(2, "In callout"), p("b")]),
    schema.nodes.toggle.create({ title: "T" }, [h(2, "In toggle"), p("c")]),
    h(1, "Next"),
  );
  const sections = documentSections(s.doc);
  assert.deepEqual(
    sections.map((x) => x.hidden),
    [3, 0],
  );
  // The callout and the toggle are part of the section of "Top".
  assert.equal(sections[0].end, sections[1].pos);
});

test("folds are carried by node, mapped position, id or place", () => {
  const before = foldSections([
    { ...H(1, "A"), node: "nodeA" },
    B,
    { ...H(1, "B"), node: "nodeB" },
    B,
  ]);
  const folded = new Set([before[0].id, before[1].id]);
  // Same nodes, text unchanged: nothing to do.
  assert.deepEqual(carryFolds(folded, before, before), folded);
  // The heading's text changed locally: found at its mapped position.
  const typed = foldSections([{ ...H(1, "A typed"), node: "new" }, B, { ...H(1, "B"), node: "nodeB" }, B]);
  const carried = carryFolds(folded, before, typed, (pos) => pos);
  assert.ok(carried.has(typed[0].id));
  assert.ok(!carried.has(before[0].id));
  assert.ok(carried.has(before[1].id));
  // A heading inserted above with the same text as a folded one: the folded
  // node keeps its fold (its occurrence changed).
  const inserted = foldSections([
    { ...H(1, "B"), node: "inserted" },
    { ...H(1, "A"), node: "nodeA" },
    B,
    { ...H(1, "B"), node: "nodeB" },
    B,
  ]);
  const shifted = carryFolds(folded, before, inserted);
  assert.ok(shifted.has(inserted[2].id), "the old B, now occurrence 1");
  assert.ok(shifted.has(inserted[1].id), "A by node");
  assert.ok(!shifted.has(inserted[0].id), "the new heading stays open");
  // Someone else changed the text (a new node, no mapping): same level and place.
  const remote = foldSections([{ ...H(1, "A by someone"), node: "remote" }, B, { ...H(1, "B"), node: "nodeB" }, B]);
  assert.ok(carryFolds(folded, before, remote, () => null).has(remote[0].id));
  // Without anything before (still loading) the stored ids stay.
  assert.deepEqual(carryFolds(folded, [], remote), folded);
});

test("hidden ranges: outermost folded sections only; what holds a position", () => {
  const sections = foldSections([H(1, "A"), B, H(2, "A1"), B, H(1, "B"), B]);
  const all = new Set(foldableIds(sections));
  assert.equal(all.size, 3);
  assert.deepEqual(
    hiddenRanges(sections, all).map((s) => s.index),
    [0, 4],
  );
  const inner = new Set([sections[1].id]);
  assert.deepEqual(
    hiddenRanges(sections, inner).map((s) => s.index),
    [2],
  );
  const insideA1 = sections[1].headingEnd + 1;
  assert.deepEqual(
    foldedAround(sections, all, insideA1).map((s) => s.index),
    [0, 2],
  );
  // The heading itself is not hidden by its own fold.
  assert.deepEqual(foldedAround(sections, all, sections[0].pos + 1), []);
  // A folded heading moves with its hidden blocks.
  const starts = [0, 4, 7, 11, 14, 18];
  assert.deepEqual(withFoldedSections([7], sections, inner, starts), [7, 11]);
  assert.deepEqual(withFoldedSections([7], sections, new Set(), starts), [7]);
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test("folds are stored per document on the device, bounded", () => {
  const storage = memoryStorage();
  assert.deepEqual(readFolds(storage, "page"), []);
  writeFolds(storage, "page", ["abc.0", "def.1"], 1);
  writeFolds(storage, "page/row", ["xyz.0"], 2);
  assert.deepEqual(readFolds(storage, "page"), ["abc.0", "def.1"]);
  assert.deepEqual(readFolds(storage, "page/row"), ["xyz.0"]);
  // Unfolding everything removes the entry; the last one removes the key.
  writeFolds(storage, "page", [], 3);
  assert.deepEqual(readFolds(storage, "page"), []);
  writeFolds(storage, "page/row", [], 4);
  assert.equal(storage.data.has(FOLD_STORAGE_KEY), false);
  // Broken or foreign values read as nothing.
  storage.setItem(FOLD_STORAGE_KEY, "{not json");
  assert.deepEqual(readFolds(storage, "page"), []);
  storage.setItem(FOLD_STORAGE_KEY, JSON.stringify({ page: { ids: ["ok.0", 5, "<script>"], at: 1 } }));
  assert.deepEqual(readFolds(storage, "page"), ["ok.0"]);
  assert.deepEqual(readFolds(null, "page"), []);
  // The least recently changed documents go first.
  for (let i = 0; i < MAX_FOLD_DOCUMENTS + 5; i++) writeFolds(storage, `p${i}`, ["a.0"], 100 + i);
  assert.deepEqual(readFolds(storage, "p0"), []);
  assert.deepEqual(readFolds(storage, `p${MAX_FOLD_DOCUMENTS + 4}`), ["a.0"]);
  assert.equal(Object.keys(JSON.parse(storage.getItem(FOLD_STORAGE_KEY)!)).length, MAX_FOLD_DOCUMENTS);
});

test("the plugin hides a folded section with decorations, never changing the document", () => {
  let s = state(h(1, "Intro"), p("one"), p("two"), h(2, "Sub"), p("three"), h(1, "End"), p("four"));
  const before = s.doc;
  s = s.apply(s.tr.setMeta(headingFoldsKey, { toggle: 0 }));
  assert.equal(s.doc, before);
  assert.equal(hiddenClasses(s), 4); // two paragraphs, the sub heading and its paragraph
  s = s.apply(s.tr.setMeta(headingFoldsKey, { toggle: 0 }));
  assert.equal(hiddenClasses(s), 0);
  // Fold everything: the outer sections hide all; unfold everything.
  s = s.apply(s.tr.setMeta(headingFoldsKey, { all: true }));
  assert.equal(folds(s).folded.size, 3);
  assert.equal(hiddenClasses(s), 5);
  s = s.apply(s.tr.setMeta(headingFoldsKey, { all: false }));
  assert.equal(folds(s).folded.size, 0);
});

test("typing in a folded heading keeps it folded; the caret in a folded part opens it", () => {
  let s = state(h(1, "Intro"), p("one"), h(1, "End"), p("two"));
  s = s.apply(s.tr.setMeta(headingFoldsKey, { toggle: 0 }));
  // Typing at the end of the heading.
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 6)));
  s = s.apply(s.tr.insertText(" more"));
  assert.equal(s.doc.firstChild!.textContent, "Intro more");
  assert.equal(folds(s).folded.size, 1);
  assert.ok(folds(s).folded.has(headingId("Intro more", 0)));
  assert.equal(hiddenClasses(s), 1);
  // Others' changes replace the whole document (y-prosemirror) and keep
  // unchanged blocks: the fold stays.
  const content: Node[] = [];
  s.doc.forEach((n) => content.push(n));
  s = s.apply(s.tr.replace(0, s.doc.content.size, new Slice(Fragment.from([...content, p("remote")]), 0, 0)));
  assert.equal(hiddenClasses(s), 1);
  // The caret moves into the hidden paragraph (arrow key, outline, undo …).
  const inside = s.doc.firstChild!.nodeSize + 1;
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, inside)));
  assert.equal(folds(s).folded.size, 0);
  assert.equal(hiddenClasses(s), 0);
});

test("folding with the caret inside moves it to the heading; unfoldAt opens what holds a position", () => {
  let s = state(h(1, "Intro"), p("one"), h(1, "End"), p("two"));
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 9)));
  const { state: next } = s.applyTransaction(s.tr.setMeta(headingFoldsKey, { toggle: 0 }));
  s = next;
  assert.equal(folds(s).folded.size, 1);
  assert.equal(s.selection.from, 6, "end of the heading");
  s = s.apply(s.tr.setMeta(headingFoldsKey, { unfoldAt: 9 }));
  assert.equal(folds(s).folded.size, 0);
});

test("moving a folded heading moves its section and it stays folded", () => {
  let s = state(h(1, "A"), p("a1"), p("a2"), h(1, "B"), p("b1"));
  s = s.apply(s.tr.setMeta(headingFoldsKey, { toggle: 0 }));
  const positions = foldedBlockPositions(s, [0]);
  assert.equal(positions.length, 3);
  const end = s.doc.content.size;
  s = s.apply(changeBlocks(s, positions, "move", end));
  assert.deepEqual(
    (() => {
      const out: string[] = [];
      s.doc.forEach((n) => out.push(n.textContent));
      return out;
    })(),
    ["B", "b1", "A", "a1", "a2"],
  );
  // The moved heading is still folded (the caret went to it, not inside).
  assert.equal(folds(s).folded.size, 1);
  assert.equal(hiddenClasses(s), 2);
});
