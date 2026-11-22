// The workflow queue gives the event loop back (lib/workflows/queue.ts):
// on SQLite every statement settles at once, and the pump used to start
// its next round in the same chain of microtasks whenever a round found
// work – a backlog (or a step that was put back due at once) blocked the
// server for as long as the queue kept finding something, 57 s and 117 s
// in the measurements of the performance work. Now every round runs in a
// macrotask of its own; an instance with nothing due asks one query per
// wake and reads the limits not at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wfyield-"));
process.env.FLOWPLAN_WORKFLOW_POLL_MS = "100";
const { id, run, one, transaction, writeGeneration } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { emitWorkflowEvent } = await import("../lib/workflows/events");
const { startWorkflowWorker, stopWorkflowWorker, workDue } = await import("../lib/workflows/queue");
const { workflowLimits } = await import("../lib/workflows/limits");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
const owner: Identity = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" };
const wid = await createWorkspace(owner.id, "Yield");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How often the environment's limits were read (FLOWPLAN_WORKFLOW_WORKERS
// is read once per uncached workflowLimits()).
let limitReads = 0;
const env = process.env;
process.env = new Proxy(env, {
  get(target, key) {
    if (key === "FLOWPLAN_WORKFLOW_WORKERS") limitReads++;
    return Reflect.get(target, key);
  },
});

test("idle: nothing due, the pump reads no limits", async () => {
  assert.equal(await workDue(), false);
  startWorkflowWorker();
  limitReads = 0;
  // About ten polls.
  await sleep(1_000);
  assert.equal(limitReads, 0);
});

test("cached limits: one read per window, a write outdates them", async () => {
  const generation = writeGeneration();
  const a = await workflowLimits({ cached: true });
  const b = await workflowLimits({ cached: true });
  // The same value unless a background job wrote in between.
  if (writeGeneration() === generation) assert.equal(a, b);
  assert.notEqual(await workflowLimits(), a, "uncached: read again");
  await run("INSERT INTO instance_settings(key,value) VALUES('workflowLimits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ workers: 3 }));
  assert.equal((await workflowLimits({ cached: true })).workers, 3);
  await run("DELETE FROM instance_settings WHERE key='workflowLimits'");
  assert.equal((await workflowLimits({ cached: true })).workers, 4);
});

test("a backlog is drained in rounds that give the event loop back", { timeout: 120_000 }, async () => {
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Made" })).id as string;
  const graph = {
    nodes: [
      { id: "n_trig00", type: "trigger.manual", label: "Start", config: { inputs: [{ name: "i", type: "text" }] } },
      { id: "n_make00", type: "action.record.create", label: "Make", config: { database: db, values: { title: "{{n_trig00.inputs.i}}" } } },
    ],
    edges: [{ id: "e_1", from: { node: "n_trig00", port: "out" }, to: { node: "n_make00", port: "in" } }],
  };
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Backlog" })).id as string;
  await act({ action: "workflow.draft", pageId, graph });
  assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
  await run("INSERT INTO instance_settings(key,value) VALUES('workflowLimits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ runsPerMinute: 1000, workspaceRunsPerMinute: 10000, parallelRuns: 100 }));
  const RUNS = 200;
  // Macrotasks that got their turn while the queue worked, and the longest
  // stretch the event loop was held.
  let turns = 0,
    longest = 0,
    last = performance.now(),
    watching = true;
  const watch = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    turns++;
    if (watching) setImmediate(watch);
  };
  await transaction(async () => {
    for (let i = 0; i < RUNS; i++)
      await emitWorkflowEvent("manual", { workspaceId: wid, scopeId: pageId, actorId: owner.id, payload: { workflow: pageId, node: "n_trig00", inputs: { i: `R${i}` }, source: "api" }, checked: true });
  });
  last = performance.now();
  const started = last;
  setImmediate(watch);
  const done = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE page_id=? AND status='succeeded'", pageId))?.n || 0);
  const deadline = Date.now() + 100_000;
  while ((await done()) < RUNS && Date.now() < deadline) await sleep(20);
  watching = false;
  const total = performance.now() - started;
  console.log(`${RUNS} runs: ${turns} turns of the event loop, held at most ${longest.toFixed(0)} ms`);
  assert.equal(await done(), RUNS);
  // Before: the whole backlog in one chain of microtasks (no turn in between, 1.5 s for 300 runs).
  assert.ok(turns > 10,`${turns} turns of the event loop while ${RUNS} runs were drained`);
  // The longest hold is a small part of the whole drain. An absolute bound
  // alone failed on a busy CI runner (one stall of 1.8 s in a 4.6 s drain,
  // 50 turns), while the bug it guards against holds the loop for nearly all
  // of it.
  assert.ok(longest < Math.max(1_000, total / 2), `event loop held for ${longest.toFixed(0)} ms of ${total.toFixed(0)} ms`);
  await stopWorkflowWorker();
});
