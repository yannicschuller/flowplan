// Audio recordings of a notebook and the ink written while they ran
// (lib/notebook-audio.ts on the server, components/notebook/notebook-audio.tsx
// in the browser). Free of React and the DOM: limits, the recording format a
// browser can write, the time marks on new items (`rec`, lib/ink/model.ts)
// and which items playback has not reached yet.
import type { InkDoc, InkItem, InkRec } from "./model";

// Maintainer's limit: three hours per recording.
export const RECORDING_MAX_MS = 3 * 60 * 60 * 1000;
// Some slack for the clocks of browser and recorder.
export const RECORDING_GRACE_MS = 30_000;
// Uploads go in pieces of this size (each one request).
export const RECORDING_CHUNK_BYTES = 4 * 1024 * 1024;
// Safari may ignore the requested bit rate (AAC up to ~128 kbit/s): three
// hours at 192 kbit/s is the hard ceiling of one file.
export const RECORDING_MAX_BYTES = Math.ceil(((RECORDING_MAX_MS + RECORDING_GRACE_MS) / 1000) * 24_000) + 1024 * 1024;
// No more bytes per second of audio than this (256 kbit/s) plus a header.
export const RECORDING_MAX_BYTES_PER_SECOND = 32_000;
export const RECORDING_NAME_MAX = 120;

export type RecordingFormat = { mime: string; base: "audio/webm" | "audio/ogg" | "audio/mp4"; ext: "webm" | "ogg" | "m4a"; bitsPerSecond: number };

// Opus in WebM or Ogg where the browser writes it; AAC in MP4 on Apple's
// WebKit (Safari, the iPhone/iPad app), which plays it everywhere Apple
// ships. `apple` puts MP4 first.
export function pickRecordingFormat(supported: (mime: string) => boolean, apple = false): RecordingFormat | null {
  const opus: RecordingFormat[] = [
    { mime: "audio/webm;codecs=opus", base: "audio/webm", ext: "webm", bitsPerSecond: 32_000 },
    { mime: "audio/ogg;codecs=opus", base: "audio/ogg", ext: "ogg", bitsPerSecond: 32_000 },
    { mime: "audio/webm", base: "audio/webm", ext: "webm", bitsPerSecond: 32_000 },
  ];
  const aac: RecordingFormat[] = [
    { mime: "audio/mp4;codecs=mp4a.40.2", base: "audio/mp4", ext: "m4a", bitsPerSecond: 64_000 },
    { mime: "audio/mp4", base: "audio/mp4", ext: "m4a", bitsPerSecond: 64_000 },
  ];
  for (const format of apple ? [...aac, ...opus] : [...opus, ...aac]) {
    try {
      if (supported(format.mime)) return format;
    } catch {
      // A browser that throws for a type does not write it.
    }
  }
  return null;
}
export const recordingExt = (mime: string) => (/mp4|m4a|aac/.test(mime) ? "m4a" : /ogg/.test(mime) ? "ogg" : "webm");

// How long a recording may get: three hours, or less when the storage left
// (bytes, null = no limit) would not hold that much at the bit rate.
export function recordingLimitMs(roomBytes: number | null, bitsPerSecond: number) {
  if (roomBytes === null) return RECORDING_MAX_MS;
  const usable = Math.max(0, roomBytes * 0.95 - 64 * 1024);
  return Math.max(0, Math.min(RECORDING_MAX_MS, Math.floor((usable / (bitsPerSecond / 8)) * 1000)));
}
// Too little room to start at all: less than a minute.
export const roomTooSmall = (roomBytes: number | null, bitsPerSecond: number) => recordingLimitMs(roomBytes, bitsPerSecond) < 60_000;

// A recording as the server lists it.
export type NotebookRecording = {
  id: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  durationMs: number;
  createdAt: number;
  createdBy: string | null;
  createdByName: string | null;
};

// ---- Time marks ----

// The items that `next` has and `before` had not (by id, per page) get the
// recording mark – unless they carry one already (a partly erased stroke,
// a copy keeps the moment of its original).
export function stampNewItems(before: InkDoc, next: InkDoc, rec: InkRec): InkDoc {
  let pages: InkDoc["pages"] | null = null;
  for (const [key, items] of Object.entries(next.pages)) {
    const old = before.pages[key];
    if (old === items) continue;
    const known = new Set((old || []).map((i) => i.id));
    let changed = false;
    const stamped = items.map((item) => {
      if (known.has(item.id) || item.rec) return item;
      changed = true;
      return { ...item, rec: { id: rec.id, t: Math.max(0, Math.round(rec.t)) } } as InkItem;
    });
    if (!changed) continue;
    pages ??= { ...next.pages };
    pages[key] = stamped;
  }
  return pages ? { ...next, pages } : next;
}

export type Playback = { id: string; t: number } | null;
// Not "spoken" yet: written during this recording, later than where it plays.
// Items without their recording marks: for copies that leave the notebook
// (sheets copied or moved into another notebook, stickers), whose
// recordings do not come along – the mark would point to nothing there.
export function withoutRec(items: InkItem[]): InkItem[] {
  if (!items.some((i) => i.rec)) return items;
  return items.map((item) => {
    if (!item.rec) return item;
    const copy = { ...item };
    delete copy.rec;
    return copy;
  });
}
// The mark of the first marked item, back to front (handwriting turned into
// text keeps when it was written), as spread fields.
export function firstRec(items: InkItem[]): { rec?: InkRec } {
  const first = items.find((item) => item.rec)?.rec;
  return first ? { rec: { ...first } } : {};
}
export const isUnspoken = (item: InkItem, playback: Playback) => !!playback && item.rec?.id === playback.id && item.rec.t > playback.t;
// Where to play from for an item: its moment in its recording, a little before.
export const seekTimeOf = (item: InkItem): InkRec | null => (item.rec ? { id: item.rec.id, t: Math.max(0, item.rec.t - 1000) } : null);
// How many items of a document belong to a recording (the list shows it).
export function itemsOfRecording(doc: InkDoc, id: string) {
  let n = 0;
  for (const items of Object.values(doc.pages)) for (const item of items) if (item.rec?.id === id) n++;
  return n;
}

// 0:07, 12:34, 1:02:03
export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600),
    m = Math.floor((total % 3600) / 60),
    s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// A default name: "Aufnahme 10.11.2026, 14:05" (the caller passes the words).
export const cleanRecordingName = (name: unknown, fallback: string) =>
  (typeof name === "string" ? name : "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim()
    .slice(0, RECORDING_NAME_MAX) || fallback;

// The next piece to upload: from what the server has, at most one chunk.
export function nextUploadRange(serverBytes: number, totalBytes: number, chunk = RECORDING_CHUNK_BYTES): { start: number; end: number } | null {
  if (serverBytes >= totalBytes) return null;
  return { start: serverBytes, end: Math.min(totalBytes, serverBytes + chunk) };
}
