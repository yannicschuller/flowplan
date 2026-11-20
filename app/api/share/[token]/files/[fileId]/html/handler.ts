// The preview of an HTML file on a published page or shared record (#398,
// lib/html-preview.ts), with the same checks as the file's download there
// (../handler.ts, lib/publication.ts publicFile).
import { serverError } from "@/lib/request-context";
import { publicFile } from "@/lib/publication";
import { htmlPreviewResponse } from "@/lib/html-preview";
import { HttpError } from "@/lib/auth";
import { withShareRequest } from "@/lib/share-access";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; fileId: string }> },
) {
  try {
    const { token, fileId } = await params;
    return await htmlPreviewResponse(req, await withShareRequest(req, async () => await publicFile(token, fileId)));
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Datei nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : serverError(e) },
    );
  }
}
export const HEAD = GET;
