// One picture of an uploaded presentation or text document (#562,
// lib/office-preview.ts), with the same checks as its download
// (GET /api/files/<id>, lib/file-access.ts).
//   GET ?name=<part>  the picture, only if a slide or the document shows it
//                     (404 otherwise; 415 for anything but PNG, JPEG, GIF, WebP)
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { readableFile } from "@/lib/file-access";
import { officeImageResponse } from "@/lib/office-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = await requireUser();
    const fileId = z.uuid().parse((await params).id);
    return await officeImageResponse(req, await readableFile(user, fileId));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Datei fehlt." }, { status: 404 });
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : serverError(e) },
    );
  }
});
