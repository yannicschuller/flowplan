// "Copy image": puts a picture of a page on the system clipboard. Browsers
// only reliably accept image/png there, so other formats are redrawn first.
import { nativeSaveFile } from "./native-app";

export type CopyImageResult = "copied" | "shared" | "unsupported";

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) throw new Error("Image could not be converted");
  return png;
}

export async function copyImage(src: string): Promise<CopyImageResult> {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Image request failed (${response.status})`);
  const original = await response.blob();
  const png = await toPng(original);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {
      // Fall through to the share sheet.
    }
  }
  const file = new File([png], "image.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file] });
    return "shared";
  }
  // The app's web view: its own share sheet ("Save to Files", other apps).
  if (await nativeSaveFile("image.png", png)) return "shared";
  return "unsupported";
}
