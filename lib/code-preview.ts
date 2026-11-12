import { tr } from "./locale-tag";
import type { PreviewKind } from "./code-block-options";

// The preview of a code block (#92), drawn into an element of the editor's
// node view (components/code-block.tsx) or of a read-only view
// (components/read-only-document.tsx). Every renderer loads on first use:
// DOMPurify, Marked, KaTeX, Mermaid and the Typst WebAssembly are not part
// of the page's JavaScript. Nothing of a preview is stored.
//
// - HTML: a frame with sandbox="" (no scripts, no same origin, no forms or
//   pop-ups) from srcdoc, its own Content-Security-Policy allowing inline
//   styles and data: pictures only – no requests at all, so remote pictures
//   stay blank and Flowplan is out of reach. The frame cannot tell its
//   height; it is measured from a sanitized copy laid out off screen.
// - SVG, Mermaid, Typst: an <img> of the SVG – no scripts, no links, no
//   requests of its own.
// - Markdown: Flowplan's Markdown conversion, sanitized with DOMPurify.
// - LaTeX: the formulas with KaTeX (no whole LaTeX documents).
// Errors show in place of the preview.

export const MAX_PREVIEW_LENGTH = 200_000;
// The policy inside an HTML preview: inline styles and data: pictures and
// fonts only.
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; form-action 'none'; base-uri 'none'";

// The document an HTML preview shows. The policy comes first, in the head,
// before anything of the block (a full document's <html> and <head> merge
// into these).
export function htmlPreviewDocument(html: string) {
  return (
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    `<meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff;color:#111}body{margin:8px;font-family:system-ui,sans-serif}</style>` +
    html
  );
}

// An SVG text as a data: address for an <img>, or an error.
export function svgImage(text: string): { url: string } | { error: string } {
  let svg = text.trim();
  if (!/<svg[^>]*\sxmlns\s*=/i.test(svg)) svg = svg.replace(/<svg(?=[\s>])/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const failed = doc.querySelector("parsererror");
    if (failed || doc.documentElement.localName !== "svg")
      return { error: tr("Ungültiges SVG: ", "Invalid SVG: ") + (failed?.textContent?.split("\n").find((line) => line.trim()) || "").slice(0, 200) };
  }
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

// LaTeX for KaTeX: formulas separated by blank lines, with or without
// $$ … $$ or \[ … \] around them.
export function latexFormulas(text: string): string[] | null {
  if (/\\documentclass|\\begin\s*\{document\}/.test(text)) return null;
  return text
    .split(/\n\s*\n/)
    .map((part) =>
      part
        .trim()
        .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
        .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
        .replace(/^\$([\s\S]*)\$$/, "$1")
        .trim(),
    )
    .filter(Boolean);
}

type Purify = typeof import("dompurify").default;
let purifier: Promise<Purify> | null = null;
const purify = () => (purifier ||= import("dompurify").then((module) => module.default));

const REMOTE_ATTRIBUTES = ["src", "srcset", "href", "xlink:href", "poster", "background", "action", "formaction", "data", "ping"];
// The HTML of a block without anything that runs or loads: DOMPurify
// (scripts, handlers, frames …) and every address that is not data:.
async function inertHtml(html: string) {
  const DOMPurify = await purify();
  const fragment = DOMPurify.sanitize(html, {
    FORCE_BODY: true,
    RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ["style"],
    // Forms, media and pictures keep their place (without addresses), as
    // they show in the frame.
    FORBID_TAGS: ["link", "meta", "base", "iframe", "frame", "object", "embed"],
  });
  for (const element of fragment.querySelectorAll("*")) {
    for (const name of REMOTE_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && !(name === "src" && /^data:image\//i.test(value.trim()))) element.removeAttribute(name);
    }
    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", inertCss(style));
    if (element.localName === "style") element.textContent = inertCss(element.textContent || "");
  }
  return fragment;
}
const inertCss = (css: string) =>
  css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/(?:-webkit-)?image-set\s*\([^)]*\)/gi, "none")
    .replace(/url\s*\((?!\s*["']?data:)[^)]*\)/gi, "none");

// The height an HTML preview needs at a width, laid out off screen.
async function measureHtml(html: string, width: number) {
  const fragment = await inertHtml(html);
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `all:initial;position:absolute;left:-100000px;top:0;width:${Math.max(120, width)}px;visibility:hidden;contain:layout style`;
  const shadow = host.attachShadow({ mode: "open" });
  const body = document.createElement("div");
  body.style.cssText = "display:flow-root;margin:8px;font-family:system-ui,sans-serif;font-size:16px;line-height:normal;color:#111";
  body.append(fragment);
  shadow.append(body);
  document.body.append(host);
  try {
    await Promise.all([...body.querySelectorAll("img")].map((img) => img.decode().catch(() => undefined)));
    // Its margins, and a little room for fonts the frame lays out wider.
    return Math.ceil(body.getBoundingClientRect().height + 16 + 8);
  } finally {
    host.remove();
  }
}

const MIN_FRAME = 48,
  MAX_FRAME = 2000;
function htmlPreview(element: HTMLElement, text: string, done: (error: string | null) => void) {
  const frame = document.createElement("iframe");
  // No scripts, no same origin, no forms, pop-ups or navigation of the page.
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  frame.title = tr("HTML-Vorschau", "HTML preview");
  frame.className = "code-preview-frame";
  frame.srcdoc = htmlPreviewDocument(text);
  frame.style.height = "160px";
  element.replaceChildren(frame);
  let cancelled = false,
    lastWidth = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  const fit = () => {
    const width = frame.clientWidth || element.clientWidth;
    if (!width || Math.abs(width - lastWidth) < 8) return;
    lastWidth = width;
    void measureHtml(text, width).then(
      (height) => {
        if (!cancelled) frame.style.height = `${Math.min(MAX_FRAME, Math.max(MIN_FRAME, height))}px`;
      },
      () => undefined,
    );
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(fit, 120);
  }) : null;
  observer?.observe(element);
  fit();
  done(null);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    observer?.disconnect();
  };
}

function picture(element: HTMLElement, url: string, alt: string, done: (error: string | null) => void, isCancelled: () => boolean, width?: number) {
  const image = document.createElement("img");
  if (width) image.style.width = `${Math.round(width)}px`;
  image.alt = alt;
  image.draggable = false;
  image.className = "code-preview-image";
  image.onload = () => !isCancelled() && done(null);
  image.onerror = () => !isCancelled() && done(tr("Die Vorschau konnte nicht angezeigt werden.", "The preview could not be shown."));
  image.src = url;
  element.replaceChildren(image);
}

// Draws the preview; returns a function that stops it. `onResult` hears
// null when it is shown or the error shown instead.
export function mountCodePreview(element: HTMLElement, kind: PreviewKind, text: string, onResult?: (error: string | null) => void) {
  let cancelled = false;
  let stop = () => {};
  const isCancelled = () => cancelled;
  element.dataset.previewState = "loading";
  element.dataset.previewKind = kind;
  const done = (error: string | null) => {
    if (cancelled) return;
    element.dataset.previewState = error ? "error" : "ready";
    if (error) {
      const message = document.createElement("p");
      message.className = "code-preview-error";
      message.setAttribute("role", "status");
      message.textContent = error;
      element.replaceChildren(message);
    }
    onResult?.(error);
  };
  const fail = (error: unknown) => done(error instanceof Error && error.message ? error.message : tr("Die Vorschau konnte nicht erstellt werden.", "The preview could not be created."));
  if (!text.trim()) {
    element.dataset.previewState = "empty";
    const empty = document.createElement("p");
    empty.className = "code-preview-empty";
    empty.textContent = tr("Noch nichts zum Anzeigen.", "Nothing to show yet.");
    element.replaceChildren(empty);
    onResult?.(null);
    return () => void (cancelled = true);
  }
  if (text.length > MAX_PREVIEW_LENGTH) {
    done(tr("Zu lang für eine Vorschau.", "Too long for a preview."));
    return () => void (cancelled = true);
  }
  const loading = document.createElement("p");
  loading.className = "code-preview-loading";
  loading.textContent = tr("Vorschau wird geladen …", "Loading preview …");
  element.replaceChildren(loading);
  switch (kind) {
    case "html":
      stop = htmlPreview(element, text, done);
      break;
    case "svg": {
      const result = svgImage(text);
      if ("error" in result) done(result.error);
      else picture(element, result.url, tr("SVG-Vorschau", "SVG preview"), done, isCancelled);
      break;
    }
    case "mermaid":
      // In the page's light or dark colours, drawn again on a switch (#241).
      void import("./mermaid-render").then(({ renderDiagram, pageDiagramTheme, watchDiagramTheme }) => {
        if (cancelled) return;
        let drawn = 0;
        const draw = (theme: ReturnType<typeof pageDiagramTheme>) => {
          const run = ++drawn;
          void renderDiagram(text, theme).then((url) => {
            if (cancelled || run !== drawn) return;
            element.dataset.diagramTheme = theme;
            picture(element, url, tr("Mermaid-Diagramm", "Mermaid diagram"), done, isCancelled);
          }, fail);
        };
        draw(pageDiagramTheme());
        stop = watchDiagramTheme(draw);
      }, fail);
      break;
    case "typst":
      void import("./typst-render")
        .then(({ renderTypst }) => renderTypst(text, (n) => tr(`Zeile ${n}`, `Line ${n}`)))
        .then(
          // Typst measures in points: shown at its real size (1 pt = 4/3 px).
          (svg) =>
            !cancelled &&
            picture(
              element,
              `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
              tr("Typst-Vorschau", "Typst preview"),
              done,
              isCancelled,
              (Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1]) || 0) * (4 / 3),
            ),
          fail,
        );
      break;
    case "latex": {
      const formulas = latexFormulas(text);
      if (!formulas) {
        done(tr("Die Vorschau zeigt Formeln (KaTeX), keine ganzen LaTeX-Dokumente.", "The preview shows formulas (KaTeX), not whole LaTeX documents."));
        break;
      }
      void import("./math-render").then(({ renderMath }) => {
        if (cancelled) return;
        const box = document.createElement("div");
        box.className = "code-preview-math";
        // KaTeX's own HTML (trust off); errors show in red in place.
        box.innerHTML = formulas.map((formula) => `<div class="code-preview-formula">${renderMath(formula, false)}</div>`).join("");
        element.replaceChildren(box);
        done(null);
      }, fail);
      break;
    }
    case "markdown":
      void Promise.all([import("./markdown-html"), purify(), import("./math-render")]).then(([{ markdownToRawHtml }, DOMPurify, { renderMath }]) => {
        if (cancelled) return;
        const box = document.createElement("div");
        box.className = "code-preview-markdown";
        box.innerHTML = DOMPurify.sanitize(markdownToRawHtml(text), {
          FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "link", "meta", "base"],
        });
        for (const math of box.querySelectorAll<HTMLElement>("[data-math]")) math.innerHTML = renderMath(math.dataset.math || "", math.tagName === "SPAN");
        for (const link of box.querySelectorAll("a")) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        for (const image of box.querySelectorAll("img")) {
          image.loading = "lazy";
          image.referrerPolicy = "no-referrer";
        }
        element.replaceChildren(box);
        done(null);
      }, fail);
      break;
  }
  return () => {
    cancelled = true;
    stop();
  };
}
