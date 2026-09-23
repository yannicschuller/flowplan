import { Node } from "@tiptap/core";
import { DEFAULT_DIAGRAM } from "./mermaid-source";
export const MermaidBlock = Node.create({
  name: "mermaidBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return { source: { default: DEFAULT_DIAGRAM } };
  },
  parseHTML: () => [
    {
      tag: "div[data-mermaid]",
      getAttrs: (element) => ({
        source: (element as HTMLElement).getAttribute("data-mermaid") || "",
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    { "data-mermaid": node.attrs.source, class: "mermaid-block" },
    node.attrs.source,
  ],
  renderText: ({ node }) => node.attrs.source,
});
