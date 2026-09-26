// Photos are made smaller in the browser before they are uploaded: at most
// 2560 px on the longer side, stored as WebP (JPEG where the browser cannot
// write WebP). Drawing the photo also applies the camera orientation and
// drops EXIF data such as the location. GIFs (animation), SVGs and files
// that would not get noticeably smaller stay as they are.
const MAX_EDGE = 2560;
const QUALITY = 0.82;
const COMPRESSIBLE = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif", "image/bmp"];

export function isCompressibleImage(file: Blob) {
  return COMPRESSIBLE.includes(file.type.toLowerCase());
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

// Transparent pixels, sampled on a small copy.
function hasAlpha(source: CanvasImageSource, width: number, height: number) {
  const probe = document.createElement("canvas");
  probe.width = Math.min(64, width);
  probe.height = Math.min(64, height);
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(source, 0, 0, probe.width, probe.height);
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

export async function compressImage(file: File): Promise<File> {
  if (typeof document === "undefined" || !isCompressibleImage(file)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // format the browser cannot decode
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    // Small and already compact: nothing to gain.
    if (scale === 1 && file.size < 150 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await canvasBlob(canvas, "image/webp", QUALITY);
    if (!blob || blob.type !== "image/webp") {
      // No WebP encoder (older Safari): JPEG, unless transparency would be lost.
      if (hasAlpha(canvas, canvas.width, canvas.height)) return file;
      blob = await canvasBlob(canvas, "image/jpeg", QUALITY);
    }
    if (!blob || blob.size > file.size * 0.9) return file;
    const extension = blob.type === "image/webp" ? "webp" : "jpg";
    const name = `${file.name.replace(/\.[^.]+$/, "") || "bild"}.${extension}`;
    return new File([blob], name, { type: blob.type, lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}
