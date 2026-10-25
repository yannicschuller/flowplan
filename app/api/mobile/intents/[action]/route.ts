import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "@/lib/auth";
import { withContentLocale } from "@/lib/content-locale";
import { localizedMessage } from "@/lib/i18n-errors";
import { pickLocale, type Locale } from "@/lib/i18n";
import { limitWidgets, widgetLocale, widgetUser } from "@/lib/mobile-widgets";
import { intentPages, intentSearch, intentWorkspaces } from "@/lib/mobile-intents";
import { setDeviceFocus } from "@/lib/mobile-focus";
import type { Identity } from "@/lib/types";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Siri, Shortcuts and Focus filters of the iPhone and iPad app
// (lib/mobile-intents.ts), only with the device token (Bearer fpd_…):
// GET  /api/mobile/intents/pages?q=…  or  ?ids=<uuid>,<uuid>
// GET  /api/mobile/intents/search?q=…
// GET  /api/mobile/intents/workspaces
// POST /api/mobile/intents/focus      { workspaceId, hide, hours }
const headers = { "Cache-Control": "no-store" };
const JSON_LIMIT = 2_000;

function failure(e: unknown, locale: Locale) {
  const status = e instanceof HttpError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  const message = status === 500 ? "Fehler" : e instanceof ZodError || e instanceof SyntaxError ? "Ungültige Anfrage." : (e as Error).message;
  return NextResponse.json({ error: localizedMessage(message, locale) }, { status, headers });
}

async function withDevice(req: Request, handle: (user: Identity) => Promise<Response> | Response) {
  const fallback = pickLocale(null, req.headers.get("accept-language"));
  const user = widgetUser(req.headers.get("authorization"));
  if (!user) return failure(new HttpError(401, "Bitte melde dich an."), fallback);
  const locale = widgetLocale(user, new URL(req.url).searchParams.get("lang"), req.headers.get("accept-language"));
  return withContentLocale(locale, async () => {
    try {
      return await handle(user);
    } catch (e) {
      return failure(e, locale);
    }
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const query = new URL(req.url).searchParams;
  return withDevice(req, (user) => {
    limitWidgets(user, "options");
    if (action === "pages") {
      const ids = query.get("ids");
      return NextResponse.json(intentPages(user, { q: query.get("q") ?? undefined, ids: ids ? ids.split(",").filter(Boolean) : undefined }), { headers });
    }
    if (action === "search") return NextResponse.json(intentSearch(user, { q: query.get("q") ?? "" }), { headers });
    if (action === "workspaces") return NextResponse.json(intentWorkspaces(user), { headers });
    throw new HttpError(404, "Nicht gefunden");
  });
}

export const POST = withIdempotency(handlePOST);
async function handlePOST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  return withDevice(req, async (user) => {
    if (action !== "focus") throw new HttpError(404, "Nicht gefunden");
    limitWidgets(user, "action");
    const text = await req.text();
    if (text.length > JSON_LIMIT) throw new HttpError(413, "Anfrage zu groß.");
    return NextResponse.json(setDeviceFocus(user, req.headers.get("authorization"), JSON.parse(text || "{}")), { headers });
  });
}
