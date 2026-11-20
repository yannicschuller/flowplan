// The preview of an uploaded HTML file (#398, lib/html-preview.ts): the
// file's bytes as a sandboxed page for the viewer's <iframe sandbox="">.
// The same checks as its download (GET /api/files/<id>, lib/file-access.ts).
//   GET    the page (413 above 5 MB, 415 for a file that is no HTML)
//   HEAD   the same without the body (the viewer asks first)
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { readableFile } from "@/lib/file-access";
import { htmlPreviewResponse } from "@/lib/html-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = await requireUser();
    const fileId = z.uuid().parse((await params).id);
    return await htmlPreviewResponse(req, await readableFile(user, fileId));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Datei fehlt." }, { status: 404 });
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : serverError(e) },
    );
  }
});
