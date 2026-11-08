// One Flowplan instance for tests/workflows-cluster.test.ts: a child
// process in cluster mode on the test's PostgreSQL schema and Redis that
// runs the workflow queue (unless WF_NO_WORKER=1), driven by JSON lines on
// stdin:
//   {"op":"run","pageId":"…","userId":"…","inputs":{…}} → starts a manual run here
//   {"op":"tick","now":ms}                             → one schedule tick
//   {"op":"stop"}                                      → graceful stop
import { createInterface } from "node:readline";

process.env.FLOWPLAN_CLUSTER = "1";
const { startBus } = await import("../../lib/cluster/bus");
const { startLeaderElection } = await import("../../lib/cluster/leader");
const { startHeartbeat } = await import("../../lib/cluster/instances");
const { stopInstance } = await import("../../lib/cluster/runtime");
const { startWorkflowWorker, stopWorkflowWorker } = await import("../../lib/workflows/queue");
const { processWorkflowSchedules } = await import("../../lib/workflows/schedules");
const { command } = await import("../../lib/api");
const { one } = await import("../../lib/db");

const say = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
await startBus();
startLeaderElection();
startHeartbeat();
if (process.env.WF_NO_WORKER !== "1") startWorkflowWorker();
const alive = setInterval(() => {}, 1000);
say({ ready: true });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const c = JSON.parse(line) as { op: string; id?: number; pageId?: string; userId?: string; inputs?: Record<string, unknown>; now?: number };
  const reply = (data: object) => say({ id: c.id, ...data });
  try {
    if (c.op === "run") {
      const user = (await one<Record<string, unknown>>("SELECT * FROM users WHERE id=?", c.userId))!;
      reply(await command({ ...user, groups: [], isAdmin: false } as never, { action: "workflow.run", pageId: c.pageId, inputs: c.inputs || {} }));
    } else if (c.op === "tick") reply({ emitted: await processWorkflowSchedules(c.now) });
    else if (c.op === "stop") {
      await stopWorkflowWorker();
      await stopInstance("test");
      reply({ stopped: true });
      clearInterval(alive);
      process.exit(0);
    }
  } catch (error) {
    reply({ error: String((error as Error).message || error) });
  }
}
