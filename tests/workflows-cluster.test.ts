// Workflows in cluster mode (#168, docs/specs/workflows.md §8.3, §15
// "Cluster-Test"): three instances as child processes on one PostgreSQL
// schema and one Redis share the step queue. 300 runs with five steps each;
// one instance is killed hard in the middle – its leases run out, the
// others take the steps over: every run ends, every internal effect happens
// once. A run started on an instance without a worker is woken on the
// others over the bus; a schedule tick on all three at once makes one
// event. PostgreSQL only (cluster mode needs it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { onPostgres } from "./helpers/backend";
import { startFakeRedis } from "./helpers/fake-redis";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wfcluster-"));
const needsPostgres = !onPostgres && "needs DATABASE_URL=postgres://… (cluster mode)";

type Instance = { child: ChildProcessWithoutNullStreams; messages: Record<string, unknown>[]; send: (c: Record<string, unknown>) => Promise<Record<string, unknown>>; waitFor: (p: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>> };
const instances: Instance[] = [];
let fake: Awaited<ReturnType<typeof startFakeRedis>> | null = null;
after(async () => {
  for (const i of instances) i.child.kill("SIGKILL");
  await fake?.close();
});
let requests = 0;
function startInstance(name: string, redisUrl: string, prefix: string, env: Record<string, string> = {}): Instance {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/workflow-instance.ts"], {
    env: {
      ...process.env,
      FLOWPLAN_CLUSTER: "1",
      REDIS_URL: redisUrl,
      FLOWPLAN_REDIS_PREFIX: prefix,
      FLOWPLAN_INSTANCE_ID: name,
      FLOWPLAN_LEADER_INTERVAL: "300",
      FLOWPLAN_WORKFLOW_LEASE_MS: "3000",
      FLOWPLAN_WORKFLOW_SWEEP_MS: "500",
      FLOWPLAN_WORKFLOW_POLL_MS: "300",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const instance: Instance = {
    child,
    messages: [],
    send: async (command) => {
      const id = ++requests;
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      return await instance.waitFor((m) => m.id === id);
    },
    waitFor: (pred, ms = 30_000) =>
      new Promise((resolve, reject) => {
        const found = instance.messages.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`${name}: timed out; got ${JSON.stringify(instance.messages.slice(-3))}`)), ms);
        const check = () => {
          const hit = instance.messages.find(pred);
          if (hit) {
            clearTimeout(timer);
            child.stdout.off("line", check);
            resolve(hit);
          }
        };
        child.stdout.on("line", check);
      }),
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      instance.messages.push(JSON.parse(line));
      child.stdout.emit("line");
    } catch {}
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (!/ExperimentalWarning|trace-warnings|Cluster|Stopping/.test(text)) process.stderr.write(`[${name}] ${text}`);
  });
  instances.push(instance);
  return instance;
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("three instances, one killed hard: every run ends, every effect exactly once; bus wake-ups; one schedule event", { skip: needsPostgres, timeout: 240_000 }, async () => {
  fake = process.env.FLOWPLAN_TEST_REDIS_URL ? null : await startFakeRedis();
  const redisUrl = process.env.FLOWPLAN_TEST_REDIS_URL || fake!.url;
  const prefix = `flowplan-wftest-${randomBytes(4).toString("hex")}:`;
  const { id, run, one, all, transaction } = await import("../lib/db");
  const { command, bootstrap } = await import("../lib/api");
  const { createWorkspace } = await import("../lib/seed");
  const { emitWorkflowEvent } = await import("../lib/workflows/events");
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "owner", "owner@test.invalid");
  const owner = { id: uid, name: "owner", email: "owner@test.invalid", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
  const wid = await createWorkspace(owner.id, "Cluster");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const db = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "Effects" })).id as string;
  const nodes = [
    { id: "n_trig00", type: "trigger.manual", label: "Start", config: { inputs: [{ name: "i", type: "text" }] } },
    { id: "n_set001", type: "logic.set", label: "One", config: { values: [{ name: "a", value: "{{n_trig00.inputs.i}}" }] } },
    { id: "n_set002", type: "logic.set", label: "Two", config: { values: [{ name: "b", value: "{{n_set001.a}}-b" }] } },
    { id: "n_set003", type: "logic.set", label: "Three", config: { values: [{ name: "c", value: "{{n_set002.b}}-c" }] } },
    { id: "n_make00", type: "action.record.create", label: "Make", config: { database: db, values: { title: "{{n_set003.c}}" } } },
    { id: "n_mark00", type: "action.record.update", label: "Mark", config: { record: "{{n_make00.record.id}}", values: { title: "{{n_set003.c}} done" } } },
  ];
  const graph = { nodes, edges: nodes.slice(1).map((n, i) => ({ id: `e_${i + 1}`, from: { node: nodes[i].id, port: "out" }, to: { node: n.id, port: "in" } })) };
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Cluster" })).id as string;
  await act({ action: "workflow.draft", pageId, graph });
  assert.equal((await act({ action: "workflow.activate", pageId })).ok, true);
  await run("INSERT INTO instance_settings(key,value) VALUES('workflowLimits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ runsPerMinute: 1000, workspaceRunsPerMinute: 10000, parallelRuns: 100 }));

  const RUNS = 300;
  await transaction(async () => {
    for (let i = 0; i < RUNS; i++)
      await emitWorkflowEvent("manual", { workspaceId: wid, scopeId: pageId, actorId: owner.id, payload: { workflow: pageId, node: "n_trig00", inputs: { i: `R${i}` }, source: "api" }, checked: true });
  });
  const a = startInstance("wf-a", redisUrl, prefix),
    b = startInstance("wf-b", redisUrl, prefix),
    c = startInstance("wf-c", redisUrl, prefix);
  await Promise.all([a, b, c].map((i) => i.waitFor((m) => m.ready === true)));
  const done = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_runs WHERE page_id=? AND status IN ('succeeded','failed','cancelled')", pageId))?.n || 0);
  // In the middle: one instance dies without a goodbye (its leases stay).
  for (let i = 0; i < 600 && (await done()) < RUNS / 3; i++) await settle(100);
  const heldByA = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_steps WHERE claimed_by='wf-a'"))!.n);
  a.child.kill("SIGKILL");
  const killedAt = Date.now();
  for (let i = 0; i < 1500 && (await done()) < RUNS; i++) await settle(100);
  const statuses = await all<{ status: string; n: number }>("SELECT status,COUNT(*) n FROM workflow_runs WHERE page_id=? GROUP BY status", pageId);
  assert.deepEqual(statuses.map((s) => [s.status, Number(s.n)]), [["succeeded", RUNS]]);
  const titles = (await all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", db)).map((r) => JSON.parse(r.cells).title as string);
  assert.equal(titles.length, RUNS, "one record per run");
  assert.equal(new Set(titles).size, RUNS);
  assert.ok(titles.every((t) => /^R\d+-b-c done$/.test(t)), titles.find((t) => !/done$/.test(t)));
  const perNode = await all<{ node_id: string; n: number }>("SELECT s.node_id,COUNT(*) n FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id WHERE r.page_id=? GROUP BY s.node_id", pageId);
  assert.ok(perNode.every((s) => Number(s.n) === RUNS), JSON.stringify(perNode));
  const byInstance = await all<{ claimed_by: string; n: number }>("SELECT claimed_by,COUNT(*) n FROM workflow_steps WHERE claimed_by IS NOT NULL GROUP BY claimed_by ORDER BY claimed_by");
  console.log(`steps by instance: ${JSON.stringify(byInstance)}; a held ${heldByA} when killed; finished ${Date.now() - killedAt} ms after the kill`);
  assert.ok(byInstance.some((r) => r.claimed_by === "wf-b") && byInstance.some((r) => r.claimed_by === "wf-c"));

  // A run started on an instance without a worker: the others hear of it on the bus
  // (they poll only every 10 minutes here).
  for (const i of [b, c]) await i.send({ op: "stop" });
  const quietB = startInstance("wf-b2", redisUrl, prefix, { FLOWPLAN_WORKFLOW_POLL_MS: "600000" }),
    quietC = startInstance("wf-c2", redisUrl, prefix, { FLOWPLAN_WORKFLOW_POLL_MS: "600000" }),
    starter = startInstance("wf-starter", redisUrl, prefix, { WF_NO_WORKER: "1", FLOWPLAN_WORKFLOW_POLL_MS: "600000" });
  await Promise.all([quietB, quietC, starter].map((i) => i.waitFor((m) => m.ready === true)));
  await settle(1500);
  const started = Date.now();
  const answer = await starter.send({ op: "run", pageId, userId: owner.id, inputs: { i: "bus" } });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  let woke = false;
  for (let i = 0; i < 100 && !woke; i++) {
    woke = !!(await one("SELECT 1 FROM rows WHERE page_id=? AND cells LIKE '%bus-b-c done%'", db));
    if (!woke) await settle(100);
  }
  assert.ok(woke, "woken over the bus");
  console.log(`run started on a worker-less instance finished after ${Date.now() - started} ms`);

  // A schedule: the tick runs on all three at once (a leader change) – one event.
  await act({ action: "workflow.pause", pageId });
  const sched = [
    { id: "n_tick00", type: "trigger.schedule", label: "Tick", config: { freq: "daily", interval: 1, time: "00:00", timeZone: "UTC" } },
    { id: "n_note00", type: "logic.set", label: "Note", config: { values: [{ name: "x", value: "{{n_tick00.slot.date}}" }] } },
  ];
  const schedPage = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title: "Tick" })).id as string;
  await act({ action: "workflow.draft", pageId: schedPage, graph: { nodes: sched, edges: [{ id: "e_1", from: { node: "n_tick00", port: "out" }, to: { node: "n_note00", port: "in" } }] } });
  await act({ action: "workflow.activate", pageId: schedPage });
  const now = Date.now() + 86_400_000;
  const emitted = await Promise.all([quietB, quietC, starter].map(async (i) => Number((await i.send({ op: "tick", now })).emitted)));
  assert.equal(emitted.reduce((x, y) => x + y, 0), 1, JSON.stringify(emitted));
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_events WHERE kind='schedule' AND payload LIKE ?", `%${schedPage}%`))!.n), 1);
  for (const i of [quietB, quietC, starter]) await i.send({ op: "stop" });
});
