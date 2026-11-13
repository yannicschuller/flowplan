// The tabs block (#272): tabs with a title each and any blocks inside, like
// Obsidian's Tabs plugin. Stored, exported, printed and published as all
// tabs one after another, each with its title as a heading:
//
//   <div data-tabs="true" class="editor-tabs" data-block-id="…">
//     <section data-tab="true" class="editor-tab">
//       <h4 class="editor-tab-title">Title</h4>
//       <div data-tab-body="true" class="editor-tab-body">…blocks…</div>
//     </section>
//   </div>
//
// In the editor a node view of its own shows one tab at a time with a tab
// strip above (lib/tabs-view.ts); which tab is shown is not part of the
// document. Markdown: the Tabs plugin's code block (lib/markdown.ts,
// lib/markdown-html.ts).
import { Node, mergeAttributes, getAttributesFromExtensions, getRenderedAttributes } from "@tiptap/core";
import { tabTitle } from "./tabs-commands";
import { tabsBlocksPlugin, tabsNodeView, type TabsViewOptions } from "./tabs-view";

// The title of a <section data-tab>: its title heading.
export function tabTitleOf(el: HTMLElement) {
  const heading = el.querySelector(":scope > .editor-tab-title") || el.querySelector(":scope > :is(h1, h2, h3, h4, h5, h6)");
  return tabTitle(heading?.textContent ?? "");
}

// `storageKey`: where the editor remembers the tab shown on this device
// (lib/tabs-memory.ts); none on the server and in other editors.
export const Tabs = Node.create<{ storageKey: string | null } & TabsViewOptions>({
  name: "tabs",
  group: "block",
  content: "tab+",
  defining: true,
  addOptions() {
    return { storageKey: null, onTabDeleted: null };
  },
  parseHTML: () => [{ tag: "div[data-tabs]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-tabs": "true", class: "editor-tabs" }), 0],
  addNodeView() {
    return (props) => {
      const attributes = getAttributesFromExtensions(props.editor.extensionManager.extensions);
      return tabsNodeView({
        ...props,
        attributesOf: (node) => getRenderedAttributes(node, attributes),
        options: { onTabDeleted: this.options.onTabDeleted },
      });
    };
  },
  addProseMirrorPlugins() {
    return [tabsBlocksPlugin({ storageKey: this.options.storageKey })];
  },
});

export const Tab = Node.create({
  name: "tab",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (el) => tabTitleOf(el),
        rendered: false,
      },
    };
  },
  parseHTML: () => [
    {
      tag: "section[data-tab]",
      contentElement: (dom: HTMLElement) => dom.querySelector<HTMLElement>(":scope > [data-tab-body]") || dom,
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    "section",
    mergeAttributes(HTMLAttributes, { "data-tab": "true", class: "editor-tab" }),
    ["h4", { class: "editor-tab-title" }, tabTitle(node.attrs.title)],
    ["div", { "data-tab-body": "true", class: "editor-tab-body" }, 0],
  ],
});
