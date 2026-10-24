// Administration → Operations (lib/admin-ops.ts): the overview, the
// activity log export (`?export=audit&format=csv|json&from&to`), health
// alert settings with a test message, the maintenance notice and the push
// relay's signing keys (`pushRelay.keys`, `pushRelay.rotate`,
// lib/push-identity.ts). Administrators only; API tokens never.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { audit } from "@/lib/db";
import { pushIdentityStatus, rotatePushIdentity } from "@/lib/push-identity";
import { auditExport, checkHealthAlerts, opsOverview, requireOpsAdmin, saveAlertSettings, saveMaintenance, sendTestAlert } from "@/lib/admin-ops";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json(
    { error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." },
    { status: e instanceof HttpError ? e.status : 500 },
  );
}
const admin = async () => requireOpsAdmin(await requireUser());

export const GET = withRequestLocale(async (req: Request) => {
  try {
    await admin();
    const url = new URL(req.url);
    if (url.searchParams.get("export") === "audit") {
      const file = auditExport({
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined,
        format: url.searchParams.get("format") || undefined,
      });
      return new Response(file.body, {
        headers: { "Content-Type": file.type, "Content-Disposition": `attachment; filename="${file.name}"`, "Cache-Control": "no-store" },
      });
    }
    return Response.json(opsOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
});

export const POST = withRequestLocale(async (req: Request) => {
  try {
    checkOrigin(req);
    const user = await admin();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "alerts.save":
        saveAlertSettings(user.id, body);
        break;
      case "alerts.test":
        return Response.json({ test: await sendTestAlert(user.id), ...opsOverview() });
      case "alerts.check":
        return Response.json({ sent: await checkHealthAlerts(), ...opsOverview() });
      case "maintenance.save":
        saveMaintenance(user.id, body.notice ?? null);
        break;
      // The push relay's signing key: list, or replace with a grace period
      // for the old one (immediate: the old one goes at once).
      case "pushRelay.keys":
        return Response.json({ keys: pushIdentityStatus() }, { headers: { "Cache-Control": "no-store" } });
      case "pushRelay.rotate": {
        const b = z.object({ immediate: z.boolean().default(false), graceDays: z.number().int().min(0).max(90).default(7) }).parse(body);
        const rotated = rotatePushIdentity({ immediate: b.immediate, graceMs: b.graceDays * 86_400_000 });
        audit(user.id, "admin.push.rotate", "instance", b.immediate ? "immediate" : `grace ${b.graceDays} d`);
        return Response.json({ rotated, keys: pushIdentityStatus() }, { headers: { "Cache-Control": "no-store" } });
      }
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
    return Response.json(opsOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
});
