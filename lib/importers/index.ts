// Imports from other tools: Confluence (space export), Evernote (.enex),
// Google Docs (Takeout with .html or .docx) and Obsidian vaults. The file is
// read with the ZIP reader's limits, recognised (or taken as the source the
// person chose), turned into an import tree and then previewed or written.
import { posix } from "node:path";
import { readZip } from "../archive";
import { HttpError } from "../auth";
import { jobProgress } from "../background-jobs";
import { parseConfluence, isConfluence } from "./confluence";
import { parseEnex } from "./evernote";
import { isGoogleTakeout, parseGoogleDocs, resolveDocx } from "./google-docs";
import { isObsidianVault, parseObsidian } from "./obsidian";
import { previewImport, requireSpace, writeImport, type ImportMode, type ImportPreview, type ImportResult } from "./write";
import type { ImportSource, ImportTree } from "./types";
import type { Identity } from "../types";

export const IMPORT_SOURCES: ImportSource[] = ["confluence", "evernote", "gdocs", "obsidian"];
const isZip = (bytes: Buffer) => bytes[0] === 0x50 && bytes[1] === 0x4b;

// The entries of a ZIP; a single folder around everything is dropped.
export async function zipEntries(bytes: Buffer, budget = { left: 512 * 1024 * 1024 }) {
  let entries = await readZip(bytes, { foreign: true, maxEntries: 12000, budget });
  const names = [...entries.keys()];
  const tops = new Set(names.map((n) => n.split("/")[0]));
  if (tops.size === 1 && names.every((n) => n.includes("/"))) {
    const [top] = [...tops];
    entries = new Map([...entries].map(([n, d]) => [n.slice(top.length + 1), d]));
  }
  return entries;
}

export function detectSource(name: string, bytes: Buffer, entries?: Map<string, Buffer>): ImportSource | null {
  if (/\.enex$/i.test(name) || (!isZip(bytes) && /<en-export[\s>]/.test(bytes.subarray(0, 4096).toString("utf8")))) return "evernote";
  if (!entries) return /\.(docx|html?)$/i.test(name) ? "gdocs" : null;
  const names = [...entries.keys()];
  if (names.length && names.every((n) => /\.enex$/i.test(n))) return "evernote";
  if (names.includes("word/document.xml")) return "gdocs";
  if (isConfluence(entries)) return "confluence";
  if (isObsidianVault(entries)) return "obsidian";
  if (isGoogleTakeout(entries)) return "gdocs";
  return null;
}

export async function parseImport(name: string, bytes: Buffer, chosen?: ImportSource | "auto"): Promise<ImportTree> {
  const budget = { left: 512 * 1024 * 1024 };
  const zipped = isZip(bytes);
  const entries = zipped ? await zipEntries(bytes, budget) : undefined;
  const source = chosen && chosen !== "auto" ? chosen : detectSource(name, bytes, entries);
  if (!source) throw new HttpError(400, "Das Format der Datei wurde nicht erkannt.");
  const title = posix.basename(name.replaceAll("\\", "/")).replace(/\.(zip|enex|html?|docx)$/i, "") || "Import";
  switch (source) {
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
  }
}

type ImportOptions = { source?: ImportSource | "auto"; mode?: ImportMode; dryRun?: boolean };
type ImportFile = { name: string; bytes: Buffer };
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
  requireSpace(user, workspaceId, spaceId);
  const tree = await parseImport(file.name, file.bytes, options.source);
  // Reading is about half of the work (Live Activity, lib/background-jobs.ts).
  jobProgress(0.5);
  return options.dryRun
    ? previewImport(user, workspaceId, spaceId, tree, options.mode)
    : writeImport(user, workspaceId, spaceId, tree, options.mode);
}
