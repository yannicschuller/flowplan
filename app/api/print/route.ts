import { NextResponse } from "next/server";
import { requireUser, checkOrigin, HttpError } from "@/lib/auth";
import { PRINT_SNAPSHOT_MAX_BYTES, storePrintSnapshot } from "@/lib/print-snapshots";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
// Stores a print view (lib/print-snapshots.ts) and answers with its address.
export async function POST(req: Request) {
  try {
    checkOrigin(req);
    const user = await requireUser();
    if (!req.body) throw new HttpError(400, "Ungültige Eingabe.");
    const reader = req.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > PRINT_SNAPSHOT_MAX_BYTES) {
          await reader.cancel();
          throw new HttpError(413, "Anfrage zu groß.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const html = Buffer.concat(chunks).toString("utf8");
    if (!html.startsWith("<!doctype html>")) throw new HttpError(400, "Ungültige Eingabe.");
    const token = storePrintSnapshot(user.id, html);
    return NextResponse.json({ url: `/api/print/${token}` }, { headers });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Anfrage konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : 500, headers },
    );
  }
}
