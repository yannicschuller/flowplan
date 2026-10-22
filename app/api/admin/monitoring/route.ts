// Administration → Überwachung (lib/admin-monitoring.ts): the dashboard,
// polled while the page is open. `?view=live` answers only the live strip
// of the landing page (numbers and the request chart); `?range=1h|24h|7d`
// picks the request chart's span. POST switches the usage statistics on or
// off (`metrics.save`), deletes them (`metrics.clear`) or checks the AI
// provider again (`ai.ping`). Administrators in the browser only; API
// tokens never.
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { audit } from "@/lib/db";
import { withRequestLocale } from "@/lib/content-locale";
import { requireOpsAdmin } from "@/lib/admin-ops";
import { monitoringLive, monitoringOverview } from "@/lib/admin-monitoring";
import { clearMetrics, metricsSetting, resetAiPing, saveMetricsSetting, REQUEST_RANGES, type RequestRange } from "@/lib/metrics";
import { updateStatus } from "@/lib/update-check";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };
function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." }, { status: e instanceof HttpError ? e.status : 500 });
}
const admin = async () => requireOpsAdmin(await requireUser());
const rangeOf = (raw: string | null): RequestRange => (REQUEST_RANGES.includes(raw as RequestRange) ? (raw as RequestRange) : "24h");

export const GET = withRequestLocale(async (req: Request) => {
  try {
    await admin();
    const url = new URL(req.url);
    const range = rangeOf(url.searchParams.get("range"));
    if (url.searchParams.get("view") === "live") return Response.json(monitoringLive(Date.now(), range), noStore);
    const update = await updateStatus().catch(() => null);
    return Response.json(monitoringOverview(Date.now(), range, update), noStore);
  } catch (e) {
    return failure(e);
  }
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("metrics.save"), enabled: z.boolean() }),
  z.object({ action: z.literal("metrics.clear") }),
  z.object({ action: z.literal("ai.ping") }),
]);

export const POST = withRequestLocale(async (req: Request) => {
  try {
    checkOrigin(req);
    const user = await admin();
    const body = postSchema.parse(await req.json().catch(() => ({})));
    if (body.action === "metrics.save") {
      if (metricsSetting().locked) throw new HttpError(409, "Die Statistik ist mit FLOWPLAN_METRICS=off ausgeschaltet.");
      saveMetricsSetting(body.enabled);
      audit(user.id, "admin.metrics", "instance", body.enabled ? "on" : "off");
    } else if (body.action === "metrics.clear") {
      clearMetrics();
      audit(user.id, "admin.metrics.clear", "instance", "");
    } else resetAiPing();
    return Response.json(monitoringLive(), noStore);
  } catch (e) {
    return failure(e);
  }
});
