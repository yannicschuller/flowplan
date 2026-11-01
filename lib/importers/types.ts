// What every importer produces: a tree of pages with HTML that refers to
// files and other pages of the import through placeholders
// (lib/importers/html.ts fileRef/pageRef), plus the files themselves.
// Some sources bring more than documents (AFFiNE): whiteboards, databases
// and journal days are pages with a kind of their own.
import type { ImportedBoard } from "../whiteboard-import";
import type { Field, View } from "../types";

export type ImportSource = "affine" | "confluence" | "evernote" | "gdocs" | "obsidian";

export type ImportDatabase = {
  fields: Field[];
  views: View[];
  // Cells by field id; the HTML is the record's document.
  rows: { cells: Record<string, unknown>; html: string; created?: string }[];
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
  url?: string;
  // Not a document: a whiteboard (items may name pages of the import by
  // their pageRef placeholder) or a database. Both only in "pages" mode.
  kind?: "document" | "whiteboard" | "database";
  board?: ImportedBoard;
  database?: ImportDatabase;
  // A journal day (YYYY-MM-DD): written into that day of the workspace's
  // journal instead of becoming a page of its own; appended when the day
  // already exists.
  journalDate?: string;
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
  // Collections and similar pages the source adds (counted in the preview).
  collections?: number;
  // The page holding everything (AFFiNE: the workspace) when the import
  // has one; it is not counted as a folder in the preview.
  wrapper?: string;
  // Releases the source (an open workspace file) after the import.
  close?: () => void;
};

export const MAX_IMPORT_PAGES = 500;
export const MAX_IMPORT_ROWS = 5000;

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
