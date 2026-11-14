// A shared whiteboard edited by guests of an edit link (#280, lib/share-canvas.ts).
//   GET ?pageId=P                               the board as the link shows it {state, generation}
//   GET ?pageId=P&client=C (text/event-stream)  the others' pointers; a revoked link ends the stream
//   POST {action:"sync", pageId, generation, update?}   merge and pull, like whiteboard.sync
//   POST {action:"cursor", pageId, clientId, point}     the guest's pointer
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { onShutdown } from "@/lib/cluster/runtime";
import { shareCookieOf, withShareCookie, withShareRequest } from "@/lib/share-access";
import { canvasAccess, sharedBoardCursor, syncSharedBoard, watchSharedBoard } from "@/lib/share-canvas";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
type Context = { params: Promise<{ token: string }> };

function failure(e: unknown) {
  const status = e instanceof HttpError ? e.status : e instanceof z.ZodError || e instanceof SyntaxError ? 400 : 500;
  if (status === 500) console.error(e);
  return NextResponse.json({ error: e instanceof HttpError ? e.message : "Anfrage konnte nicht verarbeitet werden." }, { status, headers });
}

export async function GET(req: Request, { params }: Context) {
  try {
    const { token } = await params,
      url = new URL(req.url);
    const pageId = z.uuid().parse(url.searchParams.get("pageId"));
    if (!url.searchParams.has("client"))
      return NextResponse.json(await withShareRequest(req, async () => await syncSharedBoard(token, { pageId })), { headers });
    const clientId = z.uuid().parse(url.searchParams.get("client"));
    // Password and end date count on every keepalive too.
    const unlock = shareCookieOf(req.headers);
    const check = async () => await withShareCookie(unlock, async () => await canvasAccess(token, pageId, "whiteboard"));
    const { page } = await check();
    const encoder = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        const unwatch = watchSharedBoard(token, page.id, clientId, send);
        const forget = onShutdown(() => stop());
        const ping = setInterval(async () => {
          try {
            await check();
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
          forget();
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
    return failure(e);
  }
}

export async function POST(req: Request, { params }: Context) {
  try {
    await checkOrigin(req);
    const { token } = await params;
    if (Number(req.headers.get("content-length") || 0) > 5_700_000) throw new HttpError(413, "Anfrage zu groß.");
    const text = await req.text();
    if (text.length > 5_700_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = JSON.parse(text);
    if (body?.action === "cursor") {
      if (text.length > 1024) throw new HttpError(413, "Cursoranfrage zu groß.");
      await withShareRequest(req, async () => await sharedBoardCursor(token, body));
      return new Response(null, { status: 204, headers });
    }
    if (body?.action !== "sync") throw new HttpError(400, "Unbekannte Aktion.");
    return NextResponse.json(await withShareRequest(req, async () => await syncSharedBoard(token, body)), { headers });
  } catch (e) {
    return failure(e);
  }
}
