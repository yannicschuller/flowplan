// Dialogs that edit one node of a document (a formula, a diagram) find it
// again when they save. The node view's getPos() follows the node while its
// view lives; a change of someone else can redraw the block around it (the
// Yjs binding replaces the changed paragraph – its new text and its new
// block id in one update), and the old view's getPos() then has no answer
// although the node is still there. The binding keeps the node object of an
// unchanged Yjs element, so the node as it was when the dialog opened is
// looked up by identity first: found, it is the same, untouched node.
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export type NodeTarget = { getPos?: () => number | undefined };

// The node the dialog opens for (null for a new one).
export function openedNode(doc: ProseMirrorNode, target: NodeTarget): ProseMirrorNode | null {
  const pos = target.getPos?.();
  return typeof pos === "number" ? doc.nodeAt(pos) : null;
}

// Where that node is now, if it still is.
export function nodeTargetPosition(
  doc: ProseMirrorNode,
  target: NodeTarget,
  opened: ProseMirrorNode | null,
): number | undefined {
  let found: number | undefined;
  if (opened)
    doc.descendants((node, at) => {
      if (found !== undefined) return false;
      if (node === opened) {
        found = at;
        return false;
      }
      return true;
    });
  // Else the view's answer (the node was rebuilt by an edit here, say):
  // the caller still compares what is there with what was opened.
  return found ?? target.getPos?.();
}
