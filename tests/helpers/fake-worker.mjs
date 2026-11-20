// A stand-in for lib/workers/job-worker.ts (tests/worker-pool.test.ts): the
// job's first argument says what to do – answer after a while, hang,
// fail with an HttpError, try to write, or end the thread.
import { parentPort } from "node:worker_threads";

parentPort.on("message", async ({ id, args }) => {
  const [what] = args;
  if (what.sleep) await new Promise((resolve) => setTimeout(resolve, what.sleep));
  if (what.hang) return;
  if (what.exit) process.exit(3);
  if (what.http) return parentPort.postMessage({ id, error: { kind: "http", status: what.http[0], message: what.http[1] } });
  if (what.zod) return parentPort.postMessage({ id, error: { kind: "zod", issues: [{ code: "custom", path: ["x"], message: "Falsch" }] } });
  if (what.write) return parentPort.postMessage({ id, error: { kind: "write", message: "attempt to write a readonly database" } });
  if (what.crash) throw new Error("crashed");
  parentPort.postMessage({ id, value: { echo: what.echo ?? null, bytes: new Uint8Array([1, 2, 3]) }, audits: what.audit ? [what.audit] : [] });
});
parentPort.postMessage({ ready: true });
