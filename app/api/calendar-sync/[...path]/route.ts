// Google Calendar and Microsoft 365 sync (lib/calendar-sync.ts), browser
// only: connecting an account (OAuth redirect and callback), the person's
// connections and mappings, the calendars of a connection, and "Jetzt
// synchronisieren". Changing mappings goes through /api/command.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { HttpError, appUrl, checkOrigin, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requestLocale } from "@/lib/i18n-server";
import { translate } from "@/lib/i18n";
import { localizedMessage } from "@/lib/i18n-errors";
import { desktopPage } from "@/lib/desktop-sign-in";
import {
  calendarSyncStatus,
  finishCalendarConnection,
  listExternalCalendars,
  providerSchema,
  startCalendarConnection,
  syncOwnMapping,
} from "@/lib/calendar-sync";

export const dynamic = "force-dynamic";
const FLOW_COOKIE = "flowplan_calendar_oauth";

async function browserUser() {
  const user = await requireUser();
  if (user.apiScope) throw new HttpError(403, "Kalender lassen sich nur im Browser verbinden.");
  return user;
}
function failure(error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error("Calendar sync route", error);
  return NextResponse.json({ error: error instanceof HttpError ? error.message : "Fehler" }, { status });
}

export const GET = withRequestLocale(async (req: Request, { params }: { params: Promise<{ path: string[] }> }) => {
  const { path } = await params;
  const url = new URL(req.url);
  // The OAuth steps answer with pages, not JSON.
  if ((path[0] === "connect" || path[0] === "callback") && path.length === 2) {
    const locale = await requestLocale(),
      say = translate(locale);
    try {
      const provider = providerSchema.parse(path[1]);
      const user = await browserUser();
      const jar = await cookies();
      if (path[0] === "connect") {
        const { url: target, flow } = startCalendarConnection(user, provider);
        jar.set(FLOW_COOKIE, flow, {
          httpOnly: true,
          secure: appUrl().startsWith("https:"),
          // The provider sends the person back with a top-level GET.
          sameSite: "lax",
          path: "/api/calendar-sync",
          maxAge: 600,
        });
        return NextResponse.redirect(target);
      }
      const flow = jar.get(FLOW_COOKIE)?.value;
      jar.delete(FLOW_COOKIE);
      await finishCalendarConnection(user, provider, flow, url.searchParams);
      return NextResponse.redirect(new URL("/#settings", appUrl()));
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error("Calendar connection", error);
      const text = error instanceof HttpError ? localizedMessage(error.message, locale) : say("Die Kalenderverbindung ist fehlgeschlagen.", "Connecting the calendar failed.");
      return desktopPage(locale, {
        title: say("Kalender nicht verbunden", "Calendar not connected"),
        text,
        body: `<a class="button" href="/#settings">${say("Zurück zu Flowplan", "Back to Flowplan")}</a>`,
      });
    }
  }
  try {
    const user = await browserUser();
    if (path.length === 1 && path[0] === "status") {
      const page = url.searchParams.get("page");
      return NextResponse.json(calendarSyncStatus(user, page ? z.uuid().parse(page) : null), { headers: { "Cache-Control": "no-store" } });
    }
    if (path.length === 1 && path[0] === "calendars")
      return NextResponse.json({ calendars: await listExternalCalendars(user, url.searchParams.get("connection")) }, { headers: { "Cache-Control": "no-store" } });
    throw new HttpError(404, "Nicht gefunden.");
  } catch (error) {
    return failure(error);
  }
});

export const POST = withRequestLocale(async (req: Request, { params }: { params: Promise<{ path: string[] }> }) => {
  const { path } = await params;
  try {
    checkOrigin(req);
    const user = await browserUser();
    if (path.length === 1 && path[0] === "run") return NextResponse.json(await syncOwnMapping(user, await req.json()));
    throw new HttpError(404, "Nicht gefunden.");
  } catch (error) {
    return failure(error);
  }
});
