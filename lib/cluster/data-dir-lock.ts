// SQLite: one container per data folder. docker/entrypoint.sh holds an
// exclusive flock on <data>/.flowplan.lock for the container's life. A
// second container on the same folder (a rollout with overlap, two services
// on one volume) serves anyway but starts no Litestream until the lock is
// free; while it waits it writes <data>/.flowplan-waiting (since, host,
// litestream) and rewrites it every 30 s. Administration → Überwachung
// shows that file as a warning on both containers (lib/cluster/system.ts),
// like the PostgreSQL conflict (lib/cluster/single-instance.ts). A file not
// rewritten for SINGLE_INSTANCE_STALE_MS belongs to a container that is gone.
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { postgresUrl } from "../db-driver/context";
import { SINGLE_INSTANCE_STALE_MS } from "./single-instance";

export type WaitingContainer = {
  host: string;
  // When it started waiting, and when it last said so (ms).
  since: number;
  seenAt: number;
  // Whether it waits to start Litestream (else only the warning).
  litestream: boolean;
  // Whether this process is the waiting container.
  self: boolean;
};

const markerPath = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data", ".flowplan-waiting");

export function waitingContainer(now = Date.now()): WaitingContainer | null {
  if (postgresUrl()) return null;
  try {
    const path = markerPath();
    const seenAt = statSync(path).mtimeMs;
    if (now - seenAt > SINGLE_INSTANCE_STALE_MS) return null;
    const fields = new Map<string, string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    const since = Number(fields.get("since")) * 1000;
    const host = (fields.get("host") || "").slice(0, 80);
    return {
      host,
      since: Number.isFinite(since) && since > 0 ? since : seenAt,
      seenAt,
      litestream: fields.get("litestream") === "1",
      self: !!host && host === hostname(),
    };
  } catch {
    return null;
  }
}
