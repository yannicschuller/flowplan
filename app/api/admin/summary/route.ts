// Administration → landing page: the facts behind each tile
// (lib/admin-summary.ts). Administrators in the browser only; API tokens
// never, as for the operations overview.
import { HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { requireOpsAdmin } from "@/lib/admin-ops";
import { adminSummaryFor } from "@/lib/admin-summary";
import { updateStatus } from "@/lib/update-check";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRequestLocale(async () => {
  try {
    const user = requireOpsAdmin(await requireUser());
    const update = await updateStatus().catch(() => null);
    return Response.json(adminSummaryFor(user, Date.now(), update), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
});
