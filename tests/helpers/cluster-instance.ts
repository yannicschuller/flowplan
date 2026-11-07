// One Flowplan "instance" for tests/cluster.test.ts: a child process with
// FLOWPLAN_CLUSTER=1 on the test's PostgreSQL schema and Redis, driven by
// JSON lines on stdin; it answers and reports on stdout (one JSON per line).
//
//   {"op":"watch","key":"…"}             → {"event":"…"} for each SSE event
//   {"op":"publish","key":"…","update":"…"}
//   {"op":"allow","key":"…","max":n,"window":ms} → {"allowed":bool}
//   {"op":"instances"}                    → {"instances":[…]}
//   {"op":"stop"}                         → graceful stop, then exit
// Leadership changes come as {"leader":bool}.
import { createInterface } from "node:readline";

process.env.FLOWPLAN_CLUSTER = "1";
const { startBus } = await import("../../lib/cluster/bus");
const { onLeadership, startLeaderElection } = await import("../../lib/cluster/leader");
const { startHeartbeat, liveInstances } = await import("../../lib/cluster/instances");
const { stopInstance } = await import("../../lib/cluster/runtime");
const { publishDocumentUpdate, watchDocument } = await import("../../lib/document-live");
const { allow, settleLimits } = await import("../../lib/action-limits");
const { instanceId } = await import("../../lib/cluster/config");

const say = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
onLeadership((leader) => say({ leader }));
await startBus();
startLeaderElection();
startHeartbeat();
// Keeps the process alive (the cluster connections are unref'd).
const alive = setInterval(() => {}, 1000);

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const command = JSON.parse(line) as { op: string; key?: string; update?: string; max?: number; window?: number; id?: number };
  const reply = (data: object) => say({ id: command.id, ...data });
  try {
    switch (command.op) {
      case "watch":
        watchDocument(command.key!, "test-client", (event) => say({ event: event.trim() }));
        reply({ ok: true });
        break;
      case "publish":
        publishDocumentUpdate(command.key!, command.update!, "someone-else");
        reply({ ok: true });
        break;
      case "allow": {
        const allowed = allow(command.key!, command.max!, command.window!);
        await settleLimits();
        reply({ allowed });
        break;
      }
      case "instances":
        reply({ instances: (await liveInstances()).map((i) => ({ id: i.id, leader: i.leader })), self: instanceId() });
        break;
      case "stop":
        await stopInstance("test");
        reply({ stopped: true });
        clearInterval(alive);
        process.exit(0);
    }
  } catch (error) {
    reply({ error: String((error as Error).message || error) });
  }
}
