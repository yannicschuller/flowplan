// Room for a new block between blocks without text (#261): a table right
// above an image left no place to click into, so a new block could only be
// added at the end and moved. Now
// - a click into the gap between two such blocks (a table, an image, an
//   embed, a database, columns …), above the first or below the last one –
//   also where they touch, within a few pixels of the edge – starts an
//   empty paragraph there;
// - ↑/↓/←/→ reach those gaps as a gap cursor (ProseMirror's, part of the
//   StarterKit), and typing or ↵ there starts a paragraph;
// - ↵ on a selected image, table or embed adds a paragraph after it.
import { Extension } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { NodeSelection, Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

// Where ProseMirror's gap cursor may stand: between blocks whose facing
// edges hold no text (a static method, public though not in its types).
const gapValid = ($pos: ResolvedPos) => (GapCursor as unknown as { valid: (p: ResolvedPos) => boolean }).valid($pos);

// An empty paragraph at `pos`, the caret in it – where a gap cursor may
// stand (between blocks that hold no text at their edge) and a paragraph
// fits; null elsewhere.
export function paragraphAtGap(state: EditorState, pos: number) {
  if (pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph || $pos.parent.inlineContent || !gapValid($pos)) return null;
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), paragraph)) return null;
  const tr = state.tr.insert(pos, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
}
// ↵ on a selected block without text of its own (an image, a table, an
// embed): an empty paragraph after it – also when it is the first block
// (ProseMirror's own command puts it before the first block); at a gap
// cursor: a paragraph there.
export function paragraphOnEnter(state: EditorState) {
  const { selection } = state;
  if (selection instanceof GapCursor) return paragraphAtGap(state, selection.from);
  if (!(selection instanceof NodeSelection)) return null;
  const node = selection.node;
  if (!node.isBlock || node.isTextblock || !(node.isAtom || node.type.name === "table")) return null;
  const $after = state.doc.resolve(selection.to);
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph || !$after.parent.canReplaceWith($after.index(), $after.index(), paragraph)) return null;
  const tr = state.tr.insert(selection.to, paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, selection.to + 1)).scrollIntoView();
}
// How close to the edge of a block a click counts as "between" when the
// block touches its neighbour (no margin to click into).
const EDGE = 5;
// The gap at a point of the editor, or null: in the margin between blocks
// or the padding of a container, or at the touching edges of two blocks.
export function gapAtPoint(view: EditorView, x: number, y: number): number | null {
  const hit = view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const { doc } = view.state;
  const $hit = doc.resolve(hit.pos);
  // Not inside a block, only inside the container around the gap.
  const around = $hit.depth > 0 ? $hit.before() : -1;
  if (hit.inside === around && !$hit.parent.inlineContent && gapValid($hit)) return hit.pos;
  // Where two blocks touch: the edge of a block at the point (the block or
  // a block around it).
  if (hit.inside < 0) return null;
  const $inside = doc.resolve(hit.inside);
  const chain = [hit.inside];
  for (let depth = $inside.depth; depth > 0; depth--) chain.push($inside.before(depth));
  for (const pos of chain) {
    const node = doc.nodeAt(pos);
    const dom = view.nodeDOM(pos);
    if (!node?.isBlock || !(dom instanceof HTMLElement)) continue;
    const rect = dom.getBoundingClientRect();
    if (x < rect.left || x > rect.right) continue;
    const $before = doc.resolve(pos),
      $after = doc.resolve(pos + node.nodeSize);
    // The neighbour's edge right at this one's: no margin between them.
    const touches = (neighbour: number, above: boolean) => {
      const other = view.nodeDOM(neighbour);
      if (!(other instanceof HTMLElement)) return false;
      const box = other.getBoundingClientRect();
      return above ? Math.abs(box.bottom - rect.top) < EDGE : Math.abs(box.top - rect.bottom) < EDGE;
    };
    if (y - rect.top < EDGE && $before.nodeBefore && gapValid($before) && touches(pos - $before.nodeBefore.nodeSize, true))
      return pos;
    if (rect.bottom - y < EDGE && $after.nodeAfter && gapValid($after) && touches($after.pos, false))
      return $after.pos;
  }
  return null;
}
export const BlockGaps = Extension.create({
  name: "blockGaps",
  // Before the editor's own ↵ (which splits or lifts blocks).
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const tr = paragraphOnEnter(this.editor.state);
        if (!tr) return false;
        this.editor.view.dispatch(tr);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockGaps"),
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              if (!view.editable || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
              const target = event.target instanceof Element ? event.target : null;
              // The controls of a block (a table's "+", an image's toolbar)
              // keep their clicks.
              if (target?.closest("button, a, input, textarea, select, label, [role='button'], [contenteditable='true']:not(.ProseMirror)")) return false;
              const gap = gapAtPoint(view, event.clientX, event.clientY);
              if (gap === null) return false;
              const tr = paragraphAtGap(view.state, gap);
              if (!tr) return false;
              event.preventDefault();
              view.dispatch(tr);
              view.focus();
              return true;
            },
          },
        },
      }),
    ];
  },
});
