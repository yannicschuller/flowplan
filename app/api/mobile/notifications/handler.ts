import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { withContentLocale } from "@/lib/content-locale";
import { pickLocale } from "@/lib/i18n";
import { deviceFromToken } from "@/lib/mobile-devices";
import { notificationAction } from "@/lib/notification-actions";
import { widgetLocale } from "@/lib/mobile-widgets";
import { withIdempotency } from "@/lib/idempotency";
import { deviceFailure, refuseDeviceWrite } from "@/lib/mobile-device-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The buttons on the apps' push notifications (lib/notification-actions.ts),
// only with the device token (Bearer fpd_…):
// POST /api/mobile/notifications  { action: "done" | "tomorrow" | "reply" | "read", notificationId, text?, today? }
//                                 { action: "approve", notificationId, approvalId, confirmation }
//                                 { action: "reject", notificationId, approvalId? }
// (workflow approvals, docs/specs/workflows.md §11.8)
const headers = { "Cache-Control": "no-store" };

// A notification button tapped twice (or retried) acts once per Idempotency-Key.
export const POST = withIdempotency(handlePOST);
async function handlePOST(req: Request) {
  const query = new URL(req.url).searchParams;
  const fallback = pickLocale(null, req.headers.get("accept-language"));
  // Browsers never send this header by themselves: no origin check needed.
  const found = await deviceFromToken(req.headers.get("authorization"));
  if (!found) return deviceFailure(new HttpError(401, "Bitte melde dich an."), fallback);
  const { user, device } = found;
  const locale = await widgetLocale(user, query.get("lang"), req.headers.get("accept-language"));
  return withContentLocale(locale, async () => {
    try {
      await refuseDeviceWrite(req);
      const text = await req.text();
      if (text.length > 10_000) throw new HttpError(413, "Anfrage zu groß.");
      return NextResponse.json(await notificationAction(user, JSON.parse(text || "{}"), device), { headers });
    } catch (e) {
      return deviceFailure(e, locale);
    }
  });
}
