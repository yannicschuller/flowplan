import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { receiveSlackEvent } from "@/lib/slack-replies";

// Slack Event Subscriptions of a Slack webhook (no session: the signing
// secret proves the sender); thread replies become record comments.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (Number(req.headers.get("content-length") || 0) > 1_000_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = await req.text();
    if (body.length > 1_000_000) throw new HttpError(413, "Anfrage zu groß.");
    return NextResponse.json(transaction(() => receiveSlackEvent(id, req.headers, body)));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Webhook konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500 },
    );
  }
}
