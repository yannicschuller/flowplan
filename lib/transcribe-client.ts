// Browser side of transcription: short recordings in one request, long ones
// (meetings, up to two hours) in chunks that the server puts together
// (app/api/transcribe/[...path]/route.ts).
import { serverMessage } from "./i18n-errors";
import type { Transcript } from "./transcribe";

const CHUNK = 4 * 1024 * 1024;
// Up to this size the recording goes in one request.
const SINGLE = 4 * 1024 * 1024;

async function json(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage(String(data?.error || "Transkription fehlgeschlagen.")));
  return data;
}

export async function transcribeRecording(
  file: File,
  pageId: string,
  { onProgress, signal }: { onProgress?: (share: number) => void; signal?: AbortSignal } = {},
): Promise<Transcript> {
  if (file.size <= SINGLE) {
    const form = new FormData();
    form.set("pageId", pageId);
    form.set("file", file);
    const data = await json(await fetch("/api/transcribe", { method: "POST", body: form, signal }));
    return { text: String(data.text || ""), segments: Array.isArray(data.segments) ? data.segments : [], duration: data.duration, speakers: !!data.speakers };
  }
  const upload = crypto.randomUUID();
  const parts = Math.ceil(file.size / CHUNK);
  for (let index = 0; index < parts; index++) {
    const params = new URLSearchParams({ upload, page: pageId, index: String(index) });
    await json(
      await fetch(`/api/transcribe/chunk?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file.slice(index * CHUNK, (index + 1) * CHUNK),
        signal,
      }),
    );
    onProgress?.((index + 1) / parts);
  }
  const data = await json(
    await fetch("/api/transcribe/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload, pageId, parts, name: file.name.slice(0, 200) || "aufnahme.webm", type: (file.type || "audio/webm").split(";")[0] }),
      signal,
    }),
  );
  return { text: String(data.text || ""), segments: Array.isArray(data.segments) ? data.segments : [], duration: data.duration, speakers: !!data.speakers };
}
