// Audio recordings of a notebook (like GoodNotes or Notability): the
// browser records with MediaRecorder (Opus in WebM/Ogg, AAC in MP4 on
// Safari), keeps the pieces in IndexedDB until the server has them and
// uploads them in chunks while recording and at the end
// (components/notebook/notebook-audio.tsx). Ink written meanwhile carries
// the recording's id and the moment (`rec`, lib/ink/model.ts), so playback
// shows it as it was written.
//
//   notebook_recordings(page_id, id, file_id, name, duration_ms, created_by, created_at, transcript)
//
// A recording is an uploaded file of the notebook page (files): it counts
// against the workspace quota and the person's storage, is served by
// /api/files/{id} (range requests for seeking), is listed in the media
// library, goes into the trash when deleted (restoring the file there
// brings the recording back), goes with the notebook (trash, deletion) and
// along with its files into copies, archives and exports.
//
// Rights: readers of the notebook list and play recordings (journals behind
// a PIN only when unlocked); editors add, rename and delete them – not on
// locked pages, never in encrypted spaces (the server would see the audio).
//
// Upload: POST …/recordings?upload=<id>&offset=<n>&type=<mime> with the raw
// bytes (at most RECORDING_CHUNK_BYTES) appends to a staging file under
// data/tmp/notebook-audio/<id>; a repeated chunk is ignored, so a retry or a
// resumed upload after a reload simply goes on from the size the server
// reports (GET …?upload=<id>). "finish" checks length, size and type, gives
// a WebM file its duration (lib/webm-duration.ts), and stores it as a file
// together with the recording – in one transaction with the quota checks.
// Staging files nobody finished are removed after a week.
//
// Transcription is not part of this (the maintainer chose none); the hook
// for it is `transcript` (JSON, null until something fills it) and
// `saveRecordingTranscript` below.
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { all, audit, id, nowText, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { enforceQuota, workspaceBytes, workspaceQuotaMb } from "./instance-ops";
import { effectiveUserLimits, enforceUserStorage, userBytes } from "./user-limits";
import { recordingMime, sanitizeFileName } from "./upload-safety";
import { webmDurationPatch } from "./webm-duration";
import {
  cleanRecordingName,
  recordingExt,
  RECORDING_CHUNK_BYTES,
  RECORDING_GRACE_MS,
  RECORDING_MAX_BYTES,
  RECORDING_MAX_BYTES_PER_SECOND,
  RECORDING_MAX_MS,
  type NotebookRecording,
} from "./ink/audio-sync";
import type { Identity, Page } from "./types";

export { RECORDING_CHUNK_BYTES, RECORDING_MAX_BYTES, RECORDING_MAX_MS };
export const STAGING_TTL_MS = 7 * 24 * 60 * 60_000;
// Unfinished uploads one person may have at a time.
const MAX_STAGED_PER_USER = 3;
const RECORDING_ID = z.uuid();
const MB = 1024 * 1024;

const dataDir = () => process.env.FLOWPLAN_DATA_DIR || "./data";
const stagingRoot = () => resolve(dataDir(), "tmp", "notebook-audio");
const stagingDir = (recId: string) => resolve(stagingRoot(), recId);
const stagingData = (recId: string) => resolve(stagingDir(recId), "audio");
const stagingMeta = (recId: string) => resolve(stagingDir(recId), "meta.json");
type StagingMeta = { userId: string; pageId: string; mime: string; at: number };

// ---- Pages and rights ----

async function notebookPage(user: Identity, pageId: string, write: boolean): Promise<Page> {
  const page = await requirePage(user, pageId, write);
  await requireUnlocked(user, page);
  if (page.kind !== "notebook") throw new HttpError(400, "Kein Notizbuch.");
  if (write) {
    if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
    if (await isEncryptedPage(page)) throw new HttpError(409, "Für verschlüsselte Seiten nicht verfügbar.");
  }
  return page;
}
async function mayRecord(user: Identity, page: Page) {
  if (page.locked || user.apiScope === "read" || (await isEncryptedPage(page))) return false;
  try {
    await requirePage(user, page.id, true);
    return true;
  } catch {
    return false;
  }
}

// The bytes this person may still store in the notebook's workspace: the
// smaller of what the workspace quota and the person's storage leave, null
// when neither is limited.
export async function recordingRoom(user: Identity, page: Pick<Page, "workspace_id">): Promise<number | null> {
  const limits: number[] = [];
  const quota = await workspaceQuotaMb(page.workspace_id);
  if (quota) limits.push(quota * MB - (await workspaceBytes(page.workspace_id)));
  if (!user.isAdmin) {
    const { storageMb } = await effectiveUserLimits(user.id);
    if (storageMb) limits.push(storageMb * MB - (await userBytes(user.id)));
  }
  return limits.length ? Math.max(0, Math.min(...limits)) : null;
}

// ---- Listing ----

type RecordingRow = { id: string; file_id: string; name: string; duration_ms: number; created_by: string | null; created_at: number; mime: string; size: number; by_name: string | null };
const RECORDING_SELECT = `SELECT r.id,r.file_id,r.name,r.duration_ms,r.created_by,r.created_at,f.mime,f.size,u.name by_name
  FROM notebook_recordings r JOIN files f ON f.id=r.file_id LEFT JOIN users u ON u.id=r.created_by`;
const toRecording = (r: RecordingRow): NotebookRecording => ({
  id: r.id,
  fileId: r.file_id,
  name: r.name,
  mime: r.mime,
  size: Number(r.size) || 0,
  durationMs: Number(r.duration_ms) || 0,
  createdAt: Number(r.created_at) || 0,
  createdBy: r.created_by,
  createdByName: r.by_name,
});
// The recordings of a notebook, oldest first; files in the trash are left out.
export async function notebookRecordings(pageId: string): Promise<NotebookRecording[]> {
  return (await all<RecordingRow>(`${RECORDING_SELECT} WHERE r.page_id=? AND f.deleted_at IS NULL ORDER BY r.created_at,r.id`, pageId)).map(toRecording);
}
async function recordingOf(pageId: string, recId: string) {
  const row = await one<RecordingRow>(`${RECORDING_SELECT} WHERE r.page_id=? AND r.id=? AND f.deleted_at IS NULL`, pageId, recId);
  return row ? toRecording(row) : null;
}

export async function listRecordings(user: Identity, pageId: string) {
  const page = await notebookPage(user, pageId, false);
  const canEdit = await mayRecord(user, page);
  return {
    recordings: await notebookRecordings(page.id),
    canEdit,
    // Checked before a recording starts (and again by every chunk and at the end).
    room: canEdit ? await recordingRoom(user, page) : null,
    maxMs: RECORDING_MAX_MS,
    maxBytes: RECORDING_MAX_BYTES,
    chunkBytes: RECORDING_CHUNK_BYTES,
  };
}

// ---- Staging (chunked upload) ----

// Chunks of one upload take turns (a retry may overlap the request it repeats).
const runtime = globalThis as typeof globalThis & { flowplanRecordingQueues?: Map<string, Promise<unknown>>; flowplanRecordingSweep?: number };
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const queues = (runtime.flowplanRecordingQueues ??= new Map());
  const before = queues.get(key) || Promise.resolve();
  const next = before.catch(() => {}).then(fn);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
async function readMeta(recId: string): Promise<StagingMeta | null> {
  try {
    const meta = JSON.parse(await readFile(stagingMeta(recId), "utf8"));
    return meta && typeof meta.userId === "string" && typeof meta.pageId === "string" && typeof meta.mime === "string" ? meta : null;
  } catch {
    return null;
  }
}
const stagedBytes = async (recId: string) => {
  try {
    return (await stat(stagingData(recId))).size;
  } catch {
    return 0;
  }
};
// Removes uploads nobody finished within a week (at most every ten minutes).
export async function sweepRecordingUploads(now = Date.now(), force = false) {
  if (!force && runtime.flowplanRecordingSweep && now - runtime.flowplanRecordingSweep < 10 * 60_000) return;
  runtime.flowplanRecordingSweep = now;
  let names: string[] = [];
  try {
    names = await readdir(stagingRoot());
  } catch {
    return;
  }
  for (const name of names) {
    const meta = await readMeta(name);
    let at = meta?.at ?? 0;
    try {
      at = Math.max(at, (await stat(stagingDir(name))).mtimeMs);
    } catch {}
    if (now - at > STAGING_TTL_MS) await rm(stagingDir(name), { recursive: true, force: true }).catch(() => {});
  }
}
async function stagedByUser(userId: string) {
  let names: string[] = [];
  try {
    names = await readdir(stagingRoot());
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) if ((await readMeta(name))?.userId === userId) n++;
  return n;
}
function ownStaging(meta: StagingMeta | null, user: Identity, pageId: string) {
  if (meta && (meta.userId !== user.id || meta.pageId !== pageId)) throw new HttpError(403, "Keine Berechtigung.");
  return meta;
}

// How much of an upload the server has, and whether it is finished.
export async function recordingUploadStatus(user: Identity, pageId: string, recId: string) {
  const page = await notebookPage(user, pageId, true);
  const rid = RECORDING_ID.parse(recId);
  const done = await recordingOf(page.id, rid);
  if (done) return { size: done.size, finished: true, recording: done };
  ownStaging(await readMeta(rid), user, page.id);
  return { size: await stagedBytes(rid), finished: false };
}

// One chunk at `offset`. The first one (offset 0) names the type, which the
// content must match; later ones continue the file. A chunk the server has
// already is ignored; one past the end is refused with the size it has.
export async function storeRecordingChunk(user: Identity, pageId: string, input: { recId: string; offset: number; type: string }, bytes: Uint8Array) {
  const page = await notebookPage(user, pageId, true);
  const rid = RECORDING_ID.parse(input.recId);
  const offset = z.number().int().min(0).max(RECORDING_MAX_BYTES).parse(input.offset);
  if (!bytes.length) throw new HttpError(400, "Ungültige Eingabe.");
  if (bytes.length > RECORDING_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
  await sweepRecordingUploads();
  return await serial(rid, async () => {
    if (await recordingOf(page.id, rid)) throw new HttpError(409, "Die Aufnahme ist bereits gespeichert.");
    let meta = ownStaging(await readMeta(rid), user, page.id);
    if (!meta) {
      if (offset !== 0) throw new HttpError(409, "Die Aufnahme ist unvollständig.");
      const mime = recordingMime(input.type, Buffer.from(bytes.subarray(0, 64)));
      if (!mime) throw new HttpError(415, "Dieses Audioformat wird nicht unterstützt.");
      if ((await stagedByUser(user.id)) >= MAX_STAGED_PER_USER) throw new HttpError(429, "Zu viele Aufnahmen gleichzeitig. Bitte später erneut versuchen.");
      meta = { userId: user.id, pageId: page.id, mime, at: Date.now() };
      await mkdir(stagingDir(rid), { recursive: true });
      await writeFile(stagingMeta(rid), JSON.stringify(meta));
    }
    const size = await stagedBytes(rid);
    if (offset > size) throw new HttpError(409, "Die Aufnahme ist unvollständig.");
    const total = offset + bytes.length;
    if (total <= size) return { size };
    if (total > RECORDING_MAX_BYTES) throw new HttpError(413, "Die Aufnahme ist zu lang.");
    const room = await recordingRoom(user, page);
    if (room !== null && total > room) throw new HttpError(413, "Der Speicher reicht für diese Aufnahme nicht.");
    if (offset < size) await truncate(stagingData(rid), offset);
    await appendFile(stagingData(rid), bytes);
    await writeFile(stagingMeta(rid), JSON.stringify({ ...meta, at: Date.now() }));
    return { size: total };
  });
}

// Drops an upload that will not be finished ("Discard").
export async function discardRecordingUpload(user: Identity, pageId: string, recId: string) {
  const page = await notebookPage(user, pageId, true);
  const rid = RECORDING_ID.parse(recId);
  await serial(rid, async () => {
    if (!ownStaging(await readMeta(rid), user, page.id)) return;
    await rm(stagingDir(rid), { recursive: true, force: true });
  });
  return { ok: true };
}

// ---- Finishing ----

const finishSchema = z.object({
  recId: RECORDING_ID,
  name: z.string().max(400).optional(),
  durationMs: z.number().finite().min(0),
});
// The checks of a finished upload: length, size for that length, type.
export function checkRecording(durationMs: number, size: number) {
  if (!(durationMs >= 500) || size < 64) throw new HttpError(400, "Die Aufnahme ist leer.");
  if (durationMs > RECORDING_MAX_MS + RECORDING_GRACE_MS) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  if (size > RECORDING_MAX_BYTES || size > (durationMs / 1000) * RECORDING_MAX_BYTES_PER_SECOND + MB) throw new HttpError(413, "Die Aufnahme ist zu lang.");
}

export async function finishRecording(user: Identity, pageId: string, input: unknown) {
  const page = await notebookPage(user, pageId, true);
  const b = finishSchema.parse(input);
  return await serial(b.recId, async () => {
    // A repeated "finish" (the answer was lost) gets the same recording.
    const existing = await recordingOf(page.id, b.recId);
    if (existing) return { recording: existing };
    const meta = ownStaging(await readMeta(b.recId), user, page.id);
    if (!meta) throw new HttpError(404, "Aufnahme nicht gefunden.");
    const source = stagingData(b.recId);
    const size = await stagedBytes(b.recId);
    const durationMs = Math.round(Math.min(b.durationMs, RECORDING_MAX_MS));
    checkRecording(b.durationMs, size);
    const handle = await open(source, "r");
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
    const mime = recordingMime(meta.mime, head);
    if (!mime) throw new HttpError(415, "Dieses Audioformat wird nicht unterstützt.");
    const name = cleanRecordingName(b.name, "Aufnahme");
    const fileName = sanitizeFileName(`${name}.${recordingExt(mime)}`, `aufnahme.${recordingExt(mime)}`);
    const fid = id();
    const dir = resolve(dataDir(), "uploads");
    mkdirSync(dir, { recursive: true });
    const final = resolve(dir, fid),
      part = `${final}.part`;
    // WebM from MediaRecorder has no duration: written into a copy of its
    // start; other files move over as they are.
    const patch = mime === "audio/webm" ? webmDurationPatch(head, durationMs) : null;
    let moved = false;
    if (patch) {
      const out = createWriteStream(part);
      out.write(patch.head);
      await pipeline(createReadStream(source, { start: patch.skip }), out);
    } else {
      await rename(source, part);
      moved = true;
    }
    const stored = (await stat(part)).size;
    try {
      await transaction(async () => {
        await enforceQuota(page.workspace_id, stored);
        await enforceUserStorage(user, stored);
        // Synchronous: a SQLite transaction awaits only the database.
        renameSync(part, final);
        onTransactionRollback(() => {
          try {
            renameSync(final, part);
          } catch {}
        });
        await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page.id, fileName, mime, stored, user.id);
        await run(
          "INSERT INTO notebook_recordings(page_id,id,file_id,name,duration_ms,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
          page.id,
          b.recId,
          fid,
          name,
          durationMs,
          user.id,
          Date.now(),
        );
        await run("UPDATE notebooks SET updated_at=? WHERE page_id=?", Date.now(), page.id);
        await audit(user.id, "notebook.recording.add", page.id, name);
      }, user);
    } catch (e) {
      // Refused (quota): the upload stays, so it can be finished once there is room.
      if (moved && existsSync(part) && !existsSync(source)) await rename(part, source).catch(() => {});
      else await unlink(part).catch(() => {});
      throw e;
    }
    await rm(stagingDir(b.recId), { recursive: true, force: true }).catch(() => {});
    return { recording: (await recordingOf(page.id, b.recId))! };
  });
}

// ---- Rename, delete ----

export async function renameRecording(user: Identity, pageId: string, recId: string, rawName: unknown) {
  const page = await notebookPage(user, pageId, true);
  const recording = await recordingOf(page.id, RECORDING_ID.parse(recId));
  if (!recording) throw new HttpError(404, "Aufnahme nicht gefunden.");
  const name = cleanRecordingName(rawName, recording.name);
  await run("UPDATE notebook_recordings SET name=? WHERE page_id=? AND id=?", name, page.id, recording.id);
  // The file keeps the same name (downloads, media library).
  await run("UPDATE files SET name=? WHERE id=?", sanitizeFileName(`${name}.${recordingExt(recording.mime)}`), recording.fileId);
  await audit(user.id, "notebook.recording.rename", page.id, name);
  return { recording: (await recordingOf(page.id, recording.id))! };
}

// Into the trash with its file (lib/file-trash.ts): restoring the file in
// the media library brings the recording back; emptying the trash ends it.
export async function deleteRecording(user: Identity, pageId: string, recId: string) {
  const page = await notebookPage(user, pageId, true);
  const recording = await recordingOf(page.id, RECORDING_ID.parse(recId));
  if (!recording) throw new HttpError(404, "Aufnahme nicht gefunden.");
  await transaction(async () => {
    await run("UPDATE files SET deleted_at=?,deleted_by=? WHERE id=? AND deleted_at IS NULL", nowText(), user.id, recording.fileId);
    await run("INSERT INTO search_dirty(page_id,row_id) VALUES(?,?) ON CONFLICT DO NOTHING", page.id, `f:${recording.fileId}`);
    await audit(user.id, "file.trashed", recording.fileId, recording.name);
  }, user);
  return { ok: true };
}

// The hook for a transcription (not used yet): JSON of lib/transcribe.ts's
// Transcript, shown nowhere until a client reads it.
export async function saveRecordingTranscript(pageId: string, recId: string, transcript: unknown) {
  await run("UPDATE notebook_recordings SET transcript=? WHERE page_id=? AND id=?", transcript === null ? null : JSON.stringify(transcript), pageId, recId);
}

// ---- Copies, archives, exports ----

export const recordingsArchiveSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[\w-]{1,40}$/),
      file: z.string().max(64),
      name: z.string().max(400),
      durationMs: z.number().finite().min(0).max(RECORDING_MAX_MS + RECORDING_GRACE_MS),
      createdAt: z.number().finite().optional(),
    }),
  )
  .max(1000);
export type RecordingsArchive = z.infer<typeof recordingsArchiveSchema>;
export async function recordingsArchive(pageId: string): Promise<RecordingsArchive> {
  return (await notebookRecordings(pageId)).map((r) => ({ id: r.id, file: r.fileId, name: r.name, durationMs: r.durationMs, createdAt: r.createdAt }));
}
// Recordings onto a notebook whose files came along (`files`: old file id →
// new one); those whose file is missing are left out. The ids stay: the ink
// copied with them refers to them.
export async function restoreRecordings(pageId: string, list: RecordingsArchive | undefined, files: Map<string, string>, by: string | null) {
  for (const r of list || []) {
    const fid = files.get(r.file);
    if (!fid || !(await one("SELECT 1 FROM files WHERE id=? AND page_id=?", fid, pageId))) continue;
    await run(
      "INSERT INTO notebook_recordings(page_id,id,file_id,name,duration_ms,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      pageId,
      r.id,
      fid,
      cleanRecordingName(r.name, "Aufnahme"),
      Math.round(Math.min(r.durationMs, RECORDING_MAX_MS)),
      by,
      r.createdAt ?? Date.now(),
    );
  }
}
export async function copyRecordings(fromPage: string, toPage: string, files: Map<string, string>, by: string | null) {
  await restoreRecordings(toPage, await recordingsArchive(fromPage), files, by);
}

