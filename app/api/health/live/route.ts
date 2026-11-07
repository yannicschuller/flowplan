// Liveness probe (Kubernetes livenessProbe, load balancers): the process
// answers. Deliberately no database check – a database outage is not cured
// by restarting the instance; readiness (/api/health/ready) takes it out of
// the rotation instead. /api/health stays the combined check of the
// container's HEALTHCHECK and the apps.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ service: "flowplan", status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
