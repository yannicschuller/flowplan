// The ink on a shared or published PDF, read-only (lib/ink-store.ts).
import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { publicFileInk } from "@/lib/ink-store";
import { withShareRequest } from "@/lib/share-access";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) {
  try {
    const { token, fileId } = await params;
    return NextResponse.json(
      withShareRequest(req, () => publicFileInk(token, fileId)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Datei nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
