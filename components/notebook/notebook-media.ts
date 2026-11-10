"use client";
// Pictures for notebook sheets in the browser: made ready for the upload
// (camera orientation applied, location and other EXIF data dropped by
// drawing, at most 2560 px; PNG where transparent, JPEG otherwise – so the
// server's OCR reads them for search and the PDF export embeds them as
// they are), uploaded like every attachment (POST /api/upload: quota, type
// check, size limit, placeholder), and read back as PNG/JPEG for the PDF
// export. Calls of the sticker and template library (lib/notebook-library.ts).
import { api } from "../ui";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import type { InkImageBytes } from "@/lib/ink/pdf-export";
import type { InkItem } from "@/lib/ink/model";
import type { StickerEntry, TemplateEntry, NotebookPicture } from "@/lib/notebook-library";

export type { StickerEntry, TemplateEntry, NotebookPicture };
const MAX_EDGE = 2560;
export const PICTURE_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/avif";
export const isPicture = (file: Blob) => /^image\/(png|jpe?g|webp|gif|heic|heif|avif|bmp)$/i.test(file.type);

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}
function transparent(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const step = Math.max(1, Math.floor(Math.max(w, h) / 64));
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (data[(y * w + x) * 4 + 3] < 250) return true;
  return false;
}
// The picture as it will be uploaded, and its size in pixels as shown.
export async function preparePicture(file: File): Promise<{ file: File; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // A type the browser cannot draw: the server decides.
    return { file, width: 0, height: 0 };
  }
  try {
    const { width, height } = bitmap;
    // Animated GIFs stay as they are (drawing keeps only the first frame).
    if (file.type === "image/gif") return { file, width, height };
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { file, width, height };
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const png = transparent(ctx, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, png ? "image/png" : "image/jpeg", png ? undefined : 0.88);
    if (!blob) return { file, width, height };
    const base = (file.name || "Bild").replace(/\.[^.]+$/, "") || "Bild";
    return { file: new File([blob], `${base}.${png ? "png" : "jpg"}`, { type: blob.type }), width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

export type Uploaded = { id: string; url: string; name: string; mime: string; placeholder?: { w: number; h: number } };
export async function uploadToPage(pageId: string, file: File): Promise<Uploaded> {
  const form = new FormData();
  form.append("pageId", pageId);
  form.append("file", file);
  const response = await fetch("/api/upload", { method: "POST", body: form, headers: idempotencyHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Upload failed");
  return body as Uploaded;
}

// Pictures of the sheets for the PDF export: PNG or JPEG through a canvas
// (any type the browser shows, camera orientation applied).
export function browserImageLoader(src: (file: string) => string) {
  return async (file: string): Promise<InkImageBytes | null> => {
    try {
      const response = await fetch(src(file), { credentials: "same-origin" });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.type === "image/png" || blob.type === "image/jpeg") {
        // Already right – unless a JPEG still has a turning EXIF orientation.
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (blob.type === "image/png" || !turnedJpeg(bytes)) return { bytes, type: blob.type === "image/png" ? "png" : "jpg" };
      }
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const out = await canvasBlob(canvas, "image/png");
      return out ? { bytes: new Uint8Array(await out.arrayBuffer()), type: "png" } : null;
    } catch {
      return null;
    }
  };
}
// Does a JPEG carry an EXIF orientation other than 1 (a quick look at APP1)?
function turnedJpeg(data: Uint8Array) {
  let at = 2;
  while (at + 4 < data.length && data[at] === 0xff) {
    const marker = data[at + 1],
      length = (data[at + 2] << 8) | data[at + 3];
    if (marker === 0xda) return false;
    if (marker === 0xe1 && String.fromCharCode(...data.subarray(at + 4, at + 8)) === "Exif") {
      const tiff = at + 10,
        little = data[tiff] === 0x49;
      const u16 = (i: number) => (little ? data[i] | (data[i + 1] << 8) : (data[i] << 8) | data[i + 1]);
      const u32 = (i: number) => (little ? (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0 : ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0);
      const ifd = tiff + u32(tiff + 4);
      const count = u16(ifd);
      for (let i = 0; i < count && ifd + 2 + i * 12 + 10 < data.length; i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x0112) return u16(entry + 8) > 1;
      }
      return false;
    }
    at += 2 + length;
  }
  return false;
}

// ---- Library (commands, lib/notebook-library.ts) ----

export const notebookPictures = async (pageId: string) => (await api<{ pictures: NotebookPicture[] }>("/api/command", { action: "notebook.pictures", pageId })).pictures;
export const listStickers = async (pageId: string) => (await api<{ stickers: StickerEntry[] }>("/api/command", { action: "notebook.stickers", pageId })).stickers;
export const listTemplates = async (pageId: string) => (await api<{ templates: TemplateEntry[] }>("/api/command", { action: "notebook.templates", pageId })).templates;

// "Als Sticker speichern" for a lasso selection: the items as they are on
// the sheet (any page key); the server moves them to the top left and
// leaves out pictures of files. Answers the new sticker.
export async function saveSelectionAsSticker(items: InkItem[], pageId: string, name = "Sticker") {
  return await api<StickerEntry>("/api/command", { action: "notebook.sticker.save", pageId, items, name });
}
// A picture of the page (an image item's file) as a sticker.
export async function savePictureAsSticker(fileId: string, pageId: string, name = "Sticker") {
  return await api<StickerEntry>("/api/command", { action: "notebook.sticker.save", pageId, fileId, name });
}
export async function insertOwnSticker(stickerId: string, pageId: string) {
  return await api<{ kind: "image"; fileId: string; width: number; height: number } | { kind: "ink"; items: InkItem[]; width: number; height: number }>("/api/command", {
    action: "notebook.sticker.insert",
    pageId,
    stickerId,
  });
}
export async function createTemplate(pageId: string, file: File, { name, fit, pdfPage }: { name: string; fit: "stretch" | "tile"; pdfPage?: number }) {
  const form = new FormData();
  form.append("pageId", pageId);
  form.append("file", file);
  form.append("name", name);
  form.append("fit", fit);
  if (pdfPage) form.append("pdfPage", String(pdfPage));
  const response = await fetch("/api/notebook-library", { method: "POST", body: form, headers: idempotencyHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Upload failed");
  return body as TemplateEntry;
}
