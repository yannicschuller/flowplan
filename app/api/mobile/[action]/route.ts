import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { ZodError } from "zod";
import { activeUser, checkOrigin, cookieName, hash, HttpError } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import {
  identityFromDeviceToken,
  mobilePushEnabled,
  mobileSummary,
  pushRelayInfo,
  registerMobileDevice,
  setLiveActivityToken,
  unregisterByDeviceToken,
  unregisterMobileDevice,
} from "@/lib/mobile-devices";
import { isInstanceAdmin, mobileAdminSummary } from "@/lib/mobile-admin";
import { updateStatus } from "@/lib/update-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The apps for iPhone, iPad and Android (lib/mobile-devices.ts):
// POST /api/mobile/register    from the app's web view, with the session cookie
// POST /api/mobile/unregister  likewise, or with the device token (Bearer fpd_…)
//                              when the app leaves the instance
// POST /api/mobile/live-activity  with the device token: the relay token of a
//                              Live Activity that started or ended on the phone
//                              { kind: "focus" | "timer", relayToken | null,
//                                relayUrl?, labels? (the views' texts) }
// GET  /api/mobile/summary     in the background, with the device token
// GET  /api/mobile/admin-summary  likewise, for the administrators' widgets
//                              (lib/mobile-admin.ts): 403 for everyone else
function failure(e: unknown) {
  const status = e instanceof HttpError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400 : 500;
  return NextResponse.json(
    { error: status === 500 ? "Fehler" : e instanceof ZodError ? "Ungültige Anfrage." : (e as Error).message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = withRequestLocale(handleGET);
async function handleGET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await params;
    if (action !== "summary" && action !== "admin-summary") throw new HttpError(404, "Nicht gefunden");
    const user = identityFromDeviceToken((await headers()).get("authorization"));
    if (!user) throw new HttpError(401, "Bitte melde dich an.");
    if (action === "admin-summary") {
      // Checked on every call: the admin group of the device's session now.
      if (!isInstanceAdmin(user)) throw new HttpError(403, "Administrator-Gruppe erforderlich.");
      const update = await updateStatus().catch(() => null);
      return NextResponse.json(mobileAdminSummary(Date.now(), update), { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(mobileSummary(user, new URL(req.url).searchParams.get("today")), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}

export const POST = withRequestLocale(handlePOST);
async function handlePOST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await params;
    // Browsers never send this header by themselves: no origin check needed.
    const authorization = (await headers()).get("authorization");
    if (action === "unregister" && authorization?.startsWith("Bearer fpd_"))
      return NextResponse.json({ ok: unregisterByDeviceToken(authorization) });
    if (action === "live-activity") {
      const text = await req.text();
      if (text.length > 4_000) throw new HttpError(413, "Anfrage zu groß.");
      return NextResponse.json(setLiveActivityToken(authorization, JSON.parse(text || "{}")), { headers: { "Cache-Control": "no-store" } });
    }
    checkOrigin(req);
    const user = await activeUser();
    if (!user) throw new HttpError(401, "Bitte melde dich an.");
    const text = await req.text();
    if (text.length > 10_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text || "{}");
    if (action === "register") {
      const sessionToken = hash((await cookies()).get(cookieName)?.value || "");
      return NextResponse.json(
        { ...registerMobileDevice(user, sessionToken, body), pushAvailable: mobilePushEnabled(), pushRelay: pushRelayInfo() },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (action === "unregister") return NextResponse.json(unregisterMobileDevice(user, body.installationId));
    throw new HttpError(404, "Nicht gefunden");
  } catch (e) {
    return failure(e);
  }
}
