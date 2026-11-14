// A shared notebook edited by guests of an edit link (#280, lib/share-canvas.ts).
//   GET ?pageId=P                 paper, sheets, their ink and versions
//   GET ?pageId=P&versions=1      { versions: { sheet: version } } (following others)
//   GET ?pageId=P&surface=S       the ink of one sheet
//   POST ?pageId=P&surface=S {base, doc}            saves a sheet's ink (merged)
//   POST {pageId, op, ...}        sheet.add | sheet.duplicate | sheet.delete | sheet.move
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { withShareRequest } from "@/lib/share-access";
import { INK_LIMITS } from "@/lib/ink/model";
import { saveSharedInk, sharedInk, sharedInkVersions, sharedNotebook, sharedNotebookCommand } from "@/lib/share-canvas";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
type Context = { params: Promise<{ token: string }> };
const surfaceOf = (url: URL) => z.string().regex(/^[\w-]{1,40}$/).parse(url.searchParams.get("surface"));

function failure(e: unknown) {
  const status = e instanceof HttpError ? e.status : e instanceof z.ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  return NextResponse.json({ error: e instanceof HttpError ? e.message : "Anfrage konnte nicht verarbeitet werden." }, { status, headers });
}

export async function GET(req: Request, { params }: Context) {
  try {
    const { token } = await params,
      url = new URL(req.url);
    const pageId = z.uuid().parse(url.searchParams.get("pageId"));
    const data = await withShareRequest(req, async () => {
      if (url.searchParams.has("versions")) return { versions: await sharedInkVersions(token, pageId) };
      if (url.searchParams.has("surface")) return await sharedInk(token, pageId, surfaceOf(url));
      return await sharedNotebook(token, pageId);
    });
    return NextResponse.json(data, { headers });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request, { params }: Context) {
  try {
    await checkOrigin(req);
    const { token } = await params,
      url = new URL(req.url);
    if (Number(req.headers.get("content-length") || 0) > INK_LIMITS.bytes * 2) throw new HttpError(413, "Anfrage zu groß.");
    const text = await req.text();
    if (text.length > INK_LIMITS.bytes * 2) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text);
    const data = await withShareRequest(req, async () => {
      if (url.searchParams.has("surface")) return await saveSharedInk(token, z.uuid().parse(url.searchParams.get("pageId")), surfaceOf(url), body);
      return await sharedNotebookCommand(token, body);
    });
    return NextResponse.json(data, { headers });
  } catch (e) {
    return failure(e);
  }
}
