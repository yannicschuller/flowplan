// HTTP to AI providers: one request, streamed response, no redirects, keys
// only in headers. Addresses a person entered for their own provider go
// through the SSRF protection of lib/safe-fetch.ts (https only, no private
// or special addresses, the checked address pinned for the connection).
// Addresses from the administration ("trusted") may be http and private –
// Ollama in the same compose network or on the LAN – but never redirect.
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { HttpError } from "../auth";
import { pinnedLookup, privateAddress } from "../safe-fetch";

export class AiError extends HttpError {}

export const AI_MESSAGES = {
  unreachable: "Der KI-Anbieter ist nicht erreichbar.",
  timeout: "Der KI-Anbieter antwortet nicht rechtzeitig.",
  tooLarge: "Die Antwort des KI-Anbieters ist zu groß.",
  redirect: "Der KI-Anbieter leitet weiter. Weiterleitungen sind nicht erlaubt.",
  httpsOnly: "Nur https-Adressen ohne Zugangsdaten sind erlaubt.",
  internal: "Interne Adressen sind für eigene KI-Anbieter nicht erlaubt.",
  badUrl: "Ungültige Adresse des KI-Anbieters.",
  aborted: "Die KI-Anfrage wurde abgebrochen.",
  garbled: "Die Antwort des KI-Anbieters ist unverständlich.",
} as const;

export type AiResponse = {
  status: number;
  headers: IncomingMessage["headers"];
  body: AsyncIterable<Buffer>;
  // The whole body as text (error bodies, model lists), at most maxBytes.
  text: (maxBytes?: number) => Promise<string>;
};
type Options = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  // Configured by an administrator: http and private addresses allowed.
  trusted: boolean;
  // Until the response headers arrive (a local model may first need loading).
  headersTimeout?: number;
  // Longest silence while the response streams.
  idleTimeout?: number;
};

export function checkAiUrl(raw: string, trusted: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiError(400, AI_MESSAGES.badUrl);
  }
  if (url.username || url.password || !(url.protocol === "https:" || (trusted && url.protocol === "http:")))
    throw new AiError(400, AI_MESSAGES.httpsOnly);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!trusted && isIP(host) && privateAddress(host)) throw new AiError(400, AI_MESSAGES.internal);
  return url;
}

export function aiFetch(raw: string, options: Options): Promise<AiResponse> {
  const url = checkAiUrl(raw, options.trusted);
  const { signal } = options;
  return new Promise<AiResponse>((resolve, reject) => {
    if (signal?.aborted) return reject(new AiError(499, AI_MESSAGES.aborted));
    const body = options.body ?? "";
    const request = url.protocol === "http:" ? httpRequest : httpsRequest;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = request(
      url,
      {
        method: options.method || "POST",
        headers: {
          "user-agent": "Flowplan-AI/1.0",
          ...(options.method === "GET" ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
        lookup: pinnedLookup(options.trusted) as never,
      },
      (res) => {
        clearTimeout(headersTimer);
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          req.destroy();
          return fail(new AiError(502, AI_MESSAGES.redirect));
        }
        settled = true;
        // Silence while streaming ends the request.
        res.setTimeout(options.idleTimeout ?? 120_000, () => res.destroy(new AiError(504, AI_MESSAGES.timeout)));
        const iterate = async function* () {
          try {
            for await (const chunk of res) yield chunk as Buffer;
          } catch (error) {
            if (signal?.aborted) throw new AiError(499, AI_MESSAGES.aborted);
            if (error instanceof AiError) throw error;
            throw new AiError(502, AI_MESSAGES.unreachable);
          }
        };
        resolve({
          status,
          headers: res.headers,
          body: iterate(),
          text: async (maxBytes = 1_000_000) => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of iterate()) {
              size += chunk.length;
              if (size > maxBytes) {
                res.destroy();
                throw new AiError(502, AI_MESSAGES.tooLarge);
              }
              chunks.push(chunk);
            }
            return Buffer.concat(chunks).toString("utf8");
          },
        });
      },
    );
    const headersTimer = setTimeout(() => req.destroy(new AiError(504, AI_MESSAGES.timeout)), options.headersTimeout ?? 120_000);
    const onAbort = () => req.destroy(new AiError(499, AI_MESSAGES.aborted));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => {
      clearTimeout(headersTimer);
      signal?.removeEventListener("abort", onAbort);
    });
    req.on("error", (error) => {
      clearTimeout(headersTimer);
      if (error instanceof AiError) return fail(error);
      if (/Interne Adressen/.test(error.message)) return fail(new AiError(400, AI_MESSAGES.internal));
      fail(new AiError(502, AI_MESSAGES.unreachable));
    });
    req.end(body || undefined);
  });
}

// Lines of a streamed body (NDJSON, server-sent events), with a cap on the
// total size and on a single line.
export async function* lines(body: AsyncIterable<Buffer>, maxBytes: number): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "",
    size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new AiError(502, AI_MESSAGES.tooLarge);
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
    }
    if (buffer.length > 1_000_000) throw new AiError(502, AI_MESSAGES.tooLarge);
  }
  buffer += decoder.decode();
  if (buffer) yield buffer.replace(/\r$/, "");
}

// Server-sent events: { event, data } per block.
export async function* sseEvents(body: AsyncIterable<Buffer>, maxBytes: number): AsyncGenerator<{ event: string; data: string }> {
  let event = "",
    data: string[] = [];
  for await (const line of lines(body, maxBytes)) {
    if (line === "") {
      if (data.length) yield { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length) yield { event: event || "message", data: data.join("\n") };
}
