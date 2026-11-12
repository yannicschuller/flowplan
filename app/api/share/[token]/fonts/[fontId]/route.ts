// A face uploaded for the look of the workspace a publication or share link
// belongs to (#196, lib/workspace-fonts.ts): only that workspace's faces,
// with the link's end date and password like everything served through it.
import { publicTree } from "@/lib/publication";
import { recordScope } from "@/lib/record-share";
import { HttpError } from "@/lib/auth";
import { withShareRequest } from "@/lib/share-access";
import { fontResponse, workspaceFontFile } from "@/lib/workspace-fonts";
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: { params: Promise<{ token: string; fontId: string }> }) {
  try {
    const { token, fontId } = await params;
    const file = await withShareRequest(req, async () => {
      // A shared record (lib/record-share.ts) shows its workspace's look too.
      const record = await recordScope(token);
      const workspaceId = record ? record.page.workspace_id : (await publicTree(token)).root.workspace_id;
      return await workspaceFontFile(fontId, { workspaceOf: workspaceId });
    });
    return fontResponse(file, true);
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Schrift nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
export const HEAD = GET;
