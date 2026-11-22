import { Node } from "@tiptap/core";
import { cleanFlowSource, cleanFlowUnit } from "./flow-diagram";
// A flow diagram block (Sankey, #427; lib/flow-diagram.ts draws it). The
// flows are stored as text in data-flow-diagram, the unit in data-flow-unit.
export const FlowDiagram = Node.create({
  name: "flowDiagram",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { source: { default: "" }, unit: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "div[data-flow-diagram]",
      getAttrs: (element) => ({
        source: cleanFlowSource((element as HTMLElement).getAttribute("data-flow-diagram")),
        unit: cleanFlowUnit((element as HTMLElement).getAttribute("data-flow-unit")),
      }),
    },
  ],
  renderHTML: ({ node }) => [
    "div",
    { "data-flow-diagram": cleanFlowSource(node.attrs.source), "data-flow-unit": cleanFlowUnit(node.attrs.unit), class: "flow-diagram" },
  ],
  renderText: ({ node }) => cleanFlowSource(node.attrs.source),
});
