// Ink of a page's surfaces: notebook sheets and drawing blocks
// (lib/page-ink-store.ts, lib/ink/README.md).
//   GET                              { versions: { surface: version } } (following others' changes)
//   GET ?surface=S[&from=P/S2]       the ink, its version, whether this person may change it
//   GET ?surface=S&versions=1        the saved versions (newest first)
//   GET ?surface=S&version=N         the ink of one version
//   PUT or POST ?surface=S {base, doc, recognized?}  saves (merged with saves in between)
//   PUT or POST ?surface=S {version, recognized}     text recognised on the device for that version
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, checkOrigin, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { pageInkHistory, pageInkVersion, pageInkVersions, readPageInk, savePageInk, savePageRecognized } from "@/lib/page-ink-store";
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
const surfaceOf = (url: URL) => z.string().regex(/^[\w-]{1,40}$/).parse(url.searchParams.get("surface"));

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = await requireUser();
    const pageId = z.uuid().parse((await params).id);
    const url = new URL(req.url);
    if (!url.searchParams.has("surface")) return NextResponse.json({ versions: pageInkVersions(user, pageId) }, noStore);
    const surface = surfaceOf(url);
    if (url.searchParams.has("versions")) return NextResponse.json({ versions: pageInkHistory(user, pageId, surface) }, noStore);
    const version = url.searchParams.get("version");
    if (version !== null) return NextResponse.json(pageInkVersion(user, pageId, surface, z.coerce.number().int().min(1).parse(version)), noStore);
    const from = url.searchParams.get("from");
    return NextResponse.json(readPageInk(user, pageId, surface, from && /^[0-9a-f-]{36}\/[\w-]{1,40}$/i.test(from) ? from : null), noStore);
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
    const pageId = z.uuid().parse((await params).id);
    const surface = surfaceOf(new URL(req.url));
    const text = await req.text();
    if (text.length > INK_LIMITS.bytes * 2) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text);
    if (body && typeof body === "object" && body.doc === undefined && body.recognized !== undefined)
      return NextResponse.json(savePageRecognized(user, pageId, surface, body), noStore);
    return NextResponse.json(savePageInk(user, pageId, surface, body), noStore);
  } catch (e) {
    return failure(e);
  }
}
export const PUT = withRequestLocale(save);
export const POST = withRequestLocale(save);
