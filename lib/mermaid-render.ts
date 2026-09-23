import { diagramSourceError } from "./mermaid-source";
let sequence = 0;
let queue = Promise.resolve();
const cache = new Map<string, Promise<string>>();
export function renderDiagram(source: string): Promise<string> {
  const error = diagramSourceError(source);
  if (error) return Promise.reject(new Error(error));
  const cached = cache.get(source);
  if (cached) return cached;
  const result = queue.then(async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 20_000,
      maxEdges: 500,
      theme: "default",
      fontFamily: "Arial, sans-serif",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: [
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "maxEdges",
        "suppressErrorRendering",
        "htmlLabels",
        "themeCSS",
        "fontFamily",
      ],
    });
    const container = document.createElement("div");
    container.className = "mermaid-measure";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(
        `flowplan-diagram-${++sequence}`,
        source,
        container,
      );
      // Render as an image, never insert a live SVG or bind diagram callbacks.
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Ungültiges Mermaid-Diagramm.",
      );
    } finally {
      container.remove();
    }
  });
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  cache.set(source, result);
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  return result;
}
export function mountDiagram(
  element: HTMLElement,
  source: string,
  onResult?: (error: string | null) => void,
) {
  let cancelled = false;
  element.dataset.diagramState = "loading";
  element.textContent = "Diagramm wird geladen …";
  void renderDiagram(source).then(
    (url) => {
      if (cancelled) return;
      const image = document.createElement("img");
      image.alt = "Mermaid-Diagramm";
      image.draggable = false;
      image.onload = () => {
        if (cancelled) return;
        element.dataset.diagramState = "ready";
        onResult?.(null);
      };
      image.onerror = () => {
        if (cancelled) return;
        element.dataset.diagramState = "error";
        element.textContent = "Das Diagrammbild konnte nicht angezeigt werden.";
        onResult?.(element.textContent);
      };
      image.src = url;
      element.replaceChildren(image);
    },
    (error: unknown) => {
      if (cancelled) return;
      element.textContent =
        error instanceof Error
          ? error.message
          : "Diagramm konnte nicht geladen werden.";
      element.dataset.diagramState = "error";
      onResult?.(element.textContent);
    },
  );
  return () => {
    cancelled = true;
  };
}
