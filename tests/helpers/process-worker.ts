// One app process under the supervisor (tests/processes.test.ts runs
// scripts/processes.mjs with this file instead of server.js): an HTTP server
// on the shared port whose routes call the pieces several processes share –
// the bus, the leader duties, the rate limits, the AI slots, questions to
// the other processes, the process table – and the graceful shutdown of
// lib/cluster/runtime.ts (NEXT_MANUAL_SIG_HANDLE: no Next.js here, the
// process ends itself once its tasks are done).
//
//   FAIL_PRIMARY=1: process 1 ends with code 3 before it is ready.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR ??= mkdtempSync(join(tmpdir(), "flowplan-processes-"));
process.env.NEXT_RUNTIME = "nodejs";
process.env.NEXT_MANUAL_SIG_HANDLE = "1";
const index = Number(process.env.FLOWPLAN_PROCESS_INDEX);
const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ index, ...event })}\n`);

if (process.env.FAIL_PRIMARY === "1" && index === 1) {
  say({ event: "failing" });
  process.exit(3);
}

const { startInstance, onShutdown, onShutdownTask, SHUTDOWN_PHASE } = await import("../../lib/cluster/runtime");
const { onBus, publish } = await import("../../lib/cluster/bus");
const { isLeader, leaderDuty } = await import("../../lib/cluster/leader");
const processes = await import("../../lib/cluster/processes");
const { allow, settleLimits } = await import("../../lib/action-limits");
const { takeAiSlot } = await import("../../lib/ai/concurrency");
const { instanceId } = await import("../../lib/cluster/config");
const { notePresence } = await import("../../lib/page-presence");

await startInstance();
onBus("test", (payload, origin) => say({ event: "got", payload, origin }));
processes.answerPeers("who", () => ({ index, pid: process.pid }));
onShutdownTask("probe", SHUTDOWN_PHASE.work, async () => {
  say({ event: "stopping" });
  await new Promise((r) => setTimeout(r, 300));
});
process.on("exit", (code) => say({ event: "exit", code }));

const slots: (() => void)[] = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const reply = (value: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ index, value }));
  };
  switch (url.pathname) {
    case "/whoami":
      return reply({ instance: instanceId(), primary: processes.primaryProcess(), multi: processes.multiProcess(), respawned: processes.respawnedProcess(), workers: process.env.FLOWPLAN_WORKERS });
    case "/publish":
      publish("test", url.searchParams.get("v"));
      return reply(true);
    case "/leader":
      return reply({ leader: isLeader(), ran: (await leaderDuty("probe", async () => true)) === true });
    case "/limit": {
      const ok = allow(String(url.searchParams.get("key")), 5, 60_000);
      await settleLimits();
      return reply(ok);
    }
    case "/ai": {
      const release = await takeAiSlot("someone", 2);
      if (release) slots.push(release);
      return reply(!!release);
    }
    case "/present":
      await notePresence("page-1", String(url.searchParams.get("user")));
      return reply(true);
    case "/seen": {
      const seen = (globalThis as { flowplanPagePresence?: Map<string, Map<string, number>> }).flowplanPagePresence?.get("page-1");
      return reply([...(seen?.keys() ?? [])].sort());
    }
    case "/ask":
      return reply(await processes.askPeers("who"));
    case "/table":
      return reply(await processes.processTable());
    case "/crash":
      reply(true);
      setTimeout(() => process.exit(1), 20);
      return;
  }
  res.statusCode = 404;
  res.end();
});
onShutdown(() => server.close());
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  say({ event: "up", respawned: processes.respawnedProcess() });
  processes.announceReady();
});
