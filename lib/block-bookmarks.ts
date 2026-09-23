import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { documentBlocks } from "./document-blocks";
type Bookmark = { pos: number; type: string; element?: Y.XmlElement };
// Remote Yjs updates can replace the entire ProseMirror document, so numeric
// transaction mappings alone cannot identify a surviving selected block.
export function captureBlockSelection(
  editor: Editor,
  positions: number[],
): Bookmark[] {
  const blocks = documentBlocks(editor.state.doc),
    sync = ySyncPluginKey.getState(editor.state);
  return positions.flatMap((pos) => {
    const block = blocks.find((b) => b.pos === pos);
    if (!block) return [];
    const mapping: Map<unknown, unknown> | undefined = sync?.binding.mapping;
    const entry = mapping
      ? Array.from(mapping.entries()).find(
          ([element, node]) =>
            element instanceof Y.XmlElement && node === block.node,
        )
      : undefined;
    return [
      {
        pos,
        type: block.node.type.name,
        element: entry?.[0] as Y.XmlElement | undefined,
      },
    ];
  });
}
export function mapBlockSelection(
  editor: Editor,
  tr: Transaction,
  bookmarks: Bookmark[],
): Bookmark[] {
  const blocks = documentBlocks(tr.doc),
    sync = ySyncPluginKey.getState(editor.state);
  return bookmarks.flatMap((bookmark) => {
    if (bookmark.element && sync) {
      // A relative position inside the element becomes null if that element is deleted.
      const alive = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromTypeIndex(bookmark.element, 0),
        sync.doc,
      );
      if (!alive) return [];
      const node = sync.binding.mapping.get(bookmark.element),
        block = blocks.find((b) => b.node === node);
      return block ? [{ ...bookmark, pos: block.pos }] : [];
    }
    const mapped = tr.mapping.mapResult(bookmark.pos, 1),
      block = blocks.find(
        (b) => b.pos === mapped.pos && b.node.type.name === bookmark.type,
      );
    return !mapped.deleted && block ? [{ ...bookmark, pos: mapped.pos }] : [];
  });
}
