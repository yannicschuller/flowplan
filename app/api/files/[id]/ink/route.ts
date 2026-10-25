// Ink on a PDF file (lib/ink-store.ts, lib/ink/README.md).
//   GET               the ink, its version and whether this person may change it
//   GET ?versions=1   the saved versions (newest first)
//   GET ?version=N    the ink of one version
//   PUT or POST {base, doc, recognized?}  saves; `base` is the version the ink was opened at
//   PUT or POST {version, recognized}     text recognised on the device for that
//                                         version (page → text), lib/ink/recognition.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, checkOrigin, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { fileInkVersion, fileInkVersions, readFileInk, saveFileInk, saveFileRecognized } from "@/lib/ink-store";
import { INK_LIMITS } from "@/lib/ink/model";

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
    const fileId = z.uuid().parse((await params).id);
    const url = new URL(req.url);
    if (url.searchParams.has("versions")) return NextResponse.json({ versions: fileInkVersions(user, fileId) }, noStore);
    const version = url.searchParams.get("version");
    if (version !== null) return NextResponse.json(fileInkVersion(user, fileId, z.coerce.number().int().min(1).parse(version)), noStore);
    return NextResponse.json(readFileInk(user, fileId), noStore);
  } catch (e) {
    return failure(e);
  }
});

async function save(req: Request, { params }: Context) {
  try {
    checkOrigin(req);
    if (Number(req.headers.get("content-length") || 0) > INK_LIMITS.bytes * 2) throw new HttpError(413, "Anfrage zu groß.");
    const user = await requireUser();
    if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
    const fileId = z.uuid().parse((await params).id);
    const text = await req.text();
    if (text.length > INK_LIMITS.bytes * 2) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text);
    if (body && typeof body === "object" && body.doc === undefined && body.recognized !== undefined)
      return NextResponse.json(saveFileRecognized(user, fileId, body), noStore);
    return NextResponse.json(saveFileInk(user, fileId, body), noStore);
  } catch (e) {
    return failure(e);
  }
}
export const PUT = withRequestLocale(save);
export const POST = withRequestLocale(save);
