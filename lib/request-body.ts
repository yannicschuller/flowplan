// Request bodies read with a limit. `req.text()` and `req.json()` buffer
// the whole body before any check, and requests that carry a body are not
// seen by proxy.ts (its matcher skips them), so Next's own body cap never
// applies to route handlers. These readers refuse a declared size above the
// limit at once and count the bytes while streaming, stopping at the limit
// – also for chunked bodies without Content-Length.
import { HttpError } from "./auth";

export async function readBodyLimited(req: Request, maxBytes: number, message = "Anfrage zu groß."): Promise<Buffer> {
  const header = req.headers.get("content-length");
  if (header && /^\d+$/.test(header) && Number(header) > maxBytes) {
    void req.body?.cancel().catch(() => undefined);
    throw new HttpError(413, message);
  }
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new HttpError(413, message);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

export async function readTextLimited(req: Request, maxBytes: number, message?: string): Promise<string> {
  return (await readBodyLimited(req, maxBytes, message)).toString("utf8");
}

// JSON with a limit; an empty body is `{}`. Malformed JSON throws a
// SyntaxError, as `req.json()` does.
export async function readJsonLimited(req: Request, maxBytes: number, message?: string): Promise<unknown> {
  const text = await readTextLimited(req, maxBytes, message);
  return JSON.parse(text || "{}") as unknown;
}
