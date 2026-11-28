// Large imports (#76): the size limit of /api/import/source and the upload
// kept on disk between the preview and the import.
//
// - The limit follows the largest upload of the person (Administration →
//   Grenzen & Aufbewahrung → "Größte Datei beim Hochladen", or their own
//   limit under Benutzer), but is never below 100 MB; FLOWPLAN_IMPORT_MAX_MB
//   replaces it for the whole instance. The AFFiNE workspace file and
//   Obsidian and Confluence ZIPs (#673) are read from disk; other
//   ZIP-based exports stay within the ZIP reader's 100 MB.
// - The upload is streamed (never buffered) into data/tmp/imports, one
//   folder per upload, named after the person, and kept after a preview so
//   the import does not upload it again. It is deleted after the import, on
//   "discard", and at the latest six hours later (swept on every upload).
import { IN_MEMORY_FILE_MB } from "../upload-limit";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { staging, stagingInBucket } from "../staging";
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
// least 100 MB and at most 1 GB (IN_MEMORY_FILE_MB, the former maximum of
// uploads: the importers read parts of the file into memory).
export function importLimitMb(uploadMb: number, envMb = importEnvMb()) {
  return envMb ?? Math.max(IMPORT_MIN_MB, Math.min(IN_MEMORY_FILE_MB, uploadMb));
}
export const importLimitFor = async (user: Pick<Identity, "id" | "isAdmin">) => importLimitMb(await maxUploadMbFor(user));
// The refusal names the limit and where it is changed.
export function importTooLarge(limitMb: number, envMb = importEnvMb()) {
  return new HttpError(
    413,
    envMb !== null
      ? `Die Datei darf höchstens ${limitMb} MB groß sein (FLOWPLAN_IMPORT_MAX_MB).`
      : `Die Datei darf höchstens ${limitMb} MB groß sein. Die Grenze folgt der größten Datei beim Hochladen (Einstellungen → Instanz → Grenzen & Aufbewahrung), mindestens 100 MB.`,
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
  void sweepStagedImports().catch(() => {});
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
  // Cluster mode: the import after the preview may reach another instance –
  // the file also goes into the bucket's staging, in parts (lib/staging.ts).
  if (stagingInBucket())
    try {
      await stageInBucket(`${owner(userId)}-${id}`, path);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      await staging("imports").remove(`${owner(userId)}-${id}`);
      console.error("Import: Datei nicht im Bucket abgelegt", (error as Error)?.message || error);
      throw new HttpError(503, "Die Datei konnte nicht zwischengespeichert werden (Objektspeicher nicht erreichbar). Bitte versuche es gleich noch einmal.");
    }
  return { id, path, size };
}

// Parts of 16 MB: each is sealed (encrypted) on its own.
const PART_BYTES = 16 * MB;
async function stageInBucket(folder: string, path: string) {
  const parts = staging("imports");
  let index = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    await parts.put(`${folder}/${String(index++).padStart(6, "0")}`, Buffer.concat(pending));
    pending = [];
    pendingBytes = 0;
  };
  for await (const chunk of createReadStream(path, { highWaterMark: MB })) {
    pending.push(chunk as Buffer);
    pendingBytes += (chunk as Buffer).length;
    if (pendingBytes >= PART_BYTES) await flush();
  }
  await flush();
  await parts.put(`${folder}/done`, Buffer.from(String(index)));
}

// An earlier upload of this person (after its preview).
export function importUploadPath(userId: string, uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) throw new HttpError(400, "Ungültige Eingabe.");
  const path = resolve(folderOf(userId, uploadId), "upload");
  if (!existsSync(path)) throw new HttpError(410, "Die hochgeladene Datei ist nicht mehr vorhanden. Bitte wähle sie erneut aus.");
  return path;
}
// The same, fetched from the bucket's staging first when the preview ran
// on another instance (cluster mode).
export async function importUploadFile(userId: string, uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) throw new HttpError(400, "Ungültige Eingabe.");
  const path = resolve(folderOf(userId, uploadId), "upload");
  if (existsSync(path) || !stagingInBucket()) return importUploadPath(userId, uploadId);
  const parts = staging("imports");
  const folder = `${owner(userId)}-${uploadId}`;
  const count = Number(String((await parts.get(`${folder}/done`)) ?? ""));
  if (!Number.isInteger(count) || count < 1) throw new HttpError(410, "Die hochgeladene Datei ist nicht mehr vorhanden. Bitte wähle sie erneut aus.");
  mkdirSync(folderOf(userId, uploadId), { recursive: true, mode: 0o700 });
  const partial = `${path}.part`;
  const out = createWriteStream(partial, { mode: 0o600 });
  try {
    for (let i = 0; i < count; i++) {
      const data = await parts.get(`${folder}/${String(i).padStart(6, "0")}`);
      if (!data) throw new HttpError(410, "Die hochgeladene Datei ist nicht mehr vorhanden. Bitte wähle sie erneut aus.");
      if (!out.write(data)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
  } catch (error) {
    out.destroy();
    rmSync(folderOf(userId, uploadId), { recursive: true, force: true });
    throw error;
  }
  renameSync(partial, path);
  return path;
}
export function discardImportUpload(userId: string, uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) return;
  rmSync(folderOf(userId, uploadId), { recursive: true, force: true });
  if (stagingInBucket()) void staging("imports").remove(`${owner(userId)}-${uploadId}`).catch(() => {});
}
// Cluster mode: the bucket's staged imports older than six hours (looked
// at with every upload, at most every ten minutes per instance).
const swept = globalThis as unknown as { flowplanImportSweep?: number };
export async function sweepStagedImports(now = Date.now()) {
  if (!stagingInBucket() || now - (swept.flowplanImportSweep ?? 0) < 10 * 60_000) return;
  swept.flowplanImportSweep = now;
  for (const folder of await staging("imports").folders("").catch(() => []))
    if (now - folder.at > KEEP_MS) await staging("imports").remove(folder.name);
}
export const importLimitBytes = (limitMb: number) => limitMb * MB;
