// MCP endpoint (Streamable HTTP, JSON answers, no sessions). Only personal
// API tokens sign in here, never the browser session: a site the person
// visits cannot use it, and every call carries the token's own rights.
import { after } from "next/server";
import { appUrl, HttpError } from "@/lib/auth";
import { identityFromApiToken } from "@/lib/api-tokens";
import { withRequestLocale } from "@/lib/content-locale";
import { dispatchPush } from "@/lib/push";
import { handleMcpMessage } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 2_000_000;
// Per person and minute; AI clients call tools in quick bursts.
const PER_MINUTE = 120;
const calls = new Map<string, number[]>();
function limited(userId: string) {
  const now = Date.now(),
    recent = (calls.get(userId) || []).filter((at) => now - at < 60_000);
  recent.push(now);
  calls.set(userId, recent);
  if (calls.size > 10_000)
    for (const [key, times] of calls) if (!times.some((at) => now - at < 60_000)) calls.delete(key);
  return recent.length > PER_MINUTE;
}

const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "Cache-Control": "no-store",
      ...headers,
    },
  });
const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
  reply(status, { jsonrpc: "2.0", id: null, error: { code, message } }, headers);

async function readBody(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) throw new HttpError(413, "Request too large.");
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new HttpError(413, "Request too large.");
      }
      chunks.push(value);
    }
  return Buffer.concat(chunks).toString("utf8");
}

async function handlePOST(req: Request) {
  // Browsers send an Origin; only Flowplan's own is accepted (DNS rebinding).
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(appUrl()).origin) return rpcError(403, -32000, "Origin not allowed.");
  const user = identityFromApiToken(req.headers.get("authorization"));
  if (!user || user.demo)
    return rpcError(401, -32001, "A personal Flowplan API token is required (Authorization: Bearer fp_…).", {
      "WWW-Authenticate": 'Bearer realm="flowplan"',
    });
  if (limited(user.id)) return rpcError(429, -32000, "Too many requests. Please wait a minute.", { "Retry-After": "60" });
  let input: unknown;
  try {
    input = JSON.parse(await readBody(req));
  } catch (e) {
    if (e instanceof HttpError) return rpcError(e.status, -32600, e.message);
    return rpcError(400, -32700, "Parse error.");
  }
  // Batches were removed from the protocol (2025-06-18).
  if (Array.isArray(input)) return rpcError(400, -32600, "Batch requests are not supported.");
  try {
    const answer = await handleMcpMessage(user, input);
    after(dispatchPush);
    return answer ? reply(200, answer) : reply(202);
  } catch (e) {
    if (e instanceof HttpError) return rpcError(e.status, -32000, e.message);
    console.error("MCP request failed", e);
    return rpcError(500, -32603, "Internal error.");
  }
}

export const POST = withRequestLocale(handlePOST);
// No server-sent stream and no sessions: every answer comes with its POST.
const notAllowed = async () => reply(405, undefined, { Allow: "POST" });
export const GET = notAllowed;
export const DELETE = notAllowed;
