// Workshop facilitation on a whiteboard (lib/whiteboard-facilitation.ts):
// private mode, planning poker and "Alle zu mir holen". Browser sessions
// only – API tokens are refused; changes also need the origin check.
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError, sessionIdentityFromRequest } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { facilitate, facilitationState } from "@/lib/whiteboard-facilitation";
import { PRIVATE_LIMITS } from "@/lib/whiteboard-private-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
const noStore = { headers: { "Cache-Control": "no-store" } };

function signedIn(req: Request) {
  if (req.headers.get("authorization")) throw new HttpError(403, "Nur im Browser verfügbar.");
  const user = sessionIdentityFromRequest(req);
  if (!user) throw new HttpError(401, "Bitte melde dich an.");
  if (user.twoFactorSetup) throw new HttpError(403, "Bitte richte zuerst die Zwei-Faktor-Anmeldung ein.");
  return user;
}
function error(e: unknown) {
  if (e instanceof z.ZodError)
    return NextResponse.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return NextResponse.json(
    { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
    { status: e instanceof HttpError ? e.status : 500 },
  );
}

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = signedIn(req);
    const pageId = z.uuid().parse((await params).id);
    return NextResponse.json(facilitationState(user, pageId), noStore);
  } catch (e) {
    return error(e);
  }
});

export const POST = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    checkOrigin(req);
    const user = signedIn(req);
    const pageId = z.uuid().parse((await params).id);
    const limit = Math.ceil((PRIVATE_LIMITS.update * 4) / 3) + 4096;
    if (Number(req.headers.get("content-length") || 0) > limit) throw new HttpError(413, "Anfrage zu groß.");
    const text = await req.text();
    if (text.length > limit) throw new HttpError(413, "Anfrage zu groß.");
    let body: unknown;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      throw new HttpError(400, "Ungültige Eingabe.");
    }
    return NextResponse.json(facilitate(user, pageId, body) ?? { ok: true }, noStore);
  } catch (e) {
    return error(e);
  }
});
