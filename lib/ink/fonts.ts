// Typefaces of text on a page surface. A text item without `font` is drawn
// as it always was (Helvetica); the others are Flowplan's own faces in
// public/fonts.css, downloaded by the browser only when a text uses them.
// Free of React and the DOM (also used by the server and the PDF export).

export type InkFont = "sans" | "serif" | "mono" | "caveat" | "patrick";
export const INK_FONTS: InkFont[] = ["sans", "serif", "mono", "caveat", "patrick"];

export const isInkFont = (value: unknown): value is InkFont => typeof value === "string" && (INK_FONTS as string[]).includes(value);

// The face's own name (shown as is, in the face itself).
export const INK_FONT_NAMES: Record<InkFont, string> = {
  sans: "Instrument Sans",
  serif: "Instrument Serif",
  mono: "JetBrains Mono",
  caveat: "Caveat",
  patrick: "Patrick Hand",
};

const DEFAULT_FAMILY = "Helvetica, Arial, sans-serif";
// CSS font-family lists, with fallbacks for places without Flowplan's fonts
// (an exported SVG opened on its own, EPUB readers).
const FAMILIES: Record<InkFont, string> = {
  sans: `"Instrument Sans", Helvetica, Arial, sans-serif`,
  serif: `"Instrument Serif", Georgia, "Times New Roman", serif`,
  mono: `"JetBrains Mono", Menlo, Consolas, monospace`,
  caveat: `Caveat, "Segoe Print", "Bradley Hand", cursive`,
  patrick: `"Patrick Hand", "Comic Sans MS", "Chalkboard SE", cursive`,
};
export const inkFontFamily = (font?: InkFont | null) => (font && FAMILIES[font]) || DEFAULT_FAMILY;

// Average advance of a character in em, for the rough text box (selection,
// hits) – there are no font metrics on the server.
const ADVANCE: Record<InkFont, number> = { sans: 0.53, serif: 0.46, mono: 0.6, caveat: 0.42, patrick: 0.47 };
export const inkFontAdvance = (font?: InkFont | null) => (font && ADVANCE[font]) || 0.55;

// PDF exports use the standard PDF fonts (no font embedding): the nearest
// one for each face. The handwriting faces come out as Helvetica.
export type InkPdfFont = "Helvetica" | "Times-Roman" | "Courier";
export const inkPdfFont = (font?: InkFont | null): InkPdfFont => (font === "serif" ? "Times-Roman" : font === "mono" ? "Courier" : "Helvetica");
