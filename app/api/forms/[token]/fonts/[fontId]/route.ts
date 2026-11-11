// A face uploaded for the look of the workspace a form belongs to (#196,
// lib/workspace-fonts.ts): only that workspace's faces, and only to whoever
// may open the form (internal forms: members of the workspace).
import { activeUserFromRequest, HttpError } from "@/lib/auth";
import { getForm } from "@/lib/forms";
import { fontResponse, workspaceFontFile } from "@/lib/workspace-fonts";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ token: string; fontId: string }> }) {
  try {
    const { token, fontId } = await params;
    const form = await getForm(token, await activeUserFromRequest(req));
    return fontResponse(await workspaceFontFile(fontId, { workspaceOf: form.workspace_id }), !form.internal);
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Schrift nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
export const HEAD = GET;
