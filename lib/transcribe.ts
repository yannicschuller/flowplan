// Voice notes: speech to text with Whisper running as a separate service
// next to Flowplan (e.g. faster-whisper-server or speaches in the same
// Docker network). Recordings go only to that address, never to a cloud.
// WHISPER_URL points at an OpenAI-compatible server
// (POST /v1/audio/transcriptions); WHISPER_MODEL and WHISPER_LANGUAGE are
// optional.
import { HttpError } from "./auth";

export const TRANSCRIBE_LIMIT = 25_000_000;

export function transcriptionEnabled() {
  return !!process.env.WHISPER_URL?.trim();
}

export async function transcribe(audio: Blob, name = "sprachnotiz.webm") {
  const base = process.env.WHISPER_URL?.trim().replace(/\/$/, "");
  if (!base) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
  if (audio.size > TRANSCRIBE_LIMIT) throw new HttpError(413, "Die Aufnahme ist zu lang.");
  const form = new FormData();
  form.set("file", audio, name);
  form.set("model", process.env.WHISPER_MODEL?.trim() || "Systran/faster-whisper-small");
  form.set("language", process.env.WHISPER_LANGUAGE?.trim() || "de");
  form.set("response_format", "json");
  let response: Response;
  try {
    response = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      headers: process.env.WHISPER_API_KEY ? { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {},
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new HttpError(502, "Der Transkriptionsdienst ist nicht erreichbar.");
  }
  if (!response.ok) throw new HttpError(502, `Transkription fehlgeschlagen (${response.status}).`);
  const data = (await response.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  return { text: text.slice(0, 100_000) };
}
