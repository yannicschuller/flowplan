// The picture of a draw.io block (lib/drawio-node.ts) in the editor and in
// read-only views: the stored SVG as an <img> – nothing in it runs or loads,
// and draw.io itself is never asked. Like Mermaid diagrams it sits on a
// light card in dark mode too (app/globals.css .drawio-block).
import { drawioImageUrl } from "./drawio";
import { tr } from "./locale-tag";

export const drawioLabel = () => tr("draw.io-Diagramm", "draw.io diagram");

// hasDiagram: a diagram without picture (imported from Markdown) – the
// picture comes with the next save in draw.io.
export function mountDrawioPreview(element: HTMLElement, svg: string, hasDiagram = false) {
  element.classList.add("drawio-block");
  const stage = document.createElement("div");
  stage.className = "drawio-stage";
  if (svg) {
    const image = document.createElement("img");
    image.alt = drawioLabel();
    image.draggable = false;
    image.loading = "lazy";
    image.src = drawioImageUrl(svg);
    stage.append(image);
    element.dataset.drawioState = "ready";
  } else {
    const empty = document.createElement("p");
    empty.className = "drawio-empty";
    empty.textContent = hasDiagram
      ? tr("draw.io-Diagramm ohne Vorschau – zum Anzeigen einmal bearbeiten und speichern", "draw.io diagram without preview – edit and save it once to show it")
      : tr("Leeres draw.io-Diagramm", "Empty draw.io diagram");
    stage.append(empty);
    element.dataset.drawioState = "empty";
  }
  element.replaceChildren(stage);
  return stage;
}
