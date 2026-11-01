// The editor side of folding headings (lib/heading-folds.ts): an arrow
// before every top-level heading with something below it, and decorations
// that hide the folded parts – the document itself never changes. Read mode
// folds as well; printing always shows everything (app/globals.css).
//
// What is folded opens again when the caret gets into it (arrow keys, a
// click in the outline, undo, joining from the next block), when find on the
// page or a jump goes to something in it (FOLD_UNFOLD_EVENT) – so editing
// never happens out of sight.
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { tr } from "./locale-tag";
import {
  FOLD_ALL_EVENT,
  FOLD_UNFOLD_EVENT,
  carryFolds,
  foldDocumentKey,
  foldSections,
  foldableIds,
  foldedAround,
  hiddenRanges,
  hides,
  readFolds,
  withFoldedSections,
  writeFolds,
  type FoldBlock,
  type FoldSection,
} from "./heading-folds";

type FoldState = { sections: FoldSection[]; folded: Set<string>; decorations: DecorationSet };
type FoldMeta = { toggle?: number } | { all: boolean } | { unfoldAt: number };
export const headingFoldsKey = new PluginKey<FoldState>("headingFolds");

export function documentSections(doc: PMNode): FoldSection[] {
  const blocks: FoldBlock[] = [];
  doc.forEach((node) =>
    blocks.push({
      heading: node.type.name === "heading" ? { level: Number(node.attrs.level) || 1, text: node.textContent } : null,
      size: node.nodeSize,
      node,
    }),
  );
  return foldSections(blocks);
}

const storage = () => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const CARET =
  '<svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M181.66 133.66l-80 80a8 8 0 0 1-11.32-11.32L164.69 128 90.34 53.66a8 8 0 0 1 11.32-11.32l80 80a8 8 0 0 1 0 11.32Z"/></svg>';

function arrow(view: EditorView, getPos: () => number | undefined, folded: boolean, label: string) {
  const button = document.createElement("span");
  button.className = "heading-fold";
  button.contentEditable = "false";
  button.setAttribute("role", "button");
  button.tabIndex = -1;
  button.setAttribute("aria-expanded", folded ? "false" : "true");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = CARET;
  // The caret stays where it is; the click folds or unfolds.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = getPos();
    if (typeof pos === "number") toggleFold(view, pos - 1);
  });
  return button;
}

const blocksLabel = (n: number) => (n === 1 ? tr("… 1 Block", "… 1 block") : tr(`… ${n} Blöcke`, `… ${n} blocks`));

function buildDecorations(doc: PMNode, sections: FoldSection[], folded: ReadonlySet<string>): DecorationSet {
  const decorations: Decoration[] = [];
  const ranges = hiddenRanges(sections, folded);
  const hiddenHeading = (s: FoldSection) => ranges.some((r) => r !== s && s.pos >= r.headingEnd && s.pos < r.end);
  for (const s of sections) {
    if (!s.hidden || hiddenHeading(s)) continue;
    const isFolded = folded.has(s.id);
    const label = isFolded ? tr("Abschnitt ausklappen", "Expand section") : tr("Abschnitt einklappen", "Collapse section");
    decorations.push(
      Decoration.widget(s.pos + 1, (view, getPos) => arrow(view, getPos, isFolded, label), {
        side: -1,
        ignoreSelection: true,
        stopEvent: () => true,
        key: `fold-${isFolded ? 1 : 0}-${label}`,
      }),
    );
    if (isFolded)
      decorations.push(Decoration.node(s.pos, s.headingEnd, { class: "heading-folded", "data-fold-label": blocksLabel(s.hidden) }));
  }
  for (const r of ranges) {
    let pos = r.headingEnd;
    while (pos < r.end) {
      const node = doc.nodeAt(pos);
      if (!node) break;
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "fold-hidden" }));
      pos += node.nodeSize;
    }
  }
  return DecorationSet.create(doc, decorations);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

// Where the caret goes when its part is folded: the end of the visible
// heading above it.
function caretOut(trn: Transaction, sections: FoldSection[], folded: ReadonlySet<string>) {
  const { from } = trn.selection;
  const outer = hiddenRanges(sections, folded).find((r) => hides(r, from) || hides(r, trn.selection.to - 1));
  if (outer) trn.setSelection(TextSelection.create(trn.doc, outer.headingEnd - 1));
}

export function toggleFold(view: EditorView, headingPos: number) {
  view.dispatch(view.state.tr.setMeta(headingFoldsKey, { toggle: headingPos } satisfies FoldMeta));
}
export function setAllFolded(view: EditorView, fold: boolean) {
  view.dispatch(view.state.tr.setMeta(headingFoldsKey, { all: fold } satisfies FoldMeta));
}
export function unfoldAt(view: EditorView, pos: number) {
  const value = headingFoldsKey.getState(view.state);
  if (!value || !foldedAround(value.sections, value.folded, pos).length) return false;
  view.dispatch(view.state.tr.setMeta(headingFoldsKey, { unfoldAt: pos } satisfies FoldMeta));
  return true;
}
// Block positions to move together: a folded heading takes its section.
export function foldedBlockPositions(state: EditorState, positions: number[]) {
  const value = headingFoldsKey.getState(state);
  if (!value?.folded.size) return positions;
  const starts: number[] = [];
  state.doc.forEach((_node, offset) => starts.push(offset));
  return withFoldedSections(positions, value.sections, value.folded, starts);
}

// Whether an editor is the one "fold all" means: the topmost dialog's
// (an open record) or, without a dialog, the page's.
function isTarget(dom: HTMLElement) {
  const dialogs = document.querySelectorAll(".modal");
  const top = dialogs[dialogs.length - 1];
  return top ? top.contains(dom) : !dom.closest(".modal");
}

export const HeadingFolds = Extension.create<{ pageId: string; rowId?: string | null; enabled: boolean }>({
  name: "headingFolds",
  addOptions() {
    return { pageId: "", rowId: null, enabled: true };
  },
  // ⌘⌥↵ / Ctrl+Alt+Enter in a heading folds or unfolds its section (the
  // arrow by keyboard).
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-Enter": ({ editor }) => {
        const value = headingFoldsKey.getState(editor.state);
        const { $from } = editor.state.selection;
        if (!value || $from.depth !== 1 || $from.parent.type.name !== "heading") return false;
        const section = value.sections.find((x) => x.pos === $from.before(1));
        if (!section?.hidden) return false;
        toggleFold(editor.view, section.pos);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const { pageId, rowId, enabled } = this.options;
    if (!enabled || !pageId) return [];
    return [headingFoldsPlugin(foldDocumentKey(pageId, rowId))];
  },
});

// The plugin itself; `key` names the document in the device's storage.
export function headingFoldsPlugin(key: string) {
  return new Plugin<FoldState>({
    key: headingFoldsKey,
    state: {
      init: (_config, state) => {
        const sections = documentSections(state.doc);
        const folded = new Set(readFolds(storage(), key));
        return { sections, folded, decorations: buildDecorations(state.doc, sections, folded) };
      },
      apply: (trn, value, _old, state) => {
        let { sections, folded } = value;
        if (trn.docChanged) {
          const next = documentSections(trn.doc);
          folded = carryFolds(folded, sections, next, (pos) => {
            const result = trn.mapping.mapResult(pos, 1);
            return result.deleted ? null : result.pos;
          });
          sections = next;
        }
        const meta = trn.getMeta(headingFoldsKey) as FoldMeta | undefined;
        if (meta && "toggle" in meta) {
          const s = sections.find((x) => x.pos === meta.toggle);
          if (s) {
            folded = new Set(folded);
            if (folded.has(s.id)) folded.delete(s.id);
            else folded.add(s.id);
          }
        } else if (meta && "all" in meta) {
          folded = new Set(folded);
          for (const id of foldableIds(sections)) {
            if (meta.all) folded.add(id);
            else folded.delete(id);
          }
        } else if (meta && "unfoldAt" in meta) {
          const around = foldedAround(sections, folded, meta.unfoldAt);
          if (around.length) {
            folded = new Set(folded);
            for (const s of around) folded.delete(s.id);
          }
        }
        // The caret never stays in a folded part: what it got into opens.
        if (trn.selectionSet && !meta) {
          // A selected block counts where it starts (a selected heading
          // ends where its hidden part begins).
          const sel = state.selection;
          const points = sel instanceof NodeSelection ? [sel.from] : [sel.anchor, sel.head];
          const around = points.flatMap((pos) => foldedAround(sections, folded, pos));
          if (around.length) {
            folded = new Set(folded);
            for (const s of around) folded.delete(s.id);
          }
        }
        if (!trn.docChanged && folded === value.folded) return value;
        if (folded !== value.folded && sameSet(folded, value.folded)) folded = value.folded;
        return {
          sections,
          folded,
          decorations: trn.docChanged || folded !== value.folded ? buildDecorations(trn.doc, sections, folded) : value.decorations,
        };
      },
    },
    // Folding moves the caret out of what is folded.
    appendTransaction: (transactions, _old, state) => {
      if (!transactions.some((t) => t.getMeta(headingFoldsKey))) return null;
      const value = headingFoldsKey.getState(state);
      if (!value) return null;
      const { from, to } = state.selection;
      const inside = hiddenRanges(value.sections, value.folded).some((r) => hides(r, from) || hides(r, Math.max(from, to - 1)));
      if (!inside) return null;
      const trn = state.tr;
      caretOut(trn, value.sections, value.folded);
      return trn.setMeta("addToHistory", false);
    },
    props: {
      decorations: (state) => headingFoldsKey.getState(state)?.decorations,
    },
    view: (view) => {
      const onUnfold = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        try {
          unfoldAt(view, view.posAtDOM(target, 0));
        } catch {}
      };
      const onAll = (event: Event) => {
        if (!isTarget(view.dom)) return;
        setAllFolded(view, !!(event as CustomEvent<{ fold?: boolean }>).detail?.fold);
      };
      view.dom.addEventListener(FOLD_UNFOLD_EVENT, onUnfold);
      window.addEventListener(FOLD_ALL_EVENT, onAll);
      return {
        update: (current, previous) => {
          const now = headingFoldsKey.getState(current.state)?.folded;
          const before = headingFoldsKey.getState(previous)?.folded;
          if (now && before && now !== before) writeFolds(storage(), key, now);
        },
        destroy: () => {
          view.dom.removeEventListener(FOLD_UNFOLD_EVENT, onUnfold);
          window.removeEventListener(FOLD_ALL_EVENT, onAll);
        },
      };
    },
  });
}
