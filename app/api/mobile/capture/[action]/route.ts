import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { withDevice } from "@/lib/mobile-device-route";
import { captureTargets, MAX_CAPTURE_FILES, saveCapture, spotlightItems } from "@/lib/mobile-capture";
import { limitWidgets } from "@/lib/mobile-widgets";
import type { UploadFile } from "@/lib/mobile-widget-actions";
import { requireBodySize } from "@/lib/upload-safety";
import { maxUploadMbFor } from "@/lib/user-limits";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Share extension, document scanner and Spotlight of the mobile apps
// (lib/mobile-capture.ts), only with the device token (Bearer fpd_…):
// GET  /api/mobile/capture/targets
// GET  /api/mobile/capture/spotlight
// POST /api/mobile/capture/save   JSON, or multipart/form-data with the fields and up to 10 "file"
const headers = { "Cache-Control": "no-store" };
const JSON_LIMIT = 150_000;
// The whole request with its files; each file has its own limit as well.
const MAX_REQUEST = 100 * 1024 * 1024;

export async function GET(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  return withDevice(req, async (user) => {
    limitWidgets(user, "options");
    if (action === "targets") return NextResponse.json(await captureTargets(user), { headers });
    if (action === "spotlight") return NextResponse.json(await spotlightItems(user), { headers });
    throw new HttpError(404, "Nicht gefunden");
  });
}

// Saved once per Idempotency-Key (the share extension retries with the same one).
export const POST = withIdempotency(handlePOST);
async function handlePOST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  return withDevice(req, async (user) => {
    if (action !== "save") throw new HttpError(404, "Nicht gefunden");
    limitWidgets(user, "action");
    if (!(req.headers.get("content-type") || "").startsWith("multipart/form-data")) {
      const text = await req.text();
      if (text.length > JSON_LIMIT) throw new HttpError(413, "Anfrage zu groß.");
      return NextResponse.json(await saveCapture(user, JSON.parse(text || "{}")), { headers });
    }
    // Files: the size is known before anything is read.
    requireBodySize(req, Math.min(MAX_REQUEST, (await maxUploadMbFor(user)) * 1024 * 1024 * MAX_CAPTURE_FILES) + 1_000_000, "Anfrage zu groß.");
    limitWidgets(user, "upload");
    const form = await req.formData();
    const files: UploadFile[] = [];
    for (const file of form.getAll("file")) {
      if (file instanceof File) files.push({ name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    }
    const fields = Object.fromEntries([...form.entries()].filter(([key, value]) => key !== "file" && typeof value === "string"));
    return NextResponse.json(await saveCapture(user, fields, files), { headers });
  });
}
