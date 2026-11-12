import { diagramSourceError } from "./mermaid-source";
import { diagramToolbar } from "./diagram-tools";
let sequence = 0;
let queue = Promise.resolve();
const cache = new Map<string, Promise<string>>();
// Diagrams follow the page's light or dark colours (#241): in dark mode
// Mermaid's dark theme on the dark card, not a white box. Downloads (SVG,
// PNG) stay light, they are opened elsewhere.
export type DiagramTheme = "light" | "dark";
export const pageDiagramTheme = (): DiagramTheme =>
  typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
// Calls `onChange` when the page switches between light and dark
// (lib/theme.ts sets data-theme on <html>); returns the stop function.
export function watchDiagramTheme(onChange: (theme: DiagramTheme) => void) {
  if (typeof MutationObserver !== "function") return () => {};
  let current = pageDiagramTheme();
  const observer = new MutationObserver(() => {
    const next = pageDiagramTheme();
    if (next === current) return;
    current = next;
    onChange(next);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
export function renderDiagram(source: string, theme: DiagramTheme = pageDiagramTheme()): Promise<string> {
  const error = diagramSourceError(source);
  if (error) return Promise.reject(new Error(error));
  const key = `${theme}\n${source}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = queue.then(async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 20_000,
      maxEdges: 500,
      theme: theme === "dark" ? "dark" : "default",
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
  cache.set(key, result);
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  return result;
}
export function mountDiagram(
  element: HTMLElement,
  source: string,
  onResult?: (error: string | null) => void,
  tools = true,
) {
  let cancelled = false;
  let drawn = 0;
  element.dataset.diagramState = "loading";
  element.textContent = "Diagramm wird geladen …";
  const draw = (theme: DiagramTheme) => {
    const run = ++drawn;
    const stale = () => cancelled || run !== drawn;
    void renderDiagram(source, theme).then(
      (url) => {
        if (stale()) return;
        const image = document.createElement("img");
        image.alt = "Mermaid-Diagramm";
        image.draggable = false;
        image.onload = () => {
          if (stale()) return;
          element.dataset.diagramState = "ready";
          onResult?.(null);
        };
        image.onerror = () => {
          if (stale()) return;
          element.dataset.diagramState = "error";
          element.textContent = "Das Diagrammbild konnte nicht angezeigt werden.";
          onResult?.(element.textContent);
        };
        image.src = url;
        element.dataset.diagramTheme = theme;
        element.replaceChildren(image, ...(tools ? [diagramToolbar(url, () => renderDiagram(source, "light"), theme)] : []));
      },
      (error: unknown) => {
        if (stale()) return;
        element.textContent =
          error instanceof Error
            ? error.message
            : "Diagramm konnte nicht geladen werden.";
        element.dataset.diagramState = "error";
        onResult?.(element.textContent);
      },
    );
  };
  draw(pageDiagramTheme());
  // Light ⇄ dark while the page is open: drawn again in the new colours.
  const unwatch = watchDiagramTheme(draw);
  return () => {
    cancelled = true;
    unwatch();
  };
}
