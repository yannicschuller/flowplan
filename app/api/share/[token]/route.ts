import { NextResponse, after } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { sharedContent, mutateSharedContent } from "@/lib/shared-content";
import { sharePresence } from "@/lib/share-presence";
import { dispatchPush } from "@/lib/push";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
function failure(e: unknown) {
  const status =
    e instanceof HttpError
      ? e.status
      : e instanceof z.ZodError || e instanceof SyntaxError
        ? 400
        : 500;
  return NextResponse.json(
    {
      error:
        e instanceof HttpError
          ? e.message
          : "Anfrage konnte nicht verarbeitet werden.",
    },
    { status, headers },
  );
}
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params,
      url = new URL(req.url);
    return NextResponse.json(
      sharedContent(
        token,
        url.searchParams.get("pageId") || undefined,
        url.searchParams.get("rowId") || undefined,
      ),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    checkOrigin(req);
    if (Number(req.headers.get("content-length") || 0) > 2_100_000)
      throw new HttpError(413, "Anfrage zu groß.");
    const { token } = await params,
      text = await req.text();
    if (text.length > 2_100_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text);
    // Cursor of a guest editor: frequent and small, outside the edit limits.
    if (body?.action === "presence") return NextResponse.json(sharePresence(token, body), { headers });
    const data = mutateSharedContent(token, body);
    after(dispatchPush);
    return NextResponse.json(data, { headers });
  } catch (e) {
    return failure(e);
  }
}
