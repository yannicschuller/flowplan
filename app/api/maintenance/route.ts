// The scheduled maintenance notice (lib/admin-ops.ts) for the banner every
// signed-in person sees until the maintenance has ended, and whether the
// instance is read-only or has moved (lib/instance-read-only.ts).
import { HttpError, requireUser } from "@/lib/auth";
import { maintenanceNotice } from "@/lib/admin-ops";
import { readOnlyState } from "@/lib/instance-read-only";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    return Response.json({ notice: maintenanceNotice(), move: readOnlyState() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return Response.json({ error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." }, { status: e instanceof HttpError ? e.status : 500 });
  }
}
