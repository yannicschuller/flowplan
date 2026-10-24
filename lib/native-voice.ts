// Voice notes recorded by the app for iPhone, iPad and Android
// (flowplan-app, src/voice-bridge.ts there): the editor's "Voice note" asks
// the app (window.FlowplanApp.recordVoiceNote), the app records natively,
// transcribes on the device where it can (Apple Speech, on-device when the
// language allows) and hands the recording back to this page:
//
// - the audio in base64 pieces, appended to window.__flowplanVoice[id];
// - then the event "flowplan:voice-note" with { id, status, name, mime,
//   transcript?, text, summarize } – status "done", "cancelled" or "failed".
//
// The page uploads the audio and inserts the text as with a recording in
// the browser. Safe for the browser: no server imports.
import type { Transcript, TranscriptSegment } from "./transcribe";
import { nativeApp } from "./native-app";

export type NativeVoiceNote = {
  file: File;
  // Transcribed on the device; null: not transcribed there.
  transcript: Transcript | null;
  // The person wants the words as text (the server transcribes when the
  // device did not).
  text: boolean;
  // The person asked for an AI summary below the text.
  summarize: boolean;
};
type Detail = {
  id?: unknown;
  status?: unknown;
  name?: unknown;
  mime?: unknown;
  transcript?: { text?: unknown; segments?: unknown; duration?: unknown } | null;
  text?: unknown;
  summarize?: unknown;
  error?: unknown;
};
type Store = Record<string, string[] | undefined>;
const store = () => {
  const w = window as unknown as { __flowplanVoice?: Store };
  return (w.__flowplanVoice ??= {});
};

export const canRecordInApp = () => typeof nativeApp()?.recordVoiceNote === "function";

function bytes(pieces: string[]) {
  const binary = atob(pieces.join(""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// What the app sent as transcript, checked.
export function parseTranscript(value: Detail["transcript"]): Transcript | null {
  if (!value || typeof value.text !== "string" || !value.text.trim()) return null;
  const segments: TranscriptSegment[] = Array.isArray(value.segments)
    ? value.segments
        .filter((s): s is TranscriptSegment => !!s && typeof s.text === "string" && typeof s.start === "number" && typeof s.end === "number")
        .map((s) => ({ start: s.start, end: s.end, text: s.text }))
    : [];
  return { text: value.text, segments, speakers: false, ...(typeof value.duration === "number" ? { duration: value.duration } : {}) };
}

// Asks the app to record; null when the person cancelled (or it failed:
// `onError` gets the app's message).
export function recordInApp(options: { summarize: boolean; serverTranscription: boolean }, onError: (message: string) => void) {
  const app = nativeApp();
  if (!app?.recordVoiceNote) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise<NativeVoiceNote | null>((resolve) => {
    const finish = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as Detail;
      if (detail.id !== id) return;
      removeEventListener("flowplan:voice-note", finish);
      const pieces = store()[id] || [];
      delete store()[id];
      if (detail.status !== "done" || !pieces.length) {
        if (detail.status === "failed" && typeof detail.error === "string" && detail.error) onError(detail.error);
        return resolve(null);
      }
      try {
        const mime = typeof detail.mime === "string" && detail.mime ? detail.mime : "audio/mp4";
        const name = typeof detail.name === "string" && detail.name ? detail.name : "voice-note.m4a";
        const transcript = parseTranscript(detail.transcript);
        resolve({ file: new File([bytes(pieces)], name, { type: mime }), transcript, text: detail.text === true || !!transcript, summarize: detail.summarize === true });
      } catch {
        resolve(null);
      }
    };
    addEventListener("flowplan:voice-note", finish);
    app.recordVoiceNote!({ id, ...options });
  });
}
