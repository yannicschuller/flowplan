// Voice notes and meeting recordings: speech to text with Whisper running as
// a separate service next to Flowplan (e.g. faster-whisper-server, speaches
// or a whisper.cpp server with an OpenAI-compatible API in the same Docker
// network). Recordings go only to that address, never to a cloud.
//
// WHISPER_URL points at an OpenAI-compatible server
// (POST /v1/audio/transcriptions); WHISPER_MODEL, WHISPER_LANGUAGE and
// WHISPER_API_KEY are optional.
//
// The answer is asked for as "verbose_json" (WHISPER_RESPONSE_FORMAT to
// change it): text plus segments with start and end times. Speakers are only
// shown when the backend itself separates them (diarization) and returns a
// `speaker` per segment – WHISPER_DIARIZE=on asks for it with `diarize=true`
// on servers that support it. Flowplan never guesses speakers. Servers that
// do not know the format get a second request with plain "json".
//
// Long recordings (up to two hours) arrive in chunks (POST
// /api/transcribe/chunk), are put together on the server and sent to the
// service as one file; WHISPER_MAX_MB limits the size (default 200).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpError } from "./auth";
import type { Identity } from "./types";

// One request from the browser (short voice notes).
export const TRANSCRIBE_LIMIT = 25_000_000;
// Chunks of a long recording.
export const TRANSCRIBE_CHUNK_BYTES = 5 * 1024 * 1024;
export const TRANSCRIBE_MAX_SECONDS = 2 * 60 * 60;
export const transcribeMaxBytes = () => Math.max(1, Number(process.env.WHISPER_MAX_MB) || 200) * 1024 * 1024;
const MAX_TEXT = 400_000;
const MAX_SEGMENTS = 20_000;

export type TranscriptSegment = { start: number; end: number; text: string; speaker?: string };
export type Transcript = {
  text: string;
  // Empty when the service only returns text.
  segments: TranscriptSegment[];
  duration?: number;
  // The service separated speakers (diarization).
  speakers: boolean;
};

export function transcriptionEnabled() {
  return !!process.env.WHISPER_URL?.trim();
}

const on = (value: string | undefined) => /^(1|on|true|yes)$/i.test(value?.trim() || "");
const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

// The service's answer as text and segments (verbose_json, diarized_json or json).
export function parseTranscription(data: unknown): Transcript {
  const body = (data && typeof data === "object" ? data : {}) as { text?: unknown; segments?: unknown; duration?: unknown };
  const segments: TranscriptSegment[] = [];
  if (Array.isArray(body.segments))
    for (const raw of body.segments.slice(0, MAX_SEGMENTS)) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown };
      const text = typeof s.text === "string" ? s.text.replace(/\s+/g, " ").trim() : "";
      const start = seconds(s.start);
      if (!text || start === null || start > TRANSCRIBE_MAX_SECONDS) continue;
      const speaker = typeof s.speaker === "string" || typeof s.speaker === "number" ? String(s.speaker).trim().slice(0, 60) : "";
      segments.push({ start, end: seconds(s.end) ?? start, text: text.slice(0, 5000), ...(speaker ? { speaker } : {}) });
    }
  const text = (typeof body.text === "string" ? body.text.trim() : segments.map((s) => s.text).join(" ")).slice(0, MAX_TEXT);
  const duration = seconds(body.duration);
  return { text, segments, ...(duration !== null ? { duration } : {}), speakers: segments.some((s) => s.speaker) };
}

export async function transcribe(audio: Blob, name = "sprachnotiz.webm"): Promise<Transcript> {
  const base = process.env.WHISPER_URL?.trim().replace(/\/$/, "");
  if (!base) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
  if (audio.size > transcribeMaxBytes()) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  const preferred = process.env.WHISPER_RESPONSE_FORMAT?.trim() || "verbose_json";
  // Large files take longer: half a minute per megabyte, at most an hour.
  const timeout = Math.min(3_600_000, Math.max(180_000, (audio.size / 1_000_000) * 30_000));
  const request = (format: string) => {
    const form = new FormData();
    form.set("file", audio, name);
    form.set("model", process.env.WHISPER_MODEL?.trim() || "Systran/faster-whisper-small");
    form.set("language", process.env.WHISPER_LANGUAGE?.trim() || "de");
    form.set("response_format", format);
    if (format !== "json" && format !== "text") form.append("timestamp_granularities[]", "segment");
    if (format !== "json" && on(process.env.WHISPER_DIARIZE)) form.set("diarize", "true");
    return fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      headers: process.env.WHISPER_API_KEY ? { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {},
      signal: AbortSignal.timeout(timeout),
    });
  };
  let response: Response;
  try {
    response = await request(preferred);
    // Servers that only know plain JSON refuse the format: once more without.
    if (!response.ok && preferred !== "json" && [400, 415, 422].includes(response.status)) response = await request("json");
  } catch {
    throw new HttpError(502, "Der Transkriptionsdienst ist nicht erreichbar.");
  }
  if (!response.ok) throw new HttpError(502, `Transkription fehlgeschlagen (${response.status}).`);
  return parseTranscription(await response.json().catch(() => ({})));
}

// ---- Long recordings in chunks ----

type Upload = { userId: string; pageId: string; parts: Map<number, number>; bytes: number; at: number };
const runtime = globalThis as typeof globalThis & { flowplanTranscribeUploads?: Map<string, Upload> };
const uploads = () => (runtime.flowplanTranscribeUploads ??= new Map());
const uploadDir = (id: string) => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "tmp", "transcribe", id);
const UPLOAD_TTL = 3 * 60 * 60_000;

// Unfinished uploads are removed after three hours.
async function sweep(now = Date.now()) {
  for (const [id, upload] of uploads())
    if (now - upload.at > UPLOAD_TTL) {
      uploads().delete(id);
      await rm(uploadDir(id), { recursive: true, force: true }).catch(() => {});
    }
}

// One chunk of a recording, in order of `index` (0, 1, …). The upload id
// is chosen by the browser and belongs to the person who sent the first chunk.
export async function storeTranscribeChunk(user: Identity, input: { uploadId: string; pageId: string; index: number }, bytes: Uint8Array) {
  await sweep();
  if (!Number.isInteger(input.index) || input.index < 0 || input.index > 999) throw new HttpError(400, "Ungültige Eingabe.");
  if (!bytes.length || bytes.length > TRANSCRIBE_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
  let upload = uploads().get(input.uploadId);
  if (!upload) {
    if ([...uploads().values()].filter((u) => u.userId === user.id).length >= 3)
      throw new HttpError(429, "Zu viele Aufnahmen gleichzeitig. Bitte später erneut versuchen.");
    upload = { userId: user.id, pageId: input.pageId, parts: new Map(), bytes: 0, at: Date.now() };
    uploads().set(input.uploadId, upload);
  }
  if (upload.userId !== user.id || upload.pageId !== input.pageId) throw new HttpError(403, "Keine Berechtigung.");
  const total = upload.bytes - (upload.parts.get(input.index) || 0) + bytes.length;
  if (total > transcribeMaxBytes()) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  await mkdir(uploadDir(input.uploadId), { recursive: true });
  await writeFile(resolve(uploadDir(input.uploadId), String(input.index)), bytes);
  upload.parts.set(input.index, bytes.length);
  upload.bytes = total;
  upload.at = Date.now();
  return { ok: true, received: upload.parts.size, bytes: upload.bytes };
}

// Puts the chunks together and transcribes the whole recording; the chunks
// are removed in any case.
export async function finishTranscribeUpload(user: Identity, input: { uploadId: string; pageId: string; parts: number; name: string; type: string }) {
  const upload = uploads().get(input.uploadId);
  if (!upload || upload.userId !== user.id || upload.pageId !== input.pageId) throw new HttpError(404, "Aufnahme nicht gefunden.");
  try {
    if (input.parts < 1 || input.parts !== upload.parts.size || ![...Array(input.parts).keys()].every((i) => upload.parts.has(i)))
      throw new HttpError(400, "Die Aufnahme ist unvollständig.");
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < input.parts; i++) chunks.push(new Uint8Array(await readFile(resolve(uploadDir(input.uploadId), String(i)))));
    const audio = new Blob(chunks as BlobPart[], { type: input.type });
    return await transcribe(audio, input.name);
  } finally {
    uploads().delete(input.uploadId);
    await rm(uploadDir(input.uploadId), { recursive: true, force: true }).catch(() => {});
  }
}
