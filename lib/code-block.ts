import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { codeHighlighter } from "./code-highlight";
import { captionAttribute, captionText } from "./block-captions";
// A caption (lib/block-captions.ts) puts the code into a <figure> with
// <figcaption> below it.
export const FlowCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
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
  lowlight: codeHighlighter,
  defaultLanguage: "plaintext",
  enableTabIndentation: true,
  tabSize: 2,
});
