import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { activeUser, checkOrigin, HttpError } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { createProfileLink, profileCalendars, redeemProfileLink } from "@/lib/caldav-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CalDAV for Apple devices as configuration profile (lib/caldav-profile.ts):
// GET  /api/calendar-profile           the person's calendar views (session)
// POST /api/calendar-profile           { calendars: [{ pageId, viewId }] } → a link (session)
// GET  /api/calendar-profile?token=…   the profile, once (Safari has no session)
const headers = { "Cache-Control": "no-store" };

function failure(e: unknown) {
  const status = e instanceof HttpError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  return NextResponse.json(
    { error: status === 500 ? "Fehler" : e instanceof ZodError || e instanceof SyntaxError ? "Ungültige Anfrage." : (e as Error).message },
    { status, headers },
  );
}

export const GET = withRequestLocale(handleGET);
async function handleGET(req: Request) {
  try {
    const token = new URL(req.url).searchParams.get("token");
    if (token !== null) {
      const profile = redeemProfileLink(token);
      if (!profile)
        return new NextResponse("Dieser Link ist abgelaufen oder wurde schon benutzt. / This link has expired or was already used.", {
          status: 410,
          headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
        });
      return new NextResponse(profile, {
        headers: {
          ...headers,
          "Content-Type": "application/x-apple-aspen-config; charset=utf-8",
          "Content-Disposition": 'attachment; filename="flowplan-calendars.mobileconfig"',
        },
      });
    }
    const user = await activeUser();
    if (!user) throw new HttpError(401, "Bitte melde dich an.");
    return NextResponse.json({ calendars: profileCalendars(user) }, { headers });
  } catch (e) {
    return failure(e);
  }
}

export const POST = withRequestLocale(handlePOST);
async function handlePOST(req: Request) {
  try {
    checkOrigin(req);
    const user = await activeUser();
    if (!user) throw new HttpError(401, "Bitte melde dich an.");
    const text = await req.text();
    if (text.length > 10_000) throw new HttpError(413, "Anfrage zu groß.");
    return NextResponse.json(createProfileLink(user, JSON.parse(text || "{}")), { headers });
  } catch (e) {
    return failure(e);
  }
}
