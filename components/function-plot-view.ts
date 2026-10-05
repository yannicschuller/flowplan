// The function graph in the editor: drawn and edited in place; changes are
// saved to the block a moment after typing stops.
import { FunctionPlot } from "@/lib/function-plot-node";
import type { PlotConfig } from "@/lib/function-plot";

export const FunctionPlotView = FunctionPlot.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "function-plot";
      dom.contentEditable = "false";
      let handle: { update: (c: PlotConfig) => void; destroy: () => void } | null = null;
      let saved = node.attrs.plot as string;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const save = (json: string) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos !== "number" || !editor.isEditable) return;
          const at = editor.state.doc.nodeAt(pos);
          if (at?.type.name !== "functionPlot" || at.attrs.plot === json) return;
          saved = json;
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, plot: json }));
        }, 400);
      };
      let destroyed = false;
      void import("@/lib/function-plot").then(({ mountPlot, parsePlot, plotJson }) => {
        if (destroyed) return;
        handle = mountPlot(dom, parsePlot(current.attrs.plot), {
          editable: editor.isEditable,
          onChange: (config) => save(plotJson(config)),
        });
      });
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          const outside = next.attrs.plot !== current.attrs.plot && next.attrs.plot !== saved;
          current = next;
          if (outside)
            void import("@/lib/function-plot").then(({ parsePlot }) => handle?.update(parsePlot(next.attrs.plot)));
          return true;
        },
        destroy() {
          destroyed = true;
          clearTimeout(timer);
          handle?.destroy();
        },
        ignoreMutation: () => true,
        // Inputs, buttons and dragging belong to the graph, not the editor.
        stopEvent: (event) => !(event.type === "dragstart" && (event.target as HTMLElement)?.dataset?.dragHandle !== undefined),
      };
    };
  },
});
