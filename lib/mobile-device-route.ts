// The shared frame of the mobile routes that only take the device token
// (Bearer fpd_…): app/api/mobile/capture, widgets, intents and
// notifications. These routes never pass checkOrigin, so the read-only
// check of an instance move (lib/instance-read-only.ts) happens here: every
// request that is not a GET is refused with 423 while the instance is frozen
// or has moved, unless readOnlyRefusal lets the path through (reads that are
// sent with a body, such as the widget data refresh).
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError, refuseWhileReadOnly } from "./auth";
import { withContentLocale } from "./content-locale";
import { localizedMessage } from "./i18n-errors";
import { pickLocale, type Locale } from "./i18n";
import { widgetLocale, widgetUser } from "./mobile-widgets";
import type { Identity } from "./types";

const headers = { "Cache-Control": "no-store" };

export function deviceFailure(e: unknown, locale: Locale) {
  const status = e instanceof HttpError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  const message = status === 500 ? "Fehler" : e instanceof ZodError || e instanceof SyntaxError ? "Ungültige Anfrage." : (e as Error).message;
  return NextResponse.json({ error: localizedMessage(message, locale) }, { status, headers });
}

// Throws 423 for a change while the instance is read-only.
export async function refuseDeviceWrite(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD") await refuseWhileReadOnly(req);
}

// The person behind the device token, in their language (`lang` from the
// query, else the Accept-Language header).
export async function withDevice(req: Request, handle: (user: Identity) => Promise<Response> | Response) {
  const fallback = pickLocale(null, req.headers.get("accept-language"));
  const user = await widgetUser(req.headers.get("authorization"));
  if (!user) return deviceFailure(new HttpError(401, "Bitte melde dich an."), fallback);
  const locale = await widgetLocale(user, new URL(req.url).searchParams.get("lang"), req.headers.get("accept-language"));
  return withContentLocale(locale, async () => {
    try {
      await refuseDeviceWrite(req);
      return await handle(user);
    } catch (e) {
      return deviceFailure(e, locale);
    }
  });
}
