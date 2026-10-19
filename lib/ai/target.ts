// The text the writing assistant works on, while its panel is open: marked
// in the editor (the selection itself is gone once the panel's field has the
// focus) and followed through every change – local edits through the
// transaction's mapping, changes of others through Yjs positions (a remote
// change replaces the whole document in ProseMirror, a mapping would lose
// the place). The answer is inserted where the range is then.
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

type Relative = ReturnType<typeof absolutePositionToRelativePosition>;
type Target = { from: number; to: number; rel: { from: Relative; to: Relative } | null };
const key = new PluginKey<Target | null>("flowplanAiTarget");

type SyncState = { doc: Y.Doc; type: Y.XmlFragment; binding?: { mapping: Map<unknown, unknown> } | null; snapshot?: unknown; prevSnapshot?: unknown };
function sync(state: EditorState) {
  const value = ySyncPluginKey.getState(state) as SyncState | undefined;
  return value?.binding?.mapping.size && !value.snapshot && !value.prevSnapshot ? (value as SyncState & { binding: { mapping: Map<unknown, unknown> } }) : null;
}
function relative(state: EditorState, from: number, to: number) {
  const s = sync(state);
  if (!s) return null;
  try {
    return {
      from: absolutePositionToRelativePosition(from, s.type, s.binding.mapping as never),
      to: absolutePositionToRelativePosition(to, s.type, s.binding.mapping as never),
    };
  } catch {
    return null;
  }
}
function absolute(state: EditorState, rel: Target["rel"]) {
  const s = sync(state);
  if (!s || !rel) return null;
  try {
    const from = relativePositionToAbsolutePosition(s.doc, s.type, rel.from, s.binding.mapping as never),
      to = relativePositionToAbsolutePosition(s.doc, s.type, rel.to, s.binding.mapping as never);
    return from === null || to === null ? null : { from: Math.min(from, to), to: Math.max(from, to) };
  } catch {
    return null;
  }
}
const clamp = (state: EditorState, target: Target): Target => {
  const size = state.doc.content.size;
  const from = Math.max(0, Math.min(target.from, size));
  return { ...target, from, to: Math.max(from, Math.min(target.to, size)) };
};

export const aiTargetPlugin = new Plugin<Target | null>({
  key,
  state: {
    init: () => null,
    apply(tr: Transaction, value, oldState, newState) {
      const meta = tr.getMeta(key) as { set: { from: number; to: number } } | { clear: true } | undefined;
      if (meta && "clear" in meta) return null;
      if (meta && "set" in meta) return clamp(newState, { ...meta.set, rel: relative(oldState, meta.set.from, meta.set.to) });
      if (!value || !tr.docChanged) return value;
      // Changes of others: back from the Yjs positions.
      if ((tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin) {
        const back = absolute(oldState, value.rel);
        if (back) return clamp(newState, { ...value, ...back });
      }
      return clamp(newState, { ...value, from: tr.mapping.map(value.from, -1), to: tr.mapping.map(value.to, 1) });
    },
  },
  props: {
    decorations(state) {
      const target = key.getState(state);
      if (!target) return null;
      if (target.from < target.to) return DecorationSet.create(state.doc, [Decoration.inline(target.from, target.to, { class: "ai-target" })]);
      const $pos = state.doc.resolve(target.from);
      if ($pos.depth === 0) return null;
      return DecorationSet.create(state.doc, [Decoration.node($pos.before(), $pos.after(), { class: "ai-target-line" })]);
    },
  },
});

export function setAiTarget(view: EditorView, range: { from: number; to: number } | null) {
  if (!view.state.plugins.includes(aiTargetPlugin)) return;
  view.dispatch(view.state.tr.setMeta(key, range ? { set: range } : { clear: true }).setMeta("addToHistory", false));
}
export function aiTarget(state: EditorState): { from: number; to: number } | null {
  const target = key.getState(state);
  if (!target) return null;
  // Yjs positions where they resolve (the most robust), else the mapped ones.
  const back = absolute(state, target.rel);
  return back && back.to <= state.doc.content.size ? back : { from: target.from, to: target.to };
}
