import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { mergeAttributes } from "@tiptap/core";
import { codeHighlighter } from "./code-highlight";
export const FlowCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      wrap: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-code-wrap") === "true",
        rendered: false,
      },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
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
  },
}).configure({
  lowlight: codeHighlighter,
  defaultLanguage: "plaintext",
  enableTabIndentation: true,
  tabSize: 2,
});
