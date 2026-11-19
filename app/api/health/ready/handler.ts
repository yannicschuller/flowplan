// Readiness probe (Kubernetes readinessProbe, load balancers): whether this
// instance should get requests – the database answers, in cluster mode also
// Redis and the object storage, and it is not stopping (lib/cluster/health.ts).
// 503 otherwise. The per-check details (time, error) only with the metrics
// token (FLOWPLAN_METRICS_TOKEN), as for /api/health.
import { metricsAuthorized } from "@/lib/instance-ops";
import { readiness } from "@/lib/cluster/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const state = await readiness();
  const init = { status: state.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } };
  const verdict = { service: "flowplan", status: state.ready ? "ok" : state.stopping ? "stopping" : "error" };
  const checks = Object.fromEntries(Object.entries(state.checks).map(([name, c]) => [name, c.ok ? "ok" : "error"]));
  if (metricsAuthorized(request.headers.get("authorization")) !== true) return Response.json({ ...verdict, checks }, init);
  return Response.json({ ...verdict, checks: state.checks }, init);
}
