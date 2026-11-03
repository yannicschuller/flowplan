import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { highlightedLines, startLine } from "./code-block-options";

// Line numbers and highlighted lines of code blocks in the editor (#93), as
// decorations next to Shiki's (lib/code-highlight-plugin.ts): nothing of it
// is part of the document. Each line starts with a widget – the number, drawn
// by CSS from data-line, so it cannot be selected or copied – that sits in
// the block's gutter; wrapped lines continue beside it. A highlighted line
// gets a band behind it and its text marked (for wrapped lines).
export const codeLinesKey = new PluginKey<DecorationSet>("codeLines");
const REFRESH = "refresh";
// Very long blocks get numbers up to here.
export const MAX_NUMBERED_LINES = 20_000;

type Block = { pos: number; node: PMNode };
function blocks(doc: PMNode, name: string) {
  const found: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === name) {
      found.push({ pos, node });
      return false;
    }
    return node.isBlock;
  });
  return found;
}

// The offsets where the lines of a text start.
export function lineStarts(text: string, max = MAX_NUMBERED_LINES) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0 && starts.length < max; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

// Unchanged blocks (the same node object) are not split into lines again.
const startsCache = new WeakMap<PMNode, number[]>();

function marker(line: number, numbered: boolean, highlighted: boolean) {
  return () => {
    const span = document.createElement("span");
    span.className = `code-line-number${highlighted ? " is-highlighted" : ""}${numbered ? "" : " is-mark"}`;
    if (numbered) span.dataset.line = String(line);
    span.contentEditable = "false";
    span.setAttribute("aria-hidden", "true");
    return span;
  };
}

export function lineDecorations(node: PMNode, pos: number, numbersByDefault: boolean): Decoration[] {
  const numbered = typeof node.attrs.lineNumbers === "boolean" ? node.attrs.lineNumbers : numbersByDefault;
  const marked = highlightedLines(node.attrs.highlightLines);
  if (!numbered && !marked.size) return [];
  const text = node.textContent;
  let starts = startsCache.get(node);
  if (!starts) startsCache.set(node, (starts = lineStarts(text)));
  const first = startLine(node.attrs.startLine);
  const all: Decoration[] = [];
  const lines = starts;
  lines.forEach((start, i) => {
    const highlighted = marked.has(i + 1);
    if (!numbered && !highlighted) return;
    const at = pos + 1 + start;
    all.push(
      Decoration.widget(at, marker(first + i, numbered, highlighted), {
        side: -1,
        ignoreSelection: true,
        key: `line:${first + i}:${numbered ? 1 : 0}:${highlighted ? 1 : 0}`,
      }),
    );
    const end = i + 1 < lines.length ? lines[i + 1] - 1 : text.length;
    if (highlighted && end > start) all.push(Decoration.inline(at, pos + 1 + end, { class: "code-line-highlight" }));
  });
  return all;
}

const sameBlocks = (a: Block[], b: Block[]) => a.length === b.length && a.every((block, i) => block.node === b[i].node);

export function codeLinesPlugin(name = "codeBlock", numbersByDefault: () => boolean = () => false, subscribe?: (listener: () => void) => () => void) {
  let last: Block[] = [];
  const build = (doc: PMNode) => {
    last = blocks(doc, name);
    const byDefault = numbersByDefault();
    return DecorationSet.create(
      doc,
      last.flatMap(({ node, pos }) => lineDecorations(node, pos, byDefault)),
    );
  };
  return new Plugin<DecorationSet>({
    key: codeLinesKey,
    state: {
      init: (_, state) => build(state.doc),
      apply(tr, set, _old, state: EditorState) {
        if (tr.getMeta(codeLinesKey) === REFRESH) return build(state.doc);
        if (!tr.docChanged) return set;
        const now = blocks(state.doc, name);
        if (sameBlocks(now, last)) {
          last = now;
          return set.map(tr.mapping, tr.doc);
        }
        return build(state.doc);
      },
    },
    view(view: EditorView) {
      // The personal default changed (Settings, another tab): drawn again.
      const stop = subscribe?.(() => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(codeLinesKey, REFRESH));
      });
      return { destroy: () => stop?.() };
    },
    props: {
      decorations: (state) => codeLinesKey.getState(state),
    },
  });
}
