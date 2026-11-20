// The spreadsheet preview of an uploaded .csv/.xlsx file (#402,
// lib/sheet-preview.ts): its sheets and the cells of one as JSON for the
// read-only viewer. The same checks as its download (GET /api/files/<id>,
// lib/file-access.ts).
//   GET ?sheet=<n>  the sheet's cells (413 above the preview limit, 415 for
//                   an .xls or a file that is no spreadsheet)
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { readableFile } from "@/lib/file-access";
import { sheetPreviewResponse } from "@/lib/sheet-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = withRequestLocale(async (req: Request, { params }: Context) => {
  try {
    const user = await requireUser();
    const fileId = z.uuid().parse((await params).id);
    return await sheetPreviewResponse(req, await readableFile(user, fileId));
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Datei fehlt." }, { status: 404 });
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : serverError(e) },
    );
  }
});
