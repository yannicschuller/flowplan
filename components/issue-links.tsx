"use client";
// The editor's side of the issue link status (#654): a small state icon at
// the start of each link to an issue, pull request or merge request whose
// status the store knows (components/issue-links-store.tsx, which also has
// the hover card's contents and the read-only documents' icons).
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { issueLinkShape } from "@/lib/issue-link-url";
import type { IssueState } from "@/lib/issue-preview";
import { issuePreviewOf, issueStateElement, subscribeIssueLinks } from "./issue-links-store";

export * from "./issue-links-store";

const statesKey = new PluginKey<DecorationSet>("issueLinkStates");
export function issueStateDecorations(doc: PMNode, label: (state: IssueState) => string) {
  const decorations: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let previous: unknown = null;
    block.forEach((child, offset) => {
      const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
      const href = typeof link?.attrs.href === "string" ? link.attrs.href : null;
      if (link && href && issueLinkShape(href) && !(previous && (previous as typeof link).eq(link))) {
        const result = issuePreviewOf(href);
        if (result && "state" in result) {
          const { state, kind } = result;
          decorations.push(
            Decoration.widget(blockPos + 1 + offset, () => issueStateElement(state, kind, label(state)), {
              side: 1,
              marks: [link],
              key: `issue-state:${state}:${kind}`,
              ignoreSelection: true,
            }),
          );
        }
      }
      previous = link || null;
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const IssueLinkStates = Extension.create<{ label: (state: IssueState) => string }>({
  name: "issueLinkStates",
  addOptions() {
    return { label: (state: IssueState) => state };
  },
  addProseMirrorPlugins() {
    const label = this.options.label;
    return [
      new Plugin<DecorationSet>({
        key: statesKey,
        state: {
          init: (_, state) => issueStateDecorations(state.doc, label),
          apply: (tr, old) => (tr.docChanged || tr.getMeta(statesKey) ? issueStateDecorations(tr.doc, label) : old),
        },
        props: { decorations: (state) => statesKey.getState(state) },
        view: (view) => ({
          // Answers from the provider arrive.
          destroy: subscribeIssueLinks(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(statesKey, true).setMeta("addToHistory", false));
          }),
        }),
      }),
    ];
  },
});
