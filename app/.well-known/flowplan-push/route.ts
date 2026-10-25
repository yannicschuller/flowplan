import { pushIdentityDocument } from "@/lib/push-identity";
import { relayConfig } from "@/lib/push-relay";

// The instance's public signing keys for the push relay (lib/push-identity.ts,
// PROTOCOL.md §1 of flowplan-push). Public and cacheable for an hour; nothing
// else is in it. Without the relay (PUSH_RELAY=off) there is nothing to show.
export const runtime = "nodejs";
// The key is created on first use, never at build time.
export const dynamic = "force-dynamic";

export function GET() {
  if (!relayConfig().enabled)
    return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json(pushIdentityDocument(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
