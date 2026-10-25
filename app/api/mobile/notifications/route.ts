import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "@/lib/auth";
import { withContentLocale } from "@/lib/content-locale";
import { localizedMessage } from "@/lib/i18n-errors";
import { pickLocale, type Locale } from "@/lib/i18n";
import { identityFromDeviceToken } from "@/lib/mobile-devices";
import { notificationAction } from "@/lib/notification-actions";
import { widgetLocale } from "@/lib/mobile-widgets";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The buttons on the apps' push notifications (lib/notification-actions.ts),
// only with the device token (Bearer fpd_…):
// POST /api/mobile/notifications  { action: "done" | "tomorrow" | "reply" | "read", notificationId, text?, today? }
const headers = { "Cache-Control": "no-store" };

function failure(e: unknown, locale: Locale) {
  const status = e instanceof HttpError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  const message = status === 500 ? "Fehler" : e instanceof ZodError || e instanceof SyntaxError ? "Ungültige Anfrage." : (e as Error).message;
  return NextResponse.json({ error: localizedMessage(message, locale) }, { status, headers });
}

// A notification button tapped twice (or retried) acts once per Idempotency-Key.
export const POST = withIdempotency(handlePOST);
async function handlePOST(req: Request) {
  const query = new URL(req.url).searchParams;
  const fallback = pickLocale(null, req.headers.get("accept-language"));
  // Browsers never send this header by themselves: no origin check needed.
  const user = identityFromDeviceToken(req.headers.get("authorization"));
  if (!user) return failure(new HttpError(401, "Bitte melde dich an."), fallback);
  const locale = widgetLocale(user, query.get("lang"), req.headers.get("accept-language"));
  return withContentLocale(locale, async () => {
    try {
      const text = await req.text();
      if (text.length > 10_000) throw new HttpError(413, "Anfrage zu groß.");
      return NextResponse.json(await notificationAction(user, JSON.parse(text || "{}")), { headers });
    } catch (e) {
      return failure(e, locale);
    }
  });
}
