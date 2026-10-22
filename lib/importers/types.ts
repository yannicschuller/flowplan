// What every importer produces: a tree of pages with HTML that refers to
// files and other pages of the import through placeholders
// (lib/importers/html.ts fileRef/pageRef), plus the files themselves.
export type ImportSource = "confluence" | "evernote" | "gdocs" | "obsidian";

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
};
export type ImportFile = { key: string; name: string; mime: string; data: Buffer };
export type ImportTree = {
  source: ImportSource;
  title: string;
  pages: ImportPage[];
  files: Map<string, ImportFile>;
  warnings: string[];
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
