// Putting an AI answer into a document: the Markdown goes through the
// Markdown import conversion (lib/markdown-html.ts), so headings, lists,
// task lists, tables, code and callouts become real blocks; then one
// transaction replaces the selection or adds the blocks below it – one undo
// step, and with collaboration one Yjs change like any other edit.
import { Slice, type Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { markdownToRawHtml } from "../markdown-html";
import { fenceLanguage } from "../code-languages";
import { markdownSymbol } from "../task-status";
import { expandLinkHandles, pageLinkHref, type LinkTarget } from "./links";
import { cleanAnswer } from "./prompts";

// Links only to web, mail and in-app addresses.
export function safeHref(href: string) {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^(#|\/(?!\/))/.test(value)) return value;
  return null;
}

// Links as safeHref, images left out (see below) – for AI text written on
// the server (lib/ai/actions.ts).
export const aiAnswerHref = (href: string, kind: "link" | "image") => (kind === "image" ? null : safeHref(href));

// The answer as editor HTML. Images are left out (their alt text stays): an
// answer must not make the browser load addresses it names – text injected
// into a page could otherwise smuggle content out through an image URL.
// Raw HTML in the answer stays text (lib/markdown-html.ts).
// With `links` (the pages offered to the model, lib/ai/links.ts) its page
// handles become internal page links – "/#page=<id>", as the editor makes
// them – and only those: unknown handles and page addresses the model wrote
// itself stay text.
// `raw`: the Markdown as it is – blocks of a proposed page change
// (lib/ai/page-edits.ts) are content, not an answer to clean up.
export function aiMarkdownToHtml(markdown: string, links?: readonly LinkTarget[] | null, options: { raw?: boolean } = {}) {
  const text = options.raw ? markdown.replace(/\r\n?/g, "\n") : taskMarkers(cleanAnswer(markdown));
  return markdownToRawHtml(links ? expandLinkHandles(text, links) : text, (href, kind) => {
    if (kind === "image") return null;
    if (links) {
      const page = pageLinkHref(href, links);
      if (page !== undefined) return page;
    }
    return safeHref(href);
  });
}

// Checkboxes the way models write them besides "- [ ] " (#431): "- [] a",
// "- [ ]a", "[ ] a" without a dash, "☐ a" / "- ☐ a", "1. [ ] a" (the editor
// has no numbered tasks) – as Markdown tasks, so they become task items and
// not bullets with brackets. Code blocks stay as they are.
const BOX_OPEN = "☐□";
const BOX_DONE = "☑☒";
export function taskMarkers(markdown: string) {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || marker[0] === fence[0])) {
        fence = fence ? null : marker;
        return line;
      }
      if (fence) return line;
      return line
        .replace(/^(\s*)(?:[-*+]|\d{1,3}[.)])\s+\[( |x|X)?\]\s*(?=\S)/, (_m, indent: string, mark?: string) => `${indent}- [${mark && mark !== " " ? "x" : " "}] `)
        .replace(/^(\s*)\[( |x|X)?\]\s+(?=\S)/, (_m, indent: string, mark?: string) => `${indent}- [${mark && mark !== " " ? "x" : " "}] `)
        .replace(new RegExp(`^(\\s*)(?:[-*+]\\s+)?([${BOX_OPEN}${BOX_DONE}])\\s*(?=\\S)`), (_m, indent: string, box: string) => `${indent}- [${BOX_DONE.includes(box) ? "x" : " "}] `);
    })
    .join("\n");
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
// their own, bulleted items with a dash, numbered items with their number,
// tasks with their box, sub-items indented, quotes with "> " – so the model
// sees which kind of block it works on (#431).
export function selectionText(doc: ProseMirrorNode, from: number, to: number) {
  const lines: string[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1),
      stop = Math.min(to, pos + 1 + node.content.size);
    const text = doc.textBetween(start, stop, " ", " ");
    // The ancestors in order: a quote adds "> ", the list item holding the
    // text its marker, outer items (and a later paragraph of the item) the
    // marker's width as indent.
    const $pos = doc.resolve(pos);
    let prefix = "";
    for (let depth = 1; depth <= $pos.depth; depth++) {
      const ancestor = $pos.node(depth);
      const name = ancestor.type.name;
      if (name === "blockquote") prefix += "> ";
      else if (name === "listItem" || name === "taskItem") {
        const list = $pos.node(depth - 1);
        const marker =
          name === "taskItem"
            ? `- [${markdownSymbol(ancestor.attrs)}] `
            : list.type.name === "orderedList"
              ? `${(Number(list.attrs.start) || 1) + $pos.index(depth - 1)}. `
              : "- ";
        prefix += depth === $pos.depth && $pos.index(depth) === 0 ? marker : " ".repeat(marker.length);
      }
    }
    if (node.type.name === "heading") prefix += "#".repeat(Number(node.attrs.level) || 1) + " ";
    lines.push(node.type.name === "codeBlock" ? "```" + fenceLanguage(String(node.attrs.language || "")).replace(/^plaintext$/, "") + "\n" + text + "\n```" : prefix + text);
    return false;
  });
  return lines.join("\n").trim() || doc.textBetween(from, to, "\n", " ").trim();
}

// The inserted blocks light up briefly (a soft accent background fading
// out, app/globals.css .ai-inserted) so the eye finds them. Decorations only:
// nothing is stored in the document, collaborators and undo see nothing.
const insertedKey = new PluginKey<DecorationSet>("flowplanAiInserted");
export const AI_INSERTED_MS = 1200;
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
