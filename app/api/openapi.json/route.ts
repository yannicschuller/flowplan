import { openApiDocument } from "@/lib/openapi";

export const runtime = "nodejs";
// The server address comes from APP_URL at runtime.
export const dynamic = "force-dynamic";

// The OpenAPI description of the public API (lib/openapi.ts): public, so
// tools and the generated SDKs can fetch it without a token.
export function GET() {
  return new Response(JSON.stringify(openApiDocument(), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
