import { readTextLimited } from "@/lib/request-body";
import { serverError } from "@/lib/request-context";
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { sharedContent, mutateSharedContent } from "@/lib/shared-content";
import { sharedStudyCards } from "@/lib/shared-study";
import { sharePresence } from "@/lib/share-presence";
import { dispatchPush } from "@/lib/push";
import { withShareRequest } from "@/lib/share-access";
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
        : serverError(e);
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
    // The cards of a shared deck (lib/shared-study.ts): ?study=1, the
    // study view, and the offset of the next part.
    if (url.searchParams.get("study") === "1")
      return NextResponse.json(
        await withShareRequest(req, async () =>
          await sharedStudyCards(token, {
            pageId: url.searchParams.get("pageId") || undefined,
            viewId: url.searchParams.get("viewId") || undefined,
            offset: Number(url.searchParams.get("offset") || 0) || 0,
          }),
        ),
        { headers },
      );
    return NextResponse.json(
      await withShareRequest(req, async () =>
        await sharedContent(
          token,
          url.searchParams.get("pageId") || undefined,
          url.searchParams.get("rowId") || undefined,
        ),
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
    await checkOrigin(req);
    const { token } = await params,
      text = await readTextLimited(req, 2_100_000);
    const body = JSON.parse(text);
    // Cursor of a guest editor: frequent and small, outside the edit limits.
    if (body?.action === "presence") return NextResponse.json(await withShareRequest(req, async () => await sharePresence(token, body)), { headers });
    const data = await withShareRequest(req, async () => await mutateSharedContent(token, body));
    after(dispatchPush);
    return NextResponse.json(data, { headers });
  } catch (e) {
    return failure(e);
  }
}
