// The block an uploaded file becomes in a document – a picture, a PDF with
// its first page, a card for 3D/CAD files, HTML files, spreadsheets and
// Office files, a player for video and audio, else a link with the file's
// name. Shared by the editor (a file dropped or pasted into a document,
// components/editor.tsx) and the server (a page made from a file,
// lib/file-pages.ts, #569), so both give the same block. Pure: nothing here
// reads a file.
import { isModelName } from "./model-formats";
import { isHtmlName } from "./html-files";
import { isSheetName } from "./sheet-files";
import { isOfficeName } from "./office-files";

export type FileBlock = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: FileBlock[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

// The cards open viewers that read the stored file (/api/files/<id>/…).
const STORED = /^\/api\/files\/[a-f0-9-]+$/;

export function fileBlock(file: { url: string; name: string; type: string; alt?: string }): FileBlock {
  const { url, name } = file;
  const type = (file.type || "").toLowerCase();
  const media = (kind: string) => ({ type: "media", attrs: { src: url, kind, title: name } });
  if (type.startsWith("image/")) return { type: "image", attrs: { src: url, alt: file.alt ?? name } };
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return media("pdf");
  // A 3D or CAD file (#384): a card that opens the 3D viewer.
  if (isModelName(name) && STORED.test(url)) return media("model");
  // An HTML file (#398): a card that opens the sandboxed preview.
  if (isHtmlName(name) && STORED.test(url)) return media("html");
  // A spreadsheet (#402): a card that opens the table viewer (.xls: the download).
  if (isSheetName(name) && STORED.test(url)) return media("sheet");
  // A presentation or text document (#562): a card that opens the content
  // preview (.ppt, .doc: the download).
  if (isOfficeName(name) && STORED.test(url)) return media("office");
  if (type.startsWith("video/") || type.startsWith("audio/")) return media(type.startsWith("video/") ? "video" : "audio");
  return { type: "paragraph", content: [{ type: "text", text: name, marks: [{ type: "link", attrs: { href: url } }] }] };
}

// The title of a page made from a file: its name without the extension
// ("Quarterly report.pdf" → "Quarterly report"), as captures and imports
// name their pages; a name that is only an extension stays as it is.
export function filePageTitle(name: string) {
  const clean = name.trim();
  const bare = clean.replace(/\.[a-z0-9]{1,8}$/i, "").trim();
  return (bare || clean).slice(0, 300);
}
