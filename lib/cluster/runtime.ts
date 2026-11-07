// Start and stop of an instance: the cluster pieces (instrumentation.ts) and
// a graceful shutdown in both modes. Readiness (lib/cluster/health.ts) is
// false while the opening steps run and once the instance is stopping.
import { clusterMode, instanceId, requireClusterConfig } from "./config";
import { closeBus, startBus } from "./bus";
import { resignLeadership, startLeaderElection } from "./leader";
import { startHeartbeat, stopHeartbeat } from "./instances";
import { closeSession } from "./pg-session";

type State = {
  started: boolean;
  stopping: boolean;
  closers: Set<() => void>;
  shutdown?: Promise<void>;
};
const holder = globalThis as unknown as { flowplanRuntime?: State };
const state = (): State => (holder.flowplanRuntime ??= { started: false, stopping: false, closers: new Set() });

export const shuttingDown = () => state().stopping;

// Something to end when the instance stops – an open server-sent event
// stream (the browser reconnects, through the load balancer, to another
// instance). Returns the function that forgets it again.
export function onShutdown(close: () => void) {
  const s = state();
  s.closers.add(close);
  return () => s.closers.delete(close);
}

// Called first in instrumentation.ts. In cluster mode: the configuration
// check (the process exits with the reasons when something is missing),
// the bus, the leader election and the heartbeat. Both modes: SIGTERM and
// SIGINT end the instance gracefully.
export async function startInstance(options: { pool?: () => { total: number; idle: number; waiting: number } | null; version?: string | null } = {}) {
  const s = state();
  if (s.started) return;
  s.started = true;
  let cluster = false;
  try {
    cluster = requireClusterConfig();
  } catch (error) {
    console.error(String((error as Error).message));
    process.exit(1);
  }
  process.once("SIGTERM", () => void stopInstance("SIGTERM"));
  process.once("SIGINT", () => void stopInstance("SIGINT"));
  if (!cluster) return;
  console.log(`Cluster mode: instance ${instanceId()}`);
  await startBus();
  startLeaderElection();
  startHeartbeat({
    ready: () => !s.stopping,
    extra: () => ({ pool: options.pool?.() ?? undefined, version: options.version ?? null }),
  });
}

// Next.js closes the HTTP server on the same signal and waits for open
// requests; long-lived streams would hold it until the platform kills the
// process, so they are closed here. The leader gives up its lock at once
// (another instance takes over within a round), the heartbeat entry goes.
export function stopInstance(reason = "stop"): Promise<void> {
  const s = state();
  return (s.shutdown ??= (async () => {
    s.stopping = true;
    console.log(`Stopping (${reason}): closing live streams${clusterMode() ? ", leaving the cluster" : ""}`);
    for (const close of [...s.closers])
      try {
        close();
      } catch {}
    s.closers.clear();
    if (!clusterMode()) return;
    await Promise.allSettled([resignLeadership(), stopHeartbeat()]);
    await Promise.allSettled([closeBus(), closeSession()]);
  })());
}
