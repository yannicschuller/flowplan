export const MAX_PDF_TEXT = 100000;
const MAX_PAGES = 200;

// Extracts the visible text layer of a PDF (no OCR). XFA forms, font
// loading and system fonts stay off; the result is capped for the index.
export async function pdfText(data: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    enableXfa: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    let length = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("")
        .replace(/[ \t]+/g, " ")
        .trim();
      page.cleanup();
      if (text) {
        parts.push(text);
        length += text.length;
      }
      if (length >= MAX_PDF_TEXT) break;
    }
    return parts.join("\n").slice(0, MAX_PDF_TEXT);
  } finally {
    await task.destroy();
  }
}

// Images of PDF pages without a text layer (scans), as PNG for OCR.
export async function pdfScanImages(data: Uint8Array, maxPages = 20) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { encodePng } = await import("./ocr");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  });
  const images: Buffer[] = [];
  try {
    const doc = await task.promise;
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const text = await page.getTextContent();
      if (text.items.some((item) => "str" in item && item.str.trim())) continue;
      const ops = await page.getOperatorList();
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const id = ops.argsArray[i][0] as string;
        const image = await new Promise<{
          width: number;
          height: number;
          kind: number;
          data?: Uint8ClampedArray;
        } | null>((done) => {
          try {
            page.objs.get(id, done);
          } catch {
            done(null);
          }
        });
        if (!image?.data || image.width < 50 || image.height < 20) continue;
        let pixels: Uint8Array | Uint8ClampedArray = image.data;
        // 1 bit per pixel greyscale, rows padded to whole bytes.
        if (image.kind === 1) {
          const grey = new Uint8Array(image.width * image.height);
          const row = Math.ceil(image.width / 8);
          for (let y = 0; y < image.height; y++)
            for (let x = 0; x < image.width; x++)
              grey[y * image.width + x] =
                image.data[y * row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
          pixels = grey;
        }
        try {
          images.push(encodePng(image.width, image.height, pixels));
        } catch {}
      }
      page.cleanup();
    }
    return images;
  } finally {
    await task.destroy();
  }
}
