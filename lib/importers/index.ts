// Imports from other tools: AFFiNE (workspace file .affine or snapshot ZIP),
// Confluence (space export), Evernote (.enex), Google Docs (Takeout with
// .html or .docx), Microsoft Word (.docx, several in a ZIP) and Obsidian
// vaults. Older Word files (.doc) and OneNote are refused with what to do
// instead (lib/importers/word.ts). The file is
// read with the ZIP reader's limits, recognised (or taken as the source the
// person chose), turned into an import tree and then previewed or written.
// A large upload arrives as a file on disk (lib/importers/upload.ts): an
// AFFiNE workspace file is opened there in place; everything else is read
// into memory and therefore stays within the ZIP limit.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { posix } from "node:path";
import { ARCHIVE_LIMIT, readZip } from "../archive";
import { HttpError } from "../auth";
import { jobProgress } from "../background-jobs";
import { parseConfluence, isConfluence } from "./confluence";
import { parseAffine, type AffineOptions } from "./affine";
import { isSnapshotZip, isSqlite, readAffineFile, readSnapshotZip } from "./affine-read";
import { parseEnex } from "./evernote";
import { isGoogleTakeout, parseGoogleDocs, resolveDocx } from "./google-docs";
import { isObsidianVault, parseObsidian } from "./obsidian";
import { isWordArchive, parseWord, refuseLegacyOffice } from "./word";
import { previewImport, requireSpace, writeImport, type ImportMode, type ImportPreview, type ImportResult } from "./write";
import { maxImportEntries, type ImportSource, type ImportTree } from "./types";
import type { Identity } from "../types";

const importTitle = (name: string) => posix.basename(name.replaceAll("\\", "/")).replace(/\.(zip|enex|html?|docx|affine)$/i, "") || "Import";
const isZip = (bytes: Buffer) => bytes[0] === 0x50 && bytes[1] === 0x4b;

// The entries of a ZIP; a single folder around everything is dropped.
export async function zipEntries(bytes: Buffer, budget = { left: 512 * 1024 * 1024 }) {
  let entries = await readZip(bytes, { foreign: true, maxEntries: maxImportEntries(), budget });
  const names = [...entries.keys()];
  const tops = new Set(names.map((n) => n.split("/")[0]));
  if (tops.size === 1 && names.every((n) => n.includes("/"))) {
    const [top] = [...tops];
    entries = new Map([...entries].map(([n, d]) => [n.slice(top.length + 1), d]));
  }
  return entries;
}

export function detectSource(name: string, bytes: Buffer, entries?: Map<string, Buffer>): ImportSource | null {
  if (isSqlite(bytes)) return /\.(affine|db)$/i.test(name) || !entries ? "affine" : null;
  if (/\.enex$/i.test(name) || (!isZip(bytes) && /<en-export[\s>]/.test(bytes.subarray(0, 4096).toString("utf8")))) return "evernote";
  if (!entries) return /\.docx$/i.test(name) ? "word" : /\.html?$/i.test(name) ? "gdocs" : null;
  const names = [...entries.keys()];
  if (names.length && names.every((n) => /\.enex$/i.test(n))) return "evernote";
  if (names.includes("word/document.xml")) return "word";
  if (isSnapshotZip(entries)) return "affine";
  if (isConfluence(entries)) return "confluence";
  if (isObsidianVault(entries)) return "obsidian";
  if (isWordArchive(entries)) return "word";
  if (isGoogleTakeout(entries)) return "gdocs";
  return null;
}

// The first bytes of a file on disk (enough to recognise SQLite).
function fileHead(path: string) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(100);
    return head.subarray(0, readSync(fd, head, 0, 100, 0));
  } finally {
    closeSync(fd);
  }
}
// Files other than the AFFiNE workspace file are read into memory.
export const MEMORY_IMPORT_LIMIT = ARCHIVE_LIMIT;

export async function parseImport(name: string, input: Buffer | { path: string }, chosen?: ImportSource | "auto", affine: AffineOptions = {}): Promise<ImportTree> {
  if (!Buffer.isBuffer(input)) {
    const head = fileHead(input.path);
    refuseLegacyOffice(name, head);
    // The workspace file stays on disk, however large it is.
    if (isSqlite(head) && (!chosen || chosen === "auto" || chosen === "affine")) {
      const ws = readAffineFile(input.path, importTitle(name));
      try {
        return parseAffine(ws, importTitle(name), affine);
      } catch (error) {
        ws.close?.();
        throw error;
      }
    }
    if (statSync(input.path).size > MEMORY_IMPORT_LIMIT)
      throw new HttpError(413, "ZIP- und andere Exporte dürfen höchstens 100 MB groß sein; größer darf nur die AFFiNE-Arbeitsbereichsdatei (.affine) sein.");
    input = readFileSync(input.path);
  }
  const bytes = input;
  refuseLegacyOffice(name, bytes);
  const budget = { left: 512 * 1024 * 1024 };
  const zipped = isZip(bytes);
  const entries = zipped ? await zipEntries(bytes, budget) : undefined;
  const source = chosen && chosen !== "auto" ? chosen : detectSource(name, bytes, entries);
  if (!source) throw new HttpError(400, "Das Format der Datei wurde nicht erkannt.");
  const title = importTitle(name);
  switch (source) {
    case "affine":
      // The workspace file (SQLite) or a snapshot ZIP ("Export → Snapshot").
      if (isSqlite(bytes)) return parseAffine(readAffineFile(bytes, title), title, affine);
      if (!entries || !isSnapshotZip(entries)) throw new HttpError(400, "Bitte die AFFiNE-Arbeitsbereichsdatei (.affine) oder einen Snapshot-Export (ZIP) hochladen.");
      return parseAffine(readSnapshotZip(entries, title), title, affine);
    case "evernote": {
      const files = entries
        ? [...entries].filter(([n]) => /\.enex$/i.test(n)).map(([n, data]) => ({ name: n, xml: data.toString("utf8") }))
        : [{ name, xml: bytes.toString("utf8") }];
      if (!files.length) throw new HttpError(400, "Keine Evernote-Datei (.enex) gefunden.");
      return parseEnex(files);
    }
    case "confluence":
      if (!entries) throw new HttpError(400, "Bitte den Confluence-Export als ZIP hochladen.");
      return parseConfluence(entries);
    case "obsidian":
      if (!entries) throw new HttpError(400, "Bitte den Obsidian-Tresor als ZIP hochladen.");
      return parseObsidian(entries, title);
    case "gdocs": {
      // A single document (Word file or HTML) or a Takeout archive.
      const docEntries =
        entries && !entries.has("word/document.xml") ? entries : new Map([[posix.basename(name) || "dokument.docx", bytes]]);
      return resolveDocx(parseGoogleDocs(docEntries, title), docEntries, budget);
    }
    case "word": {
      // A single document or a ZIP of them (folders become parent pages);
      // a .docx is a ZIP itself.
      if (!entries) throw new HttpError(400, "Bitte eine Word-Datei (.docx) oder ein ZIP mit Word-Dateien hochladen.");
      const single = posix.basename(name.replaceAll("\\", "/")).replace(/\.docx$/i, "") || "dokument";
      const docEntries = entries.has("word/document.xml") ? new Map([[`${single}.docx`, bytes]]) : entries;
      return resolveDocx(parseWord(docEntries, title), docEntries, budget);
    }
  }
}

type ImportOptions = {
  source?: ImportSource | "auto";
  mode?: ImportMode;
  dryRun?: boolean;
  // AFFiNE (#167): documents with exactly one document linking to them go
  // below it; on unless false (pages only – a database has no page tree).
  nestLinked?: boolean;
};
// The upload: its bytes, or (large files) its path on disk.
type ImportFile = { name: string; bytes: Buffer } | { name: string; path: string };
export async function importFromSource(user: Identity, workspaceId: string, spaceId: string, file: ImportFile, options: ImportOptions & { dryRun: true }): Promise<ImportPreview>;
export async function importFromSource(user: Identity, workspaceId: string, spaceId: string, file: ImportFile, options?: ImportOptions & { dryRun?: false }): Promise<ImportResult>;
export async function importFromSource(user: Identity, workspaceId: string, spaceId: string, file: ImportFile, options?: ImportOptions): Promise<ImportPreview | ImportResult>;
export async function importFromSource(
  user: Identity,
  workspaceId: string,
  spaceId: string,
  file: ImportFile,
  options: ImportOptions = {},
): Promise<ImportPreview | ImportResult> {
  // Rights first: reading a large archive costs time.
  await requireSpace(user, workspaceId, spaceId);
  const tree = await parseImport(file.name, "bytes" in file ? file.bytes : { path: file.path }, options.source, {
    nestLinked: options.nestLinked !== false && options.mode !== "database",
  });
  try {
    // Reading is about half of the work (Live Activity, lib/background-jobs.ts).
    await jobProgress(0.5);
    // A turn of the event loop between reading and writing (#163): the page
    // that waits for a background import sees the progress, and what the
    // reading held only for its own task can go.
    await new Promise((resolve) => setImmediate(resolve));
    return options.dryRun
      ? (await previewImport(user, workspaceId, spaceId, tree, options.mode))
      : (await writeImport(user, workspaceId, spaceId, tree, options.mode));
  } finally {
    tree.close?.();
  }
}
