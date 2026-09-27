// Suggested changes ("Vorschlagen"): while suggesting, typed text is marked
// as an insertion and deleted text stays in place, marked as a deletion.
// Everyone who may edit can accept (keep the insertion, remove the deleted
// text) or reject (the other way round). Suggestions are marks in the
// document, so they sync live and survive saving. Formatting and block
// changes are applied directly.
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Fragment, Slice, type Mark as PMMark, type Node as PMNode } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";
import { ySyncPluginKey } from "@tiptap/y-tiptap";

export const SUGGESTION_SKIP = "suggestionInternal";
export type SuggestionKind = "insert" | "delete";
export type SuggestionAttrs = { id: string; kind: SuggestionKind; author: string; name: string; at: number };

export const Suggestion = Mark.create({
  name: "suggestion",
  inclusive: false,
  excludes: "",
  addAttributes() {
    return {
      id: { default: "", parseHTML: (el) => el.getAttribute("data-suggestion-id") || "" },
      kind: {
        default: "insert",
        parseHTML: (el) => (el.getAttribute("data-suggestion") === "delete" ? "delete" : "insert"),
      },
      author: { default: "", parseHTML: (el) => el.getAttribute("data-suggestion-author") || "" },
      name: { default: "", parseHTML: (el) => el.getAttribute("data-suggestion-name") || "" },
      at: { default: 0, parseHTML: (el) => Number(el.getAttribute("data-suggestion-at")) || 0 },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion]" }];
  },
  renderHTML({ mark }) {
    const a = mark.attrs as SuggestionAttrs;
    return [
      "span",
      mergeAttributes({
        "data-suggestion": a.kind,
        "data-suggestion-id": a.id,
        "data-suggestion-author": a.author,
        "data-suggestion-name": a.name,
        "data-suggestion-at": String(a.at || 0),
        class: `suggestion suggestion-${a.kind}`,
        title: `${a.kind === "insert" ? "Eingefügt" : "Gelöscht"} von ${a.name || "jemandem"}`,
      }),
      0,
    ];
  },
});

// ---- Reading suggestions from a document ----

export type SuggestionGroup = SuggestionAttrs & { from: number; to: number; text: string };
export function suggestionGroups(doc: PMNode) {
  const groups = new Map<string, SuggestionGroup>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "suggestion") continue;
      const a = mark.attrs as SuggestionAttrs;
      const key = `${a.id}:${a.kind}`;
      const g = groups.get(key);
      if (g) {
        g.to = pos + node.nodeSize;
        g.text += node.text || "";
      } else groups.set(key, { ...a, from: pos, to: pos + node.nodeSize, text: node.text || "" });
    }
    return true;
  });
  return [...groups.values()].sort((a, b) => a.from - b.from);
}
function ranges(doc: PMNode, test: (a: SuggestionAttrs) => boolean) {
  const out: { from: number; to: number; mark: PMMark }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks)
      if (mark.type.name === "suggestion" && test(mark.attrs as SuggestionAttrs))
        out.push({ from: pos, to: pos + node.nodeSize, mark });
    return true;
  });
  return out.sort((a, b) => b.from - a.from);
}
// Accepting keeps insertions and removes deleted text; rejecting the reverse.
export function resolveSuggestions(state: EditorState, accept: boolean, test: (a: SuggestionAttrs) => boolean) {
  const tr = state.tr;
  for (const r of ranges(state.doc, test)) {
    const a = r.mark.attrs as SuggestionAttrs;
    const keep = accept ? a.kind === "insert" : a.kind === "delete";
    if (keep) tr.removeMark(r.from, r.to, r.mark);
    else tr.delete(r.from, r.to);
  }
  return tr.setMeta(SUGGESTION_SKIP, true);
}

// ---- Tracking while suggesting ----

type Options = {
  enabled: () => boolean;
  user: () => { id: string; name: string };
};
export const suggestKey = new PluginKey<{ key: string }>("suggestChanges");
const newId = () => Math.random().toString(36).slice(2, 10);

// A suggestion of the same person and kind right next to `pos`: typing on
// continues it instead of starting a new one.
function neighbour(doc: PMNode, pos: number, author: string, kind: SuggestionKind) {
  const $pos = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)));
  for (const node of [$pos.nodeBefore, $pos.nodeAfter]) {
    const mark = node?.marks.find(
      (m) => m.type.name === "suggestion" && m.attrs.author === author && m.attrs.kind === kind,
    );
    // The whole mark (with its time), so neighbouring pieces merge.
    if (mark) return mark.attrs as SuggestionAttrs;
  }
  return null;
}
// The deleted content, marked as deletion; the author's own pending
// insertions are dropped (deleting what you suggested removes it for real).
function markDeleted(slice: Slice, attrs: SuggestionAttrs, schema: PMNode["type"]["schema"]) {
  const type = schema.marks.suggestion;
  let kept = 0;
  const map = (fragment: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    fragment.forEach((node) => {
      if (node.isText) {
        const own = node.marks.find((m) => m.type === type && m.attrs.kind === "insert" && m.attrs.author === attrs.author);
        if (own) return;
        const already = node.marks.find((m) => m.type === type && m.attrs.kind === "delete");
        kept += node.nodeSize;
        nodes.push(already ? node : node.mark(type.create(attrs).addToSet(node.marks)));
      } else if (node.isLeaf) {
        kept += node.nodeSize;
        nodes.push(node);
      } else nodes.push(node.copy(map(node.content)));
    });
    return Fragment.fromArray(nodes);
  };
  const content = map(slice.content);
  return { slice: new Slice(content, slice.openStart, slice.openEnd), kept };
}


// What the plugin appends to a person's change while suggesting: marks for
// inserted text, deleted text put back and marked. Exported for tests.
export function suggestTransaction(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  user: { id: string; name: string },
  key: string,
): Transaction | null {
          const relevant = transactions.filter(
            (tr) =>
              tr.docChanged &&
              !tr.getMeta(SUGGESTION_SKIP) &&
              // Changes from others and undo arrive through the Yjs binding.
              !tr.getMeta(ySyncPluginKey),
          );
          if (relevant.length !== 1 || transactions.length > 2) return null;
          const tr = relevant[0];
          if (!tr.steps.every((s) => s instanceof ReplaceStep)) return null;
          if (!user.id) return null;
          const schema = newState.schema;
          const type = schema.marks.suggestion;
          if (!type) return null;
          const at = Date.now();
          type Op =
            | { kind: "insert"; from: number; to: number }
            | { kind: "restore"; pos: number; slice: Slice };
          const ops: Op[] = [];
          tr.steps.forEach((step, i) => {
            const s = step as ReplaceStep & { from: number; to: number; slice: Slice };
            const before = tr.docs[i];
            const after = tr.mapping.slice(i + 1);
            if (s.to > s.from) {
              const deleted = before.slice(s.from, s.to);
              ops.push({ kind: "restore", pos: after.map(s.from, -1), slice: deleted });
            }
            if (s.slice.size > 0) {
              const from = after.map(s.from, -1);
              ops.push({ kind: "insert", from, to: after.map(s.from + s.slice.size, 1) });
            }
          });
          if (!ops.length) return null;
          const out = newState.tr;
          // Insertions first (they do not move text), then restore deleted
          // text from the end of the document backwards.
          for (const op of ops)
            if (op.kind === "insert" && op.to > op.from) {
              const attrs =
                neighbour(newState.doc, op.from, user.id, "insert") ||
                neighbour(newState.doc, op.to, user.id, "insert") || { id: newId(), kind: "insert" as const, author: user.id, name: user.name, at };
              out.addMark(op.from, op.to, type.create(attrs));
            }
          let caret: number | null = null;
          const restores = ops.filter((o): o is Extract<Op, { kind: "restore" }> => o.kind === "restore").sort((a, b) => b.pos - a.pos);
          for (const op of restores) {
            const pos = out.mapping.map(op.pos, -1);
            const attrs = neighbour(out.doc, pos, user.id, "delete") || { id: newId(), kind: "delete" as const, author: user.id, name: user.name, at };
            const { slice, kept } = markDeleted(op.slice, attrs, schema);
            if (!kept) continue;
            try {
              out.replace(pos, pos, slice);
            } catch {
              continue;
            }
            // Backspace moves before the struck text, Delete after it.
            caret = key === "Delete" ? pos + slice.size : pos;
          }
          if (!out.docChanged) return null;
          if (caret !== null) {
            const typedOver = ops.some((o) => o.kind === "insert");
            if (!typedOver) out.setSelection(TextSelection.create(out.doc, Math.min(caret, out.doc.content.size)));
          }
          return out.setMeta(SUGGESTION_SKIP, true);
        }

export const SuggestChanges = Extension.create<Options>({
  name: "suggestChanges",
  addOptions() {
    return { enabled: () => false, user: () => ({ id: "", name: "" }) };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<{ key: string }>({
        key: suggestKey,
        state: {
          init: () => ({ key: "" }),
          apply: (tr, value) => {
            const key = tr.getMeta(suggestKey);
            return key !== undefined ? { key } : value;
          },
        },
        props: {
          // Which key caused a deletion decides where the caret goes.
          handleKeyDown(view, event) {
            if (event.key === "Backspace" || event.key === "Delete")
              view.dispatch(view.state.tr.setMeta(suggestKey, event.key).setMeta("addToHistory", false));
            return false;
          },
        },
        appendTransaction(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState) {
          if (!options.enabled()) return null;
          return suggestTransaction(transactions, oldState, newState, options.user(), suggestKey.getState(oldState)?.key || "");
        },
      }),
    ];
  },
});
