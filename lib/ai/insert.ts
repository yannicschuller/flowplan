// Putting an AI answer into a document: the Markdown goes through the
// Markdown import conversion (lib/markdown-html.ts), so headings, lists,
// task lists, tables, code and callouts become real blocks; then one
// transaction replaces the selection or adds the blocks below it – one undo
// step, and with collaboration one Yjs change like any other edit.
import { Slice, type Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { markdownToRawHtml } from "../markdown-html";
import { cleanAnswer } from "./prompts";

// Links only to web, mail and in-app addresses.
function safeHref(href: string) {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^(#|\/(?!\/))/.test(value)) return value;
  return null;
}

// The answer as editor HTML. Images are left out (their alt text stays): an
// answer must not make the browser load addresses it names – text injected
// into a page could otherwise smuggle content out through an image URL.
// Raw HTML in the answer stays text (lib/markdown-html.ts).
export function aiMarkdownToHtml(markdown: string) {
  return markdownToRawHtml(cleanAnswer(markdown), (href, kind) => (kind === "image" ? null : safeHref(href)));
}

// "replace" the range, "below" it, or at the "top" of the document.
export type AiInsertMode = "replace" | "below" | "top";

// Blocks that a selection may cover completely and that are then replaced as
// a whole (a fully selected list becomes the new list, not a list in a list).
const WRAPPERS = new Set(["bulletList", "orderedList", "taskList", "listItem", "taskItem", "blockquote", "toggle"]);

// The block range a selection covers, widened to whole blocks when the
// selection spans their complete text.
function coveredBlocks(doc: ProseMirrorNode, from: number, to: number) {
  const $from = doc.resolve(from),
    $to = doc.resolve(to);
  const range = $from.blockRange($to);
  if (!range) return null;
  if (doc.textBetween(range.start, from, "\n", "\n").trim() || doc.textBetween(to, range.end, "\n", "\n").trim()) return null;
  let { start, end } = range;
  let depth = range.depth;
  // Climb while the selection covers the whole wrapper (all of a list).
  while (depth > 0) {
    const parent = $from.node(depth);
    if (!WRAPPERS.has(parent.type.name)) break;
    const before = $from.before(depth),
      after = $from.after(depth);
    if (doc.textBetween(before, start, "\n", "\n").trim() || doc.textBetween(end, after, "\n", "\n").trim()) break;
    start = before;
    end = after;
    depth--;
  }
  return { start, end };
}

// After the block holding `pos` – after a whole list or quote, not inside it.
function afterBlock(doc: ProseMirrorNode, pos: number) {
  const $pos = doc.resolve(pos);
  if ($pos.depth === 0) return pos;
  let depth = $pos.depth;
  while (depth > 1 && WRAPPERS.has($pos.node(depth - 1).type.name)) depth--;
  return $pos.after(depth);
}

// One transaction that puts `blocks` (block nodes of the editor's schema) in
// place of the range or below it; null when there is nothing to insert.
export function aiInsertTransaction(
  state: EditorState,
  blocks: Fragment,
  range: { from: number; to: number },
  mode: AiInsertMode,
): Transaction | null {
  let content = false;
  blocks.forEach((node) => {
    if (!node.isTextblock || node.content.size) content = true;
  });
  if (!content) return null;
  const { doc } = state;
  const from = Math.max(0, Math.min(range.from, range.to, doc.content.size)),
    to = Math.max(from, Math.min(Math.max(range.from, range.to), doc.content.size));
  const tr = state.tr;
  const $from = doc.resolve(from);
  let end: number, start: number;
  if (mode === "top") {
    start = 0;
    tr.replaceRange(0, 0, new Slice(blocks, 0, 0));
    end = tr.mapping.map(0, 1);
  } else if (mode === "below") {
    const at = afterBlock(doc, to);
    start = at;
    tr.replaceRange(at, at, new Slice(blocks, 0, 0));
    end = tr.mapping.map(at, 1);
  } else if (from === to && $from.parent.isTextblock && !$from.parent.content.size && $from.depth > 0) {
    // An empty line (the /ki command): the blocks take its place.
    const after = $from.after();
    start = $from.before();
    tr.replaceRange(start, after, new Slice(blocks, 0, 0));
    end = tr.mapping.map(after, 1);
  } else if (
    blocks.childCount === 1 &&
    blocks.firstChild!.type.name === "paragraph" &&
    $from.parent.isTextblock &&
    $from.sameParent(doc.resolve(to)) &&
    !coveredBlocks(doc, from, to)
  ) {
    // Part of one paragraph, answered with one paragraph: stays inline.
    start = from;
    tr.replaceWith(from, to, blocks.firstChild!.content);
    end = tr.mapping.map(to, 1);
  } else {
    const whole = coveredBlocks(doc, from, to);
    if (whole) {
      start = whole.start;
      tr.replaceRange(whole.start, whole.end, new Slice(blocks, 0, 0));
      end = tr.mapping.map(whole.end, 1);
    } else {
      start = from;
      tr.replaceRange(from, to, new Slice(blocks, 0, 0));
      end = tr.mapping.map(to, 1);
    }
  }
  if (!tr.docChanged) return null;
  // Where the answer landed, for the short highlight (aiInsertedPlugin).
  tr.setMeta(insertedKey, { from: Math.min(tr.mapping.map(start, -1), end), to: end });
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
  return tr.scrollIntoView();
}

// The selection as Markdown-ish text for the prompt: blocks on lines of
// their own, list items with a dash.
export function selectionText(doc: ProseMirrorNode, from: number, to: number) {
  const lines: string[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1),
      stop = Math.min(to, pos + 1 + node.content.size);
    const text = doc.textBetween(start, stop, " ", " ");
    const type = parent?.type.name;
    const prefix =
      node.type.name === "heading"
        ? "#".repeat(Number(node.attrs.level) || 1) + " "
        : type === "listItem"
          ? "- "
          : type === "taskItem"
            ? `- [${parent?.attrs.checked ? "x" : " "}] `
            : "";
    lines.push(node.type.name === "codeBlock" ? "```\n" + text + "\n```" : prefix + text);
    return false;
  });
  return lines.join("\n").trim() || doc.textBetween(from, to, "\n", " ").trim();
}

// The inserted blocks light up briefly (a soft accent background fading
// out, app/globals.css .ai-inserted) so the eye finds them. Decorations only:
// nothing is stored in the document, collaborators and undo see nothing.
const insertedKey = new PluginKey<DecorationSet>("flowplanAiInserted");
export const AI_INSERTED_MS = 1200;
export function insertedRange(tr: Transaction) {
  return (tr.getMeta(insertedKey) as { from: number; to: number } | undefined) || null;
}
function insertedDecorations(doc: ProseMirrorNode, from: number, to: number) {
  const marks: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isBlock && pos >= from && pos + node.nodeSize <= to) {
      marks.push(Decoration.node(pos, pos + node.nodeSize, { class: "ai-inserted" }));
      return false;
    }
    return true;
  });
  // Inside one paragraph: the inserted text itself.
  if (!marks.length && from < to) marks.push(Decoration.inline(from, to, { class: "ai-inserted" }));
  return DecorationSet.create(doc, marks);
}
export const aiInsertedPlugin = new Plugin<DecorationSet>({
  key: insertedKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, value) {
      const meta = tr.getMeta(insertedKey) as { from: number; to: number } | "clear" | undefined;
      if (meta === "clear") return DecorationSet.empty;
      if (meta) return insertedDecorations(tr.doc, meta.from, Math.min(meta.to, tr.doc.content.size));
      return value === DecorationSet.empty ? value : value.map(tr.mapping, tr.doc);
    },
  },
  props: {
    decorations: (state) => insertedKey.getState(state),
  },
  view() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      // Once a highlight shows, it is cleared after it has faded.
      update(view) {
        const current = insertedKey.getState(view.state);
        if (!current || current === DecorationSet.empty || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(insertedKey, "clear").setMeta("addToHistory", false));
        }, AI_INSERTED_MS + 100);
      },
      destroy() {
        clearTimeout(timer);
      },
    };
  },
});
