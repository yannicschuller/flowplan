// Workflows (#168, docs/specs/workflows.md §8.3–8.5, §15 "Gleichzeitigkeit"):
// four workers take steps from the queue at the same time while leases are
// stolen all the time (a sweeper as if instances hung) – every internal
// effect still happens exactly once, every run ends. Successors are queued
// idempotently, a restart brings running steps back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wfqueue-"));
const { id, run, one, all, transaction } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { claimSteps, sweepLeases, releaseLeases, drainWorkflows } = await import("../lib/workflows/queue");
const { executeStep } = await import("../lib/workflows/engine");
const { dispatchEvents, emitWorkflowEvent } = await import("../lib/workflows/events");
const { onPostgres } = await import("./helpers/backend");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
const owner: Identity = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const wid = await createWorkspace(owner.id, "Queue");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Effects" })).id as string;

const graph = {
  nodes: [
    { id: "n_trig00", type: "trigger.manual", label: "Start", config: { inputs: [{ name: "i", type: "text" }] } },
    { id: "n_make00", type: "action.record.create", label: "Make", config: { database: db, values: { title: "{{n_trig00.inputs.i}}" } } },
    { id: "n_mark00", type: "action.record.update", label: "Mark", config: { record: "{{n_make00.record.id}}", values: { title: "{{n_trig00.inputs.i}} done" } } },
  ],
  edges: [
    { id: "e_1", from: { node: "n_trig00", port: "out" }, to: { node: "n_make00", port: "in" } },
    { id: "e_2", from: { node: "n_make00", port: "out" }, to: { node: "n_mark00", port: "in" } },
  ],
};
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Effects" })).id as string;
await act({ action: "workflow.draft", pageId, graph });
assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
// Without the per-minute limit: this test makes many runs at once.
await run("INSERT INTO instance_settings(key,value) VALUES('workflowLimits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ runsPerMinute: 1000, workspaceRunsPerMinute: 10000, parallelRuns: 100 }));

const RUNS = onPostgres ? 300 : 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(`four workers, stolen leases: ${RUNS} runs, every effect exactly once`, { timeout: 300_000 }, async () => {
  await transaction(async () => {
    for (let i = 0; i < RUNS; i++)
      await emitWorkflowEvent("manual", { workspaceId: wid, scopeId: pageId, actorId: owner.id, payload: { workflow: pageId, node: "n_trig00", inputs: { i: `R${i}` }, source: "api" }, checked: true });
  });
  let open = true,
    stealing = true,
    // Once the thief stops, the workers look past the backoffs of swept steps.
    offset = 0;
  let executed = 0,
    stolen = 0;
  const worker = async () => {
    while (open) {
      await dispatchEvents();
      const [step] = await claimSteps(1, Date.now() + offset);
      if (!step) {
        await sleep(5);
        continue;
      }
      await executeStep(step);
      executed++;
      // Like the queue's pump: the next round in a new macrotask.
      await sleep(1);
    }
  };
  // As if instances hung: a worker whose lease runs out right after its
  // claim (the sweeper puts the step back, another worker takes it) still
  // tries to finish – and must not commit; leases of the others run out too.
  const thief = async () => {
    let loops = 0;
    while (stealing) {
      loops++;
      const [step] = await claimSteps(1);
      if (step) {
        await run("UPDATE workflow_steps SET lease_until=0 WHERE id=? AND status='running'", step.id);
        const sw = await sweepLeases(Date.now() + 1);
        stolen += sw;
        await executeStep(step);
      }
      const victim = await one<{ id: string }>("SELECT id FROM workflow_steps WHERE status='running' ORDER BY seq DESC LIMIT 1");
      if (victim) {
        await run("UPDATE workflow_steps SET lease_until=0 WHERE id=? AND status='running'", victim.id);
        stolen += await sweepLeases(Date.now() + 1);
      }
      await sleep(2);
    }
    console.log("thief loops", loops);
  };
  const done = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE page_id=? AND status IN ('succeeded','failed','cancelled')", pageId))?.n || 0);
  const workers = [worker(), worker(), worker(), worker(), thief()];
  // Steal for a while (or until half the runs are done), then let the workers finish.
  const stealUntil = Date.now() + 15_000;
  while ((await done()) < RUNS / 2 && Date.now() < stealUntil) await sleep(50);
  stealing = false;
  offset = 3 * 3_600_000;
  const deadline = Date.now() + 200_000;
  while ((await done()) < RUNS && Date.now() < deadline) await sleep(50);
  open = false;
  await Promise.all(workers);
  // Swept steps wait out a backoff: what is left runs now.
  await drainWorkflows({ now: () => Date.now() + 3_600_000 });
  const runs = await all<{ status: string; n: number }>("SELECT status,COUNT(*) n FROM workflow_runs WHERE page_id=? GROUP BY status", pageId);
  assert.deepEqual(runs.map((r) => [r.status, Number(r.n)]), [["succeeded", RUNS]]);
  const titles = (await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", db)).map((r) => JSON.parse(r.cells).title as string);
  assert.equal(titles.length, RUNS, "one record per run");
  assert.equal(new Set(titles).size, RUNS);
  assert.ok(titles.every((t) => / done$/.test(t)));
  // Every node ran once per run (a stolen attempt rolled back).
  const steps = await all<{ node_id: string; n: number }>("SELECT s.node_id,COUNT(*) n FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE r.page_id=? GROUP BY s.node_id ORDER BY s.node_id", pageId);
  assert.deepEqual(steps.map((s) => [s.node_id, Number(s.n)]), [["n_make00", RUNS], ["n_mark00", RUNS], ["n_trig00", RUNS]]);
  console.log(`${RUNS} runs, ${executed} step executions, ${stolen} leases stolen`);
  assert.ok(stolen > 0, "leases were stolen");
});

test("successors are queued once per arrival; a restarted instance gets its steps back", async () => {
  // A step whose successors were queued twice (a retry after a crash) has them once.
  const r = await one<{ id: string }>("SELECT id FROM workflow_runs WHERE page_id=? LIMIT 1", pageId);
  const s = await one<{ id: string }>("SELECT id FROM workflow_steps WHERE run_id=? AND node_id='n_make00'", r!.id);
  const before = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_steps WHERE run_id=?", r!.id))!.n);
  await run("INSERT INTO workflow_steps(id,run_id,node_id,iteration,via,status,due_at,created_at) VALUES(?,?,'n_mark00','',?,'queued',0,0) ON CONFLICT(run_id,node_id,iteration,via) DO NOTHING", id(), r!.id, s!.id);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_steps WHERE run_id=?", r!.id))!.n), before);
  // A stopping instance gives its leases back right away.
  await act({ action: "workflow.run", pageId, inputs: { i: "late" } });
  await dispatchEvents();
  const [claimed] = await claimSteps(1);
  assert.ok(claimed);
  assert.equal(await releaseLeases(), 1);
  assert.equal((await one<{ status: string; attempt: number }>("SELECT status,attempt FROM workflow_steps WHERE id=?", claimed.id))!.status, "queued");
  await drainWorkflows();
  assert.ok(await one("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%late done%'", db), JSON.stringify(await all("SELECT s.node_id,s.status,s.error FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE r.page_id=? ORDER BY r.created_at DESC LIMIT 3", pageId)));
});
