// Incoming e-mail from a mail provider (lib/inbound-mail.ts): Mailgun,
// Postmark, SendGrid Inbound Parse, a Cloudflare Email Worker or anything
// posting the generic JSON/multipart format or a raw message/rfc822 body.
// The secret token in the path authenticates; an optional signing key adds
// an HMAC check. Answers 2xx for stored, duplicate and rejected mail, so
// providers do not retry; 429/413 ask them to try again later.
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError } from "@/lib/auth";
import {
  INBOUND_REQUEST_BYTES,
  inboundAddressByToken,
  parseInboundPayload,
  receiveInboundMail,
  verifyInboundSignature,
} from "@/lib/inbound-mail";

export const dynamic = "force-dynamic";

// The body up to the limit; a chunked body is counted while it is read.
async function limitedBody(req: Request) {
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > INBOUND_REQUEST_BYTES) throw new HttpError(413, "E-Mail zu groß.");
  if (!req.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > INBOUND_REQUEST_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "E-Mail zu groß.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const address = inboundAddressByToken(token);
    if (!address) throw new HttpError(404, "E-Mail-Eingang nicht gefunden.");
    const body = await limitedBody(req);
    const payload = await parseInboundPayload(req.headers.get("content-type") || "", body);
    verifyInboundSignature(address, body, req.headers.get("x-flowplan-signature"), payload.signature);
    const result = receiveInboundMail(token, payload.mail);
    return NextResponse.json({ ok: true, provider: payload.provider, ...result });
  } catch (e) {
    if (!(e instanceof HttpError) && !(e instanceof z.ZodError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Die E-Mail konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
