import { Fragment, Slice, type Node } from "@tiptap/pm/model";
export function freshLinkedIds(slice: Slice) {
  const map = (node: Node): Node =>
    node.type.name === "linkedDatabase"
      ? node.type.create({
          ...node.attrs,
          id: crypto.randomUUID(),
          version: "1",
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
