// Long voice notes and meeting recordings: the browser sends the recording
// in chunks (POST /api/transcribe/chunk?upload=…&page=…&index=…, the raw
// bytes as body), then POST /api/transcribe/finish puts them together and
// sends the whole recording to the transcription service (lib/transcribe.ts).
// Short recordings still go in one request to POST /api/transcribe.
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requirePage } from "@/lib/permissions";
import { finishTranscribeUpload, storeTranscribeChunk, TRANSCRIBE_CHUNK_BYTES, transcriptionEnabled } from "@/lib/transcribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.uuid();

export const POST = withRequestLocale(async (req: Request, { params }: { params: Promise<{ path: string[] }> }) => {
  try {
    checkOrigin(req);
    const { path } = await params;
    const user = await requireUser();
    if (user.demo || user.apiScope) throw new HttpError(403, "Hier nicht verfügbar.");
    if (!transcriptionEnabled()) throw new HttpError(501, "Transkription ist auf diesem Server nicht eingerichtet.");
    if (path.length === 1 && path[0] === "chunk") {
      const url = new URL(req.url);
      const pageId = uuid.parse(url.searchParams.get("page"));
      requirePage(user, pageId, true);
      if (Number(req.headers.get("content-length") || 0) > TRANSCRIBE_CHUNK_BYTES) throw new HttpError(413, "Anfrage zu groß.");
      const bytes = new Uint8Array(await req.arrayBuffer());
      return NextResponse.json(
        await storeTranscribeChunk(user, { uploadId: uuid.parse(url.searchParams.get("upload")), pageId, index: Number(url.searchParams.get("index")) }, bytes),
      );
    }
    if (path.length === 1 && path[0] === "finish") {
      const b = z
        .object({
          upload: uuid,
          pageId: uuid,
          parts: z.number().int().min(1).max(1000),
          name: z.string().trim().min(1).max(200),
          type: z.string().regex(/^audio\/[\w.+-]+$/),
        })
        .parse(await req.json());
      requirePage(user, b.pageId, true);
      return NextResponse.json(await finishTranscribeUpload(user, { uploadId: b.upload, pageId: b.pageId, parts: b.parts, name: b.name, type: b.type }));
    }
    throw new HttpError(404, "Nicht gefunden.");
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
});
