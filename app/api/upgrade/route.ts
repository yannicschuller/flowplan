// The upgrade link of hosted offerings (lib/upgrade-link.ts): 404 unless
// FLOWPLAN_UPGRADE_URL and FLOWPLAN_UPGRADE_SECRET are set; otherwise a
// redirect with a fresh signed token for the signed-in person (session
// cookie only, never an API token).
import { sessionIdentityFromRequest } from "@/lib/auth";
import { upgradeRedirect } from "@/lib/upgrade-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return upgradeRedirect(await sessionIdentityFromRequest(request));
}
