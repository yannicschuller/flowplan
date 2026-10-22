// A transcript as a document block: a toggle ("Transkript · 12:34") with
// one paragraph per passage, each starting with its timestamp and – only
// when the transcription service separated speakers – the speaker.
// Consecutive segments of the same speaker are joined into passages.
// Safe for the browser: no server imports.
import type { Transcript, TranscriptSegment } from "./transcribe";

export type TranscriptPassage = { start: number; speaker?: string; text: string };

// 75 → "01:15", 3725 → "1:02:05".
export function formatTimestamp(total: number) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

// Passages of at most ~600 characters; a new speaker or a pause of more
// than 20 seconds starts a new one.
export function transcriptPassages(segments: TranscriptSegment[], maxChars = 600): TranscriptPassage[] {
  const passages: TranscriptPassage[] = [];
  let last: TranscriptSegment | null = null;
  for (const segment of segments) {
    const current = passages[passages.length - 1];
    const joinable =
      current && last && current.speaker === segment.speaker && segment.start - last.end <= 20 && current.text.length + segment.text.length < maxChars;
    if (joinable) current.text = `${current.text} ${segment.text}`;
    else passages.push({ start: segment.start, ...(segment.speaker ? { speaker: segment.speaker } : {}), text: segment.text });
    last = segment;
  }
  return passages;
}

// Speakers as the service names them ("SPEAKER_00", "A") → 1, 2, … in the
// order they first speak.
export function speakerNumbers(segments: TranscriptSegment[]) {
  const numbers = new Map<string, number>();
  for (const s of segments) if (s.speaker && !numbers.has(s.speaker)) numbers.set(s.speaker, numbers.size + 1);
  return numbers;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The block as HTML for the editor; null without segments (the caller then
// inserts the plain text as before).
export function transcriptHtml(transcript: Pick<Transcript, "segments" | "duration">, labels: { title: string; speaker: (n: number) => string }) {
  if (!transcript.segments.length) return null;
  const numbers = speakerNumbers(transcript.segments);
  const end = transcript.duration ?? transcript.segments[transcript.segments.length - 1].end;
  const paragraphs = transcriptPassages(transcript.segments).map((p) => {
    const speaker = p.speaker ? ` <strong>${escape(labels.speaker(numbers.get(p.speaker)!))}:</strong>` : "";
    return `<p><code>${formatTimestamp(p.start)}</code>${speaker} ${escape(p.text)}</p>`;
  });
  return `<details><summary>${escape(`${labels.title} · ${formatTimestamp(end)}`)}</summary><div>${paragraphs.join("")}</div></details>`;
}

// The transcript as plain text with timestamps (for the AI and copying).
export function transcriptText(transcript: Pick<Transcript, "segments" | "text">, speaker: (n: number) => string) {
  if (!transcript.segments.length) return transcript.text;
  const numbers = speakerNumbers(transcript.segments);
  return transcriptPassages(transcript.segments)
    .map((p) => `[${formatTimestamp(p.start)}]${p.speaker ? ` ${speaker(numbers.get(p.speaker)!)}:` : ""} ${p.text}`)
    .join("\n");
}
