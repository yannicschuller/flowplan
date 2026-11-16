"use client";
// The editor's side of the link icons (#96): a widget at the start of each
// link. The store (pages, records asked for, read-only HTML, React links)
// is components/page-link-icons-store.tsx, re-exported here.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { destroyLinkIcon, linkIconElement, linkIconFor, subscribeLinkTargets } from "./page-link-icons-store";

export * from "./page-link-icons-store";

// The editor: a widget at the start of each link to a page or record,
// drawn inside the link (same mark), so it reads "📄 Title" as one chip.
const iconsKey = new PluginKey<DecorationSet>("pageLinkIcons");
export function iconDecorations(doc: PMNode) {
  const decorations: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let previous: unknown = null;
    block.forEach((child, offset) => {
      const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
      const href = typeof link?.attrs.href === "string" ? link.attrs.href : null;
      if (link && href && !(previous && (previous as typeof link).eq(link))) {
        const name = linkIconFor(href);
        if (name)
          decorations.push(
            Decoration.widget(blockPos + 1 + offset, () => linkIconElement(name), {
              side: 1,
              marks: [link],
              key: `link-icon:${name}`,
              ignoreSelection: true,
              destroy: destroyLinkIcon,
            }),
          );
      }
      previous = link || null;
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}
export const PageLinkIcons = Extension.create({
  name: "pageLinkIcons",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: iconsKey,
        state: {
          init: (_, state) => iconDecorations(state.doc),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(iconsKey) ? iconDecorations(tr.doc) : old),
        },
        props: { decorations: (state) => iconsKey.getState(state) },
        view: (view) => ({
          // New icons, renames of the tree, answers for records.
          destroy: subscribeLinkTargets(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(iconsKey, true).setMeta("addToHistory", false));
          }),
        }),
      }),
    ];
  },
});
