import { Node } from "@tiptap/core";
// The workflow button on a page (docs/specs/workflows.md §10.8): starts a
// workflow with a manual trigger. The stored HTML names the workflow page
// and the button's label and stays empty – published pages and share links
// show nothing; components/workflow-button.ts draws it for signed-in members
// (who may press it: the trigger decides, never guests).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WorkflowButton = Node.create({
  name: "workflowButton",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { workflow: { default: "" }, label: { default: "" } };
  },
  parseHTML: () => [
    {
      tag: "div[data-workflow-button]",
      getAttrs: (element) => {
        const el = element as HTMLElement;
        const workflow = el.getAttribute("data-workflow-button") || "";
        return { workflow: UUID.test(workflow) ? workflow : "", label: (el.getAttribute("data-label") || "").slice(0, 80) };
      },
    },
  ],
  renderHTML: ({ node }) => ["div", { "data-workflow-button": node.attrs.workflow, "data-label": node.attrs.label, class: "workflow-button-block" }],
});
