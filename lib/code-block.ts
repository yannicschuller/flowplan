import CodeBlock from "@tiptap/extension-code-block";
import { mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { fenceLanguage } from "./code-languages";
import { captionAttribute, captionText } from "./block-captions";
// The code block of documents (schema, server and editor). Highlighting is
// added by the editor only (components/code-block.tsx with
// lib/code-highlight-plugin.ts), so the schema carries no grammar.
// A caption (lib/block-captions.ts) puts the code into a <figure> with
// <figcaption> below it.
export const FlowCodeBlock = CodeBlock.extend({
  addAttributes() {
    const parent = this.parent?.() || {};
    return {
      ...parent,
      language: {
        ...parent.language,
        // Older ids and aliases ("js", "py", "sh") become Shiki's ids when
        // HTML is read (paste, import); unknown languages stay as written.
        parseHTML: (element: HTMLElement) => {
          const language = [...(element.firstElementChild?.classList || [])]
            .find((name) => name.startsWith("language-"))
            ?.slice("language-".length);
          return language ? fenceLanguage(language) : null;
        },
      },
      wrap: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-code-wrap") === "true",
        rendered: false,
      },
      caption: captionAttribute(),
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    const pre: DOMOutputSpec = [
      "pre",
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        node.attrs.wrap ? { "data-code-wrap": "true" } : {},
      ),
      [
        "code",
        {
          class: node.attrs.language ? `language-${node.attrs.language}` : null,
        },
        0,
      ],
    ];
    const caption = captionText(node.attrs.caption);
    return caption ? ["figure", { class: "block-figure" }, pre, ["figcaption", {}, caption]] : pre;
  },
}).configure({
  defaultLanguage: "plaintext",
  enableTabIndentation: true,
  tabSize: 2,
});
