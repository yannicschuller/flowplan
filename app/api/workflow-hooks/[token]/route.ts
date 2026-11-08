// Inbound workflow webhooks (lib/workflows/inbound.ts, docs/specs/workflows.md
// §9.6): POST /api/workflow-hooks/<token>, signed (X-Flowplan-Timestamp,
// X-Flowplan-Signature) or – chosen deliberately – by the token alone.
// Answers 202 with the run's id, 200 for a repeated delivery.
import { NextResponse } from "next/server";
import { HttpError, refuseWhileReadOnly } from "@/lib/auth";
import { HOOK_BODY_BYTES, receiveWorkflowHook } from "@/lib/workflows/inbound";

export const dynamic = "force-dynamic";

async function limitedBody(req: Request) {
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > HOOK_BODY_BYTES) throw new HttpError(413, "Der Inhalt ist größer als 256 KB.");
  if (!req.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > HOOK_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Der Inhalt ist größer als 256 KB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    await refuseWhileReadOnly(req);
    const { token } = await params;
    const body = await limitedBody(req);
    const result = await receiveWorkflowHook({ token, headers: req.headers, body, query: new URL(req.url).searchParams });
    if (!result.runId && result.status >= 400)
      return NextResponse.json({ error: result.status === 409 ? "Der Workflow ist pausiert." : "Zu viele Läufe. Bitte später erneut versuchen." }, { status: result.status });
    return NextResponse.json({ runId: result.runId, ...(result.duplicate ? { duplicate: true } : {}) }, { status: result.status });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json({ error: e instanceof HttpError ? e.message : "Der Webhook konnte nicht verarbeitet werden." }, { status: e instanceof HttpError ? e.status : 500 });
  }
}
