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
