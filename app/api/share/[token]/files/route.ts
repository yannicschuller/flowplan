import { NextResponse } from "next/server";
import { requireBodySize } from "@/lib/upload-safety";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { guestUpload, MAX_GUEST_UPLOAD } from "@/lib/shared-uploads";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

// Upload through an editing share link (multipart: pageId, file).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    checkOrigin(req);
    requireBodySize(req, MAX_GUEST_UPLOAD + 100000, "Gäste können Dateien bis 10 MB hochladen.");
    const { token } = await params,
      form = await req.formData(),
      file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Datei fehlt.");
    const pageId = z.string().uuid().parse(form.get("pageId"));
    return NextResponse.json(await guestUpload(token, pageId, file), {
      headers,
    });
  } catch (e) {
    const status =
      e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500;
    return NextResponse.json(
      {
        error:
          e instanceof HttpError
            ? e.message
            : "Upload konnte nicht verarbeitet werden.",
      },
      { status, headers },
    );
  }
}
