// Entries of a ZIP on disk, read when they are needed (#673): the ZIP
// imports from other tools (lib/archive.ts readZipFile) leave attachments
// where they are and inflate one only when it is written
// (lib/importers/write.ts) – never more than its stated size, and only with
// the stated size and checksum. An entry's place in the ZIP is plain data,
// so a file crosses the worker thread (lib/importers/parse-transfer.ts)
// without its bytes.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { constants as zlibConstants, crc32, inflateRawSync } from "node:zlib";
import { HttpError } from "./auth";

// Where an entry lies: its local header, sizes, method (0 stored,
// 8 deflated) and CRC-32, as the central directory states them.
export type ZipEntryRef = { path: string; offset: number; compressedSize: number; size: number; method: number; crc: number };
export type LazyZipEntry = { size: number; read: () => Buffer; head: () => Buffer; zip: ZipEntryRef };
// An entry's data: read already, or read when it is needed.
export type ZipData = Buffer | LazyZipEntry;
export const zipText = (data: ZipData) => (Buffer.isBuffer(data) ? data : data.read()).toString("utf8");

const damaged = () => new HttpError(400, "Beschädigtes ZIP-Archiv.");
// Where the entry's data begins (after its local header), checked against
// the file's size.
function entryStart(fd: number, ref: ZipEntryRef) {
  const header = Buffer.alloc(30);
  if (readSync(fd, header, 0, 30, ref.offset) !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw damaged();
  const start = ref.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + ref.compressedSize > fstatSync(fd).size) throw damaged();
  return start;
}
function readAt(fd: number, at: number, length: number) {
  const raw = Buffer.allocUnsafe(length);
  for (let done = 0; done < length; ) {
    const n = readSync(fd, raw, done, length - done, at + done);
    if (n <= 0) throw damaged();
    done += n;
  }
  return raw;
}

export function readZipEntrySync(ref: ZipEntryRef): Buffer {
  const fd = openSync(ref.path, "r");
  try {
    const raw = readAt(fd, entryStart(fd, ref), ref.compressedSize);
    let data: Buffer;
    if (ref.method === 0) data = raw;
    else
      try {
        // More than the stated size is a zip bomb: zlib stops there.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, ref.size) });
      } catch {
        throw new HttpError(413, "Entpacktes Archiv überschreitet das Größenlimit.");
      }
    if (data.length !== ref.size || crc32(data) >>> 0 !== ref.crc >>> 0) throw damaged();
    return data;
  } finally {
    closeSync(fd);
  }
}

// The first bytes of an entry (to check a file's type) without inflating
// all of it.
export function readZipEntryHead(ref: ZipEntryRef, bytes = 64): Buffer {
  const fd = openSync(ref.path, "r");
  try {
    const raw = readAt(fd, entryStart(fd, ref), Math.min(ref.compressedSize, ref.method === 0 ? bytes : 64 * 1024));
    if (ref.method === 0) return raw;
    try {
      return inflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: Math.max(1, Math.min(ref.size, 1024 * 1024)) }).subarray(0, bytes);
    } catch {
      return Buffer.alloc(0);
    }
  } finally {
    closeSync(fd);
  }
}

export const lazyZipEntry = (zip: ZipEntryRef): LazyZipEntry => ({ size: zip.size, read: () => readZipEntrySync(zip), head: () => readZipEntryHead(zip), zip });
