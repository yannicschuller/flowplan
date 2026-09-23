import { publicFile } from "@/lib/publication";
import { fileResponse } from "@/lib/file-response";
import { HttpError } from "@/lib/auth";
export const dynamic = "force-dynamic";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; fileId: string }> },
) {
  try {
    const { token, fileId } = await params;
    return await fileResponse(req, publicFile(token, fileId));
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Datei nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
export const HEAD = GET;
