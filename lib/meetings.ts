// Meeting notes (#199): recording, transcription and the AI's notes of a
// "/meet" block (lib/meeting-schema.ts, components/meeting-block.tsx).
//
// The block keeps everything people read in the document; this module keeps
// the rest in `meetings` (one row per block, keyed by its meetingId):
//
//   sessions   [{ n, offsetMs, durationMs, tracks, parts, mime, by, byName, at, state }]
//              one per recording ("continue later" adds one; its segments
//              start at the offset, so the transcript grows in order)
//   status     new | recording | transcribing | summarizing | done | failed
//   audio      [{ session, track, fileId, mime }] kept audio (files of the page)
//   audio_until  when kept audio goes (workspace retention), NULL = keep
//
// Upload: the browser records each track (microphone "me", in the desktop
// app also the system sound "others") with MediaRecorder in 30-second
// pieces and sends them as they come (POST …/chunk), keeping each until the
// server confirmed it; after a lost connection it asks which pieces arrived
// (GET …/chunks) and sends the rest. "finish" puts each track together and
// starts the processing in the background: Whisper per track
// (lib/transcribe.ts), speaker names from the tracks, echoes of the call in
// the microphone dropped (lib/meeting-core.ts removeEchoes), the segments
// written into the transcript part – then the summary (at least a minute of
// audio) into the summary part, with tasks that "Meine Aufgaben" lists
// (lib/doc-tasks.ts). Afterwards the audio is deleted or kept per the
// workspace's retention.
//
// While a recording goes on, its pieces are already transcribed in windows
// (liveStep, lib/webm.ts): at the end only the last window and the summary
// are left. Whenever that does not work (no WebM, the service failed), the
// whole track is transcribed at the end as before – the pieces stay until
// the transcript is there. A track's finished transcript is kept with the
// pieces, so a retry only redoes the track that failed. Kept audio can be
// transcribed again ("retranscribe"); passages people corrected stay.
// Errors: `error` is the message people see, `error_detail` what went
// wrong for administrators (timeout, refused connection, the service's
// answer).
//
// Rights: reading the page reads the block (guests only when the page is
// shared with them); recording, processing and settings need edit rights,
// a page that is not locked, not encrypted end-to-end (the server would
// hear the audio) and a journal that is unlocked. Transcription and the AI
// follow their own switches; API tokens need "KI und Transkription"
// (lib/ai/token-access.ts).
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import * as Y from "yjs";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { z } from "zod";
import { all, audit, id as newId, lockFor, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember, requirePage } from "./permissions";
import { ensureRowDocument, requireRow } from "./row-documents";
import { requireUnlocked } from "./journal-extras";
import { isEncryptedPage } from "./e2ee-server";
import { htmlJson, htmlState, jsonHtml } from "./document-server";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { syncDocTasks } from "./doc-tasks";
import { mayHear } from "./comment-recipients";
import { recordPageEdit } from "./page-activity";
import { TranscribeError, transcribe, transcribeMaxBytes, transcriptionEnabled, whisperPrompt, type TranscriptSegment } from "./transcribe";
import { webmClusters, webmHeader, webmWindow } from "./webm";
import { speakerNumbers } from "./transcript";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage } from "./user-limits";
import { purgeFiles } from "./file-trash";
import { sanitizeFileName } from "./upload-safety";
import { contentLocale, ct } from "./content-locale";
import { requireTokenAi } from "./ai/token-access";
import { aiJson } from "./ai/json";
import { aiStreamResponse } from "./ai/run";
import { resolveAi } from "./ai/resolve";
import { AI_REASON_TEXT } from "./ai/features";
import { guessLanguage } from "./ai/prompts";
import { command, database } from "./api";
import { readableDatabase } from "./field-access";
import { writableFields } from "./ai/actions";
import { validateCellPatch } from "./database-operations";
import { recordingRoom } from "./notebook-audio";
import { htmlToMarkdown } from "./markdown";
import { meetingHtml } from "./meeting-schema";
import {
  MEETING_CHUNK_SECONDS,
  MEETING_MAX_SECONDS,
  MEETING_TEXT,
  MIN_SUMMARY_SECONDS,
  isEdited,
  isMeetingPreset,
  markHallucinations,
  mergeLiveWindow,
  meetingLanguage,
  meetingPrompt,
  meetingSummarySchema,
  overlapSeconds,
  presetPrompt,
  removeEchoes,
  segmentHash,
  segmentId,
  segmentNodes,
  speakerLabel,
  summaryNodes,
  type MeetingLanguage,
  type MeetingPreset,
  type MeetingSegment,
  type MeetingTrack,
  type Person,
} from "./meeting-core";
import type { Field, Identity, Page } from "./types";

// ---- Workspace settings ----

// i18n-table: 1 – [German, English] pairs
export const DEFAULT_CONSENT_TEXT = [
  "Diese Besprechung wird aufgezeichnet und transkribiert. Alle Teilnehmenden wurden informiert und sind einverstanden.",
  "This meeting is recorded and transcribed. Everyone taking part has been informed and agrees.",
] as const;
export const meetingSettingsSchema = z.object({
  // The default instructions of new blocks.
  instructions: z.enum(["auto", "status", "oneonone", "workshop", "customer", "custom"]).default("auto"),
  prompt: z.string().max(4000).default(""),
  // What happens to the audio once the transcript is there.
  retention: z.enum(["delete", "keep", "days"]).default("delete"),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  // Recording only after confirming that everyone agreed.
  consentRequired: z.boolean().default(false),
  consentText: z.string().max(2000).default(""),
  // Names, acronyms and terms of the workspace, one per line or separated
  // by commas: the speech recognition's vocabulary (whisperPrompt).
  glossary: z.string().max(2000).default(""),
});
export type MeetingSettings = z.infer<typeof meetingSettingsSchema>;

export async function meetingSettings(workspaceId: string): Promise<MeetingSettings> {
  const row = await one<{ meeting_settings: string | null }>("SELECT meeting_settings FROM workspaces WHERE id=?", workspaceId);
  let stored: unknown = {};
  try {
    stored = JSON.parse(row?.meeting_settings || "{}");
  } catch {}
  const parsed = meetingSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : meetingSettingsSchema.parse({});
}
// Members read them (the block shows the consent text); owners change them.
export async function readMeetingSettings(user: Identity, workspaceId: string) {
  await requireMember(user, workspaceId);
  const settings = await meetingSettings(workspaceId);
  return { ...settings, defaultConsentText: ct(DEFAULT_CONSENT_TEXT[0], DEFAULT_CONSENT_TEXT[1]), transcription: transcriptionEnabled() };
}
export async function saveMeetingSettings(user: Identity, workspaceId: string, input: unknown) {
  if (user.apiScope) throw new HttpError(403, "Mit einem API-Token nicht erlaubt.");
  await requireMember(user, workspaceId, "owner");
  const next = meetingSettingsSchema.parse({ ...(await meetingSettings(workspaceId)), ...((input && typeof input === "object" ? input : {}) as object) });
  await run("UPDATE workspaces SET meeting_settings=? WHERE id=?", JSON.stringify(next), workspaceId);
  await audit(user.id, "workspace.meetings", workspaceId, JSON.stringify({ retention: next.retention, days: next.retentionDays, consent: next.consentRequired }));
  return await readMeetingSettings(user, workspaceId);
}

// ---- Rows ----

export type MeetingSession = {
  n: number;
  offsetMs: number;
  durationMs: number;
  tracks: MeetingTrack[];
  parts: Partial<Record<MeetingTrack, number>>;
  mime: string;
  by: string;
  byName: string;
  at: number;
  // "text": a transcript given as text (API, MCP) instead of audio.
  kind?: "audio" | "text";
  state: "recording" | "uploaded" | "done" | "failed";
  // Transcribed in windows while recording (the recorder asks for it).
  live?: boolean;
  // Transcribed again from the kept audio (retranscribe); corrected
  // passages stay unless `keepEdited` is false.
  source?: "kept";
  keepEdited?: boolean;
};
type KeptAudio = { session: number; track: MeetingTrack; fileId: string; mime: string };
type MeetingRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  row_id: string | null;
  created_by: string | null;
  status: string;
  error: string | null;
  error_detail: string | null;
  sessions: string;
  duration_ms: number;
  audio: string;
  audio_until: number | null;
  consent_by: string | null;
  consent_at: number | null;
  created_at: number;
  updated_at: number;
  summarized_at: number | null;
};
const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};
const sessionsOf = (row: MeetingRow) => parse<MeetingSession[]>(row.sessions, []);
const audioOf = (row: MeetingRow) => parse<KeptAudio[]>(row.audio, []);
const meetingRow = async (meetingId: string) => await one<MeetingRow>("SELECT * FROM meetings WHERE id=?", meetingId);

export const MEETING_COPY = "Dieser Besprechungsblock ist eine Kopie und bekommt eine eigene Aufnahme.";
const TRACKS = ["me", "others", "mixed"] as const;
const trackSchema = z.enum(TRACKS);
const uuid = z.uuid();

// ---- Access ----

// The page (and record) of a block, checked for reading or for recording.
async function target(user: Identity, pageId: string, rowId: string | null, write: boolean): Promise<Page> {
  const page = rowId ? (await requireRow(user, pageId, rowId, write)).page : await requirePage(user, pageId, write);
  await requireUnlocked(user, page);
  if (!rowId && page.kind === "database") throw new HttpError(400, "Kein Dokument.");
  if (write) {
    if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
    // The server would hear the audio and write plaintext into the page.
    if (await isEncryptedPage(page)) throw new HttpError(409, "Besprechungsnotizen sind in verschlüsselten Bereichen nicht verfügbar.");
  }
  return page;
}
// Recording, transcription and the AI: not in the demo, tokens only with
// "KI und Transkription".
async function requireMeetingCaller(user: Identity) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  await requireTokenAi(user);
}

async function storedDocument(pageId: string, rowId: string | null) {
  if (rowId) {
    const row = await one<{ id: string; page_id: string }>("SELECT * FROM rows WHERE id=? AND page_id=?", rowId, pageId);
    if (!row) throw new HttpError(404, "Datensatz nicht gefunden.");
    return await ensureRowDocument(row as never);
  }
  const stored = await one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM documents WHERE page_id=?", pageId);
  if (!stored) throw new HttpError(404, "Dokument nicht gefunden.");
  return stored;
}
async function readDocument(pageId: string, rowId: string | null) {
  const stored = await storedDocument(pageId, rowId);
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    return PMNode.fromJSON(rewriteSchema(), yDocToProsemirrorJSON(ydoc, "default"));
  } finally {
    ydoc.destroy();
  }
}
export function findMeeting(doc: PMNode, meetingId: string) {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "meeting" && node.attrs.meetingId === meetingId) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found as { node: PMNode; pos: number } | null;
}
const partOf = (meeting: PMNode, name: string) => {
  let offset = -1,
    found: PMNode | null = null;
  meeting.forEach((child, childOffset) => {
    if (child.type.name === name) {
      found = child;
      offset = childOffset;
    }
  });
  return found ? { node: found as PMNode, offset } : null;
};
export function segmentsOf(meeting: PMNode): MeetingSegment[] {
  const part = partOf(meeting, "meetingTranscript");
  const list: MeetingSegment[] = [];
  part?.node.forEach((s) =>
    list.push({
      sid: String(s.attrs.sid || ""),
      start: Number(s.attrs.start) || 0,
      end: Number(s.attrs.end) || 0,
      text: s.textContent,
      speaker: String(s.attrs.speaker || ""),
      track: (TRACKS as readonly string[]).includes(s.attrs.track) ? s.attrs.track : "mixed",
      session: Number(s.attrs.session) || 1,
      ...(s.attrs.hallucination ? { hallucination: true } : {}),
      ...(s.attrs.edited ? { edited: true } : {}),
      ...(s.attrs.hash ? { hash: String(s.attrs.hash) } : {}),
    }),
  );
  return list;
}

// The meeting of a block: created on first use, after checking that the
// document holds the block. A block copied to another page or record gets
// a new id from the editor (409 MEETING_COPY).
export async function ensureMeeting(user: Identity, input: { meetingId: string; pageId: string; rowId?: string | null }) {
  const meetingId = uuid.parse(input.meetingId),
    pageId = uuid.parse(input.pageId),
    rowId = input.rowId ? uuid.parse(input.rowId) : null;
  const page = await target(user, pageId, rowId, true);
  const existing = await meetingRow(meetingId);
  if (existing) {
    if (existing.page_id !== pageId || (existing.row_id || null) !== rowId) throw new HttpError(409, MEETING_COPY);
    return { row: existing, page };
  }
  if (!findMeeting(await readDocument(pageId, rowId), meetingId)) throw new HttpError(404, "Besprechung nicht gefunden.");
  const now = Date.now();
  await run(
    "INSERT INTO meetings(id,workspace_id,page_id,row_id,created_by,status,sessions,audio,created_at,updated_at) VALUES(?,?,?,?,?,'new','[]','[]',?,?) ON CONFLICT(id) DO NOTHING",
    meetingId,
    page.workspace_id,
    pageId,
    rowId,
    user.id,
    now,
    now,
  );
  const row = (await meetingRow(meetingId))!;
  if (row.page_id !== pageId || (row.row_id || null) !== rowId) throw new HttpError(409, MEETING_COPY);
  return { row, page };
}
// A meeting the person may read (or change).
async function meetingFor(user: Identity, meetingId: string, write: boolean) {
  const row = await meetingRow(uuid.parse(meetingId));
  if (!row) throw new HttpError(404, "Besprechung nicht gefunden.");
  const page = await target(user, row.page_id, row.row_id, write);
  return { row, page };
}

// ---- Status ----

// A block nobody recorded with yet has no row: an empty status (the editor
// asks for every block it shows). Says nothing about other blocks – any
// unknown id answers the same.
export async function meetingStatusOrNew(user: Identity, meetingId: string) {
  const id = uuid.parse(meetingId);
  if (await meetingRow(id)) return await meetingStatus(user, id);
  return {
    id,
    pageId: null,
    rowId: null,
    status: "new",
    error: null,
    errorDetail: null,
    durationMs: 0,
    sessions: [],
    audio: [],
    audioUntil: null,
    summarizedAt: null,
    consentAt: null,
    consentRequired: false,
    transcription: transcriptionEnabled(),
  };
}
export async function meetingStatus(user: Identity, meetingId: string, options: { content?: boolean } = {}) {
  const { row, page } = await meetingFor(user, meetingId, false);
  const settings = await meetingSettings(row.workspace_id);
  const sessions = sessionsOf(row);
  const base = {
    id: row.id,
    pageId: row.page_id,
    rowId: row.row_id,
    status: row.status,
    error: row.error,
    // What went wrong, for the instance's administrators only.
    errorDetail: user.isAdmin ? row.error_detail || null : null,
    durationMs: Number(row.duration_ms) || 0,
    sessions: sessions.map((s) => ({ n: s.n, offsetMs: s.offsetMs, durationMs: s.durationMs, tracks: s.tracks, state: s.state, by: s.by, byName: s.byName, at: s.at })),
    audio: audioOf(row).map((a) => ({ session: a.session, track: a.track, url: `/api/files/${a.fileId}`, mime: a.mime })),
    audioUntil: row.audio_until,
    summarizedAt: row.summarized_at,
    consentAt: row.consent_at,
    consentRequired: settings.consentRequired,
    transcription: transcriptionEnabled(),
  };
  if (!options.content) return base;
  // For API clients: the summary as Markdown and the transcript as text.
  const found = findMeeting(await readDocument(page.id, row.row_id), row.id);
  const summary = found ? partOf(found.node, "meetingSummary") : null;
  const agenda = found ? partOf(found.node, "meetingAgenda") : null;
  const markdown = (node: PMNode | undefined) =>
    node
      ? htmlToMarkdown(jsonHtml({ type: "doc", content: node.content.toJSON() }), { url: (url) => (/^(https?:|mailto:|\/)/i.test(url) ? url : null), linked: () => null }).trim()
      : "";
  return {
    ...base,
    title: found ? String(found.node.attrs.title || "") : "",
    summary: markdown(summary?.node),
    agenda: markdown(agenda?.node),
    transcript: found
      ? segmentsOf(found.node).map((s) => ({
          id: s.sid,
          start: s.start,
          end: s.end,
          speaker: s.speaker,
          track: s.track,
          session: s.session,
          text: s.text,
          hallucination: !!s.hallucination,
          edited: isEdited(s),
        }))
      : [],
  };
}

export type MeetingDetails = Awaited<ReturnType<typeof meetingStatus>> & {
  title: string;
  summary: string;
  agenda: string;
  transcript: { id: string; start: number; end: number; speaker: string; track: MeetingTrack; session: number; text: string; hallucination: boolean; edited: boolean }[];
};
// The status with the summary (Markdown), agenda and transcript.
export const meetingDetails = async (user: Identity, meetingId: string) => (await meetingStatus(user, meetingId, { content: true })) as MeetingDetails;

// ---- Recording ----

const startInput = z.object({
  meetingId: z.uuid(),
  pageId: z.uuid(),
  rowId: z.uuid().nullable().optional(),
  tracks: z.array(trackSchema).min(1).max(2),
  mime: z.string().regex(/^(audio\/[\w.+-]+|text\/plain)$/).max(100).default("audio/webm"),
  consent: z.boolean().optional(),
  // The recorder's 30-second pieces: transcribe them while recording.
  live: z.boolean().optional(),
});
// A new recording session ("continue later" starts another one; its times
// continue after the earlier ones).
export async function startMeetingSession(user: Identity, input: unknown, kind: "audio" | "text" = "audio") {
  await requireMeetingCaller(user);
  const b = startInput.parse(input);
  if (kind === "audio" && !transcriptionEnabled()) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
  if (new Set(b.tracks).size !== b.tracks.length || (b.tracks.includes("mixed") && b.tracks.length > 1)) throw new HttpError(400, "Ungültige Eingabe.");
  const { page } = await ensureMeeting(user, b);
  const settings = await meetingSettings(page.workspace_id);
  if (settings.consentRequired && !b.consent) throw new HttpError(428, "Bitte bestätige zuerst, dass alle Teilnehmenden der Aufnahme zugestimmt haben.");
  return await transaction(async () => {
    await lockFor(`meeting:${b.meetingId}`);
    const row = (await meetingRow(b.meetingId))!;
    if (row.status === "transcribing" || row.status === "summarizing") throw new HttpError(409, "Die Besprechung wird gerade verarbeitet.");
    // Sessions that never finished (closed tab) are given up.
    const sessions = sessionsOf(row).filter((s) => s.state !== "recording");
    for (const s of sessionsOf(row)) if (s.state === "recording") await rm(stagingDir(row.id, s.n), { recursive: true, force: true }).catch(() => {});
    const offsetMs = sessions.reduce((sum, s) => sum + (s.state === "failed" && !s.durationMs ? 0 : s.durationMs), 0);
    if (offsetMs >= MEETING_MAX_SECONDS * 1000) throw new HttpError(413, "Die Besprechung hat die Höchstlänge erreicht.");
    const n = sessions.reduce((max, s) => Math.max(max, s.n), 0) + 1;
    const session: MeetingSession = { n, offsetMs, durationMs: 0, tracks: b.tracks, parts: {}, mime: b.mime.split(";")[0], by: user.id, byName: user.name, at: Date.now(), kind, state: "recording", ...(b.live && kind === "audio" ? { live: true } : {}) };
    sessions.push(session);
    await run(
      "UPDATE meetings SET sessions=?,status='recording',error=NULL,error_detail=NULL,consent_by=COALESCE(?,consent_by),consent_at=COALESCE(?,consent_at),updated_at=? WHERE id=?",
      JSON.stringify(sessions),
      b.consent ? user.id : null,
      b.consent ? Date.now() : null,
      Date.now(),
      row.id,
    );
    if (b.consent) await audit(user.id, "meeting.consent", page.id, row.id);
    return { session: n, offsetMs, maxMs: MEETING_MAX_SECONDS * 1000 - offsetMs, chunkSeconds: MEETING_CHUNK_SECONDS };
  }, user);
}

const dataDir = () => process.env.FLOWPLAN_DATA_DIR || "./data";
const stagingRoot = () => resolve(dataDir(), "tmp", "meetings");
const stagingDir = (meetingId: string, session: number) => resolve(stagingRoot(), meetingId, String(session));
const trackDir = (meetingId: string, session: number, track: MeetingTrack) => resolve(stagingDir(meetingId, session), track);
export const MEETING_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 1000;

async function stagedParts(meetingId: string, session: number, track: MeetingTrack) {
  try {
    return (await readdir(trackDir(meetingId, session, track)))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
async function stagedBytes(meetingId: string) {
  let total = 0;
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory()) await walk(resolve(dir, entry.name));
      else total += (await stat(resolve(dir, entry.name)).catch(() => ({ size: 0 }))).size;
  };
  await walk(resolve(stagingRoot(), meetingId));
  return total;
}
function ownSession(row: MeetingRow, user: Identity, n: number) {
  const session = sessionsOf(row).find((s) => s.n === n);
  if (!session) throw new HttpError(404, "Aufnahme nicht gefunden.");
  if (session.by !== user.id) throw new HttpError(403, "Keine Berechtigung.");
  return session;
}

// One piece of a track. Sending a piece again replaces it (a retry).
export async function storeMeetingChunk(user: Identity, meetingId: string, input: { session: number; track: string; index: number }, bytes: Uint8Array) {
  await requireMeetingCaller(user);
  const { row, page } = await meetingFor(user, meetingId, true);
  const session = ownSession(row, user, input.session);
  const track = trackSchema.parse(input.track);
  if (session.state !== "recording" || !session.tracks.includes(track)) throw new HttpError(409, "Diese Aufnahme ist bereits abgeschlossen.");
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= MAX_PARTS) throw new HttpError(400, "Ungültige Eingabe.");
  if (!bytes.length || bytes.length > MEETING_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
  const staged = await stagedBytes(row.id);
  if (staged + bytes.length > transcribeMaxBytes() * session.tracks.length) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  // The audio may stay (retention): it has to fit the storage.
  const room = await recordingRoom(user, page);
  if (room !== null && staged + bytes.length > room) throw new HttpError(413, "Der Speicherplatz reicht für diese Aufnahme nicht aus.");
  await mkdir(trackDir(row.id, session.n, track), { recursive: true });
  await writeFile(resolve(trackDir(row.id, session.n, track), String(input.index)), bytes);
  if (session.live && session.mime === "audio/webm" && liveEnabled()) scheduleLive(row.id, session.n, track, whisperPrompt((await meetingSettings(row.workspace_id)).glossary));
  return { ok: true, received: (await stagedParts(row.id, session.n, track)).length };
}
// Which pieces arrived (to resume after a lost connection).
export async function meetingChunks(user: Identity, meetingId: string, n: number) {
  const { row } = await meetingFor(user, meetingId, true);
  const session = ownSession(row, user, n);
  const received: Partial<Record<MeetingTrack, number[]>> = {};
  for (const track of session.tracks) received[track] = await stagedParts(row.id, session.n, track);
  return { session: session.n, state: session.state, received };
}

const finishInput = z.object({
  session: z.number().int().min(1),
  parts: z.partialRecord(trackSchema, z.number().int().min(1).max(MAX_PARTS)),
  durationMs: z.number().min(0).max(MEETING_MAX_SECONDS * 1000 + 60_000),
  // The block's language for speaker names and the summary.
  language: z.enum(["de", "en", "fr", "zh"]).optional(),
});
// The session is complete: transcription and summary run in the background.
export async function finishMeetingSession(user: Identity, meetingId: string, input: unknown) {
  await requireMeetingCaller(user);
  const b = finishInput.parse(input);
  const { row } = await meetingFor(user, meetingId, true);
  const session = ownSession(row, user, b.session);
  if (session.state !== "recording") return await meetingStatus(user, row.id);
  for (const track of session.tracks) {
    const want = b.parts[track];
    const have = await stagedParts(row.id, session.n, track);
    if (!want || have.length !== want || have.some((n, i) => n !== i)) throw new HttpError(400, "Die Aufnahme ist unvollständig.");
  }
  await transaction(async () => {
    await lockFor(`meeting:${row.id}`);
    const current = (await meetingRow(row.id))!;
    const sessions = sessionsOf(current);
    const own = sessions.find((s) => s.n === session.n)!;
    own.parts = Object.fromEntries(own.tracks.map((t) => [t, b.parts[t]!]));
    own.durationMs = Math.round(Math.min(b.durationMs, MEETING_MAX_SECONDS * 1000 - own.offsetMs));
    own.state = "uploaded";
    await run(
      "UPDATE meetings SET sessions=?,duration_ms=?,status='transcribing',error=NULL,error_detail=NULL,updated_at=? WHERE id=?",
      JSON.stringify(sessions),
      sessions.reduce((sum, s) => sum + (s.state === "recording" ? 0 : s.durationMs), 0),
      Date.now(),
      row.id,
    );
  }, user);
  launchProcessing(user, row.id, b.language || languageOfLocale());
  return await meetingStatus(user, row.id);
}
// Processing again after an error (staged audio is kept until it worked).
export async function retryMeeting(user: Identity, meetingId: string, language?: string) {
  await requireMeetingCaller(user);
  const { row } = await meetingFor(user, meetingId, true);
  if (running().has(row.id)) return await meetingStatus(user, row.id);
  const sessions = sessionsOf(row);
  for (const s of sessions) if (s.state === "failed") s.state = "uploaded";
  await run("UPDATE meetings SET sessions=?,status='transcribing',error=NULL,error_detail=NULL,updated_at=? WHERE id=?", JSON.stringify(sessions), Date.now(), row.id);
  launchProcessing(user, row.id, meetingLanguage(language || languageOfLocale()));
  return await meetingStatus(user, row.id);
}
const languageOfLocale = (): MeetingLanguage => meetingLanguage(contentLocale());

// ---- Processing ----

const runtime = globalThis as typeof globalThis & { flowplanMeetingJobs?: Map<string, Promise<void>> };
const running = () => (runtime.flowplanMeetingJobs ??= new Map());
function launchProcessing(user: Identity, meetingId: string, language: MeetingLanguage) {
  if (running().has(meetingId)) return;
  const job = processMeeting(user, meetingId, language)
    .catch((error) => console.error("Besprechung konnte nicht verarbeitet werden:", (error as Error)?.message))
    .finally(() => running().delete(meetingId));
  running().set(meetingId, job);
}
// Tests wait for the background work.
export const meetingJob = (meetingId: string) => running().get(meetingId) ?? Promise.resolve();

async function setStatus(meetingId: string, status: string, error: string | null = null, detail: string | null = null) {
  await run(
    "UPDATE meetings SET status=?,error=?,error_detail=?,updated_at=? WHERE id=?",
    status,
    error ? error.slice(0, 500) : null,
    detail ? detail.slice(0, 1000) : null,
    Date.now(),
    meetingId,
  );
}
// The message people see and the detail administrators see.
function failure(error: unknown, fallback: string) {
  const e = error as Error & { code?: string; cause?: { code?: string } };
  if (error instanceof TranscribeError) return { message: error.message, detail: error.detail };
  if (error instanceof HttpError) return { message: error.message, detail: null };
  const code = e?.code || e?.cause?.code;
  return { message: fallback, detail: `${code ? `${code}: ` : ""}${e?.message || String(error)}` };
}
async function saveSession(meetingId: string, n: number, change: (s: MeetingSession) => void) {
  await transaction(async () => {
    await lockFor(`meeting:${meetingId}`);
    const row = await meetingRow(meetingId);
    if (!row) return;
    const sessions = sessionsOf(row);
    const s = sessions.find((x) => x.n === n);
    if (s) change(s);
    const total = sessions.reduce((sum, x) => sum + (x.state === "recording" ? 0 : x.durationMs), 0);
    await run("UPDATE meetings SET sessions=?,duration_ms=?,updated_at=? WHERE id=?", JSON.stringify(sessions), total, Date.now(), meetingId);
  });
}

// Changes one part of the block in the stored document (as an edit of
// `actor`), then the tasks are collected and open editors get the change.
async function editPart(actor: Identity, row: MeetingRow, partName: string, change: (meeting: PMNode, part: PMNode) => PMNode[] | null) {
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", row.page_id))!;
  let publish = () => {};
  let missing = false;
  await transaction(async () => {
    const changed = await rewriteDocument(row.page_id, row.row_id, actor.id, (doc) => {
      const found = findMeeting(doc, row.id);
      const part = found && partOf(found.node, partName);
      if (!found || !part) {
        missing = true;
        return null;
      }
      const nodes = change(found.node, part.node);
      if (!nodes) return null;
      const schema = rewriteSchema();
      const from = found.pos + 1 + part.offset;
      const replacement = schema.nodes[partName].create(part.node.attrs, Fragment.fromArray(nodes));
      return new Transform(doc).replaceWith(from, from + part.node.nodeSize, replacement).doc;
    });
    if (changed) {
      publish = changed.publish;
      await syncDocTasks(actor, page, row.row_id, changed.ydoc);
      await recordPageEdit(actor, row.page_id);
    }
  }, actor);
  publish();
  if (missing) throw new HttpError(404, "Der Besprechungsblock wurde aus der Seite entfernt.");
}

// One track of a session as audio: put together from its pieces, or the
// kept file when it is transcribed again.
async function trackAudio(row: MeetingRow, session: MeetingSession, track: MeetingTrack) {
  if (session.source === "kept") {
    const kept = audioOf(row).find((a) => a.session === session.n && a.track === track);
    if (!kept) throw new HttpError(409, "Für diese Besprechung ist kein Audio mehr gespeichert.");
    const data = await readFile(resolve(dataDir(), "uploads", kept.fileId)).catch(() => {
      throw new HttpError(409, "Für diese Besprechung ist kein Audio mehr gespeichert.");
    });
    return new Blob([new Uint8Array(data)], { type: kept.mime });
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < (session.parts[track] || 0); i++) parts.push(new Uint8Array(await readFile(resolve(trackDir(row.id, session.n, track), String(i)))));
  return new Blob(parts as BlobPart[], { type: session.mime });
}
const extension = (mime: string) => ({ "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/aac": "aac", "audio/ogg": "ogg" })[mime] || "webm";

// ---- Transcribing while recording ----

// Per track of a session that records live: which clusters of the WebM
// its pieces hold (lib/webm.ts), up to which piece it is transcribed, up to
// which time the transcript is final, the final segments (times in the
// track) – next to the pieces, so a restart goes on from there.
type LiveState = {
  header: number;
  tick: number;
  scanned: number;
  clusters: { chunk: number; offset: number; time: number }[];
  done: number;
  until: number;
  segments: TranscriptSegment[];
  errors: number;
  failed?: string;
};
export const liveEnabled = () => !/^(0|off|false|no)$/i.test(process.env.MEETING_LIVE_TRANSCRIPTION?.trim() || "");
const liveFile = (meetingId: string, n: number, track: MeetingTrack) => resolve(stagingDir(meetingId, n), `${track}.live.json`);
const transcriptFile = (meetingId: string, n: number, track: MeetingTrack) => resolve(stagingDir(meetingId, n), `${track}.transcript.json`);
const liveRuntime = globalThis as typeof globalThis & { flowplanMeetingLive?: Map<string, { job: Promise<void>; again: boolean }> };
const liveJobs = () => (liveRuntime.flowplanMeetingLive ??= new Map());

// One live job per track at a time; pieces that arrive meanwhile make it
// run once more.
function scheduleLive(meetingId: string, n: number, track: MeetingTrack, prompt: string) {
  const key = `${meetingId}:${n}:${track}`;
  const current = liveJobs().get(key);
  if (current) {
    current.again = true;
    return;
  }
  const entry = { again: false, job: Promise.resolve() };
  entry.job = (async () => {
    do {
      entry.again = false;
      await liveStep(meetingId, n, track, false, prompt).catch((error) => console.error("Besprechung: Live-Transkription fehlgeschlagen", (error as Error)?.message));
    } while (entry.again);
  })().finally(() => liveJobs().delete(key));
  liveJobs().set(key, entry);
}
// Tests (and the processing) wait for the live work of a meeting.
export async function meetingLiveJob(meetingId: string) {
  await Promise.all([...liveJobs()].filter(([key]) => key.startsWith(`${meetingId}:`)).map(([, entry]) => entry.job));
}

// Transcribes the window from a little before `until` to the last piece
// that arrived in order; `final` also takes the window's last segment.
// Throws only when `final` (the caller then transcribes the whole track).
async function liveStep(meetingId: string, n: number, track: MeetingTrack, final: boolean, prompt: string): Promise<LiveState> {
  const file = liveFile(meetingId, n, track);
  const state = parse<LiveState | null>(await readFile(file, "utf8").catch(() => ""), null) ?? {
    header: 0,
    tick: 0.001,
    scanned: 0,
    clusters: [],
    done: -1,
    until: 0,
    segments: [],
    errors: 0,
  };
  const save = async () => {
    await mkdir(stagingDir(meetingId, n), { recursive: true });
    await writeFile(file, JSON.stringify(state));
  };
  if (state.failed) {
    if (final) throw new Error(state.failed);
    return state;
  }
  const have = await stagedParts(meetingId, n, track);
  let last = -1;
  while (have[last + 1] === last + 1) last++;
  if (last < 0 || (!final && last <= state.done)) {
    if (final && last < 0) throw new Error("no pieces");
    return state;
  }
  const piece = async (i: number) => new Uint8Array(await readFile(resolve(trackDir(meetingId, n, track), String(i))));
  const first = await piece(0);
  if (!state.header) {
    const head = webmHeader(first);
    if (!head) {
      state.failed = "the first piece has no WebM header";
      await save();
      if (final) throw new Error(state.failed);
      return state;
    }
    state.header = head.header.length;
    state.tick = head.tick;
    state.clusters = head.clusters.map((c) => ({ chunk: 0, ...c }));
    state.scanned = 1;
  }
  for (let i = state.scanned; i <= last; i++) {
    state.clusters.push(...webmClusters(await piece(i)).map((c) => ({ chunk: i, ...c })));
    state.scanned = i + 1;
  }
  // The window starts at the last cluster at least two seconds before
  // `until` (some context for the recogniser), at first at the start.
  const before = state.clusters.filter((c) => c.chunk <= last && c.time * state.tick <= state.until - 2);
  const start = state.until > 0 && before.length ? before[before.length - 1] : { chunk: 0, offset: state.header, time: 0 };
  const pieces: Uint8Array[] = [];
  for (let i = start.chunk; i <= last; i++) pieces.push(i === 0 ? first : await piece(i));
  const offset = start.time * state.tick;
  try {
    const heard = await transcribe(webmWindow(first.subarray(0, state.header), pieces, start.offset, start.chunk === 0), `besprechung-${n}-${track}-live.webm`, { prompt });
    const window = (heard.segments.length ? heard.segments : heard.text ? [{ start: 0, end: heard.duration ?? 0, text: heard.text }] : []).map((s) => ({
      ...s,
      start: s.start + offset,
      end: Math.max(s.end, s.start) + offset,
    }));
    const merged = mergeLiveWindow(state.segments, state.until, window, final);
    const quiet = !window.some((s) => s.start >= state.until - 0.3);
    state.segments = merged.committed;
    state.until = merged.until;
    // Nothing said in the window: the next one need not go back further.
    const lastCluster = state.clusters.filter((c) => c.chunk <= last).at(-1);
    if (quiet && !final && lastCluster) state.until = Math.max(state.until, lastCluster.time * state.tick - 2);
    state.done = last;
    state.errors = 0;
  } catch (error) {
    state.errors++;
    // A service that fails again and again: the whole track at the end.
    if (state.errors >= 3) state.failed = (error as TranscribeError).detail || (error as Error).message;
    await save();
    if (final) throw error;
    return state;
  }
  await save();
  return state;
}

// ---- Transcribing a session ----

type TrackResult = { segments: TranscriptSegment[]; duration?: number };
// One track's transcript: kept from an earlier attempt, from the live
// windows (their last one now), or the whole track.
async function trackTranscript(row: MeetingRow, session: MeetingSession, track: MeetingTrack, prompt: string): Promise<TrackResult> {
  const cached = parse<TrackResult | null>(await readFile(transcriptFile(row.id, session.n, track), "utf8").catch(() => ""), null);
  if (cached && Array.isArray(cached.segments)) return cached;
  let result: TrackResult | null = null;
  if (session.live && !session.source && session.mime === "audio/webm" && liveEnabled()) {
    await meetingLiveJob(row.id);
    try {
      result = { segments: (await liveStep(row.id, session.n, track, true, prompt)).segments };
    } catch (error) {
      console.error("Besprechung: Live-Transkription unvollständig, die ganze Spur wird transkribiert", (error as Error)?.message);
    }
  }
  if (!result) {
    const transcript = await transcribe(await trackAudio(row, session, track), `besprechung-${session.n}-${track}.${extension(session.mime)}`, { prompt });
    result = {
      // A service without segments: the text as one passage.
      segments: transcript.segments.length
        ? transcript.segments
        : transcript.text
          ? [{ start: 0, end: transcript.duration ?? session.durationMs / 1000, text: transcript.text }]
          : [],
      ...(transcript.duration !== undefined ? { duration: transcript.duration } : {}),
    };
  }
  await mkdir(stagingDir(row.id, session.n), { recursive: true });
  await writeFile(transcriptFile(row.id, session.n, track), JSON.stringify(result));
  return result;
}

// The transcript of one session as meeting segments: speaker names from
// the tracks, made-up lines marked, echoes of the call in the microphone
// dropped, times after the earlier sessions.
export function sessionSegments(
  session: Pick<MeetingSession, "n" | "offsetMs" | "tracks" | "byName">,
  results: Partial<Record<MeetingTrack, TranscriptSegment[]>>,
  language: MeetingLanguage,
): { segments: MeetingSegment[]; echoes: number } {
  const split = session.tracks.includes("me") && session.tracks.includes("others");
  const offset = session.offsetMs / 1000;
  let me = markHallucinations(results.me || []);
  const others = markHallucinations(results.others || []);
  let echoes = 0;
  if (split && others.length) {
    const cleaned = removeEchoes(
      others.filter((s) => !s.hallucination),
      me,
    );
    me = cleaned.kept;
    echoes = cleaned.dropped;
  }
  const byTrack: [MeetingTrack, TranscriptSegment[]][] = [
    ["me", me],
    ["others", others],
    ["mixed", markHallucinations(results.mixed || [])],
  ];
  const segments: MeetingSegment[] = [];
  for (const [track, list] of byTrack) {
    const numbers = speakerNumbers(list);
    list.forEach((s, i) =>
      segments.push({
        sid: segmentId(session.n, track, i),
        start: s.start + offset,
        end: Math.max(s.end, s.start) + offset,
        text: s.text,
        speaker: speakerLabel(track, s.speaker, numbers, { me: session.byName, language, split }),
        track,
        session: session.n,
        ...(s.hallucination ? { hallucination: true } : {}),
        hash: segmentHash(s.text),
      }),
    );
  }
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return { segments, echoes };
}
// "Name: text" lines of a transcript given as text → segments (no times).
export function textSegments(text: string, session: number): MeetingSegment[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5000)
    .map((line, i) => {
      const m = /^([^:\n]{1,60}):\s+(.+)$/.exec(line);
      return { sid: segmentId(session, "mixed", i), start: 0, end: 0, text: (m ? m[2] : line).slice(0, 5000), speaker: m ? m[1].trim() : "", track: "mixed" as const, session };
    });
}

// The segments of a session replace its earlier ones in the transcript;
// with `keepEdited` passages people corrected stay, and new segments at
// their time are left out.
export function replaceSessionSegments(existing: MeetingSegment[], session: number, fresh: MeetingSegment[], keepEdited: boolean) {
  const others = existing.filter((s) => s.session !== session);
  const kept = keepEdited ? existing.filter((s) => s.session === session && isEdited(s)) : [];
  const used = new Set(kept.map((s) => s.sid));
  const added = fresh
    .filter((s) => !kept.some((k) => overlapSeconds(k, s) > 0))
    .map((s) => {
      let sid = s.sid;
      while (used.has(sid)) sid += "r";
      used.add(sid);
      return { ...s, sid };
    });
  return [...others, ...kept, ...added].sort((a, b) => a.start - b.start || a.end - b.end);
}

async function processMeeting(actor: Identity, meetingId: string, language: MeetingLanguage) {
  let row = await meetingRow(meetingId);
  if (!row) return;
  const settings = await meetingSettings(row.workspace_id);
  const prompt = whisperPrompt(settings.glossary);
  for (const session of sessionsOf(row).filter((s) => s.state === "uploaded")) {
    let segments: MeetingSegment[];
    // Uploaded files come without a length: the transcript's counts.
    let heardSeconds = 0;
    try {
      if (session.kind === "text") {
        segments = textSegments(await readFile(resolve(trackDir(row.id, session.n, "mixed"), "0"), "utf8"), session.n);
      } else {
        const results: Partial<Record<MeetingTrack, TranscriptSegment[]>> = {};
        // One track after the other; a finished one is kept when the next fails.
        for (const track of session.tracks) {
          const transcript = await trackTranscript(row, session, track, prompt);
          heardSeconds = Math.max(heardSeconds, transcript.duration ?? 0, ...transcript.segments.map((s) => s.end));
          results[track] = transcript.segments;
        }
        // The language of the speaker names: the transcript's own when clear.
        const spoken = Object.values(results)
          .flat()
          .filter((s) => !s!.hallucination)
          .map((s) => s!.text)
          .join(" ")
          .slice(0, 5000);
        language = (guessLanguage(spoken) as MeetingLanguage | null) || language;
        segments = sessionSegments(session, results, language).segments;
      }
      const keepEdited = session.source === "kept" && session.keepEdited !== false;
      await editPart(actor, row, "meetingTranscript", (meeting) => {
        const next = replaceSessionSegments(segmentsOf(meeting), session.n, segments, keepEdited);
        return segmentNodes(next).map((json) => rewriteSchema().nodeFromJSON(json));
      });
    } catch (error) {
      const { message, detail } = failure(error, "Die Transkription ist fehlgeschlagen.");
      if (!(error instanceof HttpError)) console.error("Besprechung: Transkription fehlgeschlagen", detail);
      await saveSession(row.id, session.n, (s) => (s.state = "failed"));
      await setStatus(row.id, "failed", message, detail);
      return;
    }
    await keepOrDropAudio(actor, row, session, settings);
    await saveSession(row.id, session.n, (s) => {
      s.state = "done";
      delete s.source;
      delete s.keepEdited;
      if (!s.durationMs && heardSeconds) s.durationMs = Math.round(Math.min(heardSeconds * 1000, MEETING_MAX_SECONDS * 1000 - s.offsetMs));
    });
  }
  row = (await meetingRow(meetingId))!;
  // The summary: at least a minute of audio, and the AI available.
  await setStatus(row.id, "summarizing");
  try {
    const result = await writeSummary(actor, row, { language });
    await fillRecordProperties(actor, row);
    await setStatus(row.id, "done", result.note);
  } catch (error) {
    const { message, detail } = failure(error, "Die Zusammenfassung ist fehlgeschlagen.");
    if (!(error instanceof HttpError)) console.error("Besprechung: Zusammenfassung fehlgeschlagen", detail);
    await fillRecordProperties(actor, row).catch(() => {});
    // The transcript is there; only the summary is missing (can be redone).
    await setStatus(row.id, "done", message, detail);
  }
}

// After a successful transcript: the audio goes (default) or is kept as a
// file of the page, deleted after the workspace's number of days.
async function keepOrDropAudio(actor: Identity, row: MeetingRow, session: MeetingSession, settings: MeetingSettings) {
  try {
    // Transcribed again from the kept audio: it is kept already.
    if (settings.retention === "delete" || session.kind === "text" || session.source === "kept") return;
    const page = (await one<Page>("SELECT * FROM pages WHERE id=?", row.page_id))!;
    const kept: KeptAudio[] = [];
    for (const track of session.tracks) {
      const audio = Buffer.from(await (await trackAudio(row, session, track)).arrayBuffer());
      const fid = newId();
      const dir = resolve(dataDir(), "uploads");
      mkdirSync(dir, { recursive: true });
      const final = resolve(dir, fid),
        part = `${final}.part`;
      writeFileSync(part, audio);
      try {
        await transaction(async () => {
          await enforceQuota(page.workspace_id, audio.length);
          await enforceUserStorage(actor, audio.length, page.workspace_id);
          renameSync(part, final);
          onTransactionRollback(() => {
            try {
              renameSync(final, part);
            } catch {}
          });
          const name = sanitizeFileName(`${ct("Besprechung", "Meeting")}-${session.n}-${track}.${extension(session.mime)}`, `besprechung.${extension(session.mime)}`);
          await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, page.id, name, session.mime, audio.length, actor.id);
        }, actor);
        kept.push({ session: session.n, track, fileId: fid, mime: session.mime });
      } catch {
        // No room: the transcript stays, the audio goes.
        if (existsSync(part)) await rm(part, { force: true });
      }
    }
    if (!kept.length) return;
    await transaction(async () => {
      await lockFor(`meeting:${row.id}`);
      const current = (await meetingRow(row.id))!;
      const audio = [...audioOf(current).filter((a) => a.session !== session.n), ...kept];
      const until = settings.retention === "days" ? Date.now() + settings.retentionDays * 86_400_000 : null;
      await run("UPDATE meetings SET audio=?,audio_until=?,updated_at=? WHERE id=?", JSON.stringify(audio), until, Date.now(), row.id);
    });
  } finally {
    await rm(stagingDir(row.id, session.n), { recursive: true, force: true }).catch(() => {});
    // The meeting's folder once no session is staged any more.
    await rmdir(resolve(stagingRoot(), row.id)).catch(() => {});
  }
}

// ---- Summary ----

const MAX_PROMPT_TRANSCRIPT = 180_000;
async function readers(page: Page, rowId: string | null): Promise<Person[]> {
  const people = await all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.disabled=0",
    page.workspace_id,
  );
  const out: Person[] = [];
  // Only who may read the page (and the record) becomes an owner.
  for (const p of people) if (await mayHear(p.id, page, rowId)) out.push(p);
  return out;
}
const today = () => new Date().toISOString().slice(0, 10);

// Writes the summary part from the transcript and the notes as they are
// now (people may add to them after the meeting); with fewer
// than MIN_SUMMARY_SECONDS of audio it says so instead. `instructions`
// overrides the block's own (re-generating with other instructions).
async function writeSummary(actor: Identity, row: MeetingRow, options: { language: MeetingLanguage; instructions?: MeetingPreset; prompt?: string }) {
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", row.page_id))!;
  const found = findMeeting(await readDocument(row.page_id, row.row_id), row.id);
  if (!found) throw new HttpError(404, "Der Besprechungsblock wurde aus der Seite entfernt.");
  // What the recogniser made up is no part of the meeting.
  const segments = segmentsOf(found.node).filter((s) => !s.hallucination);
  const sessions = sessionsOf(row);
  const textOnly = sessions.length > 0 && sessions.every((s) => s.kind === "text");
  const spoken = segments.map((s) => s.text).join(" ");
  const language = (guessLanguage(spoken.slice(0, 5000)) as MeetingLanguage | null) || options.language;
  const labels = MEETING_TEXT[language];
  const say = async (text: string) => {
    await editPart(actor, row, "meetingSummary", () => [rewriteSchema().nodeFromJSON({ type: "paragraph", content: [{ type: "text", text }] })]);
    return { note: text };
  };
  if (!segments.length) return await say(labels.noSpeech);
  if (!textOnly && (Number(row.duration_ms) || 0) < MIN_SUMMARY_SECONDS * 1000) return await say(labels.tooShort);
  const ai = await resolveAi(actor, "summarize", { workspaceId: page.workspace_id });
  if (!ai.ok) return { note: AI_REASON_TEXT[ai.reason][0] };
  // Long transcripts: the first part that fits the prompt.
  let size = 0;
  const used = segments.filter((s) => (size += s.text.length + 40) <= MAX_PROMPT_TRANSCRIPT);
  const instructions = options.instructions ?? (isMeetingPreset(found.node.attrs.instructions) ? found.node.attrs.instructions : "auto");
  const custom = options.prompt ?? String(found.node.attrs.prompt || "");
  const agendaPart = partOf(found.node, "meetingAgenda");
  const attendees = parse<{ name?: string }[]>(String(found.node.attrs.attendees || "[]"), [])
    .map((a) => String(a?.name || "").trim())
    .filter(Boolean);
  await setStatus(row.id, "summarizing");
  const summary = await aiJson(
    actor,
    "summarize",
    meetingPrompt({
      segments: used,
      agenda: agendaPart ? agendaPart.node.textBetween(0, agendaPart.node.content.size, "\n", " ") : "",
      title: String(found.node.attrs.title || ""),
      date: String(found.node.attrs.date || ""),
      attendees,
      language,
      instructions: presetPrompt(instructions, custom),
      today: today(),
    }),
    meetingSummarySchema,
    { workspaceId: page.workspace_id, pageId: page.id, rowId: row.row_id },
  );
  const { nodes } = summaryNodes(summary, used, { language, members: await readers(page, row.row_id) });
  await editPart(actor, row, "meetingSummary", () => nodes.map((json) => rewriteSchema().nodeFromJSON(json)));
  await run("UPDATE meetings SET summarized_at=? WHERE id=?", Date.now(), row.id);
  return { note: null };
}

const regenerateInput = z.object({
  instructions: z.enum(["auto", "status", "oneonone", "workshop", "customer", "custom"]).optional(),
  prompt: z.string().max(4000).optional(),
  language: z.enum(["de", "en", "fr", "zh"]).optional(),
});
// The summary again (other instructions), without transcribing again.
export async function regenerateSummary(user: Identity, meetingId: string, input: unknown) {
  await requireMeetingCaller(user);
  const b = regenerateInput.parse(input ?? {});
  const { row } = await meetingFor(user, meetingId, true);
  if (row.status === "transcribing" || row.status === "summarizing" || row.status === "recording") throw new HttpError(409, "Die Besprechung wird gerade verarbeitet.");
  const ai = await resolveAi(user, "summarize", { workspaceId: row.workspace_id });
  if (!ai.ok) throw new HttpError(ai.reason === "no-provider" ? 409 : 403, AI_REASON_TEXT[ai.reason][0]);
  try {
    const result = await writeSummary(user, row, { language: meetingLanguage(b.language || languageOfLocale()), instructions: b.instructions, prompt: b.prompt });
    await setStatus(row.id, "done", result.note);
  } catch (error) {
    await setStatus(row.id, "done", error instanceof HttpError ? error.message : "Die Zusammenfassung ist fehlgeschlagen.");
    throw error;
  }
  return await meetingStatus(user, row.id);
}

// Transcribes the kept audio again (another model, a better glossary) and
// writes the summary anew; the earlier summary stays in the page's
// versions. Passages people corrected stay (and new segments at their time
// are left out) unless `force`. `dryRun` only counts them, so the editor
// can ask first ("N corrected passages").
const retranscribeInput = z.object({
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  language: z.enum(["de", "en", "fr", "zh"]).optional(),
});
export async function retranscribeMeeting(user: Identity, meetingId: string, input: unknown) {
  await requireMeetingCaller(user);
  const b = retranscribeInput.parse(input ?? {});
  const { row, page } = await meetingFor(user, meetingId, true);
  if (!transcriptionEnabled()) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
  if (running().has(row.id) || ["recording", "transcribing", "summarizing"].includes(row.status)) throw new HttpError(409, "Die Besprechung wird gerade verarbeitet.");
  const kept = audioOf(row);
  const redo = sessionsOf(row).filter((s) => s.kind !== "text" && s.state === "done" && s.tracks.every((t) => kept.some((a) => a.session === s.n && a.track === t)));
  if (!redo.length) throw new HttpError(409, "Für diese Besprechung ist kein Audio mehr gespeichert.");
  const found = findMeeting(await readDocument(page.id, row.row_id), row.id);
  if (!found) throw new HttpError(404, "Der Besprechungsblock wurde aus der Seite entfernt.");
  const numbers = new Set(redo.map((s) => s.n));
  const edited = segmentsOf(found.node).filter((s) => numbers.has(s.session) && isEdited(s)).length;
  if (b.dryRun) return { ...(await meetingStatus(user, row.id)), edited, keepsEdited: !b.force, started: false };
  await transaction(async () => {
    await lockFor(`meeting:${row.id}`);
    const current = (await meetingRow(row.id))!;
    if (current.status === "transcribing" || current.status === "summarizing" || current.status === "recording") throw new HttpError(409, "Die Besprechung wird gerade verarbeitet.");
    const sessions = sessionsOf(current);
    for (const s of sessions)
      if (numbers.has(s.n)) {
        s.state = "uploaded";
        s.source = "kept";
        s.keepEdited = !b.force;
      }
    await run("UPDATE meetings SET sessions=?,status='transcribing',error=NULL,error_detail=NULL,updated_at=? WHERE id=?", JSON.stringify(sessions), Date.now(), row.id);
    await audit(user.id, "meeting.retranscribe", page.id, row.id);
  }, user);
  // Nothing from an earlier attempt counts.
  for (const n of numbers) for (const track of TRACKS) await rm(transcriptFile(row.id, n, track), { force: true }).catch(() => {});
  launchProcessing(user, row.id, meetingLanguage(b.language || languageOfLocale()));
  return { ...(await meetingStatus(user, row.id)), edited, keepsEdited: !b.force, started: true };
}

// "Frag diese Besprechung": a question about this block's transcript and
// agenda, answered as a text stream (like /api/ai/ask) with [S12] for the
// segments it relies on.
const askInput = z.object({
  question: z.string().trim().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) })).max(20).default([]),
});
export async function askMeeting(user: Identity, meetingId: string, input: unknown, signal: AbortSignal) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  await requireTokenAi(user);
  const b = askInput.parse(input);
  const { row, page } = await meetingFor(user, meetingId, false);
  const found = findMeeting(await readDocument(page.id, row.row_id), row.id);
  if (!found) throw new HttpError(404, "Besprechung nicht gefunden.");
  const segments = segmentsOf(found.node).filter((s) => !s.hallucination);
  let size = 0;
  const used = segments.filter((s) => (size += s.text.length + 40) <= MAX_PROMPT_TRANSCRIPT);
  const agendaPart = partOf(found.node, "meetingAgenda");
  const agenda = agendaPart ? agendaPart.node.textBetween(0, agendaPart.node.content.size, "\n", " ").trim() : "";
  const system = [
    "You answer questions about one meeting, only from its transcript and its agenda/notes below. If they do not contain the answer, say so.",
    "Answer in the language of the question, concisely. After each statement cite the transcript segments it relies on as [S12] (several: [S3][S7]). Never invent segment numbers.",
    `Meeting: ${String(found.node.attrs.title || "")}${found.node.attrs.date ? ` (${found.node.attrs.date})` : ""}`,
    agenda ? `Agenda and notes:\n${agenda}` : "",
    `Transcript:\n${used.map((s, i) => `S${i + 1} [${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, "0")}]${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const response = await aiStreamResponse(
    user,
    "ask",
    { system, messages: [...b.history, { role: "user", content: b.question }], maxTokens: 1500, temperature: 0.2 },
    { workspaceId: page.workspace_id, pageId: page.id, rowId: row.row_id, signal },
  );
  // S-numbers → segment ids, so the answer's chips can open the passage.
  response.headers.set("X-Flowplan-Segments", Buffer.from(JSON.stringify(used.map((s) => s.sid))).toString("base64"));
  return response;
}

// ---- Record properties (a meeting inside a record of a database) ----

const NAMES = {
  date: /^(datum|date|termin|when|wann)$/i,
  attendees: /(teilnehm|attendee|participant|personen|people)/i,
  duration: /(dauer|duration|länge|length|minuten|minutes)/i,
  status: /^status$/i,
};
const DONE = /^(erledigt|done|abgeschlossen|completed|fertig|protokolliert|transkribiert)$/i;
// Date, attendees (person), duration (minutes) and status of the record,
// when the database has such properties the person may change.
export async function fillRecordProperties(actor: Identity, row: MeetingRow) {
  if (!row.row_id) return;
  const page = (await one<Page>("SELECT * FROM pages WHERE id=?", row.page_id))!;
  const record = await one<{ id: string; version: number; cells: string }>("SELECT id,version,cells FROM rows WHERE id=? AND page_id=?", row.row_id, page.id);
  if (!record) return;
  const found = findMeeting(await readDocument(page.id, row.row_id), row.id);
  if (!found) return;
  const fields: Field[] = (await readableDatabase(actor, page, await database(page.id))).fields;
  const writable = new Set((await writableFields(actor, page)).map((f) => f.id));
  const usable = fields.filter((f) => writable.has(f.id));
  const cells = parse<Record<string, unknown>>(record.cells, {});
  const empty = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
  const patch: Record<string, unknown> = {};
  const date = String(found.node.attrs.date || "") || new Date(Number(row.created_at)).toISOString().slice(0, 10);
  const dateField = usable.find((f) => f.type === "date" && NAMES.date.test(f.name.trim())) || usable.find((f) => f.type === "date");
  if (dateField && empty(cells[dateField.id])) patch[dateField.id] = date;
  const people = parse<{ id?: string }[]>(String(found.node.attrs.attendees || "[]"), [])
    .map((a) => a?.id)
    .filter((v): v is string => typeof v === "string" && !!v);
  const attendeeField = usable.find((f) => f.type === "person" && NAMES.attendees.test(f.name));
  // A person property holds one member: the first attendee who is one.
  if (attendeeField && people.length && empty(cells[attendeeField.id])) patch[attendeeField.id] = people[0];
  const durationField = usable.find((f) => f.type === "number" && NAMES.duration.test(f.name));
  if (durationField) patch[durationField.id] = Math.max(1, Math.round((Number(row.duration_ms) || 0) / 60_000));
  const statusField = usable.find((f) => f.type === "select" && NAMES.status.test(f.name.trim()));
  const doneOption = statusField?.options?.find((o) => DONE.test(o.trim()));
  if (statusField && doneOption) patch[statusField.id] = doneOption;
  if (!Object.keys(patch).length) return;
  // Each property on its own: one that does not take the value is left out.
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch))
    try {
      Object.assign(valid, await validateCellPatch(actor, page, fields, { [key]: value }));
    } catch {}
  if (!Object.keys(valid).length) return;
  await command(actor, { action: "row.update", pageId: page.id, rowId: record.id, version: record.version, cells: valid });
}

// ---- Audio retention ----

// Kept audio past its date, and pieces of recordings nobody finished.
export async function sweepMeetingAudio(now = Date.now()) {
  const due = await all<MeetingRow>("SELECT * FROM meetings WHERE audio_until IS NOT NULL AND audio_until<=?", now);
  for (const row of due) {
    const files = audioOf(row);
    const existing = files.length
      ? await all<{ id: string; page_id: string }>(`SELECT id,page_id FROM files WHERE id IN (${files.map(() => "?").join(",")})`, ...files.map((f) => f.fileId))
      : [];
    await transaction(async () => {
      await purgeFiles(existing);
      await run("UPDATE meetings SET audio='[]',audio_until=NULL,updated_at=? WHERE id=?", now, row.id);
    });
  }
  // Staged pieces older than a week (the browser keeps its own copy).
  for (const entry of await readdir(stagingRoot(), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(stagingRoot(), entry.name);
    const info = await stat(dir).catch(() => null);
    if (info && now - info.mtimeMs > 7 * 86_400_000 && !running().has(entry.name)) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return due.length;
}
// Removes the kept audio of a meeting now (the block's settings).
export async function deleteMeetingAudio(user: Identity, meetingId: string) {
  const { row } = await meetingFor(user, meetingId, true);
  const files = audioOf(row);
  const existing = files.length
    ? await all<{ id: string; page_id: string }>(`SELECT id,page_id FROM files WHERE id IN (${files.map(() => "?").join(",")})`, ...files.map((f) => f.fileId))
    : [];
  await transaction(async () => {
    await purgeFiles(existing);
    await run("UPDATE meetings SET audio='[]',audio_until=NULL,updated_at=? WHERE id=?", Date.now(), row.id);
    await audit(user.id, "meeting.audio.delete", row.page_id, row.id);
  }, user);
  return await meetingStatus(user, row.id);
}

export function startMeetingWorker() {
  const timers = globalThis as typeof globalThis & { flowplanMeetingTimer?: ReturnType<typeof setInterval> };
  if (timers.flowplanMeetingTimer) return;
  const tick = async () => {
    try {
      await sweepMeetingAudio();
    } catch (error) {
      console.error("Besprechungsaudio konnte nicht aufgeräumt werden", error);
    }
  };
  timers.flowplanMeetingTimer = setInterval(() => void tick(), 60 * 60_000);
  timers.flowplanMeetingTimer.unref();
  void tick();
}

// ---- API: a meeting from uploaded audio (POST /api/meetings, MCP) ----

export type MeetingUpload = {
  title?: string;
  pageId?: string;
  databaseId?: string;
  attendees?: string[];
  instructions?: string;
  prompt?: string;
  date?: string;
  consent?: boolean;
  language?: string;
  // Audio per track ("mixed": one file with everyone), or a transcript as text.
  audio?: Partial<Record<MeetingTrack, { data: Uint8Array; mime: string; name: string; durationMs?: number }>>;
  transcript?: string;
};
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|x-m4a|m4a|mpeg|mp3|wav|x-wav|wave|aac|x-aac|flac)$/;
const AUDIO_EXTENSIONS: Record<string, string> = { webm: "audio/webm", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", flac: "audio/flac" };
export function audioMime(type: string, name: string) {
  const base = type.split(";")[0].trim().toLowerCase();
  if (AUDIO_TYPES.test(base)) return base === "audio/x-m4a" || base === "audio/m4a" ? "audio/mp4" : base === "audio/mp3" ? "audio/mpeg" : base;
  return AUDIO_EXTENSIONS[name.toLowerCase().split(".").pop() || ""] || null;
}

// Creates the block (at the end of a page, or as a new record of a
// database with the block as its document), stores the audio as one
// session and starts the processing. Answers with the meeting's id and
// where to ask for its status.
export async function createMeetingFromUpload(user: Identity, input: MeetingUpload) {
  await requireMeetingCaller(user);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  const tracks = (Object.keys(input.audio || {}) as MeetingTrack[]).filter((t) => input.audio?.[t]);
  const text = input.transcript?.trim() || "";
  if (!tracks.length && !text) throw new HttpError(400, "Keine Aufnahme.");
  if (tracks.length && text) throw new HttpError(400, "Entweder Audio oder ein Transkript.");
  if (tracks.length && !transcriptionEnabled()) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
  if (tracks.includes("mixed") && tracks.length > 1) throw new HttpError(400, "Ungültige Eingabe.");
  if (!!input.pageId === !!input.databaseId) throw new HttpError(400, "Bitte genau eine Seite oder Datenbank angeben.");
  const mimes = new Set(tracks.map((t) => input.audio![t]!.mime));
  if (mimes.size > 1) throw new HttpError(400, "Alle Spuren brauchen dasselbe Format.");
  for (const t of tracks) if (input.audio![t]!.data.length > transcribeMaxBytes()) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  const title = (input.title || "").trim().slice(0, 300) || ct(MEETING_TEXT.de.title, MEETING_TEXT.en.title);
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : new Date().toISOString().slice(0, 10);
  const meetingId = newId();
  const instructions = isMeetingPreset(input.instructions) ? input.instructions : undefined;
  let pageId: string, rowId: string | null = null;
  const pageOrDb = await requirePage(user, uuid.parse(input.pageId || input.databaseId), true);
  const settings = await meetingSettings(pageOrDb.workspace_id);
  if (settings.consentRequired && !input.consent) throw new HttpError(428, "Bitte bestätige zuerst, dass alle Teilnehmenden der Aufnahme zugestimmt haben.");
  const team = await all<{ id: string; name: string; email: string }>(
    "SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.disabled=0",
    pageOrDb.workspace_id,
  );
  const attendees = (input.attendees || [])
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((a) => {
      const wanted = a.toLowerCase();
      const member = team.find((m) => m.id === a || m.email.toLowerCase() === wanted || m.name.toLowerCase() === wanted);
      return member ? { id: member.id, name: member.name } : { name: a.slice(0, 200) };
    });
  const html = meetingHtml({ meetingId, title, date, attendees, instructions: instructions || settings.instructions, prompt: input.prompt ?? (instructions ? "" : settings.prompt) });
  if (input.pageId) {
    const page = await target(user, pageOrDb.id, null, true);
    if (page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
    const { appendHtmlToPage } = await import("./mcp");
    await appendHtmlToPage(user, { pageId: page.id, html });
    pageId = page.id;
  } else {
    if (pageOrDb.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
    await requireUnlocked(user, pageOrDb);
    if (await isEncryptedPage(pageOrDb)) throw new HttpError(409, "Besprechungsnotizen sind in verschlüsselten Bereichen nicht verfügbar.");
    const fields = (await database(pageOrDb.id)).fields;
    const titleField = fields[0];
    const created = (await command(user, { action: "row.create", pageId: pageOrDb.id, cells: titleField ? { [titleField.id]: title } : {} })) as { id: string };
    rowId = created.id;
    pageId = pageOrDb.id;
    const blockNode = rewriteSchema().nodeFromJSON((htmlJson(html) as { content: Record<string, unknown>[] }).content[0]);
    await ensureRowDocument((await one("SELECT * FROM rows WHERE id=?", rowId)) as never);
    await transaction(async () => {
      const changed = await rewriteDocument(pageId, rowId, user.id, (doc) => {
        const empty = doc.childCount === 1 && doc.firstChild!.type.name === "paragraph" && !doc.firstChild!.content.size;
        return doc.type.create(doc.attrs, empty ? Fragment.from(blockNode) : doc.content.append(Fragment.from(blockNode)), doc.marks);
      });
      if (changed) {
        const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
        await syncDocTasks(user, page, rowId, changed.ydoc);
        changed.publish();
      }
    }, user);
  }
  const started = await startMeetingSession(
    user,
    { meetingId, pageId, rowId, tracks: tracks.length ? tracks : ["mixed"], mime: tracks.length ? [...mimes][0] : "text/plain", consent: input.consent },
    tracks.length ? "audio" : "text",
  );
  const parts: Partial<Record<MeetingTrack, number>> = {};
  if (tracks.length)
    for (const t of tracks) {
      await mkdir(trackDir(meetingId, started.session, t), { recursive: true });
      await writeFile(resolve(trackDir(meetingId, started.session, t), "0"), input.audio![t]!.data);
      parts[t] = 1;
    }
  else {
    await mkdir(trackDir(meetingId, started.session, "mixed"), { recursive: true });
    await writeFile(resolve(trackDir(meetingId, started.session, "mixed"), "0"), text.slice(0, 400_000));
    parts.mixed = 1;
  }
  const durationMs = tracks.length ? Math.max(...tracks.map((t) => input.audio![t]!.durationMs || 0)) : 0;
  await finishMeetingSession(user, meetingId, {
    session: started.session,
    parts,
    // Unknown length (no player on the server): the transcript's end counts.
    durationMs,
    language: input.language && ["de", "en", "fr", "zh"].includes(input.language) ? input.language : undefined,
  });
  return { id: meetingId, pageId, rowId, status: "transcribing", statusUrl: `/api/meetings/${meetingId}` };
}
