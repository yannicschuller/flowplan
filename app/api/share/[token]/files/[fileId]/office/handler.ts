// The content preview of a presentation or text document on a published
// page or shared record (#562, lib/office-preview.ts), with the same checks
// as the file's download there (../handler.ts, lib/publication.ts publicFile).
import { serverError } from "@/lib/request-context";
import { publicFile } from "@/lib/publication";
import { officePreviewResponse } from "@/lib/office-preview";
import { HttpError } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { withShareRequest } from "@/lib/share-access";
export const dynamic = "force-dynamic";
export const GET = withRequestLocale(async (req: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) => {
  try {
    const { token, fileId } = await params;
    return await officePreviewResponse(req, await withShareRequest(req, async () => await publicFile(token, fileId)));
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Datei nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : serverError(e) },
    );
  }
});
