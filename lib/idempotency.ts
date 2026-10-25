// Idempotency keys for state-changing requests (schema 65). A request with
// `Idempotency-Key` is applied once per principal and key; retries of it –
// a flaky network, the offline queue after reconnecting, the apps' native
// queues, a widget tapped twice, a script that tries again – get the stored
// answer instead of applying the change a second time.
//
// - The key is reserved under the principal: a session's person ("u:"), an
//   API token ("t:") or a mobile app installation ("d:"); keys of one never
//   match another's.
// - The same key with the same request (method, path and a SHA-256 of the
//   body) answers with the stored status and body plus
//   `Idempotent-Replayed: true`; with a different request 422; while the
//   first is still running 409 with `Retry-After`.
// - /api/command reserves the key inside the transaction of the action
//   (command(…, hook)): the change and the stored answer commit together, a
//   failed action leaves no key behind. Other handlers (uploads, imports,
//   widget actions) reserve it first ('processing') and store the answer
//   when they are done; a failure releases the key, so it can be retried.
// - Answers are kept up to 64 KB and only as JSON; answers that carry
//   secrets (new tokens, feed addresses, passwords) keep only their status:
//   a retry gets 409 "already applied", never the secret again. The same
//   for answers beyond the limit.
// - Keys expire after 24 hours (sweepIdempotencyKeys in the operations
//   worker). Requests without a key behave as before.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { one, run } from "./db";
import { cookieName, HttpError } from "./auth";
import { localeOfRequest } from "./content-locale";
import { localizedMessage } from "./i18n-errors";
import {
  IDEMPOTENCY_CODES,
  IDEMPOTENCY_HEADER,
  REPLAYED_HEADER,
  isIdempotencyKey,
  unkeyedActions,
} from "./idempotency-key";

export const IDEMPOTENCY_TTL = 24 * 3600_000;
export const MAX_STORED_RESPONSE = 64 * 1024;
// Bodies are hashed up to this size (the largest archive imports); larger
// ones are refused before anything else reads them.
const MAX_HASHED_BODY = 120 * 1024 * 1024;
const RETRY_AFTER_SECONDS = 2;

// Commands whose answer is a secret shown once (a new token, an address
// with its token, a generated password).
const secretActions = new Set([
  "token.create",
  "calendar.feed",
  "calendar.caldav",
  "inbound.save",
  "inbound.rotate",
  "share.create",
  "form.update",
  "page.share",
]);
// Property names in an answer that make it a secret one.
const SECRET_NAME = /(token|secret|password|passphrase|recoverycodes?|privatekey|apikey)$/i;
export function containsSecret(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 6) return false;
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, depth + 1));
  return Object.entries(value).some(([name, item]) => (SECRET_NAME.test(name) && item != null && item !== "") || containsSecret(item, depth + 1));
}

type Principal = { scope: string; userId: string };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// Who the key belongs to, from the request's own credentials (the handler
// still authenticates; null means it will refuse, so no key is reserved).
export function idempotencyPrincipal(req: Request): Principal | null {
  const authorization = req.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const match = authorization.match(/^Bearer\s+(fpd?_[A-Za-z0-9_-]{20,80})$/);
    if (!match) return null;
    const tokenHash = sha256(match[1]);
    if (match[1].startsWith("fpd_")) {
      const device = one<{ id: string; user_id: string }>("SELECT id,user_id FROM mobile_devices WHERE token_hash=?", tokenHash);
      return device ? { scope: `d:${device.id}`, userId: device.user_id } : null;
    }
    const token = one<{ id: string; user_id: string }>(
      "SELECT id,user_id FROM api_tokens WHERE token_hash=? AND (expires_at IS NULL OR expires_at>?)",
      tokenHash,
      Date.now(),
    );
    return token ? { scope: `t:${token.id}`, userId: token.user_id } : null;
  }
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== cookieName) continue;
    let token: string;
    try {
      token = decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
    const session = one<{ user_id: string }>("SELECT user_id FROM sessions WHERE token=? AND expires>?", sha256(token), Date.now());
    return session ? { scope: `u:${session.user_id}`, userId: session.user_id } : null;
  }
  return null;
}

// The request as hashed: method, path with its query (without the display
// language) and the body. Multipart bodies hash with their boundary
// replaced – a client builds a new one for every attempt.
async function requestHash(req: Request): Promise<string> {
  const url = new URL(req.url);
  const query = [...url.searchParams.entries()].filter(([name]) => name !== "lang").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const target = url.pathname + (query.length ? `?${new URLSearchParams(query)}` : "");
  let body: Buffer = Buffer.alloc(0);
  if (req.body) {
    const length = Number(req.headers.get("content-length") || 0);
    if (length > MAX_HASHED_BODY) throw new HttpError(413, "Anfrage zu groß.");
    const reader = req.clone().body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HASHED_BODY) {
        // Not awaited: a tee's cancel settles only once both branches are done.
        void reader.cancel().catch(() => undefined);
        throw new HttpError(413, "Anfrage zu groß.");
      }
      chunks.push(value);
    }
    body = Buffer.concat(chunks);
    const boundary = (req.headers.get("content-type") || "").match(/^multipart\/form-data;.*boundary="?([^";]+)"?/i)?.[1];
    if (boundary) body = replaceAll(body, Buffer.from(`--${boundary}`), Buffer.from("--flowplan-boundary"));
  }
  return sha256(`${req.method.toUpperCase()}\n${target}\n${sha256(body)}`);
}
function replaceAll(source: Buffer, search: Buffer, replacement: Buffer) {
  const parts: Buffer[] = [];
  let from = 0;
  for (let at = source.indexOf(search, from); at !== -1; at = source.indexOf(search, from)) {
    parts.push(source.subarray(from, at), replacement);
    from = at + search.length;
  }
  if (!from) return source;
  parts.push(source.subarray(from));
  return Buffer.concat(parts);
}

type Row = {
  request_hash: string;
  status: "processing" | "done";
  http_status: number | null;
  response: string | null;
  stored: string;
  created_at: number;
};
function lookup(scope: string, key: string, now: number): Row | undefined {
  const row = one<Row>("SELECT request_hash,status,http_status,response,stored,created_at FROM idempotency_keys WHERE scope=? AND key=?", scope, key);
  if (row && row.created_at <= now - IDEMPOTENCY_TTL) {
    run("DELETE FROM idempotency_keys WHERE scope=? AND key=? AND created_at=?", scope, key, row.created_at);
    return undefined;
  }
  return row;
}
// What is kept of an answer: the body when it is JSON, small enough and
// free of secrets; otherwise only the status ('secret' / 'large').
function storedForm(status: number, body: string | null, secret: boolean): { stored: string; response: string | null } {
  if (secret) return { stored: "secret", response: null };
  if (body === null || Buffer.byteLength(body) > MAX_STORED_RESPONSE) return { stored: "large", response: null };
  return { stored: "body", response: body };
}

function refusal(req: Request, status: number, message: string, code: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: localizedMessage(message, localeOfRequest(req)), code }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
function answerFor(req: Request, row: Row, hash: string, extra: Record<string, string>): Response {
  if (row.request_hash !== hash)
    return refusal(req, 422, "Dieser Idempotency-Key wurde schon für eine andere Anfrage verwendet.", IDEMPOTENCY_CODES.mismatch, extra);
  if (row.status === "processing")
    return refusal(req, 409, "Diese Anfrage wird noch bearbeitet. Bitte gleich erneut versuchen.", IDEMPOTENCY_CODES.processing, {
      ...extra,
      "Retry-After": String(RETRY_AFTER_SECONDS),
    });
  if (row.stored !== "body")
    return refusal(req, 409, "Diese Anfrage wurde bereits ausgeführt.", IDEMPOTENCY_CODES.applied, { ...extra, [REPLAYED_HEADER]: "true" });
  return new Response(row.response, {
    status: row.http_status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", [REPLAYED_HEADER]: "true", ...extra },
  });
}

// The answer of the handler as text, when it is JSON and not beyond the
// limit (null otherwise); the handler's own response stays untouched.
async function responseText(response: Response): Promise<string | null> {
  if (!(response.headers.get("content-type") || "").includes("application/json") || !response.body) return null;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_STORED_RESPONSE) return null;
  const reader = response.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STORED_RESPONSE) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The reservation inside an action's transaction (command(…, hook)).
export type TransactionHook = { begin(action: string): void; end(result: unknown, action: string): void };
type Context = {
  principal: Principal;
  key: string;
  hash: string;
  now: number;
  atomic: boolean;
  // Set by the hook: the key was stored with the action (done), another
  // request took it first (raced), or the action goes without one (skipped).
  done?: boolean;
  raced?: boolean;
  skipped?: boolean;
};
const context = new AsyncLocalStorage<Context>();
class IdempotencyRace extends HttpError {
  constructor() {
    super(409, "Diese Anfrage wird noch bearbeitet. Bitte gleich erneut versuchen.");
  }
}

// For command(): reserves the key in the action's transaction and stores
// the answer there too. Undefined without a key (or outside withIdempotency).
export function idempotencyHook(): TransactionHook | undefined {
  const ctx = context.getStore();
  if (!ctx || !ctx.atomic) return undefined;
  return {
    begin(action) {
      if (unkeyedActions.has(action)) {
        ctx.skipped = true;
        return;
      }
      const inserted = run(
        "INSERT INTO idempotency_keys(scope,key,user_id,request_hash,status,stored,created_at) VALUES(?,?,?,?,'processing','body',?) ON CONFLICT(scope,key) DO NOTHING",
        ctx.principal.scope,
        ctx.key,
        ctx.principal.userId,
        ctx.hash,
        ctx.now,
      ).changes;
      if (!inserted) {
        ctx.raced = true;
        throw new IdempotencyRace();
      }
    },
    end(result, action) {
      if (ctx.skipped) return;
      const body = result === undefined ? null : JSON.stringify(result);
      const { stored, response } = storedForm(200, body, secretActions.has(action) || containsSecret(result));
      run(
        "UPDATE idempotency_keys SET status='done',http_status=200,response=?,stored=? WHERE scope=? AND key=?",
        response,
        stored,
        ctx.principal.scope,
        ctx.key,
      );
      ctx.done = true;
    },
  };
}

type Options<A extends unknown[]> = {
  // Requests the handler only reads with (POST for a long body): no key.
  skip?: (req: Request, ...rest: A) => boolean;
  // The handler reserves the key in its transaction (idempotencyHook()).
  atomic?: (req: Request, ...rest: A) => boolean;
  // Headers every answer of the route carries (CORS of the extension).
  headers?: (req: Request) => Record<string, string>;
  // Runs before a stored answer may be sent (the route's origin check).
  check?: (req: Request) => void;
};

// Wraps a route handler for state-changing methods.
export function withIdempotency<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Promise<Response> | Response,
  options: Options<A> = {},
) {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const key = req.headers.get(IDEMPOTENCY_HEADER);
    if (key === null || options.skip?.(req, ...rest)) return handler(req, ...rest);
    const extra = options.headers?.(req) ?? {};
    if (!isIdempotencyKey(key))
      return refusal(req, 400, "Ungültiger Idempotency-Key (8–128 Zeichen: A–Z, a–z, 0–9, _ und -).", IDEMPOTENCY_CODES.invalid, extra);
    const principal = idempotencyPrincipal(req);
    if (!principal) return handler(req, ...rest);
    let hash: string;
    try {
      options.check?.(req);
      hash = await requestHash(req);
    } catch (e) {
      if (e instanceof HttpError) return refusal(req, e.status, e.message, e.status === 413 ? "request_too_large" : "refused", extra);
      throw e;
    }
    const now = Date.now();
    const existing = lookup(principal.scope, key, now);
    if (existing) return answerFor(req, existing, hash, extra);
    const ctx: Context = { principal, key, hash, now, atomic: !!options.atomic?.(req, ...rest) };
    if (!ctx.atomic) {
      const reserved = run(
        "INSERT INTO idempotency_keys(scope,key,user_id,request_hash,status,stored,created_at) VALUES(?,?,?,?,'processing','body',?) ON CONFLICT(scope,key) DO NOTHING",
        principal.scope,
        key,
        principal.userId,
        hash,
        now,
      ).changes;
      if (!reserved) {
        const row = lookup(principal.scope, key, now);
        if (row) return answerFor(req, row, hash, extra);
      }
    }
    const release = () => run("DELETE FROM idempotency_keys WHERE scope=? AND key=? AND status='processing'", principal.scope, key);
    let response: Response;
    try {
      response = await context.run(ctx, () => handler(req, ...rest));
    } catch (e) {
      if (!ctx.atomic) release();
      throw e;
    }
    // Another request with this key won inside the transaction: its answer.
    if (ctx.raced) {
      const row = lookup(principal.scope, key, Date.now());
      if (row) return answerFor(req, row, hash, extra);
      return response;
    }
    if (ctx.done || ctx.skipped) return response;
    if (response.status < 200 || response.status >= 300) {
      if (!ctx.atomic) release();
      return response;
    }
    const text = await responseText(response);
    let secret = false;
    if (text !== null)
      try {
        secret = containsSecret(JSON.parse(text));
      } catch {}
    const { stored, response: body } = storedForm(response.status, text, secret);
    if (ctx.atomic)
      // The handler answered without the hook (an action outside command()).
      run(
        "INSERT INTO idempotency_keys(scope,key,user_id,request_hash,status,http_status,response,stored,created_at) VALUES(?,?,?,?,'done',?,?,?,?) ON CONFLICT(scope,key) DO NOTHING",
        principal.scope,
        key,
        principal.userId,
        hash,
        response.status,
        body,
        stored,
        now,
      );
    else
      run(
        "UPDATE idempotency_keys SET status='done',http_status=?,response=?,stored=? WHERE scope=? AND key=?",
        response.status,
        body,
        stored,
        principal.scope,
        key,
      );
    return response;
  };
}

// Keys older than 24 hours (the operations worker, every ten minutes).
export function sweepIdempotencyKeys(now = Date.now()) {
  return Number(run("DELETE FROM idempotency_keys WHERE created_at<=?", now - IDEMPOTENCY_TTL).changes);
}
