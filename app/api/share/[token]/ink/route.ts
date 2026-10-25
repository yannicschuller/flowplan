// A drawing block on a shared or published page as a picture, read-only
// (lib/ink-export.ts): ?page=P&block=B&height=H&paper=X → { svg, text }.
import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { withShareRequest } from "@/lib/share-access";
import { publicPage } from "@/lib/publication";
import { inkPicture } from "@/lib/ink-export";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const url = new URL(req.url);
    const pageId = url.searchParams.get("page") || "";
    const block = url.searchParams.get("block") || "";
    if (!/^[0-9a-f-]{36}$/i.test(pageId) || !/^[\w-]{1,40}$/.test(block)) throw new HttpError(400, "Ungültige Eingabe.");
    const picture = withShareRequest(req, () => {
      const { page } = publicPage(token, pageId);
      return inkPicture(page, { id: block, height: url.searchParams.get("height"), paper: url.searchParams.get("paper") });
    });
    return NextResponse.json({ svg: picture?.svg ?? null, text: picture?.text ?? "" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
