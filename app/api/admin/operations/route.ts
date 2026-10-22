// Administration → Operations (lib/admin-ops.ts): the overview, the
// activity log export (`?export=audit&format=csv|json&from&to`), health
// alert settings with a test message, and the maintenance notice.
// Administrators only; API tokens never.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
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
      default:
        throw new HttpError(400, "Unbekannte Aktion.");
    }
    return Response.json(opsOverview(), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
});
