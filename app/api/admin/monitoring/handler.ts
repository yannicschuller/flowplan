// Administration → Überwachung (lib/admin-monitoring.ts): the dashboard,
// polled while the page is open. `?view=live` answers only the live panels
// of the settings' start page (lib/admin-monitoring.ts monitoringStart), `?view=ai`
// the AI statistics (`&days=7|30|90`, per person too), `?view=errors` the
// error details (lib/error-details.ts, with `range` for the counts and
// trend), `?view=upstream` the failures of third-party services counted
// apart from the server errors (#514, same `range`), `?view=restarts` the restart history (`&offset=&limit=&only=unexpected`, 20 a page) and `?view=restart&id=…`
// one restart with its saved log lines (lib/restarts/history.ts, loaded
// when the section opens and when a row is opened); `?range=1h|24h|7d` picks the request chart's span. POST switches the usage statistics on or
// off (`metrics.save`), deletes them (`metrics.clear`) or the error
// details (`errors.clear`, answers the empty list), checks the AI
// provider again (`ai.ping`) or changes the recommendations
// (`recommendation.hide|snooze|restore`, `recommendations.settings`), or
// rebuilds a stuck Litestream replica on the next start
// (`litestream.rebuild`, `litestream.cancel`, then `litestream.restart`;
// lib/litestream-health.ts).
// Administrators in the browser only; API tokens never.
import { serverError } from "@/lib/request-context";
import { z } from "zod";
import { checkOrigin, HttpError, requireUser } from "@/lib/auth";
import { audit } from "@/lib/db";
import { withRequestLocale } from "@/lib/content-locale";
import { requireOpsAdmin } from "@/lib/admin-ops";
import { forgetMonitoringGlance, monitoringLive, monitoringOverview, monitoringStart } from "@/lib/admin-monitoring";
import { aiStatistics } from "@/lib/ai-statistics";
import { applyRecommendationAction, recommendationAction, recommendations } from "@/lib/recommendations-data";
import { clearMetrics, metricsSetting, resetAiPing, saveMetricsSetting, REQUEST_RANGES, type RequestRange } from "@/lib/metrics";
import { updateStatus } from "@/lib/update-check";
import { warmPushChecks } from "@/lib/push-status";
import { clearErrorDetails, errorDetails, upstreamFailures } from "@/lib/error-details";
import { litestreamActions, litestreamAdminAction } from "@/lib/litestream-health";
import { restartsForAdmin } from "@/lib/restarts/history";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };
function failure(e: unknown) {
  if (e instanceof z.ZodError) return Response.json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, { status: 400 });
  if (!(e instanceof HttpError)) console.error(e);
  return Response.json({ error: e instanceof HttpError ? e.message : "Aktion fehlgeschlagen." }, { status: e instanceof HttpError ? e.status : serverError(e) });
}
const admin = async () => requireOpsAdmin(await requireUser());
const rangeOf = (raw: string | null): RequestRange => (REQUEST_RANGES.includes(raw as RequestRange) ? (raw as RequestRange) : "24h");

export const GET = withRequestLocale(async (req: Request) => {
  try {
    const user = await admin();
    const url = new URL(req.url);
    const view = url.searchParams.get("view");
    if (view === "restart") return Response.json(await restartsForAdmin(user, url.searchParams.get("id") || ""), noStore);
    if (view === "restarts") {
      const n = (key: string) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined);
      return Response.json(await restartsForAdmin(user, null, { offset: n("offset"), limit: n("limit"), only: url.searchParams.get("only") === "unexpected" ? "unexpected" : "all" }), noStore);
    }
    const range = rangeOf(url.searchParams.get("range"));
    if (url.searchParams.get("view") === "live") return Response.json(await monitoringStart(Date.now(), range), noStore);
    if (url.searchParams.get("view") === "errors") return Response.json(await errorDetails(Date.now(), range), noStore);
    if (url.searchParams.get("view") === "upstream") return Response.json(await upstreamFailures(Date.now(), range), noStore);
    // Administration → KI → Statistik: per model, workspace and person.
    if (url.searchParams.get("view") === "ai") {
      const days = [7, 30, 90].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
      return Response.json(await aiStatistics(Date.now(), days), noStore);
    }
    const [update] = await Promise.all([updateStatus().catch(() => null), warmPushChecks(1000)]);
    return Response.json(await monitoringOverview(Date.now(), range, update), noStore);
  } catch (e) {
    return failure(e);
  }
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("metrics.save"), enabled: z.boolean() }),
  z.object({ action: z.literal("metrics.clear") }),
  z.object({ action: z.literal("ai.ping") }),
  z.object({ action: z.literal("errors.clear") }),
  z.object({ action: z.enum(litestreamActions) }),
]);

export const POST = withRequestLocale(async (req: Request) => {
  try {
    await checkOrigin(req);
    const user = await admin();
    const raw = await req.json().catch(() => ({}));
    // Recommendations: hide, remind in 30 days, bring back, thresholds and
    // rules switched off (lib/recommendations-data.ts).
    if (typeof raw?.action === "string" && raw.action.startsWith("recommendation")) {
      const input = recommendationAction.parse(raw);
      await applyRecommendationAction(input);
      if (input.action === "recommendations.settings") await audit(user.id, "admin.recommendations", "instance", JSON.stringify({ off: input.off?.length ?? null }));
      return Response.json(await recommendations(), noStore);
    }
    const body = postSchema.parse(raw);
    if (body.action === "litestream.rebuild" || body.action === "litestream.cancel" || body.action === "litestream.restart")
      return Response.json(await litestreamAdminAction(user, body.action), noStore);
    if (body.action === "metrics.save") {
      if ((await metricsSetting()).locked) throw new HttpError(409, "Die Statistik ist mit FLOWPLAN_METRICS=off ausgeschaltet.");
      await saveMetricsSetting(body.enabled);
      await audit(user.id, "admin.metrics", "instance", body.enabled ? "on" : "off");
    } else if (body.action === "metrics.clear") {
      await clearMetrics();
      await audit(user.id, "admin.metrics.clear", "instance", "");
    } else if (body.action === "errors.clear") {
      await clearErrorDetails();
      await audit(user.id, "admin.errors.clear", "instance", "");
      return Response.json(await errorDetails(), noStore);
    } else resetAiPing();
    // The start page's cached facts follow the switch at once.
    forgetMonitoringGlance();
    return Response.json(await monitoringLive(), noStore);
  } catch (e) {
    return failure(e);
  }
});
