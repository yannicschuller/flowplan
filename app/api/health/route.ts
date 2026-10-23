import { NextResponse } from "next/server";
import { accessSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sessionIdentityFromRequest } from "@/lib/auth";
import { one } from "@/lib/db";
import { metricsAuthorized } from "@/lib/instance-ops";
import { storageStatus } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The details are for monitoring with FLOWPLAN_METRICS_TOKEN (as for
// /api/metrics) and for signed-in instance administrators; API tokens never
// administer, so only the session cookie counts here.
function detailsAllowed(request: Request) {
  if (metricsAuthorized(request.headers.get("authorization")) === true) return true;
  const user = sessionIdentityFromRequest(request);
  return !!user?.isAdmin && !user.twoFactorSetup;
}

// Liveness/readiness check for container healthchecks, monitoring and the
// apps, which recognise an instance by `service: "flowplan"`. Without the
// metrics token or an administrator's session it answers only that and the
// status (200 or 503): no backlogs, no object storage, no uptime that would
// tell a visitor when the server was last updated (#41).
export async function GET(request: Request) {
  const checks: Record<string, "ok" | "error"> = {};
  let backlog = 0,
    failedPush = 0;
  try {
    one("SELECT 1");
    backlog = Number(
      one<{ n: number }>("SELECT COUNT(*) n FROM search_dirty")?.n || 0,
    );
    failedPush = Number(
      one<{ n: number }>(
        "SELECT COUNT(*) n FROM push_deliveries WHERE delivered_at IS NULL AND attempts>=5",
      )?.n || 0,
    );
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }
  try {
    const uploads = resolve(
      process.env.FLOWPLAN_DATA_DIR || "./data",
      "uploads",
    );
    mkdirSync(uploads, { recursive: true });
    accessSync(uploads, constants.W_OK);
    checks.storage = "ok";
  } catch {
    checks.storage = "error";
  }
  const healthy = Object.values(checks).every((c) => c === "ok");
  const init = {
    status: healthy ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  };
  // Lets clients such as the desktop and mobile apps recognise a Flowplan instance.
  const verdict = { service: "flowplan", status: healthy ? "ok" : "error" } as const;
  if (!detailsAllowed(request)) return NextResponse.json(verdict, init);
  let mirror: ReturnType<typeof storageStatus> = { enabled: false };
  try {
    mirror = storageStatus();
  } catch {}
  return NextResponse.json(
    {
      ...verdict,
      checks,
      searchBacklog: backlog,
      failedPushDeliveries: failedPush,
      // Object storage mirror: pending uploads/deletions, not part of the
      // health verdict (the local copy keeps working while S3 is away).
      objectStorage: mirror.enabled
        ? { pending: mirror.pending, retrying: mirror.failing }
        : "off",
      uptimeSeconds: Math.round(process.uptime()),
    },
    init,
  );
}
