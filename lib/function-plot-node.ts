import { Node } from "@tiptap/core";
// A function graph block (lib/function-plot.ts draws it). The functions and
// the view are stored as JSON in data-function-plot.
export const FunctionPlot = Node.create({
  name: "functionPlot",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { plot: { default: '{"functions":[]}' } };
  },
  parseHTML: () => [
    {
      tag: "div[data-function-plot]",
      getAttrs: (element) => ({ plot: (element as HTMLElement).getAttribute("data-function-plot") || '{"functions":[]}' }),
    },
  ],
  renderHTML: ({ node }) => ["div", { "data-function-plot": node.attrs.plot, class: "function-plot" }],
  renderText: ({ node }) => {
    try {
      return (JSON.parse(node.attrs.plot).functions || []).map((f: { expr: string }) => f.expr).join(", ");
    } catch {
      return "";
    }
  },
});
