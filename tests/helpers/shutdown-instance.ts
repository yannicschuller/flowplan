// A process that stops like the Flowplan server does (tests/cluster-runtime.test.ts):
// a SIGTERM handler standing in for Next.js's (registered first, as Next.js
// does before instrumentation.ts runs) closes its "server" after a moment
// and calls process.exit(143); lib/cluster/runtime.ts must hold that exit
// until Flowplan's shutdown tasks are done (or the budget is used up).
//
//   TASK_MS: how long the shutdown task takes ("never": it does not end)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR ??= mkdtempSync(join(tmpdir(), "flowplan-shutdown-"));
process.env.NEXT_RUNTIME = "nodejs";
delete process.env.NEXT_MANUAL_SIG_HANDLE;
const say = (line: string) => process.stdout.write(`${line}\n`);

// "Next.js": closes the server (open requests finish), then exits.
process.on("SIGTERM", () => {
  say("next: closing the server");
  setTimeout(() => {
    say("next: exit 143");
    process.exit(143);
  }, 100);
});

const { startInstance, onShutdownTask, SHUTDOWN_PHASE } = await import("../../lib/cluster/runtime");
const { leaderDuty } = await import("../../lib/cluster/leader");
await startInstance();
const ms = process.env.TASK_MS || "300";
onShutdownTask("probe", SHUTDOWN_PHASE.files, async () => {
  say("task: started");
  if (ms === "never") await new Promise(() => {});
  await new Promise((r) => setTimeout(r, Number(ms)));
  say("task: done");
});
// A leader round running at the signal finishes first.
void leaderDuty("probe-round", async () => {
  say("round: started");
  await new Promise((r) => setTimeout(r, 400));
  say("round: done");
});
// The process stays alive like a server.
setInterval(() => {}, 1000);
say("ready");
