// A streaming multipart/form-data reader for large uploads (POST
// /api/upload, up to 10 GB per file). Request.formData() reads the whole
// body into memory before anything else happens; this reads it chunk by
// chunk instead: the text fields are kept (small, limited), the one file
// part goes straight to a temporary file next to the uploads folder, so the
// memory stays flat whatever the file's size. Only the first bytes of the
// file are kept in memory (`head`), for the type checks.
//
// The temporary file lives in <uploads>/.incoming (the same file system as
// the uploads folder, so the stored file is moved, never copied; a name
// with a dot is never taken for a stored file). The caller moves it into
// place or calls discard(); leftovers of a process that ended meanwhile are
// removed after a day (sweepIncoming, on every upload).
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { HttpError } from "./auth";

export type StreamedFile = {
  field: string;
  name: string;
  type: string;
  path: string;
  size: number;
  // The first HEAD_BYTES of the file.
  head: Buffer;
};
export type StreamedForm = {
  fields: Map<string, string>;
  file: StreamedFile | null;
  // Removes the temporary file (no-op once it was moved away).
  discard(): void;
};

export const HEAD_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_FIELDS = 50;
const KEEP_INCOMING_MS = 24 * 3600e3;

export const incomingDir = (uploads: string) => resolve(uploads, ".incoming");

// Temporary files older than a day (a process that ended mid-upload).
export function sweepIncoming(uploads: string, now = Date.now()) {
  const dir = incomingDir(uploads);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names)
    try {
      if (now - statSync(resolve(dir, name)).mtimeMs > KEEP_INCOMING_MS) rmSync(resolve(dir, name), { force: true });
    } catch {
      /* gone meanwhile */
    }
}

export function multipartBoundary(contentType: string | null): string | null {
  const type = contentType || "";
  if (!/^multipart\/form-data\s*;/i.test(type)) return null;
  const match = type.match(/;\s*boundary=(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i);
  return match ? (match[1] ?? match[2]) : null;
}

// The parameters of a Content-Disposition header: name, filename and
// filename* (RFC 5987, preferred when given).
function disposition(value: string) {
  const params = new Map<string, string>();
  const re = /;\s*([A-Za-z0-9_*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (let m; (m = re.exec(value)); ) params.set(m[1].toLowerCase(), m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim());
  let filename = params.get("filename");
  const extended = params.get("filename*")?.match(/^utf-8''(.*)$/i);
  if (extended)
    try {
      filename = decodeURIComponent(extended[1]);
    } catch {}
  return { name: params.get("name") ?? null, filename: filename ?? null };
}

type Options = {
  // Where the uploads folder is; the temporary file goes below it.
  uploads: string;
  // The largest file accepted; beyond it `tooLarge()` is thrown.
  maxFileBytes: number;
  tooLarge: () => Error;
  // The field that carries the file (other file parts are refused).
  fileField?: string;
  // Runs with the fields read so far when the file starts (a refusal there
  // stops the upload before the file is read).
  beforeFile?: (fields: Map<string, string>) => Promise<void>;
};

/** Reads a multipart/form-data body without holding the file in memory. */
export async function readMultipartStream(body: ReadableStream<Uint8Array> | null, contentType: string | null, options: Options): Promise<StreamedForm> {
  const boundary = multipartBoundary(contentType);
  if (!boundary || !body) throw new HttpError(400, "Ungültige Eingabe.");
  const fileField = options.fileField ?? "file";
  // The body starts with "--boundary"; every later one follows a CRLF.
  const delimiter = Buffer.from(`\r\n--${boundary}`, "latin1");
  const fields = new Map<string, string>();
  let file: StreamedFile | null = null;
  let path: string | null = null;
  let handle: FileHandle | null = null;
  const discard = () => {
    if (path) rmSync(path, { force: true });
  };

  type State = "preamble" | "after" | "headers" | "body" | "done";
  let state = "preamble" as State;
  let buffer: Buffer = Buffer.from("\r\n", "latin1");
  let part: { name: string; filename: string | null; type: string } | null = null;
  let fieldChunks: Buffer[] = [];
  let fieldBytes = 0;
  let headBytes: Buffer[] = [];
  let headSize = 0;
  // Writes of the file part are gathered into blocks of about 1 MB.
  let pending: Buffer[] = [];
  let pendingSize = 0;
  const flush = async () => {
    if (!handle || !pendingSize) return;
    const block = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingSize);
    pending = [];
    pendingSize = 0;
    await handle.write(block);
  };

  const emit = async (data: Buffer) => {
    if (!data.length || !part) return;
    if (part.filename === null) {
      fieldBytes += data.length;
      if (fieldBytes > MAX_FIELD_BYTES) throw new HttpError(413, "Anfrage zu groß.");
      fieldChunks.push(Buffer.from(data));
      return;
    }
    if (!file) return;
    file.size += data.length;
    if (file.size > options.maxFileBytes) throw options.tooLarge();
    if (headSize < HEAD_BYTES) {
      const take = data.subarray(0, HEAD_BYTES - headSize);
      headBytes.push(Buffer.from(take));
      headSize += take.length;
    }
    // The parser's buffer is a new one every round: no copy needed.
    pending.push(data);
    pendingSize += data.length;
    if (pendingSize >= 1024 * 1024) await flush();
  };
  const startPart = async (headerText: string) => {
    let name: string | null = null,
      filename: string | null = null,
      type = "";
    for (const line of headerText.split("\r\n")) {
      const at = line.indexOf(":");
      if (at < 0) continue;
      const key = line.slice(0, at).trim().toLowerCase(),
        value = line.slice(at + 1).trim();
      if (key === "content-disposition") ({ name, filename } = disposition(value));
      else if (key === "content-type") type = value.slice(0, 200);
    }
    if (name === null) throw new HttpError(400, "Ungültige Eingabe.");
    part = { name, filename, type };
    fieldChunks = [];
    fieldBytes = 0;
    if (filename === null) {
      if (fields.size >= MAX_FIELDS) throw new HttpError(413, "Anfrage zu groß.");
      return;
    }
    // One file, in the expected field.
    if (name !== fileField || file) throw new HttpError(400, "Ungültige Eingabe.");
    await options.beforeFile?.(fields);
    const dir = incomingDir(options.uploads);
    mkdirSync(dir, { recursive: true });
    path = resolve(dir, `${randomBytes(12).toString("hex")}.upload`);
    handle = await open(path, "wx", 0o600);
    file = { field: name, name: filename, type, path, size: 0, head: Buffer.alloc(0) };
  };
  const endPart = async () => {
    if (!part) return;
    if (part.filename === null) {
      if (!fields.has(part.name)) fields.set(part.name, Buffer.concat(fieldChunks).toString("utf8"));
    } else if (file) {
      await flush();
      await handle!.close();
      handle = null;
      file.head = Buffer.concat(headBytes);
      headBytes = [];
    }
    part = null;
  };

  // One step over the buffer: false when more data is needed.
  const step = async (): Promise<boolean> => {
    switch (state) {
      case "preamble": {
        const at = buffer.indexOf(delimiter);
        if (at < 0) {
          // Nothing before the first boundary is kept.
          buffer = buffer.subarray(Math.max(0, buffer.length - delimiter.length + 1));
          return false;
        }
        buffer = buffer.subarray(at + delimiter.length);
        state = "after";
        return true;
      }
      case "after": {
        if (buffer.length < 2) return false;
        const two = buffer.subarray(0, 2).toString("latin1");
        if (two === "--") {
          state = "done";
          return false;
        }
        // Transport padding after the boundary, then CRLF.
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) {
          if (buffer.length > 256) throw new HttpError(400, "Ungültige Eingabe.");
          return false;
        }
        if (buffer.subarray(0, eol).toString("latin1").trim()) throw new HttpError(400, "Ungültige Eingabe.");
        buffer = buffer.subarray(eol + 2);
        state = "headers";
        return true;
      }
      case "headers": {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > MAX_HEADER_BYTES) throw new HttpError(400, "Ungültige Eingabe.");
          return false;
        }
        await startPart(buffer.subarray(0, end).toString("utf8"));
        buffer = buffer.subarray(end + 4);
        state = "body";
        return true;
      }
      case "body": {
        const at = buffer.indexOf(delimiter);
        if (at < 0) {
          // Everything but a possible start of the delimiter.
          const safe = Math.max(0, buffer.length - delimiter.length + 1);
          await emit(buffer.subarray(0, safe));
          buffer = buffer.subarray(safe);
          return false;
        }
        await emit(buffer.subarray(0, at));
        await endPart();
        buffer = buffer.subarray(at + delimiter.length);
        state = "after";
        return true;
      }
      default:
        return false;
    }
  };

  try {
    for await (const chunk of Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>)) {
      if (state === "done") continue;
      buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : Buffer.from(chunk as Uint8Array);
      while (await step());
    }
    if (state !== "done") throw new HttpError(400, "Ungültige Eingabe.");
  } catch (error) {
    if (handle) await (handle as FileHandle).close().catch(() => {});
    discard();
    throw error;
  }
  return { fields, file, discard };
}
