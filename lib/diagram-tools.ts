// Toolbar for rendered diagrams: enlarge with zoom, download as SVG or PNG.
// Plain DOM so it works in editor node views and read-only documents.
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4];

function download(href: string, name: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}
function button(label: string, text: string, onClick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "diagram-tool";
  b.setAttribute("aria-label", label);
  b.title = label;
  b.textContent = text;
  b.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  // Keep editor node views from treating the key as "edit diagram".
  b.addEventListener("keydown", (event) => event.stopPropagation());
  return b;
}
// Draws the SVG on a canvas at twice its size for a sharp PNG.
export async function diagramPng(url: string) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = 2,
    canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
export function openDiagramViewer(url: string) {
  const dialog = document.createElement("dialog");
  dialog.className = "diagram-viewer";
  dialog.setAttribute("aria-label", "Diagramm vergrößert");
  const image = document.createElement("img");
  image.src = url;
  image.alt = "Mermaid-Diagramm";
  image.draggable = false;
  const stage = document.createElement("div");
  stage.className = "diagram-viewer-stage";
  stage.append(image);
  let zoom = 2;
  const label = document.createElement("output");
  label.setAttribute("aria-live", "polite");
  const apply = () => {
    const width = image.naturalWidth || 600;
    image.style.width = `${Math.round(width * ZOOMS[zoom])}px`;
    label.textContent = `${Math.round(ZOOMS[zoom] * 100)} %`;
    smaller.disabled = zoom === 0;
    larger.disabled = zoom === ZOOMS.length - 1;
  };
  const smaller = button("Verkleinern", "−", () => {
    zoom = Math.max(0, zoom - 1);
    apply();
  });
  const larger = button("Vergrößern", "+", () => {
    zoom = Math.min(ZOOMS.length - 1, zoom + 1);
    apply();
  });
  const close = button("Schließen", "×", () => dialog.close());
  const bar = document.createElement("div");
  bar.className = "diagram-viewer-bar";
  bar.append(
    smaller,
    label,
    larger,
    button("Als SVG herunterladen", "SVG", () => download(url, "diagramm.svg")),
    button(
      "Als PNG herunterladen",
      "PNG",
      () => void diagramPng(url).then((png) => download(png, "diagramm.png")),
    ),
    close,
  );
  dialog.append(bar, stage);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  image.decode().then(apply, apply);
  apply();
  dialog.showModal();
  return dialog;
}
export function diagramToolbar(url: string) {
  const tools = document.createElement("div");
  tools.className = "diagram-tools";
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", "Diagramm");
  tools.append(
    button("Diagramm vergrößern", "⤢", () => openDiagramViewer(url)),
    button("Als SVG herunterladen", "SVG", () => download(url, "diagramm.svg")),
    button(
      "Als PNG herunterladen",
      "PNG",
      () => void diagramPng(url).then((png) => download(png, "diagramm.png")),
    ),
  );
  return tools;
}
