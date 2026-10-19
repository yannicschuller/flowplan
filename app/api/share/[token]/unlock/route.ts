import { NextResponse } from "next/server";
import { checkOrigin, HttpError } from "@/lib/auth";
import { clientAddress } from "@/lib/client-address";
import { unlockCookies, unlockShare } from "@/lib/share-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

// The password of a protected link: the right one sets the unlock cookie
// for this link only (lib/share-access.ts); wrong ones are limited.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    checkOrigin(req);
    if (Number(req.headers.get("content-length") || 0) > 2000) throw new HttpError(413, "Anfrage zu groß.");
    const { token } = await params;
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    const { value, maxAge } = await unlockShare(token, body?.password, clientAddress(req.headers));
    const response = NextResponse.json({ ok: true }, { headers });
    if (value) for (const cookie of unlockCookies(token, value, maxAge)) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return NextResponse.json({ error: e instanceof HttpError ? e.message : "Ungültige Anfrage." }, { status, headers });
  }
}
