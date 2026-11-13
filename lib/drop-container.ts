import type { Node } from "@tiptap/pm/model";

// The block that receives blocks dropped at a position (#255), tinted while
// dragging: the innermost list item, list, toggle, callout, quote or
// column around it. At the top level of the document there is none.
export const DROP_CONTAINERS = [
  "listItem",
  "taskItem",
  "bulletList",
  "orderedList",
  "taskList",
  "toggle",
  "callout",
  "blockquote",
  "column",
];
export function dropContainer(doc: Node, target: number): { pos: number; node: Node } | null {
  if (target < 0 || target > doc.content.size) return null;
  const $target = doc.resolve(target);
  for (let d = $target.depth; d > 0; d--) {
    const node = $target.node(d);
    if (DROP_CONTAINERS.includes(node.type.name)) return { pos: $target.before(d), node };
  }
  return null;
}
