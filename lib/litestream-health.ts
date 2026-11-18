// A stuck Litestream replica (SQLite with S3, docker/entrypoint.sh). A
// corrupt L0 file in the bucket (<prefix>/db/0000/, typically left by two
// containers replicating at once) makes every compaction to level 1 fail
// ("compaction failed … file checksum mismatch", every 30 s). Litestream
// never repairs that: L0 files are only deleted after a successful L1
// compaction, so they pile up and a restore through the bad file fails.
//
// Detection, every 15 minutes, only on the container that holds the data
// folder lock and replicates (it wrote <data>/.flowplan-replicating when
// Litestream started): one bounded listing of <prefix>/db/0000/. Stuck means
// an L0 object older than an hour while Litestream has run here for more
// than 30 minutes – right after a downtime old L0 files legitimately wait
// for their first compaction, which runs every 30 s.
//
// Report: a warning in Administration → Überwachung, one alert per
// incident (the operator's webhook and the administrators' chat apps,
// lib/admin-ops.ts) and an entry in the activity log.
//
// Repair on the next start: the marker <data>/litestream-reset with the
// first line "remote" makes the entrypoint delete <prefix>/db/ in the
// bucket (scripts/litestream-replica-reset.mjs) and then reset the local
// state, both under the lock and before `litestream replicate`; Litestream
// then starts afresh with a full snapshot. An empty marker (written by
// hand, as before) still resets only the local state. Before the marker is
// written, a scheduled backup is taken when they are on; when it fails, the
// automatic path writes no marker. FLOWPLAN_LITESTREAM_AUTOHEAL=off keeps
// detection and warning but never writes the marker by itself; the button
// in Administration (rebuildReplica) still does. Nothing here ever touches
// the database file, and nothing here restarts by itself.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { audit, one, run } from "./db";
import { postgresUrl } from "./db-driver/context";
import { bucketFetch, storageConfig } from "./storage";
import { waitingContainer } from "./cluster/data-dir-lock";
import { HttpError } from "./auth";
import { requireOpsAdmin } from "./admin-ops";
import type { Identity } from "./types";

const MINUTE = 60_000;
export const LITESTREAM_CHECK = {
  // How often the bucket is looked at.
  interval: 15 * MINUTE,
  // An L0 file older than this, while Litestream has run longer than
  // `running`, means compaction is stuck.
  oldL0: 60 * MINUTE,
  running: 30 * MINUTE,
  // One page of the listing, no more.
  maxKeys: 1000,
} as const;

const dataDir = () => resolve(/* turbopackIgnore: true */ process.env.FLOWPLAN_DATA_DIR || "./data");
export const resetMarkerPath = () => resolve(dataDir(), "litestream-reset");
export const replicatingPath = () => resolve(dataDir(), ".flowplan-replicating");
const STATE_KEY = "litestreamReplica";

export const autohealEnabled = (env: Record<string, string | undefined> = process.env) => env.FLOWPLAN_LITESTREAM_AUTOHEAL?.trim().toLowerCase() !== "off";

// Where the replica lies in the bucket: <prefix>/db/ (docker/litestream.yml).
export function replicaPrefix(prefix: string) {
  return `${prefix ? `${prefix}/` : ""}db/`;
}

// Since when Litestream replicates in this container, from the file the
// entrypoint writes when it starts `litestream replicate` (with the lock
// held): null when it does not replicate here – Litestream off, PostgreSQL,
// no S3, not started by the entrypoint, or this container waits for the
// lock of another one.
export function replicatingSince(): number | null {
  if (postgresUrl() || !storageConfig()) return null;
  if (process.env.FLOWPLAN_LITESTREAM === "off" || process.env.FLOWPLAN_LITESTREAM_ACTIVE !== "1") return null;
  if (waitingContainer()?.self) return null;
  try {
    const fields = new Map<string, string>();
    for (const line of readFileSync(replicatingPath(), "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    // Another container's file (it ran here before, or runs now and this
    // one has not replicated yet).
    if (fields.get("host") !== hostname()) return null;
    const since = Number(fields.get("since")) * 1000;
    return Number.isFinite(since) && since > 0 ? since : null;
  } catch {
    return null;
  }
}

export type MarkerMode = "remote" | "local";
export function resetMarker(): MarkerMode | null {
  try {
    if (!existsSync(resetMarkerPath())) return null;
    return readFileSync(resetMarkerPath(), "utf8").split("\n")[0].trim() === "remote" ? "remote" : "local";
  } catch {
    return null;
  }
}
// The marker for the entrypoint (first line "remote"; the others only say
// who asked and when). Written atomically; never the database.
function writeRemoteMarker(source: "auto" | "admin", now: number) {
  const path = resetMarkerPath();
  writeFileSync(`${path}.tmp`, `remote\nsource=${source}\nat=${Math.floor(now / 1000)}\n`);
  renameSync(`${path}.tmp`, path);
}

export type L0Listing = { files: number; oldestAt: number | null; truncated: boolean };
// One page of <prefix>/db/0000/ (Litestream's level 0), oldest first – the
// keys are named by transaction ID, so the first page holds the oldest.
export async function listLevel0(): Promise<L0Listing> {
  const config = storageConfig();
  if (!config) throw new Error("Kein S3-Speicher eingerichtet.");
  const prefix = `${replicaPrefix(config.prefix)}0000/`;
  const response = await bucketFetch(`?list-type=2&max-keys=${LITESTREAM_CHECK.maxKeys}&prefix=${encodeURIComponent(prefix)}`, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Liste der Litestream-Replik: HTTP ${response.status}`);
  const xml = await response.text();
  let files = 0;
  let oldestAt: number | null = null;
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]+)<\/Key>/.exec(m[1])?.[1] ?? "";
    if (!key.startsWith(prefix) || !key.endsWith(".ltx")) continue;
    files++;
    const at = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] ?? "");
    if (Number.isFinite(at) && (oldestAt === null || at < oldestAt)) oldestAt = at;
  }
  return { files, oldestAt, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml) };
}

export type BackupNote = { at: number; name: string; error: string | null };
export type LitestreamIncident = {
  // First seen stuck, last checked.
  since: number;
  checkedAt: number;
  oldestAt: number;
  files: number;
  truncated: boolean;
  // What happens next: the marker is written (repaired on the next start),
  // automatic repair is off, an administrator took it back, or the backup
  // before it failed (no marker; tried again after six hours).
  repair: "scheduled" | "off" | "cancelled" | "backup_failed";
  backup: BackupNote | null;
};
type Stored = { incident: LitestreamIncident | null; lastCheck: { at: number; error: string | null } | null };

async function stored(): Promise<Stored> {
  const row = await one<{ value: string }>("SELECT value FROM instance_state WHERE key=?", STATE_KEY);
  try {
    return row ? { incident: null, lastCheck: null, ...(JSON.parse(row.value) as Partial<Stored>) } : { incident: null, lastCheck: null };
  } catch {
    return { incident: null, lastCheck: null };
  }
}
async function store(value: Stored) {
  await run(
    "INSERT INTO instance_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    STATE_KEY,
    JSON.stringify(value),
  );
}

// The backup before the replica goes: a scheduled backup when they are on
// (encrypted with FLOWPLAN_ENCRYPTION_KEY, to <prefix>/backups/ – outside
// db/, so it stays). null when scheduled backups are off.
async function backupFirst(now: number): Promise<BackupNote | null> {
  const { runScheduledBackup, scheduledBackupStatus } = await import("./scheduled-backup");
  if (!(await scheduledBackupStatus()).enabled) return null;
  const result = await runScheduledBackup(now);
  return { at: result.at, name: result.name, error: result.error };
}

export type CheckResult =
  | { state: "inactive" }
  | { state: "error"; error: string }
  | { state: "starting" | "healthy"; files: number }
  | { state: "stuck"; incident: LitestreamIncident; opened: boolean };

// One check (the worker every 15 minutes). `list` is the bucket listing
// (tests pass their own).
export async function checkLitestreamReplica(now = Date.now(), list: () => Promise<L0Listing> = listLevel0): Promise<CheckResult> {
  const since = replicatingSince();
  if (since === null) return { state: "inactive" };
  const previous = await stored();
  let listing: L0Listing;
  try {
    listing = await list();
  } catch (error) {
    const message = String((error as Error)?.message || error).slice(0, 300);
    await store({ ...previous, lastCheck: { at: now, error: message } });
    return { state: "error", error: message };
  }
  const old = listing.oldestAt !== null && now - listing.oldestAt > LITESTREAM_CHECK.oldL0;
  const runningLong = now - since > LITESTREAM_CHECK.running;
  if (!old || !runningLong) {
    // Not stuck (any more): an incident ends here – after the repair on a
    // restart the old L0 files are gone.
    if (previous.incident && !old) await audit("", "litestream.replica.healthy", "instance", `files ${listing.files}`);
    await store({ incident: old ? previous.incident : null, lastCheck: { at: now, error: null } });
    return { state: old ? "starting" : "healthy", files: listing.files };
  }
  const opened = !previous.incident;
  const incident: LitestreamIncident = {
    since: previous.incident?.since ?? now,
    checkedAt: now,
    oldestAt: listing.oldestAt!,
    files: listing.files,
    truncated: listing.truncated,
    repair: previous.incident?.repair ?? "off",
    backup: previous.incident?.backup ?? null,
  };
  // An administrator took the repair back (not again for this incident), or
  // the backup before it failed less than six hours ago: it stays so.
  const waits = incident.repair === "cancelled" || (incident.repair === "backup_failed" && now - (incident.backup?.at ?? 0) < 6 * 60 * MINUTE);
  if (resetMarker() === "remote") incident.repair = "scheduled";
  else if (!autohealEnabled()) incident.repair = "off";
  else if (!waits) {
    // The automatic repair: a backup first (again after six hours when it
    // failed), then the marker for the next start.
    const backup = await backupFirst(now).catch((error) => ({ at: now, name: "", error: String((error as Error)?.message || error).slice(0, 300) }));
    incident.backup = backup;
    if (backup?.error) incident.repair = "backup_failed";
    else {
      writeRemoteMarker("auto", now);
      incident.repair = "scheduled";
      await audit("", "litestream.replica.reset_scheduled", "instance", JSON.stringify({ source: "auto", backup: backup ? backup.name : null }));
    }
  }
  await store({ incident, lastCheck: { at: now, error: null } });
  if (opened) {
    const detail = `${listing.files}${listing.truncated ? "+" : ""} L0 files, oldest ${new Date(listing.oldestAt!).toISOString()}`;
    console.error(
      `Litestream: the replica in the bucket looks stuck (${detail}): compaction does not clean up level 0. ${
        incident.repair === "scheduled" ? "It is rebuilt on the next restart." : incident.repair === "backup_failed" ? "The backup before the repair failed; nothing is scheduled." : "Automatic repair is off (FLOWPLAN_LITESTREAM_AUTOHEAL=off)."
      }`,
    );
    await audit("", "litestream.replica.stuck", "instance", JSON.stringify({ files: listing.files, oldestAt: listing.oldestAt, repair: incident.repair }));
    const { sendIncidentAlert } = await import("./admin-ops");
    await sendIncidentAlert("litestream_stuck", `litestream:${incident.since}`, `${detail}; ${incident.repair}`, now).catch((error) =>
      console.error("Litestream alert failed", (error as Error)?.message),
    );
  }
  return { state: "stuck", incident, opened };
}

export type LitestreamStatus = {
  // Litestream replicates in this container (the checks run here).
  active: boolean;
  since: number | null;
  autoheal: boolean;
  marker: MarkerMode | null;
  incident: LitestreamIncident | null;
  lastCheck: { at: number; error: string | null } | null;
};
// For Administration → Überwachung (lib/cluster/system.ts): null when it
// does not apply at all (PostgreSQL, no S3, Litestream off).
export async function litestreamStatus(): Promise<LitestreamStatus | null> {
  if (postgresUrl() || !storageConfig() || process.env.FLOWPLAN_LITESTREAM === "off" || process.env.FLOWPLAN_LITESTREAM_ACTIVE !== "1") return null;
  const since = replicatingSince();
  const s = await stored();
  return { active: since !== null, since, autoheal: autohealEnabled(), marker: resetMarker(), incident: current(s.incident, since), lastCheck: s.lastCheck };
}
// An incident counts once it was confirmed by a check since Litestream
// started here: the one of a container before a restart (repaired by it, or
// not) waits for the next check.
const current = (incident: LitestreamIncident | null, since: number | null) => (since !== null && incident && incident.checkedAt >= since ? incident : null);
// The open incident for the health alerts (lib/admin-ops.ts activeAlerts).
export async function openLitestreamIncident() {
  return current((await stored()).incident, replicatingSince());
}

// Administration → Überwachung → "Replik jetzt neu aufbauen": the same
// marker by hand (also with FLOWPLAN_LITESTREAM_AUTOHEAL=off), after a
// backup when scheduled backups are on. Only where Litestream replicates
// here, with the lock held.
export async function rebuildReplica(actorId: string, now = Date.now()) {
  if (replicatingSince() === null)
    throw new HttpError(409, "Litestream repliziert in diesem Container nicht (aus, PostgreSQL, kein S3 oder ein anderer Container hält das Datenverzeichnis).");
  const backup = await backupFirst(now);
  if (backup?.error) throw new HttpError(502, `Die Sicherung vorher ist fehlgeschlagen, die Replik bleibt: ${backup.error}`);
  writeRemoteMarker("admin", now);
  const s = await stored();
  if (s.incident) await store({ ...s, incident: { ...s.incident, repair: "scheduled", backup: backup ?? s.incident.backup } });
  await audit(actorId, "admin.litestream.rebuild", "instance", JSON.stringify({ backup: backup ? backup.name : null }));
  return { backup };
}
// Takes back a marker written here (the button's "Abbrechen"). A local-only
// marker written by hand stays.
export async function cancelRebuild(actorId: string) {
  if (resetMarker() !== "remote") return;
  rmSync(resetMarkerPath(), { force: true });
  const s = await stored();
  if (s.incident) await store({ ...s, incident: { ...s.incident, repair: "cancelled" } });
  await audit(actorId, "admin.litestream.rebuild.cancel", "instance", "");
}

// "Jetzt neu starten": ends the process gracefully (SIGTERM, the same path
// as `docker stop`: Next.js drains, lib/cluster/runtime.ts finishes the
// shutdown tasks, Litestream replicates the last writes and exits with the
// app); the container's restart policy starts it again, and the entrypoint
// applies the marker. Answers first, then stops.
export async function restartForRepair(actorId: string, kill: () => void = () => process.kill(process.pid, "SIGTERM")) {
  if (replicatingSince() === null) throw new HttpError(409, "Litestream repliziert in diesem Container nicht.");
  if (!resetMarker()) throw new HttpError(409, "Es ist keine Reparatur vorgemerkt.");
  await audit(actorId, "admin.litestream.restart", "instance", "");
  const timer = setTimeout(kill, 500);
  timer.unref?.();
}

export const litestreamActions = ["litestream.rebuild", "litestream.cancel", "litestream.restart"] as const;
export type LitestreamAction = (typeof litestreamActions)[number];
// The buttons of the warning (app/api/admin/monitoring/route.ts):
// administrators in the browser only, each step in the activity log.
export async function litestreamAdminAction(user: Identity, action: LitestreamAction, options: { now?: number; kill?: () => void } = {}) {
  requireOpsAdmin(user);
  if (user.demo) throw new HttpError(403, "Im Demo-Modus nicht verfügbar.");
  if (action === "litestream.rebuild") await rebuildReplica(user.id, options.now);
  else if (action === "litestream.cancel") await cancelRebuild(user.id);
  else await restartForRepair(user.id, options.kill);
  return { litestream: await litestreamStatus(), restarting: action === "litestream.restart" };
}

const runtime = globalThis as unknown as { flowplanLitestreamTimer?: ReturnType<typeof setInterval>; flowplanLitestreamBusy?: boolean };
export function startLitestreamWorker() {
  if (runtime.flowplanLitestreamTimer) return;
  if (postgresUrl() || !storageConfig() || process.env.FLOWPLAN_LITESTREAM_ACTIVE !== "1") return;
  const tick = async () => {
    if (runtime.flowplanLitestreamBusy) return;
    runtime.flowplanLitestreamBusy = true;
    try {
      await checkLitestreamReplica();
    } catch (error) {
      console.error("Litestream check failed", (error as Error)?.message);
    } finally {
      runtime.flowplanLitestreamBusy = false;
    }
  };
  runtime.flowplanLitestreamTimer = setInterval(() => void tick(), LITESTREAM_CHECK.interval);
  runtime.flowplanLitestreamTimer.unref?.();
}
