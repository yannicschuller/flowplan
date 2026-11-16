// The own selection stays on its text when others change the document.
//
// After a remote change y-tiptap puts the selection back from relative
// positions, then "recovers" endpoints it takes for misresolved after a
// structural change (@tiptap/y-tiptap 3.3.0, isMisresolvedAfterStructuralChange):
// every endpoint whose paragraph's text changed counts as such, and a
// paragraph with a block id is found again by its attributes. So when a
// collaborator typed in front of the selection in the same paragraph, the
// selection was set back to its old offset in that paragraph – onto other
// text ("pha B" instead of "Bravo") – and the cursor shown to the others
// moved with it.
//
// A relative position resolves exactly as long as the paragraph (the Yjs
// type) it points into still exists – also when the text at it was
// deleted, which resolves to where it was. Only for a deleted paragraph (a
// block replaced or moved) is a guess needed. This plugin puts endpoints of
// the first kind back where they resolve and leaves the second kind to
// y-tiptap.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

type Relative = { anchor: Y.RelativePosition; head: Y.RelativePosition };

// Whether the type a relative position points into still exists.
export function positionAlive(doc: Y.Doc, position: Y.RelativePosition) {
  const id = position.item ?? position.type;
  // At the end of a root type (the document itself).
  if (!id) return position.tname !== null;
  try {
    const struct = Y.getItem(doc.store, id);
    if (!(struct instanceof Y.Item)) return false;
    // Before an item: its parent type; at the end of a type: that type.
    const type = position.item ? (struct.parent as Y.AbstractType<unknown> | null)?._item : struct;
    if (type === undefined) return false;
    return type === null || !type.deleted;
  } catch {
    return false;
  }
}

const key = new PluginKey("remoteSelection");

export const RemoteSelection = Extension.create({
  name: "remoteSelection",
  addProseMirrorPlugins() {
    // The selection as relative positions, taken before each Yjs
    // transaction (as y-tiptap does) and dropped after it.
    let before: Relative | null = null;
    return [
      new Plugin({
        key,
        view(view) {
          const doc: Y.Doc | undefined = ySyncPluginKey.getState(view.state)?.doc;
          if (!doc) return {};
          const capture = () => {
            if (before) return;
            const sync = ySyncPluginKey.getState(view.state);
            const selection = view.state.selection;
            if (!sync?.binding?.mapping.size || sync.snapshot || sync.prevSnapshot || !(selection instanceof TextSelection))
              return;
            try {
              before = {
                anchor: absolutePositionToRelativePosition(selection.anchor, sync.type, sync.binding.mapping),
                head: absolutePositionToRelativePosition(selection.head, sync.type, sync.binding.mapping),
              };
            } catch {
              before = null;
            }
          };
          const clear = () => {
            before = null;
          };
          doc.on("beforeAllTransactions", capture);
          doc.on("afterAllTransactions", clear);
          return {
            destroy() {
              doc.off("beforeAllTransactions", capture);
              doc.off("afterAllTransactions", clear);
              before = null;
            },
          };
        },
        appendTransaction(transactions, _old, state) {
          if (!before) return null;
          // Only changes of others; undo and redo restore their own selection.
          const remote = transactions.some((tr) => {
            const meta = tr.getMeta(ySyncPluginKey);
            return meta?.isChangeOrigin && !meta.isUndoRedoOperation;
          });
          const sync = ySyncPluginKey.getState(state);
          if (!remote || !sync?.binding || !(state.selection instanceof TextSelection)) return null;
          if (!positionAlive(sync.doc, before.anchor) || !positionAlive(sync.doc, before.head)) return null;
          try {
            const anchor = relativePositionToAbsolutePosition(sync.doc, sync.type, before.anchor, sync.binding.mapping),
              head = relativePositionToAbsolutePosition(sync.doc, sync.type, before.head, sync.binding.mapping);
            if (anchor === null || head === null) return null;
            if (anchor === state.selection.anchor && head === state.selection.head) return null;
            return state.tr.setSelection(TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head)));
          } catch {
            return null;
          }
        },
      }),
    ];
  },
});
