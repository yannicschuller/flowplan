// SCIM 2.0 provisioning (lib/scim.ts): its own standard with its own bearer
// tokens, outside the Flowplan token API.
import { handleScim, SCIM_CONTENT_TYPE } from "@/lib/scim";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1024 * 1024;

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const length = Number(req.headers.get("content-length") || 0);
  const body = length > MAX_BODY ? null : await req.text();
  if (body === null || body.length > MAX_BODY)
    return Response.json(
      { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "413", detail: "Request too large." },
      { status: 413, headers: { "Content-Type": SCIM_CONTENT_TYPE } },
    );
  const result = handleScim({
    method: req.method,
    path,
    query: new URL(req.url).searchParams,
    authorization: req.headers.get("authorization"),
    body,
  });
  return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, "Cache-Control": "no-store", ...result.headers },
  });
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
