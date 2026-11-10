// Audio recordings of a notebook (lib/notebook-audio.ts).
//   GET                                        { recordings, canEdit, room, maxMs, maxBytes, chunkBytes }
//   GET ?upload=R                              { size, finished, recording? } – how much of upload R the server has
//   POST ?upload=R&offset=N&type=T  (raw bytes) { size } – one chunk (application/octet-stream)
//   POST { action: "finish", recId, name, durationMs }   { recording }
//   POST { action: "rename", recId, name }                { recording }
//   POST { action: "delete", recId }                      { ok } – into the trash with its file
//   POST { action: "discard", recId }                     { ok } – drops an unfinished upload
// The audio itself is served by /api/files/{fileId} (range requests).
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, checkOrigin, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import {
  deleteRecording,
  discardRecordingUpload,
  finishRecording,
  listRecordings,
  recordingUploadStatus,
  renameRecording,
  RECORDING_CHUNK_BYTES,
  storeRecordingChunk,
} from "@/lib/notebook-audio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "private, no-store" } };
type Context = { params: Promise<{ id: string }> };

function failure(e: unknown) {
  if (e instanceof z.ZodError || e instanceof SyntaxError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return NextResponse.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : 500 },
  );
}

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = await requireUser();
    const pageId = z.uuid().parse((await params).id);
    const upload = new URL(req.url).searchParams.get("upload");
    if (upload !== null) return NextResponse.json(await recordingUploadStatus(user, pageId, upload), noStore);
    return NextResponse.json(await listRecordings(user, pageId), noStore);
  } catch (e) {
    return failure(e);
  }
});

export const POST = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    await checkOrigin(req);
    const user = await requireUser();
    if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
    const pageId = z.uuid().parse((await params).id);
    const url = new URL(req.url);
    const upload = url.searchParams.get("upload");
    if (upload !== null) {
      // The size must be known before anything is read.
      const length = req.headers.get("content-length");
      if (!length || !/^\d+$/.test(length)) throw new HttpError(411, "Die Größe der Anfrage fehlt.");
      if (Number(length) > RECORDING_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > RECORDING_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
      const offset = Number(url.searchParams.get("offset"));
      return NextResponse.json(await storeRecordingChunk(user, pageId, { recId: upload, offset, type: url.searchParams.get("type") || "" }, bytes), noStore);
    }
    if (Number(req.headers.get("content-length") || 0) > 16_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = z.object({ action: z.enum(["finish", "rename", "delete", "discard"]), recId: z.string().max(64) }).passthrough().parse(await req.json());
    if (body.action === "finish") return NextResponse.json(await finishRecording(user, pageId, body), noStore);
    if (body.action === "rename") return NextResponse.json(await renameRecording(user, pageId, body.recId, body.name), noStore);
    if (body.action === "delete") return NextResponse.json(await deleteRecording(user, pageId, body.recId), noStore);
    return NextResponse.json(await discardRecordingUpload(user, pageId, body.recId), noStore);
  } catch (e) {
    return failure(e);
  }
});
