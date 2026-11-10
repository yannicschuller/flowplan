import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { withDevice } from "@/lib/mobile-device-route";
import { limitWidgets, widgetKinds, widgetOptions, widgetsData, type WidgetKind } from "@/lib/mobile-widgets";
import { SHARE_MAX_FILES, widgetAction, type UploadFile } from "@/lib/mobile-widget-actions";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Configurable widgets, Live Activities and Shortcuts of the mobile apps
// (lib/mobile-widgets.ts), only with the device token (Bearer fpd_…):
// GET  /api/mobile/widgets/options?kind=…[&pageId=…]
// POST /api/mobile/widgets/data      { today, zone, lang, widgets: [{ id, kind, config }] }
// POST /api/mobile/widgets/action    { action, … } (JSON), or multipart/form-data
//                                    for capture.upload (fields + "file") and
//                                    capture.share (fields + up to 10 "file")
const headers = { "Cache-Control": "no-store" };
const JSON_LIMIT = 32_000;

export async function GET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const query = new URL(req.url).searchParams;
  return withDevice(req, async (user) => {
    if (action !== "options") throw new HttpError(404, "Nicht gefunden");
    const kind = query.get("kind");
    if (!widgetKinds.includes(kind as WidgetKind)) throw new HttpError(400, "Ungültige Anfrage.");
    limitWidgets(user, "options");
    return NextResponse.json(await widgetOptions(user, kind as WidgetKind, { pageId: query.get("pageId") }), { headers });
  });
}

async function jsonBody(req: Request) {
  const text = await req.text();
  if (text.length > JSON_LIMIT) throw new HttpError(413, "Anfrage zu groß.");
  return JSON.parse(text || "{}") as Record<string, unknown>;
}

// Widget actions with Idempotency-Key (the apps send one per tap and keep
// it for retries, lib/idempotency.ts); the data refresh only reads.
export const POST = withIdempotency(handlePOST, { skip: (req) => !new URL(req.url).pathname.endsWith("/action") });
async function handlePOST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  return withDevice(req, async (user) => {
    if (action === "data") {
      limitWidgets(user, "data");
      return NextResponse.json(await widgetsData(user, await jsonBody(req)), { headers });
    }
    if (action !== "action") throw new HttpError(404, "Nicht gefunden");
    limitWidgets(user, "action");
    // Photos and voice memos come as multipart/form-data.
    if ((req.headers.get("content-type") || "").startsWith("multipart/form-data")) {
      limitWidgets(user, "upload");
      const form = await req.formData();
      // capture.share takes several "file" parts, capture.upload the first.
      const parts = form.getAll("file").filter((value): value is File => value instanceof File);
      if (parts.length > SHARE_MAX_FILES) throw new HttpError(413, "Anfrage zu groß.");
      const uploads: UploadFile[] = await Promise.all(
        parts.map(async (file) => ({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) })),
      );
      const fields = Object.fromEntries([...form.entries()].filter(([key, value]) => key !== "file" && typeof value === "string"));
      const input = { ...fields, ...(fields.transcribe !== undefined ? { transcribe: fields.transcribe !== "0" && fields.transcribe !== "false" } : {}) };
      return NextResponse.json(await widgetAction(user, input, uploads[0] ?? null, uploads), { headers });
    }
    return NextResponse.json(await widgetAction(user, await jsonBody(req)), { headers });
  });
}
