"use client";
// Pictures of the board for the exports (PNG of a frame or the selection in
// 1×, 2× or 4×, SVG, PDF via lib/whiteboard-pdf.ts). The board's own SVG is
// copied without the interface, cropped to the box, its pictures and PDF
// pages put inside as data (an SVG drawn as an image may load nothing), and
// drawn onto a canvas. The board menu's quick "Als PNG/SVG exportieren"
// goes the same way (exportWholeBoard, #455).
//
// An SVG drawn as an image loads nothing from outside, and only a data:
// address of it keeps the canvas readable – Chromium taints a canvas that
// drew an SVG with foreignObject (every text, note and table) from a blob:
// address, so toBlob throws (#455). Pictures of other sites (link cards,
// YouTube stills, image addresses) are read through CORS where the site
// allows it; otherwise PNG and PDF show a neutral placeholder in their place.
import { exportPages, type Box } from "@/lib/whiteboard-pdf";
import type { WhiteboardItem } from "@/lib/whiteboard-model";

// Styles of the elements, inside the file (the page's style sheet is not).
export const EXPORT_CSS =
  ".wb-text{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;white-space:pre-wrap;word-break:break-word;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;box-sizing:border-box}" +
  ".wb-rich{white-space:normal}.wb-rich p{margin:0;min-height:1.2em}.wb-rich ul,.wb-rich ol{margin:0;padding-left:1.3em;text-align:left}.wb-link{color:inherit;text-decoration:underline}" +
  ".wb-frame-title{font:600 14px system-ui,sans-serif;color:#495057;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
  ".wb-card-body{display:flex;flex-direction:column;justify-content:center;height:100%;font:14px system-ui,sans-serif;color:#1f2937;overflow:hidden}.wb-card-body small{color:#868e96;font-size:12px}.wb-card-excerpt{font-size:12px;color:#495057}" +
  ".wb-connector-label{display:flex;align-items:center;justify-content:center;height:100%;font:13px system-ui,sans-serif;color:#1f2937}" +
  ".wb-table-grid{display:grid;width:100%;height:100%;font-family:system-ui,sans-serif;color:#1f2937}.wb-cell{border:1px solid #dee2e6;padding:4px 6px;overflow:hidden;white-space:pre-wrap}.wb-cell.head{font-weight:600;background:#f1f3f5}" +
  ".wb-emoji-glyph{display:flex;align-items:center;justify-content:center;height:100%}" +
  ".wb-tags{display:flex;gap:4px;overflow:hidden}.wb-tag{border-radius:9px;padding:1px 7px;font:600 11px system-ui,sans-serif;white-space:nowrap}" +
  ".wb-link-badge{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#3b3fd8;color:#fff}" +
  ".wb-embed{display:flex;flex-direction:column;height:100%;color:#fff;font:13px system-ui,sans-serif;align-items:center;justify-content:center;text-align:center;gap:6px;padding:10px;box-sizing:border-box}.wb-embed button,.wb-embed-note{display:none}" +
  ".wb-pdf{display:flex;flex-direction:column;height:100%;font:12px system-ui,sans-serif;color:#1f2937}.wb-embed-bar{display:flex;gap:6px;align-items:center;padding:4px 8px;height:28px;box-sizing:border-box}.wb-pdf-nav{display:none}.wb-pdf img{width:100%;flex:1;object-fit:contain}" +
  // Tables (#455): colours of rows and columns, links and link previews in cells.
  ".wb-cell{display:flex;align-items:center}.wb-cell.filled{background:var(--wb-cell-fill);color:var(--wb-cell-fill-text)}.wb-cell .wb-link{color:#1c7ed6}" +
  ".wb-cell-card{display:flex;align-items:center;gap:8px;min-width:0;white-space:normal}.wb-cell-card-text{display:grid;min-width:0}.wb-cell-card-text .wb-link{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.wb-cell-card-text small{font-size:.8em;color:#868e96}" +
  ".wb-cell-thumb{position:relative;flex:none;width:3.2em;height:2.2em;border-radius:4px;overflow:hidden;object-fit:cover}.wb-cell-thumb .wb-cell-thumb-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}" +
  // Link cards (#455).
  ".wb-linkcard{display:flex;flex-direction:column;width:100%;height:100%;border-radius:10px;overflow:hidden;color:#1f2937;font:13px system-ui,sans-serif}.wb-linkcard-image{flex:1 1 auto;min-height:0;width:100%;object-fit:cover}" +
  ".wb-linkcard-body{display:grid;gap:3px;padding:10px 12px;flex:none}.wb-linkcard:not(.with-image) .wb-linkcard-body{flex:1;align-content:center}.wb-linkcard-site{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#868e96}.wb-linkcard-icon{width:14px;height:14px}" +
  ".wb-linkcard-title{color:inherit;font-weight:650;font-size:14px;text-decoration:none}.wb-linkcard-text{font-size:12px;color:#495057}";
// What stands in for a picture of another site that does not allow reading.
export const PICTURE_PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48" preserveAspectRatio="xMidYMid slice"><rect width="64" height="48" fill="#e9ecef"/><path d="M18 34l9-11 6 7 4-5 9 9z" fill="#adb5bd"/><circle cx="40" cy="17" r="3.5" fill="#adb5bd"/></svg>',
)}`;

const blobToData = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
const dataCache = new Map<string, Promise<string | null>>();
// A picture of another site as data, when the site allows reading it
// (CORS). The page's Content Security Policy lets images load from https
// but no fetch, so it goes through an image element and a canvas.
function corsData(href: string) {
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    const timer = setTimeout(() => resolve(null), 6000);
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.onload = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Small pictures (icons) keep transparency, photos become JPEG.
        resolve(canvas.width * canvas.height <= 256 * 256 ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.88));
      } catch {
        resolve(null);
      }
    };
    img.src = href;
  });
}
// Pictures as data: files of the workspace (same origin) with the
// session, pictures of other sites through CORS where allowed; null
// otherwise.
export function pictureData(href: string) {
  if (href.startsWith("data:")) return Promise.resolve(href);
  let known = dataCache.get(href);
  if (!known) {
    known = (async () => {
      try {
        const url = new URL(href, location.href);
        if (url.origin !== location.origin) return url.protocol === "https:" ? await corsData(url.href) : null;
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) return null;
        return await blobToData(await response.blob());
      } catch {
        return null;
      }
    })();
    dataCache.set(href, known);
  }
  return known;
}

// The board's SVG for the box, ready to save or draw.
// `copy` runs the copying (synchronously) – on the dark canvas while the
// board is drawn light, so exports always have the stored colours (#399).
export async function boardSvgSource(node: SVGSVGElement, box: Box, options: { inline?: boolean; copy?: <T>(copy: () => T) => T } = {}) {
  const clone = (options.copy ?? ((copy) => copy()))(() => {
    const copy = node.cloneNode(true) as SVGSVGElement;
    // PDF pages are canvases: their pixels do not travel with a copy.
    const sources = [...node.querySelectorAll("canvas")];
    [...copy.querySelectorAll("canvas")].forEach((canvas, i) => {
      const img = document.createElement("img");
      try {
        img.src = sources[i]?.toDataURL("image/png") || "";
      } catch {}
      img.className = canvas.className;
      canvas.replaceWith(img);
    });
    return copy;
  });
  clone.querySelectorAll("[data-ui], iframe, button").forEach((el) => el.remove());
  clone.querySelector("[data-world]")?.removeAttribute("transform");
  clone.querySelectorAll(".wb-offstage, .wb-dim").forEach((el) => el.classList.remove("wb-offstage", "wb-dim"));
  clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
  clone.setAttribute("width", String(Math.round(box.w)));
  clone.setAttribute("height", String(Math.round(box.h)));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.removeAttribute("style");
  clone.removeAttribute("class");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = EXPORT_CSS;
  clone.prepend(style);
  const sheet = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ x: box.x, y: box.y, width: box.w, height: box.h, fill: "#ffffff" })) sheet.setAttribute(k, String(v));
  style.after(sheet);
  // Players show their still picture where there is one (YouTube, #455)
  // instead of the dark card or the frame.
  clone.querySelectorAll("[data-export-thumb]").forEach((g) => {
    const thumb = g.getAttribute("data-export-thumb") || "";
    const frame = g.querySelector("foreignObject");
    if (!/^https:/.test(thumb) || !frame) return;
    const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
    for (const [k, v] of Object.entries({ href: thumb, width: frame.getAttribute("width") || "0", height: frame.getAttribute("height") || "0", preserveAspectRatio: "xMidYMid slice", "data-thumb": "" }))
      image.setAttribute(k, v);
    frame.replaceWith(image);
  });
  if (options.inline !== false)
    await Promise.all([
      ...[...clone.querySelectorAll("image")].map(async (image) => {
        const href = image.getAttribute("href") || image.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
        if (!href) return;
        const data = await pictureData(href);
        if (data) image.setAttribute("href", data);
        else if (/^https:/.test(href)) image.setAttribute("href", PICTURE_PLACEHOLDER);
        else image.remove();
      }),
      // Pictures inside elements (link cards, previews in table cells).
      ...[...clone.querySelectorAll("foreignObject img")].map(async (img) => {
        const src = img.getAttribute("src") || "";
        if (!src) return img.remove();
        const data = await pictureData(src);
        if (data) img.setAttribute("src", data);
        else if (/^https:/.test(src)) img.setAttribute("src", PICTURE_PLACEHOLDER);
        else img.remove();
      }),
    ]);
  return new XMLSerializer().serializeToString(clone);
}

// The SVG drawn at a scale (at most 8000 px on the longer side).
export async function rasterize(source: string, box: Box, scale: number) {
  const factor = Math.min(scale, 8000 / Math.max(box.w, box.h));
  const width = Math.max(1, Math.round(box.w * factor)),
    height = Math.max(1, Math.round(box.h * factor));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("render"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("render");
  return { blob, width, height };
}

export function saveFile(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const exportFileName = (title: string, ext: string) =>
  `${(title || "Whiteboard").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "Whiteboard"}.${ext}`;

// The board menu's quick exports (#455): the whole board as SVG or PNG (2×)
// through the same drawing as "Exportieren …". Throws "empty" for an empty
// board and "render" when the browser cannot draw the picture.
export async function exportWholeBoard(
  node: SVGSVGElement,
  items: WhiteboardItem[],
  kind: "svg" | "png",
  copy?: <T>(copy: () => T) => T,
) {
  const page = exportPages(items, "board")[0];
  if (!page) throw new Error("empty");
  const source = await boardSvgSource(node, page.box, { inline: kind === "png", copy });
  // The file keeps the quick export's name ("whiteboard.png").
  if (kind === "svg") return saveFile(new Blob([source], { type: "image/svg+xml" }), "whiteboard.svg");
  const { blob } = await rasterize(source, page.box, 2);
  saveFile(blob, "whiteboard.png");
}
