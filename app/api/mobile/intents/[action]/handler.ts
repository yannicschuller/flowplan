import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { withDevice } from "@/lib/mobile-device-route";
import { limitWidgets } from "@/lib/mobile-widgets";
import { intentPages, intentSearch, intentWorkspaces } from "@/lib/mobile-intents";
import { setDeviceFocus } from "@/lib/mobile-focus";
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

export async function GET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const query = new URL(req.url).searchParams;
  return await withDevice(req, async (user) => {
    limitWidgets(user, "options");
    if (action === "pages") {
      const ids = query.get("ids");
      return NextResponse.json(await intentPages(user, { q: query.get("q") ?? undefined, ids: ids ? ids.split(",").filter(Boolean) : undefined }), { headers });
    }
    if (action === "search") return NextResponse.json(await intentSearch(user, { q: query.get("q") ?? "" }), { headers });
    if (action === "workspaces") return NextResponse.json(await intentWorkspaces(user), { headers });
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
    return NextResponse.json(await setDeviceFocus(user, req.headers.get("authorization"), JSON.parse(text || "{}")), { headers });
  });
}
