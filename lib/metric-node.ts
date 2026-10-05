import { Node } from "@tiptap/core";
// A number from a database for dashboards (components/metric-view.ts draws
// and configures it). The query is stored as JSON in data-metric.
export const MetricBlock = Node.create({
  name: "metricBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { metric: { default: "{}" } };
  },
  parseHTML: () => [
    { tag: "div[data-metric]", getAttrs: (element) => ({ metric: (element as HTMLElement).getAttribute("data-metric") || "{}" }) },
  ],
  renderHTML: ({ node }) => ["div", { "data-metric": node.attrs.metric, class: "metric-block" }],
});
