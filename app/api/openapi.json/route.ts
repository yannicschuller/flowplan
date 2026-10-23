import { identityFromRequest } from "@/lib/auth";
import { pickLocale } from "@/lib/i18n";
import { localizedMessage } from "@/lib/i18n-errors";
import { apiDocsAllowed, publicApiDocs } from "@/lib/instance-disclosure";
import { openApiDocument } from "@/lib/openapi";

export const runtime = "nodejs";
// The server address comes from APP_URL at runtime.
export const dynamic = "force-dynamic";

// The OpenAPI description of the API (lib/openapi.ts): for signed-in people
// and API tokens, so tools and the SDK generators fetch it with a token.
// Instances that want it public set FLOWPLAN_PUBLIC_API_DOCS=true; visitors
// then see the major version only (lib/instance-disclosure.ts).
export function GET(request: Request) {
  const identity = identityFromRequest(request);
  if (!apiDocsAllowed(identity)) {
    const locale = pickLocale(null, request.headers.get("accept-language"));
    return Response.json(
      { error: localizedMessage("Bitte melde dich an.", locale) },
      { status: 401, headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" } },
    );
  }
  const signedIn = !!identity && !identity.twoFactorSetup;
  const open = publicApiDocs();
  return new Response(JSON.stringify(openApiDocument({ exactVersion: signedIn }), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // The answer depends on who asks (exact version or not); next.config.ts
      // marks every API answer private anyway.
      "Cache-Control": "private, no-store",
      ...(open ? { "Access-Control-Allow-Origin": "*" } : {}),
    },
  });
}
