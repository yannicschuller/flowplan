// Office files (#562): an uploaded presentation (.pptx, .odp) or text
// document (.docx, .odt) opens in a read-only content preview
// (components/office-viewer.tsx) – the slides or the document's headings,
// paragraphs, lists, tables and pictures, not its exact layout. The old
// binary formats (.ppt, .doc) only get a card with their download. Shared
// by the browser and the server (lib/office-preview.ts); nothing here
// reads a file.

// Larger files are only downloaded. The default; FLOWPLAN_OFFICE_PREVIEW_MB
// changes it on the server (lib/office-preview.ts officePreviewLimit()).
export const OFFICE_PREVIEW_LIMIT = 20 * 1024 * 1024;
// What one answer of the preview holds at most; the rest is left out
// (`truncated`).
export const OFFICE_LIMITS = {
  // Slides of a presentation.
  slides: 500,
  // Headings, paragraphs, tables and pictures of a document, and of all
  // slides together (their notes included).
  blocks: 10_000,
  // Characters of text of the whole file.
  chars: 500_000,
  // Pictures of the whole file.
  images: 500,
  // Rows and columns of one table.
  rows: 500,
  columns: 50,
};

export type OfficeKind = "pptx" | "odp" | "docx" | "odt" | "ppt" | "doc";

// By the name only, as for spreadsheets (lib/sheet-files.ts): browsers send
// differing types for Office files, and the preview reads the content.
export function officeKindOf(name: string): OfficeKind | null {
  const ext = /\.(pptx|odp|docx|odt|ppt|doc)$/i.exec(name.trim())?.[1]?.toLowerCase();
  return (ext as OfficeKind | undefined) ?? null;
}
export const isOfficeName = (name: string) => officeKindOf(name) !== null;
// The files the viewer shows (a .ppt or .doc is only downloaded).
export const isPreviewableOffice = (name: string) => {
  const kind = officeKindOf(name);
  return !!kind && kind !== "ppt" && kind !== "doc";
};
export const isPresentationKind = (kind: OfficeKind | null) => kind === "pptx" || kind === "odp" || kind === "ppt";

// The preview's address next to a file's own (/api/files/<id> and the
// published /api/share/<token>/files/<id>), and of one of its pictures.
export const officePreviewUrl = (src: string) => `${src}/office`;
export const officeImageUrl = (src: string, image: string) => `${src}/office/image?name=${encodeURIComponent(image)}`;

// A piece of a document or slide. Text is plain text (line breaks as
// "\n"); `level` counts list levels from 0; `list` says how a list item is
// marked; `image` is the picture's name inside the file, served by
// officeImageUrl().
export type OfficeBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string; level: number; list?: "bullet" | "number" }
  | { type: "table"; rows: string[][] }
  | { type: "image"; image: string };
export type OfficeSlide = {
  // The title placeholder's text ("" without one).
  title: string;
  blocks: OfficeBlock[];
  // The speaker notes, paragraph by paragraph.
  notes: string[];
};
// What GET …/office answers: `slides` for a presentation, `blocks` for a
// text document.
export type OfficePreview = {
  kind: "pptx" | "odp" | "docx" | "odt";
  slides?: OfficeSlide[];
  blocks?: OfficeBlock[];
  // More than OFFICE_LIMITS allows: only the first part is here.
  truncated: boolean;
  limits: typeof OFFICE_LIMITS;
};

// The numbers of numbered list items, as the viewer shows them: counted
// per level, restarted by any paragraph that is no item of that list at a
// level at or above it.
export function listNumbers(blocks: readonly OfficeBlock[]) {
  const out: (number | null)[] = [];
  const counters: number[] = [];
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.list) {
      counters.length = 0;
      out.push(null);
      continue;
    }
    // A deeper level starts afresh below a shallower item.
    counters.length = Math.min(counters.length, block.level + 1);
    if (block.list !== "number") {
      counters[block.level] = 0;
      out.push(null);
      continue;
    }
    counters[block.level] = (counters[block.level] || 0) + 1;
    out.push(counters[block.level]);
  }
  return out;
}
