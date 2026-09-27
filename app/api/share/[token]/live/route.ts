import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError } from "@/lib/auth";
import { watchPrefix } from "@/lib/document-live";
import { shareAccess } from "@/lib/share-presence";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Push channel for guest editors: "check" when the page or record changed
// (members or other guests), "presence" when cursors moved. The link is
// checked again on every keepalive; a revoked link ends the stream.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params,
      url = new URL(req.url);
    const pageId = z.uuid().parse(url.searchParams.get("pageId"));
    const rowId = url.searchParams.get("rowId") ? z.uuid().parse(url.searchParams.get("rowId")) : null;
    const clientId = z.uuid().parse(url.searchParams.get("client"));
    shareAccess(token, pageId, rowId);
    const encoder = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        const unwatch = watchPrefix(pageId, rowId, clientId, send);
        const ping = setInterval(() => {
          try {
            shareAccess(token, pageId, rowId);
            send(": ping\n\n");
          } catch {
            try {
              send(`data: ${JSON.stringify({ type: "revoked" })}\n\n`);
            } catch {}
            stop();
          }
        }, 15_000);
        stop = () => {
          clearInterval(ping);
          unwatch();
          try {
            controller.close();
          } catch {}
        };
        req.signal.addEventListener("abort", () => stop());
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return NextResponse.json({ error: e instanceof HttpError ? e.message : "Ungültige Anfrage." }, { status });
  }
}
