// Large imports (#76): the size limit of /api/import/source and the upload
// kept on disk between the preview and the import.
//
// - The limit follows the largest upload of the person (Administration →
//   Grenzen & Aufbewahrung → "Größte Datei beim Hochladen", or their own
//   limit under Benutzer), but is never below 100 MB; FLOWPLAN_IMPORT_MAX_MB
//   replaces it for the whole instance. Only the AFFiNE workspace file is
//   read from disk; ZIP-based exports stay within the ZIP reader's 100 MB.
// - The upload is streamed (never buffered) into data/tmp/imports, one
//   folder per upload, named after the person, and kept after a preview so
//   the import does not upload it again. It is deleted after the import, on
//   "discard", and at the latest six hours later (swept on every upload).
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../auth";
import { maxUploadMbFor } from "../user-limits";
import type { Identity } from "../types";

export const IMPORT_MIN_MB = 100;
const MAX_ENV_MB = 20480;
const KEEP_MS = 6 * 3600e3;
const MB = 1024 * 1024;

// FLOWPLAN_IMPORT_MAX_MB as a number of MB (null: not set or invalid).
export function importEnvMb(raw = process.env.FLOWPLAN_IMPORT_MAX_MB): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_ENV_MB) : null;
}
// The limit in MB: the variable, else the person's largest upload, at
// least 100 MB.
export function importLimitMb(uploadMb: number, envMb = importEnvMb()) {
  return envMb ?? Math.max(IMPORT_MIN_MB, uploadMb);
}
export const importLimitFor = async (user: Pick<Identity, "id" | "isAdmin">) => importLimitMb(await maxUploadMbFor(user));
// The refusal names the limit and where it is changed.
export function importTooLarge(limitMb: number, envMb = importEnvMb()) {
  return new HttpError(
    413,
    envMb !== null
      ? `Die Datei darf höchstens ${limitMb} MB groß sein (FLOWPLAN_IMPORT_MAX_MB).`
      : `Die Datei darf höchstens ${limitMb} MB groß sein. Die Grenze folgt der größten Datei beim Hochladen (Administration → Grenzen & Aufbewahrung), mindestens 100 MB.`,
  );
}

const root = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp", "imports");
const owner = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 16);
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const folderOf = (userId: string, uploadId: string) => resolve(root(), `${owner(userId)}-${uploadId}`);

// Uploads older than six hours (an import that was never started).
export function sweepImportUploads(now = Date.now()) {
  let names: string[];
  try {
    names = readdirSync(root());
  } catch {
    return;
  }
  for (const name of names)
    try {
      if (now - statSync(resolve(root(), name)).mtimeMs > KEEP_MS) rmSync(resolve(root(), name), { recursive: true, force: true });
    } catch {
      /* gone meanwhile */
    }
}

// Streams the request body to disk, refusing more than maxBytes.
export async function saveImportUpload(userId: string, body: ReadableStream<Uint8Array>, maxBytes: number, tooLarge: () => HttpError) {
  sweepImportUploads();
  const id = randomUUID();
  const dir = folderOf(userId, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, "upload");
  let size = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) controller.error(tooLarge());
      else controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body.pipeThrough(limit) as never), createWriteStream(path, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error instanceof HttpError ? error : new HttpError(400, "Die Datei konnte nicht hochgeladen werden.");
  }
  if (!size) {
    rmSync(dir, { recursive: true, force: true });
    throw new HttpError(400, "Datei fehlt.");
  }
  return { id, path, size };
}

// An earlier upload of this person (after its preview).
export function importUploadPath(userId: string, uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) throw new HttpError(400, "Ungültige Eingabe.");
  const path = resolve(folderOf(userId, uploadId), "upload");
  if (!existsSync(path)) throw new HttpError(410, "Die hochgeladene Datei ist nicht mehr vorhanden. Bitte wähle sie erneut aus.");
  return path;
}
export function discardImportUpload(userId: string, uploadId: string) {
  if (UPLOAD_ID.test(uploadId)) rmSync(folderOf(userId, uploadId), { recursive: true, force: true });
}
export const importLimitBytes = (limitMb: number) => limitMb * MB;
