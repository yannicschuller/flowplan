// Dialogs that edit one node of a document (a formula, a diagram) find it
// again when they save. The node view's getPos() follows the node while its
// view lives; a change of someone else can redraw the block around it (the
// Yjs binding replaces the changed paragraph – its new text and its new
// block id in one update), and the old view's getPos() then has no answer
// although the node is still there. So the dialog also remembers the node's
// Yjs element: the binding keeps it mapped to the node's current version
// whatever is redrawn around it, and it is deleted only with the node.
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";

export type NodeTarget = { getPos?: () => number | undefined };
type YElement = { _item?: { deleted?: boolean } | null };
type Mapping = Map<YElement, ProseMirrorNode | ProseMirrorNode[]>;
export type OpenedNode = { node: ProseMirrorNode; element: YElement | null };

function mapping(state: EditorState): Mapping | null {
  const sync = ySyncPluginKey.getState(state) as { binding?: { mapping?: Mapping } | null } | undefined;
  return sync?.binding?.mapping ?? null;
}

// The node the dialog opens for (null for a new one).
export function openedNode(state: EditorState, target: NodeTarget): OpenedNode | null {
  const pos = target.getPos?.();
  const node = typeof pos === "number" ? state.doc.nodeAt(pos) : null;
  if (!node) return null;
  let element: YElement | null = null;
  for (const [y, mapped] of mapping(state) ?? [])
    if (mapped === node) {
      element = y;
      break;
    }
  return { node, element };
}

function positionOf(doc: ProseMirrorNode, wanted: ProseMirrorNode): number | undefined {
  let found: number | undefined;
  doc.descendants((node, at) => {
    if (found !== undefined) return false;
    if (node === wanted) {
      found = at;
      return false;
    }
    return true;
  });
  return found;
}

// Where that node is now, if it still is. The caller compares what is there
// with what was opened (changed meanwhile: a conflict).
export function nodeTargetPosition(
  state: EditorState,
  target: NodeTarget,
  opened: OpenedNode | null,
): number | undefined {
  if (opened) {
    const current = opened.element && !opened.element._item?.deleted ? mapping(state)?.get(opened.element) : undefined;
    for (const node of [current, opened.node])
      if (node && !Array.isArray(node)) {
        const at = positionOf(state.doc, node);
        if (at !== undefined) return at;
      }
  }
  // Else the view's answer (no collaboration binding, say).
  return target.getPos?.();
}

// What a dialog saves is a step of its own in the undo history: Yjs merges
// changes less than half a second apart, so an edit saved soon after the
// insert (or after typing) was undone together with it – the whole diagram
// went.
export function beginUndoStep(state: EditorState) {
  (yUndoPluginKey.getState(state) as { undoManager?: { stopCapturing: () => void } } | undefined)?.undoManager?.stopCapturing();
}
