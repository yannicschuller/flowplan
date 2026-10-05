import { NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin, HttpError } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { transaction } from "@/lib/db";
import { customerReply } from "@/lib/service-desk";

// A customer answers on their request page (the link is the key).
async function handlePOST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    checkOrigin(req);
    const { token } = await params;
    const raw = await req.text();
    if (raw.length > 20_000) throw new HttpError(413, "Nachricht zu lang.");
    const ticket = transaction(() => customerReply(token, JSON.parse(raw)));
    return NextResponse.json(ticket, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const invalid = e instanceof z.ZodError || e instanceof SyntaxError;
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : invalid ? "Bitte Eingaben prüfen." : "Nachricht konnte nicht gesendet werden." },
      { status: e instanceof HttpError ? e.status : invalid ? 400 : 500 },
    );
  }
}
export const POST = withRequestLocale(handlePOST);
