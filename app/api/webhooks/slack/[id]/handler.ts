import { readTextLimited } from "@/lib/request-body";
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { HttpError, refuseWhileReadOnly } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { receiveSlackEvent } from "@/lib/slack-replies";

// Slack Event Subscriptions of a Slack webhook (no session: the signing
// secret proves the sender); thread replies become record comments.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Not during an instance move (lib/instance-read-only.ts): the sender retries.
    await refuseWhileReadOnly(req);
    const { id } = await params;
    const body = await readTextLimited(req, 1_000_000);
    return NextResponse.json(await transaction(async () => await receiveSlackEvent(id, req.headers, body)));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Webhook konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : serverError(e) },
    );
  }
}
