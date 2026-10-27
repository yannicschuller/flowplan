"use client";
// Pictures of the board for the exports (PNG of a frame or the selection in
// 1×, 2× or 4×, SVG, PDF via lib/whiteboard-pdf.ts). The board's own SVG is
// copied without the interface, cropped to the box, its pictures and PDF
// pages put inside as data (an SVG drawn as an image may load nothing), and
// drawn onto a canvas.
import type { Box } from "@/lib/whiteboard-pdf";

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
  ".wb-pdf{display:flex;flex-direction:column;height:100%;font:12px system-ui,sans-serif;color:#1f2937}.wb-embed-bar{display:flex;gap:6px;align-items:center;padding:4px 8px;height:28px;box-sizing:border-box}.wb-pdf-nav{display:none}.wb-pdf img{width:100%;flex:1;object-fit:contain}";

const blobToData = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
const dataCache = new Map<string, Promise<string | null>>();
// Same-origin pictures (files of the workspace) as data; others stay
// addresses (they may be missing in the PNG, the SVG keeps them).
function pictureData(href: string) {
  if (href.startsWith("data:")) return Promise.resolve(href);
  let known = dataCache.get(href);
  if (!known) {
    known = (async () => {
      try {
        const url = new URL(href, location.href);
        if (url.origin !== location.origin) return null;
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
export async function boardSvgSource(node: SVGSVGElement, box: Box, options: { inline?: boolean } = {}) {
  const clone = node.cloneNode(true) as SVGSVGElement;
  // PDF pages are canvases: their pixels do not travel with a copy.
  const sources = [...node.querySelectorAll("canvas")];
  [...clone.querySelectorAll("canvas")].forEach((canvas, i) => {
    const img = document.createElement("img");
    try {
      img.src = sources[i]?.toDataURL("image/png") || "";
    } catch {}
    img.className = canvas.className;
    canvas.replaceWith(img);
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
  if (options.inline !== false)
    await Promise.all(
      [...clone.querySelectorAll("image")].map(async (image) => {
        const href = image.getAttribute("href") || image.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
        if (!href) return;
        const data = await pictureData(href);
        if (data) image.setAttribute("href", data);
        else if (!/^https:/.test(href)) image.remove();
      }),
    );
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
