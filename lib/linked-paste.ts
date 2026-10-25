import { Fragment, Slice, type Node } from "@tiptap/pm/model";
import { newDrawBlockId } from "./draw-block-node";
// Pasted or duplicated blocks that point to data of their own get fresh
// ids: linked databases (their views), drawing blocks (their ink – the copy
// starts with the ink of the block it came from, `from`).
export function freshLinkedIds(slice: Slice) {
  const map = (node: Node): Node =>
    node.type.name === "linkedDatabase"
      ? node.type.create({
          ...node.attrs,
          id: crypto.randomUUID(),
          version: "1",
        })
      : node.type.name === "drawBlock"
        ? node.type.create({
            ...node.attrs,
            id: newDrawBlockId(),
            from: node.attrs.from || (node.attrs.page && node.attrs.id ? `${node.attrs.page}/${node.attrs.id}` : ""),
          })
        : node.copy(
            Fragment.fromArray(
              Array.from({ length: node.childCount }, (_, index) =>
                map(node.child(index)),
              ),
            ),
          );
  return new Slice(
    Fragment.fromArray(
      Array.from({ length: slice.content.childCount }, (_, index) =>
        map(slice.content.child(index)),
      ),
    ),
    slice.openStart,
    slice.openEnd,
  );
}
