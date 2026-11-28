// Reading an import (lib/importers/index.ts parseImport) in a worker thread
// (lib/worker-pool.ts, #383): unpacking, converting Word, Evernote,
// Confluence and Obsidian pages and their Markdown/HTML is CPU work of
// seconds for a large archive. The tree crosses the thread as plain data:
// files with their bytes (or, from a ZIP on disk, their place in it), the
// import report as its entries and counts.
// Writing it stays on the request thread (one transaction, lib/importers/write.ts).
// A workspace file on disk (AFFiNE) is opened where it lies, on this thread.
import { closeSync, openSync, readSync } from "node:fs";
import { offThread, type PoolJobOptions } from "../worker-pool";
import { parseImport, type ParseOptions } from "./index";
import { isSqlite } from "./affine-read";
import { importFileData, importReport, zipImportFile, type ImportFile, type ImportReport, type ImportSource, type ImportTree, type ReportEntry, type ReportKind } from "./types";
import { lazyZipEntry, type ZipEntryRef } from "../zip-file";

// A file of a ZIP on disk (#673) crosses as its place in the ZIP and is
// read on this thread when it is written.
type PortableFile = { key: string; name: string; mime: string } & ({ data: Buffer } | { zip: ZipEntryRef });
export type PortableTree = Omit<ImportTree, "files" | "report" | "close"> & {
  files: Map<string, PortableFile>;
  report?: { entries: ReportEntry[]; counts: Partial<Record<ReportKind, number>> };
};

function portable(tree: ImportTree): PortableTree {
  const { files, report, close: _close, ...rest } = tree;
  return {
    ...rest,
    files: new Map(
      [...files].map(([key, file]) => [
        key,
        "zip" in file && file.zip ? { key: file.key, name: file.name, mime: file.mime, zip: file.zip } : { key: file.key, name: file.name, mime: file.mime, data: importFileData(file) },
      ]),
    ),
    ...(report ? { report: { entries: report.entries, counts: report.counts } } : {}),
  };
}
function revived(tree: PortableTree): ImportTree {
  const { report, files: portableFiles, ...rest } = tree;
  const files = new Map<string, ImportFile>(
    [...portableFiles].map(([key, file]) => [key, "zip" in file ? zipImportFile(file.key, file.name, file.mime, lazyZipEntry(file.zip)) : file]),
  );
  let rebuilt: ImportReport | undefined;
  if (report) {
    rebuilt = importReport();
    for (const entry of report.entries) rebuilt.add(entry.kind, entry.detail, entry.page, entry.row);
    for (const kind of Object.keys(rebuilt.counts) as ReportKind[]) delete rebuilt.counts[kind];
    Object.assign(rebuilt.counts, report.counts);
  }
  return { ...rest, files, ...(rebuilt ? { report: rebuilt } : {}) };
}

// The worker's job: the tree of an upload in memory or in a file.
export async function parseImportData(name: string, input: Uint8Array | { path: string }, chosen?: ImportSource | "auto", affine: ParseOptions = {}): Promise<PortableTree> {
  const source = input instanceof Uint8Array && !Buffer.isBuffer(input) ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : (input as Buffer | { path: string });
  const tree = await parseImport(name, source, chosen, affine);
  try {
    return portable(tree);
  } finally {
    tree.close?.();
  }
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

export async function parseImportOffThread(name: string, input: Buffer | { path: string }, chosen?: ImportSource | "auto", affine: ParseOptions = {}, job: PoolJobOptions = {}): Promise<ImportTree> {
  // An AFFiNE workspace file on disk is read page by page where it lies.
  if (!Buffer.isBuffer(input) && isSqlite(fileHead(input.path))) return await parseImport(name, input, chosen, affine);
  return revived(await offThread("import.parse", [name, input, chosen, affine], () => parseImportData(name, input, chosen, affine), job));
}
