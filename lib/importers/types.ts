// What every importer produces: a tree of pages with HTML that refers to
// files and other pages of the import through placeholders
// (lib/importers/html.ts fileRef/pageRef), plus the files themselves.
// Some sources bring more than documents (AFFiNE): whiteboards, databases
// and journal days are pages with a kind of their own.
import type { ImportedBoard } from "../whiteboard-import";
import type { Field, View } from "../types";
import type { FrontmatterValue } from "../frontmatter";
import type { PropertyHints } from "../frontmatter-types";

// "notion": Notion's API (lib/importers/notion-api.ts) – not a file; its
// export ZIP goes through lib/zip-import.ts. "bookstack": BookStack's API
// (lib/importers/bookstack-api.ts), not a file either.
// "anki": an Anki package (lib/importers/anki.ts), flashcard databases.
export type ImportSource = "affine" | "anki" | "bookstack" | "confluence" | "evernote" | "gdocs" | "goodnotes" | "notion" | "obsidian" | "word";

// The import report (lib/importers/report.ts): what an import did not carry
// over or only approximated, each entry with the imported page it concerns
// (its key in the tree; for the ZIP import the created page's id). The
// writer turns it into a page "Importbericht" in the target space.
export type ReportKind =
  // A block type the importer does not know or cannot convert.
  | "block"
  // An embed, bookmark or external file kept as a link.
  | "embed"
  // A synced block: its content copied where it was shown.
  | "synced"
  // A formula or rollup without counterpart: its computed values as text.
  | "formula"
  | "rollup"
  // A property brought in as another type (person as text, …).
  | "property"
  // A relation target that is not part of the import.
  | "relation"
  // A file too large, missing or failed to download.
  | "file"
  // A page, database, its records or part of a page's content left out
  // because the source did not deliver it, even after retries (Notion API,
  // #563): its title, what failed and the HTTP status with the source's
  // error code – never a token or the answer's text.
  | "skipped"
  | "other";
export type ReportEntry = { kind: ReportKind; detail: string; page?: string; row?: string };
// Collects report entries; the same entry for the same page once, at most
// MAX_REPORT entries (the rest only counted).
export const MAX_REPORT = 2000;
export function importReport() {
  const seen = new Set<string>();
  const entries: ReportEntry[] = [];
  const counts: Partial<Record<ReportKind, number>> = {};
  return {
    entries,
    counts,
    add(kind: ReportKind, detail: string, page?: string | null, row?: string | null) {
      const clean = detail.replace(/\s+/g, " ").trim().slice(0, 300);
      const key = `${kind}\u0000${clean}\u0000${page || ""}\u0000${row || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      counts[kind] = (counts[kind] || 0) + 1;
      if (entries.length < MAX_REPORT) entries.push({ kind, detail: clean, ...(page ? { page } : {}), ...(row ? { row } : {}) });
    },
  };
}
export type ImportReport = ReturnType<typeof importReport>;

// A sheet of an imported notebook (GoodNotes PDF, lib/importers/goodnotes.ts):
// page `page` (from 1) of the PDF `file` (a key of the tree's files) as its
// background, its size as shown in points.
export type ImportSheet = { file: string; page: number; width: number; height: number };

export type ImportDatabase = {
  fields: Field[];
  views: View[];
  // Cells by field id; the HTML is the record's document. A record that
  // carries a document of the import (AFFiNE: a database row turned into a
  // doc, #82) has that document's key: links to it lead to the record. Its
  // icon is an emoji, as a page's.
  // `id`: the record's id chosen by the importer (Anki: to replay the
  // learning state onto it afterwards).
  rows: { cells: Record<string, unknown>; html: string; created?: string; updated?: string; key?: string; icon?: string; id?: string }[];
  // Stored settings of the database (lib/database-settings-schema.ts), e.g.
  // the card mapping `study` of a flashcard deck (Anki).
  settings?: Record<string, unknown>;
};

export type ImportPage = {
  key: string;
  parent: string | null;
  title: string;
  html: string;
  // A folder or notebook without text of its own.
  folder?: boolean;
  created?: string;
  updated?: string;
  tags?: string[];
  aliases?: string[];
  // Further frontmatter keys (Obsidian): properties of the page (#70,
  // lib/page-properties-server.ts frontmatterMeta).
  properties?: Record<string, FrontmatterValue>;
  url?: string;
  // Not a document: a whiteboard (items may name pages of the import by
  // their pageRef placeholder) or a database. Both only in "pages" mode.
  // A notebook (GoodNotes): its sheets, only in "pages" mode as well.
  kind?: "document" | "whiteboard" | "database" | "notebook";
  board?: ImportedBoard;
  database?: ImportDatabase;
  notebook?: { sheets: ImportSheet[] };
  // A journal day (YYYY-MM-DD): written into that day of the workspace's
  // journal instead of becoming a page of its own; appended when the day
  // already exists.
  journalDate?: string;
  // The page's icon: an emoji (AFFiNE's document, folder and collection
  // icons, #82).
  icon?: string;
  // The page's cover: a file of the import (an image; Notion).
  cover?: string;
  // The document's content is that of a record of a database of this
  // import (the record has this page's key): in "pages" mode it
  // gets no page of its own and links to it lead to the record; in
  // "database" mode, where databases are left out, it is a record as any
  // other page (AFFiNE, #82).
  inRecord?: boolean;
};
// A document the source marks as a template (AFFiNE, #116): saved as a
// template of the workspace (lib/page-templates.ts) instead of a page. Its
// HTML (and a database template's records) refer to files and pages of the
// import like a page's; links to it from pages are plain text.
export type ImportTemplate = {
  key: string;
  name: string;
  kind: "document" | "database";
  html: string;
  database?: ImportDatabase;
  icon?: string;
  tags?: string[];
};
// A file: in memory, or (large AFFiNE workspaces) read from the source when
// it is written, so only one is in memory at a time.
export type ImportFile = { key: string; name: string; mime: string } & ({ data: Buffer } | { size: number; read: () => Buffer });
export const importFileSize = (file: ImportFile) => ("data" in file ? file.data.length : file.size);
export const importFileData = (file: ImportFile) => ("data" in file ? file.data : file.read());
export type ImportTree = {
  source: ImportSource;
  title: string;
  pages: ImportPage[];
  files: Map<string, ImportFile>;
  warnings: string[];
  // What was not carried over or only approximated, per page (the import
  // report; lib/importers/report.ts).
  report?: ImportReport;
  // Colours of tags by name, as the source names them (AFFiNE).
  tagColors?: Record<string, string>;
  // Collections and similar pages the source adds (counted in the preview).
  collections?: number;
  // Templates of the source (AFFiNE, #116), written as saved templates.
  templates?: ImportTemplate[];
  // Documents that go below the one document linking to them (AFFiNE,
  // #167) – counted also when that is switched off, for the preview.
  linkedBelow?: number;
  // Obsidian (#668, #672): daily notes matching the vault's date format,
  // notes of its templates folder and embeds of notes – counted whether or
  // not the preview switches them on, so it can offer the switches.
  dailyNotes?: number;
  templateNotes?: number;
  noteEmbeds?: number;
  // The page holding everything (AFFiNE: the workspace) when the import
  // has one; it is not counted as a folder in the preview.
  wrapper?: string;
  // Releases the source (an open workspace file) after the import.
  close?: () => void;
  // Set when the source has more pages than one import may bring: the
  // preview counts them, nothing is converted (AFFiNE, #82).
  tooMany?: boolean;
  // The types of the pages' properties decided for the whole import, by
  // folded name (Obsidian: .obsidian/types.json and the values of all
  // notes, #598); a key without one is guessed from each value.
  propertyTypes?: PropertyHints;
  // Records one database of the import may have (default MAX_IMPORT_ROWS;
  // Anki decks are larger).
  maxRows?: number;
};

export const MAX_IMPORT_ROWS = 5000;

// Limits of one import (#82), the same for every importer (also the
// Markdown/Notion ZIP import, lib/zip-import.ts). An instance sets them with
// FLOWPLAN_IMPORT_MAX_DOCS (pages: documents, folders, databases,
// whiteboards, collections; records in database mode) and
// FLOWPLAN_IMPORT_MAX_FILES (images and attachments). Documents are
// converted one at a time and files read when written, so a high limit
// costs time, not memory.
export const IMPORT_DEFAULT_PAGES = 10000;
export const IMPORT_DEFAULT_FILES = 20000;
const IMPORT_HARD_MAX = 1_000_000;
// Folders below folders: deeper ones land at the level above.
export const MAX_IMPORT_DEPTH = 50;
function envCount(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? Math.min(n, IMPORT_HARD_MAX) : fallback;
}
export const maxImportPages = (raw = process.env.FLOWPLAN_IMPORT_MAX_DOCS) => envCount(raw, IMPORT_DEFAULT_PAGES);
export const maxImportFiles = (raw = process.env.FLOWPLAN_IMPORT_MAX_FILES) => envCount(raw, IMPORT_DEFAULT_FILES);
// Entries of a ZIP export: its documents and files.
export const maxImportEntries = () => Math.max(12000, maxImportPages() + maxImportFiles());
// The refusals name the count, the limit and the variable that raises it.
export const tooManyPages = (count: number, limit = maxImportPages()) =>
  `Die Datei ergibt ${count} Seiten; erlaubt sind höchstens ${limit} je Import (FLOWPLAN_IMPORT_MAX_DOCS).`;
export const tooManyRecords = (count: number, limit = maxImportPages()) =>
  `Die Datei ergibt ${count} Einträge; erlaubt sind höchstens ${limit} je Import (FLOWPLAN_IMPORT_MAX_DOCS).`;
export const tooManyFiles = (skipped: number, limit = maxImportFiles()) =>
  `${skipped} Dateien über der Grenze von ${limit} je Import werden nicht übernommen (FLOWPLAN_IMPORT_MAX_FILES).`;

// Collects warnings without repeating the same one a hundred times.
export function warningList() {
  const counts = new Map<string, number>();
  return {
    add(message: string) {
      counts.set(message, (counts.get(message) || 0) + 1);
    },
    list() {
      return [...counts].slice(0, 50).map(([message, n]) => (n > 1 ? `${message} (${n}×)` : message));
    },
  };
}

// Dates as YYYY-MM-DD from ISO strings or Evernote's 20260102T030405Z.
export function isoDate(value: string | undefined | null) {
  if (!value) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
