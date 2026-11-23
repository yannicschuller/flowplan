// Link cards on whiteboards (#455): the preview of an address someone adds
// to the board, with its picture and icon (or a video's still picture)
// fetched once by the server and stored as files of the board
// (lib/link-pictures.ts) – nobody viewing the board loads anything from the
// other site. Browser sessions only, for people who may edit the board;
// demo accounts may not make the server fetch other sites (as GET
// /api/embed). Changes also need the origin check.
//   POST {url}   → {kind: "card", url, title, site, description?, image?, icon?}
//                  or {kind: "player", src, provider, image?}
import { requireModule } from "@/lib/instance-modules";
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, sessionIdentityFromRequest } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { previewForBoard } from "@/lib/link-pictures";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function error(e: unknown) {
  if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return NextResponse.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : serverError(e) },
  );
}

export const POST = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    await checkOrigin(req);
    if (req.headers.get("authorization")) throw new HttpError(403, "Nur im Browser verfügbar.");
    const user = await sessionIdentityFromRequest(req);
    if (!user) throw new HttpError(401, "Bitte melde dich an.");
    if (user.twoFactorSetup) throw new HttpError(403, "Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.");
    await requireModule("whiteboards");
    const pageId = z.uuid().parse((await params).id);
    const text = await req.text();
    if (text.length > 4096) throw new HttpError(413, "Anfrage zu groß.");
    let raw: unknown;
    try {
      raw = JSON.parse(text || "{}");
    } catch {
      throw new HttpError(400, "Ungültige Eingabe.");
    }
    const body = z.object({ url: z.string().min(8).max(2000) }).strict().parse(raw);
    return NextResponse.json(await previewForBoard(user, pageId, body.url), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return error(e);
  }
});
