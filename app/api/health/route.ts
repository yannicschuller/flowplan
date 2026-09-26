import { NextResponse } from "next/server";
import { accessSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { one } from "@/lib/db";
import { storageStatus } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unauthenticated liveness/readiness check for container healthchecks and
// monitoring. It reports only aggregate states, never content or identities.
export async function GET() {
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
  let mirror: ReturnType<typeof storageStatus> = { enabled: false };
  try {
    mirror = storageStatus();
  } catch {}
  return NextResponse.json(
    {
      status: healthy ? "ok" : "error",
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
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
