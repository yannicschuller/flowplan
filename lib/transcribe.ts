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
//
// The request may take a minute per megabyte (at least three minutes, at
// most two hours; WHISPER_TIMEOUT_SECONDS sets it). WHISPER_PROMPT (and a
// workspace's meeting glossary) go along as `prompt`: names and acronyms
// the recogniser should spell right. WHISPER_VAD=on asks faster-whisper
// servers (speaches) to skip silence first (`vad_filter=true`).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { HttpError } from "./auth";
import type { Identity } from "./types";

// Chunks of a long recording.
export const TRANSCRIBE_CHUNK_BYTES = 5 * 1024 * 1024;
export const TRANSCRIBE_MAX_SECONDS = 2 * 60 * 60;
export const transcribeMaxBytes = () => Math.max(1, Number(process.env.WHISPER_MAX_MB) || 200) * 1024 * 1024;
const MAX_TEXT = 400_000;
const MAX_SEGMENTS = 20_000;

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  // What the service says about it (verbose_json), for the hallucination
  // filter (lib/meeting-core.ts markHallucinations).
  noSpeechProb?: number;
  avgLogprob?: number;
  compressionRatio?: number;
  // A silence phrase or a repetition the recogniser made up.
  hallucination?: boolean;
};
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
      const s = raw as { start?: unknown; end?: unknown; text?: unknown; speaker?: unknown; no_speech_prob?: unknown; avg_logprob?: unknown; compression_ratio?: unknown };
      const text = typeof s.text === "string" ? s.text.replace(/\s+/g, " ").trim() : "";
      const start = seconds(s.start);
      if (!text || start === null || start > TRANSCRIBE_MAX_SECONDS) continue;
      const speaker = typeof s.speaker === "string" || typeof s.speaker === "number" ? String(s.speaker).trim().slice(0, 60) : "";
      const metric = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
      const noSpeechProb = metric(s.no_speech_prob),
        avgLogprob = metric(s.avg_logprob),
        compressionRatio = metric(s.compression_ratio);
      segments.push({
        start,
        end: seconds(s.end) ?? start,
        text: text.slice(0, 5000),
        ...(speaker ? { speaker } : {}),
        ...(noSpeechProb !== undefined ? { noSpeechProb } : {}),
        ...(avgLogprob !== undefined ? { avgLogprob } : {}),
        ...(compressionRatio !== undefined ? { compressionRatio } : {}),
      });
    }
  const text = (typeof body.text === "string" ? body.text.trim() : segments.map((s) => s.text).join(" ")).slice(0, MAX_TEXT);
  const duration = seconds(body.duration);
  return { text, segments, ...(duration !== null ? { duration } : {}), speakers: segments.some((s) => s.speaker) };
}

// How long the service may take for a file of `bytes`: a minute per
// megabyte (whisper.cpp large-v3-turbo on an M2 needed 383 s for 8.4 MB,
// on a CPU it is slower), at least three minutes, at most two hours –
// WHISPER_TIMEOUT_SECONDS sets it for every file. Whole milliseconds.
export function transcribeTimeoutMs(bytes: number) {
  const fixed = Math.floor(Number(process.env.WHISPER_TIMEOUT_SECONDS));
  if (Number.isFinite(fixed) && fixed > 0) return Math.min(fixed, 24 * 60 * 60) * 1000;
  return Math.ceil(Math.min(2 * 60 * 60_000, Math.max(180_000, (bytes / 1_000_000) * 60_000)));
}

// The vocabulary hint (OpenAI-compatible `prompt`): WHISPER_PROMPT of the
// instance and the workspace's glossary (names, acronyms). Whisper reads
// at most 224 tokens of it; ~2.5 characters per token for German and
// French leaves about 550 characters, cut after the last whole term.
export const WHISPER_PROMPT_CHARS = 550;
export function whisperPrompt(glossary = "") {
  const terms = [process.env.WHISPER_PROMPT || "", glossary]
    .join("\n")
    .split(/[\n,;]+/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set<string>();
  let out = "";
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const next = out ? `${out}, ${term}` : term;
    if (next.length > WHISPER_PROMPT_CHARS) {
      // A single term longer than the limit: its start.
      if (!out) out = term.slice(0, WHISPER_PROMPT_CHARS).replace(/\s+\S*$/, "");
      break;
    }
    out = next;
  }
  return out;
}

// A failed transcription: `message` for the person (German source text),
// `detail` for administrators (what actually went wrong: timeout, refused
// connection, the service's answer) – never the API key.
export class TranscribeError extends HttpError {
  constructor(
    status: number,
    message: string,
    public detail: string,
  ) {
    super(status, message);
  }
}
const UNREACHABLE = "Der Transkriptionsdienst ist nicht erreichbar.";
const TOO_SLOW = "Der Transkriptionsdienst hat nicht rechtzeitig geantwortet.";
const MAX_RESPONSE = 50 * 1024 * 1024;

type WhisperAnswer = { status: number; body: string };
// One multipart request with node:http(s): its own timer covers the whole
// request – fetch (undici) would end any answer whose headers take longer
// than five minutes (headersTimeout), and Whisper sends them only at the end.
function post(url: URL, fields: [string, string][], audio: Blob, name: string, timeoutMs: number): Promise<WhisperAnswer> {
  const boundary = `----flowplan${randomUUID().replace(/-/g, "")}`;
  const quote = (value: string) => value.replace(/["\r\n\\]/g, "_");
  const head = fields.map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${quote(key)}"\r\n\r\n${value}\r\n`).join("");
  const body = new Blob([
    head,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quote(name)}"\r\nContent-Type: ${quote(audio.type || "application/octet-stream")}\r\n\r\n`,
    audio,
    `\r\n--${boundary}--\r\n`,
  ]);
  return new Promise<WhisperAnswer>((resolvePost, reject) => {
    let done = false;
    const finish = (error: Error | null, answer?: WhisperAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePost(answer!);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.size),
          ...(process.env.WHISPER_API_KEY ? { authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) return req.destroy(Object.assign(new Error("answer larger than 50 MB"), { code: "TOO_LARGE" }));
          chunks.push(chunk);
        });
        res.on("end", () => finish(null, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (error) => finish(error));
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: "TIMEOUT" })), timeoutMs);
    req.on("error", (error) => finish(error));
    Readable.fromWeb(body.stream() as never)
      .on("error", (error) => req.destroy(error))
      .pipe(req);
  });
}

export async function transcribe(audio: Blob, name = "sprachnotiz.webm", options: { prompt?: string } = {}): Promise<Transcript> {
  const base = process.env.WHISPER_URL?.trim().replace(/\/$/, "");
  if (!base) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
  if (audio.size > transcribeMaxBytes()) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  let url: URL;
  try {
    url = new URL(`${base}/v1/audio/transcriptions`);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http");
  } catch {
    throw new TranscribeError(502, UNREACHABLE, "WHISPER_URL is not an http(s) address");
  }
  const preferred = process.env.WHISPER_RESPONSE_FORMAT?.trim() || "verbose_json";
  const timeout = transcribeTimeoutMs(audio.size);
  const prompt = (options.prompt ?? whisperPrompt()).trim();
  const request = (format: string) => {
    const fields: [string, string][] = [
      ["model", process.env.WHISPER_MODEL?.trim() || "Systran/faster-whisper-small"],
      ["language", process.env.WHISPER_LANGUAGE?.trim() || "de"],
      ["response_format", format],
    ];
    if (format !== "json" && format !== "text") fields.push(["timestamp_granularities[]", "segment"]);
    if (format !== "json" && on(process.env.WHISPER_DIARIZE)) fields.push(["diarize", "true"]);
    if (prompt) fields.push(["prompt", prompt]);
    // faster-whisper / speaches: skip silence first (fewer made-up lines).
    if (on(process.env.WHISPER_VAD)) fields.push(["vad_filter", "true"]);
    return post(url, fields, audio, name, timeout);
  };
  let response: WhisperAnswer;
  try {
    response = await request(preferred);
    // Servers that only know plain JSON refuse the format: once more without.
    if (preferred !== "json" && [400, 415, 422].includes(response.status)) response = await request("json");
  } catch (error) {
    const e = error as Error & { code?: string; cause?: { code?: string } };
    const code = e.code || e.cause?.code || "";
    const detail = `${code ? `${code}: ` : ""}${e.message || "unknown error"} (${(audio.size / 1_000_000).toFixed(1)} MB, limit ${Math.round(timeout / 1000)} s)`;
    console.error("Transkription fehlgeschlagen:", detail);
    throw new TranscribeError(code === "TIMEOUT" ? 504 : 502, code === "TIMEOUT" ? TOO_SLOW : UNREACHABLE, detail.slice(0, 500));
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = `HTTP ${response.status}: ${response.body.replace(/\s+/g, " ").trim().slice(0, 300)}`;
    console.error("Transkription fehlgeschlagen:", detail);
    throw new TranscribeError(502, `Transkription fehlgeschlagen (${response.status}).`, detail);
  }
  let data: unknown = {};
  try {
    data = JSON.parse(response.body);
  } catch {}
  return parseTranscription(data);
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
