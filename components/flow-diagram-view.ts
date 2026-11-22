// The flow diagram in the editor (#427): drawn from its text; "Edit" opens
// the text below it, the diagram follows while typing, problems are listed
// by line. Changes are saved to the block a moment after typing stops.
import { FlowDiagram } from "@/lib/flow-diagram-node";
import { MAX_FLOW_SOURCE, MAX_FLOW_UNIT, flowSvg, parseFlow } from "@/lib/flow-diagram";
import { tr } from "@/lib/locale-tag";
import { onEditableChange } from "./editor-editable";

// The next flow diagram that appears opens its text, focused (set by the
// slash command right before inserting one).
let openNext = false;
export const openNextFlowDiagram = () => {
  openNext = true;
};

export const FlowDiagramView = FlowDiagram.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      let source = String(node.attrs.source || ""),
        unit = String(node.attrs.unit || "");
      const saved = { source, unit };
      const dom = document.createElement("div");
      dom.className = "flow-diagram";
      dom.contentEditable = "false";
      const stage = document.createElement("div");
      stage.className = "flow-stage";
      const controls = document.createElement("div");
      controls.className = "flow-controls";
      dom.append(stage, controls);
      let open = openNext || (!source.trim() && editor.isEditable);
      const focus = openNext;
      openNext = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let errors: HTMLUListElement | null = null;

      const draw = () => {
        const graph = parseFlow(source);
        stage.innerHTML = flowSvg(graph, { unit });
        if (errors) {
          errors.replaceChildren(
            ...graph.errors.slice(0, 20).map((e) => {
              const item = document.createElement("li");
              item.textContent = tr(`Zeile ${e.line}: ${e.message}`, `Line ${e.line}: ${e.message}`);
              return item;
            }),
          );
          errors.hidden = !graph.errors.length;
        }
      };
      const save = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos !== "number" || !editor.isEditable) return;
          const at = editor.state.doc.nodeAt(pos);
          if (at?.type.name !== "flowDiagram" || (at.attrs.source === source && at.attrs.unit === unit)) return;
          saved.source = source;
          saved.unit = unit;
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...at.attrs, source, unit }));
        }, 400);
      };
      const renderControls = (focusText = false) => {
        controls.replaceChildren();
        errors = null;
        if (!editor.isEditable) return;
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "flow-toggle";
        toggle.textContent = open ? tr("Fertig", "Done") : tr("Flüsse bearbeiten", "Edit flows");
        toggle.setAttribute("aria-expanded", String(open));
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          open = !open;
          renderControls(open);
        });
        controls.append(toggle);
        if (!open) return;
        const panel = document.createElement("div");
        panel.className = "flow-editor";
        const textLabel = document.createElement("label");
        textLabel.className = "flow-source";
        const textTitle = document.createElement("span");
        textTitle.textContent = tr("Flüsse – eine Zeile pro Fluss", "Flows – one line per flow");
        const text = document.createElement("textarea");
        text.value = source;
        text.rows = Math.min(16, Math.max(6, source.split("\n").length + 1));
        text.maxLength = MAX_FLOW_SOURCE;
        text.spellcheck = false;
        text.placeholder = tr("Hauptjob -> Budget: 2750\nBudget -> Fixkosten: 1.100,00\nFixkosten #f5c542", "Salary -> Budget: 2750\nBudget -> Fixed costs: 1,100.00\nFixed costs #f5c542");
        text.addEventListener("input", () => {
          source = text.value;
          draw();
          save();
        });
        textLabel.append(textTitle, text);
        const unitLabel = document.createElement("label");
        unitLabel.className = "flow-unit";
        const unitTitle = document.createElement("span");
        unitTitle.textContent = tr("Einheit (optional)", "Unit (optional)");
        const unitInput = document.createElement("input");
        unitInput.value = unit;
        unitInput.maxLength = MAX_FLOW_UNIT;
        unitInput.placeholder = tr("z. B. €", "e.g. €");
        unitInput.addEventListener("input", () => {
          unit = unitInput.value;
          draw();
          save();
        });
        unitLabel.append(unitTitle, unitInput);
        errors = document.createElement("ul");
        errors.className = "flow-errors";
        errors.setAttribute("role", "status");
        errors.setAttribute("aria-label", tr("Probleme im Flussdiagramm", "Problems in the flow diagram"));
        const help = document.createElement("p");
        help.className = "flow-help";
        help.textContent = tr(
          "„Quelle -> Ziel: Betrag“ (auch → und Dezimalkomma). Gleiche Paare werden addiert. Farbe eines Knotens: „Name #f5c542“. Zeilen mit // sind Kommentare.",
          "“Source -> Target: amount” (→ and decimal commas work too). Equal pairs add up. A node's colour: “Name #f5c542”. Lines starting with // are comments.",
        );
        panel.append(textLabel, unitLabel, errors, help);
        controls.append(panel);
        draw();
        if (focusText) requestAnimationFrame(() => text.focus());
      };
      renderControls(focus);
      draw();
      // Reading mode on or off: the controls come and go.
      const unsubscribe = onEditableChange(editor, () => {
        renderControls();
        draw();
      });
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          const outside =
            (next.attrs.source !== current.attrs.source && next.attrs.source !== saved.source) ||
            (next.attrs.unit !== current.attrs.unit && next.attrs.unit !== saved.unit);
          current = next;
          if (outside) {
            // A change from elsewhere (another person, undo); text being
            // typed in keeps its state until the next save.
            const typing = controls.contains(document.activeElement);
            source = saved.source = String(next.attrs.source || "");
            unit = saved.unit = String(next.attrs.unit || "");
            if (!typing) renderControls();
            draw();
          }
          return true;
        },
        destroy() {
          unsubscribe();
          clearTimeout(timer);
        },
        ignoreMutation: () => true,
        // Typing and clicks belong to the diagram's controls, not the editor.
        stopEvent: (event) => !(event.type === "dragstart" && (event.target as HTMLElement)?.dataset?.dragHandle !== undefined),
      };
    };
  },
});
