"use client";
// The editor's side of the link icons (#96): a widget at the start of each
// link. The store (pages, records asked for, read-only HTML, React links)
// is components/page-link-icons-store.tsx, re-exported here.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { PAGE_CHIP } from "@/lib/page-chip";
import { destroyLinkIcon, linkIconElement, linkIconFor, subscribeLinkTargets } from "./page-link-icons-store";

export * from "./page-link-icons-store";

// A page link as a chip (#466, lib/page-chip.ts): the <a> it is stored as,
// with the target's icon in front of its text, both kept up to date. The
// editor treats it as one piece (contenteditable=false, draggable).
export function pageChipView(initial: PMNode): NodeView {
  let node = initial;
  const dom = document.createElement("a");
  dom.dataset.pageLink = "";
  dom.target = "_blank";
  dom.rel = "noopener noreferrer";
  const text = document.createTextNode("");
  dom.append(text);
  let icon: HTMLElement | null = null;
  const draw = () => {
    const href = String(node.attrs.href || "");
    if (dom.getAttribute("href") !== href) dom.setAttribute("href", href);
    const title = String(node.attrs.title || "");
    if (text.data !== title) text.data = title;
    const name = linkIconFor(href);
    if ((icon?.dataset.linkIcon || null) === name) return;
    if (icon) {
      destroyLinkIcon(icon);
      icon.remove();
    }
    icon = name ? linkIconElement(name) : null;
    if (icon) dom.prepend(icon);
  };
  draw();
  const unsubscribe = subscribeLinkTargets(draw);
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      draw();
      return true;
    },
    ignoreMutation: (mutation) => mutation.type !== "selection",
    destroy() {
      unsubscribe();
      if (icon) destroyLinkIcon(icon);
    },
  };
}

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
        props: {
          decorations: (state) => iconsKey.getState(state),
          // Page links as chips (#466) with their icon.
          nodeViews: { [PAGE_CHIP]: (node) => pageChipView(node) },
        },
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
