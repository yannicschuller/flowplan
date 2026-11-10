// GoodNotes (and other handwriting apps) via PDF: every PDF becomes a
// notebook (lib/notebook.ts) whose sheets have the PDF's pages as their
// background – size and orientation as shown (crop box and rotation
// applied), the notebook titled by the file name. A ZIP of PDFs (several
// exported notebooks, or GoodNotes' auto-backup folder in PDF format) gives
// one notebook per PDF, its folders become parent pages. The PDF file stays
// attached to the notebook, so its text layer (typed text, and GoodNotes'
// recognised handwriting where the export has it) is indexed for search as
// for every PDF (lib/file-text.ts).
//
// GoodNotes' own format (.goodnotes, also inside its backups) is a ZIP of
// undocumented protobuf records (index.notes.pb, notes/, attachments/ …)
// whose layout changes between versions. Flowplan does not decode it: such
// a file is refused (inside a ZIP: skipped) with how to export as PDF
// instead, which keeps the handwriting as vectors.
//
// Everything here is an untrusted upload: the ZIP was read with the ZIP
// reader's limits (lib/archive.ts readZip, zip-bomb checks), a PDF must
// start like one, pdf.js only parses it (no scripts, fonts or XFA) within a
// time limit, and the page and sheet limits of notebooks apply.
import { posix } from "node:path";
import { HttpError } from "../auth";
import { jobProgress } from "../background-jobs";
import { MAX_IMPORT_PAGES as MAX_PDF_SHEETS } from "../notebook";
import { warningList, type ImportFile, type ImportPage, type ImportSheet, type ImportTree } from "./types";

export const GOODNOTES_REFUSAL =
  "GoodNotes-Dateien (.goodnotes) haben ein eigenes, nicht offengelegtes Format, das Flowplan nicht liest. Exportiere das Notizbuch in GoodNotes als PDF (Teilen bzw. Exportieren → PDF) und importiere das PDF – Handschrift, Seitenvorlagen und eingefügte PDFs bleiben so erhalten.";
export const NO_PDF = "Keine PDF-Dateien gefunden.";
export const PDF_EXPECTED = "Bitte ein PDF (etwa aus GoodNotes exportiert) oder ein ZIP mit PDFs hochladen.";
export const goodnotesSkipped = (name: string) => `${name}: GoodNotes-Datei übersprungen – bitte in GoodNotes als PDF exportieren.`;
export const pdfUnreadable = (name: string) => `${name}: Das PDF kann nicht gelesen werden (beschädigt oder mit Passwort geschützt) und wird übersprungen.`;
export const pdfTruncated = (name: string, kept: number, total: number) => `${name}: Nur die ersten ${kept} von ${total} Seiten werden übernommen.`;
export const pdfOddPages = (name: string) => `${name}: Seiten mit ungültiger Größe werden übersprungen.`;
export const NOT_PDF_SKIPPED = "Dateien, die keine PDFs sind, werden übersprungen.";

// Time one PDF may take to be measured.
const PDF_TIMEOUT = 30_000;
// Smallest and largest side of a sheet in points (lib/notebook.ts).
const MIN_SIDE = 10;
const MAX_SIDE = 14400;

const base = (name: string) => posix.basename(name.replaceAll("\\", "/"));
export const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString("latin1") === "%PDF-";
// macOS resource forks and hidden files of a copied folder.
const isJunk = (path: string) => base(path).startsWith(".") || /(^|\/)__MACOSX\//.test(path);

// A GoodNotes file: by its name, or a ZIP holding GoodNotes' own records.
export const isGoodNotesName = (name: string) => /\.goodnotes$/i.test(base(name));
export function isGoodNotesPackage(entries: Map<string, Buffer>) {
  const names = [...entries.keys()];
  return (
    names.some((n) => /^index\.(notes|attachments|events)\.pb$/.test(n)) ||
    (names.some((n) => n.startsWith("notes/")) && names.some((n) => n.startsWith("attachments/")) && !names.some((n) => /\.pdf$/i.test(n)))
  );
}
export function refuseGoodNotes(name: string, head?: Buffer) {
  // (A PDF that was only named so is taken as the PDF it is.)
  if (isGoodNotesName(name) && !(head && isPdf(head))) throw new HttpError(400, GOODNOTES_REFUSAL);
}

// A ZIP of PDFs (or of GoodNotes files, refused with what to do). Other
// sources come first; this one takes archives with no documents of theirs.
export function isPdfArchive(entries: Map<string, Buffer>) {
  const names = [...entries.keys()].filter((n) => !isJunk(n));
  if (isGoodNotesPackage(entries)) return true;
  return names.some((n) => /\.(pdf|goodnotes)$/i.test(n)) && !names.some((n) => /\.(html?|md|docx|enex|xml)$/i.test(n));
}

type PdfjsPage = { getViewport(options: { scale: number }): { width: number; height: number }; cleanup(): void };
// The pages of a PDF as shown (pdf.js viewport at scale 1: crop box and
// rotation applied, in points), at most `max`; null when it cannot be read.
export async function pdfSheetSizes(data: Buffer, max = MAX_PDF_SHEETS): Promise<{ sizes: { width: number; height: number }[]; total: number } | null> {
  if (!isPdf(data)) return null;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    enableXfa: false,
    isEvalSupported: false,
    verbosity: 0,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const measure = async () => {
    const doc = await task.promise;
    const sizes: { width: number; height: number }[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, max); n++) {
      const page = (await doc.getPage(n)) as unknown as PdfjsPage;
      const { width, height } = page.getViewport({ scale: 1 });
      sizes.push({ width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 });
      page.cleanup();
    }
    return { sizes, total: doc.numPages };
  };
  try {
    return await Promise.race([
      measure(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), PDF_TIMEOUT);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}

const notebookTitle = (path: string) => base(path).replace(/\.pdf$/i, "").trim() || "GoodNotes";

// The import tree: `files` are the PDFs by path (a single upload, or the
// entries of a ZIP after a single folder around everything was dropped).
export async function parseGoodNotes(files: Map<string, Buffer>, title = "GoodNotes"): Promise<ImportTree> {
  const warnings = warningList();
  const tree: ImportTree = { source: "goodnotes", title, pages: [], files: new Map<string, ImportFile>(), warnings: [] };
  const pdfs: string[] = [];
  let goodnotes = 0;
  for (const path of files.keys()) {
    if (isJunk(path)) continue;
    if (isGoodNotesName(path) && !isPdf(files.get(path)!)) {
      warnings.add(goodnotesSkipped(base(path)));
      goodnotes++;
    } else if (/\.pdf$/i.test(path) || isPdf(files.get(path)!)) pdfs.push(path);
    else warnings.add(NOT_PDF_SKIPPED);
  }
  if (!pdfs.length) throw new HttpError(400, goodnotes ? GOODNOTES_REFUSAL : NO_PDF);
  // Folders become parent pages; names in natural order (Heft 2 before Heft 10).
  const folders = new Map<string, string>();
  const folderPage = (dir: string): string | null => {
    if (!dir || dir === ".") return null;
    if (!folders.has(dir)) {
      const key = `folder:${dir}`;
      folders.set(dir, key);
      tree.pages.push({ key, parent: folderPage(posix.dirname(dir)), title: posix.basename(dir), html: "", folder: true });
    }
    return folders.get(dir)!;
  };
  const sorted = [...pdfs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  for (const [index, path] of sorted.entries()) {
    // Measuring is the reading half of the import (lib/importers/index.ts).
    await jobProgress((index / sorted.length) * 0.5);
    const data = files.get(path)!;
    const name = base(path);
    const measured = await pdfSheetSizes(data);
    if (!measured || !measured.sizes.length) {
      warnings.add(pdfUnreadable(name));
      continue;
    }
    if (measured.total > measured.sizes.length) warnings.add(pdfTruncated(name, measured.sizes.length, measured.total));
    const sheets: ImportSheet[] = [];
    let odd = false;
    measured.sizes.forEach((size, i) => {
      const fits = [size.width, size.height].every((v) => Number.isFinite(v) && v >= MIN_SIDE && v <= MAX_SIDE);
      if (fits) sheets.push({ file: path, page: i + 1, width: size.width, height: size.height });
      else odd = true;
    });
    if (odd) warnings.add(pdfOddPages(name));
    if (!sheets.length) continue;
    tree.files.set(path, { key: path, name: /\.pdf$/i.test(name) ? name : `${name}.pdf`, mime: "application/pdf", data });
    const page: ImportPage = { key: `notebook:${path}`, parent: folderPage(posix.dirname(path)), title: notebookTitle(path), html: "", kind: "notebook", notebook: { sheets } };
    tree.pages.push(page);
  }
  // Folders without a notebook (all of their PDFs unreadable) are left out.
  const used = new Set(tree.pages.filter((p) => !p.folder).map((p) => p.parent));
  for (let changed = true; changed; ) {
    changed = false;
    for (const page of tree.pages)
      if (page.folder && used.has(page.key) && page.parent && !used.has(page.parent)) {
        used.add(page.parent);
        changed = true;
      }
  }
  tree.pages = tree.pages.filter((p) => !p.folder || used.has(p.key));
  tree.warnings = warnings.list();
  return tree;
}

// The upload: a PDF, a ZIP of them, or a GoodNotes file (refused).
export async function parseGoodNotesUpload(name: string, bytes: Buffer, entries: Map<string, Buffer> | undefined, title: string) {
  refuseGoodNotes(name, bytes);
  if (entries) {
    if (isGoodNotesPackage(entries)) throw new HttpError(400, GOODNOTES_REFUSAL);
    return parseGoodNotes(entries, title);
  }
  if (!isPdf(bytes)) throw new HttpError(400, PDF_EXPECTED);
  return parseGoodNotes(new Map([[/\.pdf$/i.test(base(name)) ? base(name) : `${base(name) || "GoodNotes"}.pdf`, bytes]]), title);
}
