import { NextResponse } from "next/server";
import { metricsAuthorized, prometheusMetrics } from "@/lib/instance-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Prometheus scrape target, enabled with FLOWPLAN_METRICS_TOKEN.
export async function GET(request: Request) {
  const authorized = metricsAuthorized(request.headers.get("authorization"));
  if (authorized === null)
    return NextResponse.json(
      { error: "Metriken sind nicht aktiviert." },
      { status: 404 },
    );
  if (!authorized)
    return NextResponse.json(
      { error: "Ungültiges Metrik-Token." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  return new NextResponse(prometheusMetrics(), {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
