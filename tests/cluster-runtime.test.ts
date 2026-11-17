// The running instance on Kubernetes (lib/cluster/runtime.ts, health.ts,
// leader.ts, lib/instance-ops.ts): the graceful shutdown holds Next.js's
// process.exit until Flowplan's tasks are done (within the budget),
// readiness waits for the opening steps and names their failures, the
// metrics of a cluster pod carry its id and leave the installation's
// figures to the leader, jobs started on one pod are not "interrupted" on
// another. Runs on SQLite and PostgreSQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onPostgres } from "./helpers/backend";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-cluster-runtime-"));
const { run, one, id } = await import("../lib/db");
const { readiness } = await import("../lib/cluster/health");
const { failedDataSteps, dataSteps } = await import("../lib/data-steps");
const { prometheusMetrics } = await import("../lib/instance-ops");
const { leaderDuty } = await import("../lib/cluster/leader");
const { shutdownBudgetMs } = await import("../lib/cluster/runtime");
const jobs = await import("../lib/background-jobs");

function stopProcess(env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; lines: string[]; ms: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/shutdown-instance.ts"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buffer = "";
    let sent = 0;
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        lines.push(line);
        if (line === "ready") setTimeout(() => {
          sent = Date.now();
          child.kill("SIGTERM");
        }, 100);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!/ExperimentalWarning|trace-warnings/.test(String(chunk))) lines.push(`stderr: ${String(chunk).trim()}`);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no exit: ${lines.join(" | ")}`));
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, lines, ms: Date.now() - sent });
    });
  });
}

test("SIGTERM: Next.js's exit waits for the running leader round and the shutdown tasks, then exits with 143", { timeout: 60_000 }, async () => {
  const { code, lines } = await stopProcess();
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  assert.equal(code, 143, lines.join("\n"));
  assert.ok(at("next: exit 143") >= 0, lines.join("\n"));
  // The exit came, and still the round and the task finished before the end.
  assert.ok(at("round: done") > at("next: closing the server"), lines.join("\n"));
  assert.ok(at("task: started") > at("round: done"), "tasks after the running rounds");
  assert.ok(at("task: done") > at("task: started"));
  assert.ok(at("Stopped after") > at("task: done"), lines.join("\n"));
});

test("SIGTERM: a task that does not end is left behind once FLOWPLAN_SHUTDOWN_SECONDS is used up", { timeout: 60_000 }, async () => {
  assert.equal(shutdownBudgetMs({}), 20_000);
  assert.equal(shutdownBudgetMs({ FLOWPLAN_SHUTDOWN_SECONDS: "45" }), 45_000);
  const { code, lines, ms } = await stopProcess({ TASK_MS: "never", FLOWPLAN_SHUTDOWN_SECONDS: "2" });
  assert.equal(code, 143, lines.join("\n"));
  assert.ok(lines.some((l) => /not finished in time: probe/.test(l)), lines.join("\n"));
  assert.ok(ms < 8000, `ended after ${ms} ms`);
});

test("readiness waits for the opening steps and names a failed data step, which it tries again", async () => {
  const ok = await readiness();
  assert.equal(ok.ready, true, JSON.stringify(ok.checks));
  assert.ok(ok.checks.opening.ok && ok.checks.database.ok);
  const step = dataSteps()[0].name;
  failedDataSteps().set(step, "boom");
  // Tried again at the next probe (at most once a minute).
  (globalThis as { flowplanStepRetry?: number }).flowplanStepRetry = Date.now();
  const failing = await readiness();
  assert.equal(failing.ready, false);
  assert.match(String(failing.checks.opening.error), new RegExp(`data step ${step} failed: boom`));
  (globalThis as { flowplanStepRetry?: number }).flowplanStepRetry = 0;
  await readiness();
  for (let i = 0; i < 100 && failedDataSteps().size; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await readiness()).ready, true, "the step went through on the retry");
  // Opening steps that failed keep the instance out of the rotation.
  const holder = globalThis as { flowplanOpening?: { state: string; error?: string } };
  const before = holder.flowplanOpening;
  holder.flowplanOpening = { state: "failed", error: "schema step: permission denied" };
  try {
    const down = await readiness();
    assert.equal(down.ready, false);
    assert.match(String(down.checks.opening.error), /opening steps failed: schema step: permission denied/);
  } finally {
    holder.flowplanOpening = before;
  }
  if (onPostgres) {
    // A database whose schema is older than this version (the migration
    // Job has not run): not ready.
    const meta = await one<{ value: string }>("SELECT value FROM flowplan_meta WHERE key='sqlite_schema'");
    await run("UPDATE flowplan_meta SET value='1' WHERE key='sqlite_schema'");
    try {
      const old = await readiness();
      assert.equal(old.ready, false);
      assert.match(String(old.checks.opening.error), /older than this version/);
    } finally {
      await run("UPDATE flowplan_meta SET value=? WHERE key='sqlite_schema'", meta!.value);
    }
  }
});

test("metrics of a cluster pod: per-process figures with its instance_id, the installation's only from the leader", async () => {
  const single = await prometheusMetrics();
  assert.match(single, /^flowplan_uptime_seconds \d+$/m);
  assert.match(single, /^flowplan_pages \d+$/m);
  const families = (text: string) => [...text.matchAll(/^# HELP (\S+)/gm)].map((m) => m[1]);
  assert.equal(new Set(families(single)).size, families(single).length, "every family once (Prometheus refuses repeats)");
  process.env.FLOWPLAN_CLUSTER = "1";
  process.env.FLOWPLAN_INSTANCE_ID = "flowplan-7d9-abc";
  try {
    const pod = await prometheusMetrics();
    assert.match(pod, /^flowplan_uptime_seconds\{instance_id="flowplan-7d9-abc"\} \d+$/m);
    assert.match(pod, /^flowplan_metrics_shared\{instance_id="flowplan-7d9-abc"\} 0$/m);
    assert.match(pod, /^flowplan_process_resident_memory_bytes\{instance_id="flowplan-7d9-abc"\} \d+$/m);
    assert.match(pod, /^flowplan_build_info\{instance_id="flowplan-7d9-abc",version="[^"]*",commit="[^"]*",node="v\d/m);
    // Not the leader (no election here): no counts from the database, so
    // a sum over the pods counts them once.
    assert.doesNotMatch(pod, /^flowplan_pages /m);
    assert.doesNotMatch(pod, /^flowplan_workspace_bytes/m);
    assert.equal(new Set(families(pod)).size, families(pod).length);
  } finally {
    delete process.env.FLOWPLAN_CLUSTER;
    delete process.env.FLOWPLAN_INSTANCE_ID;
  }
});

test("leader rounds outside cluster mode run as before", async () => {
  assert.equal(await leaderDuty("probe", async () => 42), 42);
});

test("a job running on another pod is not interrupted; one whose pod stopped marking it is", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Job", "job@example.test");
  const jobId = await jobs.startJob({ id: uid }, "import", "a.zip");
  // Single container: this process runs it.
  assert.equal((await jobs.personJobs({ id: uid })).find((j) => j.id === jobId)?.status, "running");
  // Another pod's job (other boot), marked alive a moment ago: running.
  await run("UPDATE background_jobs SET boot='other-pod',updated_at=? WHERE id=?", Date.now() - 10_000, jobId);
  process.env.FLOWPLAN_CLUSTER = "1";
  try {
    assert.equal((await jobs.personJobs({ id: uid })).find((j) => j.id === jobId)?.status, "running");
    await run("UPDATE background_jobs SET updated_at=? WHERE id=?", Date.now() - 5 * 60_000, jobId);
    assert.equal((await jobs.personJobs({ id: uid })).find((j) => j.id === jobId)?.status, "interrupted");
  } finally {
    delete process.env.FLOWPLAN_CLUSTER;
  }
  assert.equal((await jobs.personJobs({ id: uid })).find((j) => j.id === jobId)?.status, "interrupted", "single container: an earlier process's job");
  await jobs.finishJob(jobId);
});
