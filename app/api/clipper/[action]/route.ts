// Endpoints of the browser extension (lib/clipper.ts): GET targets lists
// where the person may save, POST save stores a clip. Bearer tokens only
// (scope "clipper" or "write"); CORS answers name browser-extension
// origins only and never allow credentials.
import { z } from "zod";
import { HttpError } from "@/lib/auth";
import { clipperCors, clipperTargets, clipperUser, saveClip } from "@/lib/clipper";
import { localeOfRequest, withRequestLocale } from "@/lib/content-locale";
import { localizedMessage } from "@/lib/i18n-errors";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 3_000_000;

function answer(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...clipperCors(req.headers.get("origin")) },
  });
}
function failure(req: Request, e: unknown) {
  if (e instanceof z.ZodError) return answer(req, 400, { error: localizedMessage("Ungültige Eingabe.", localeOfRequest(req)) });
  if (!(e instanceof HttpError)) console.error(e);
  const message = e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden.";
  return answer(req, e instanceof HttpError ? e.status : 500, { error: localizedMessage(message, localeOfRequest(req)) });
}

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: clipperCors(req.headers.get("origin")) });
}

export const GET = withRequestLocale(async (req: Request, { params }: { params: Promise<{ action: string }> }) => {
  try {
    const { action } = await params;
    if (action !== "targets") throw new HttpError(404, "Nicht gefunden.");
    return answer(req, 200, clipperTargets(clipperUser(req.headers.get("authorization"))));
  } catch (e) {
    return failure(req, e);
  }
});

export const POST = withRequestLocale(
  withIdempotency(async (req: Request, { params }: { params: Promise<{ action: string }> }) => {
    try {
      const { action } = await params;
      if (action !== "save") throw new HttpError(404, "Nicht gefunden.");
      const user = clipperUser(req.headers.get("authorization"));
      if (Number(req.headers.get("content-length") || 0) > MAX_BODY) throw new HttpError(413, "Anfrage zu groß.");
      const text = await req.text();
      if (text.length > MAX_BODY) throw new HttpError(413, "Anfrage zu groß.");
      return answer(req, 200, saveClip(user, JSON.parse(text)));
    } catch (e) {
      return failure(req, e instanceof SyntaxError ? new HttpError(400, "Ungültige Eingabe.") : e);
    }
  }, { headers: (req) => clipperCors(req.headers.get("origin")) }),
);
