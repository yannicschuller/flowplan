import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { highlightTokens, isLanguageReady, loadLanguage, type CodeToken } from "./code-highlight";

// Highlighting of code blocks in the editor as decorations: nothing of it is
// part of the document, so every collaborator has the same content however
// far their grammars have loaded. A block whose grammar is still loading
// shows plain text; the plugin loads it and draws the decorations again.
export const codeHighlightKey = new PluginKey<DecorationSet>("codeHighlight");
const REFRESH = "refresh";

// Ranges per block node: unchanged blocks (the same node object) are not
// tokenized again.
const cache = new WeakMap<PMNode, CodeToken[]>();
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

function decorations(doc: PMNode, found: Block[], missing: Set<string>) {
  const all: Decoration[] = [];
  for (const { pos, node } of found) {
    let tokens = cache.get(node);
    if (!tokens) {
      const language = String(node.attrs.language || "");
      const result = highlightTokens(language, node.textContent);
      if (!result) {
        missing.add(language);
        continue;
      }
      cache.set(node, (tokens = result));
    }
    for (const token of tokens)
      all.push(Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, { class: token.className }));
  }
  return DecorationSet.create(doc, all);
}

const sameBlocks = (a: Block[], b: Block[]) => a.length === b.length && a.every((block, i) => block.node === b[i].node);

export function codeHighlightPlugin(name = "codeBlock") {
  let view: EditorView | null = null;
  let last: Block[] = [];
  const requested = new Set<string>();
  // Loads what is missing; the decorations follow in one transaction.
  const load = (missing: Set<string>) => {
    for (const language of missing) {
      if (requested.has(language) || isLanguageReady(language)) continue;
      requested.add(language);
      void loadLanguage(language).then(() => {
        requested.delete(language);
        if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(codeHighlightKey, REFRESH));
      });
    }
  };
  const build = (state: { doc: PMNode }) => {
    const missing = new Set<string>();
    last = blocks(state.doc, name);
    const set = decorations(state.doc, last, missing);
    // Not from inside a state update: a microtask later.
    if (missing.size) queueMicrotask(() => load(missing));
    return set;
  };
  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_, state) => build(state),
      apply(tr, set, _old, state: EditorState) {
        if (tr.getMeta(codeHighlightKey) === REFRESH) return build(state);
        if (!tr.docChanged) return set;
        // Only when a code block changed, appeared or went away; otherwise
        // the decorations move along with the text.
        const now = blocks(state.doc, name);
        if (sameBlocks(now, last)) {
          last = now;
          return set.map(tr.mapping, tr.doc);
        }
        return build(state);
      },
    },
    view(editorView) {
      view = editorView;
      return { destroy: () => void (view = null) };
    },
    props: {
      decorations: (state) => codeHighlightKey.getState(state),
    },
  });
}
