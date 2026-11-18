// State that every instance of a cluster must see alike (docs/architecture/
// database.md §14c): the outcome of a background import and "an import is
// already running" (in the database, lib/background-jobs.ts), and the
// parallel AI answers per person (Redis, lib/ai/concurrency.ts – per
// instance when Redis is away). Print views: tests/print-snapshots.test.ts.
// Runs on SQLite and PostgreSQL; Redis: FLOWPLAN_TEST_REDIS_URL, else the
// in-process double.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startFakeRedis } from "./helpers/fake-redis";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-cluster-shared-"));
process.env.FLOWPLAN_REDIS_PREFIX = `flowplan-test-${randomBytes(4).toString("hex")}:`;
const fake = process.env.FLOWPLAN_TEST_REDIS_URL ? null : await startFakeRedis();
const { run, one, id } = await import("../lib/db");
const jobs = await import("../lib/background-jobs");
const { HttpError } = await import("../lib/auth");
const { takeAiSlot, SLOT_TTL_MS } = await import("../lib/ai/concurrency");
const { closeBus } = await import("../lib/cluster/bus");
after(async () => {
  await closeBus();
  await fake?.close();
});

async function person() {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Jo", `${uid}@example.test`);
  return { id: uid };
}
// As another instance would have written it.
async function foreignJob(user: { id: string }, fields: { status: "running" | "done" | "failed"; updatedAgo: number; outcome?: unknown; expiresIn?: number }) {
  const jobId = id(),
    now = Date.now();
  await run(
    "INSERT INTO background_jobs(id,user_id,kind,label,progress,status,boot,started_at,updated_at,finished_at,launched,instance,outcome,expires_at) VALUES(?,?,'import','x.zip',0.5,?,'other-boot',?,?,?,1,'pod-b',?,?)",
    jobId,
    user.id,
    fields.status,
    now - 600_000,
    now - fields.updatedAgo,
    fields.status === "running" ? null : now - fields.updatedAgo,
    fields.outcome === undefined ? null : JSON.stringify(fields.outcome),
    fields.expiresIn === undefined ? null : now + fields.expiresIn,
  );
  return jobId;
}
// Until the launched jobs of the person ended (they run after "the request").
async function settled(user: { id: string }) {
  for (let i = 0; i < 200 && (await one("SELECT 1 AS ok FROM background_jobs WHERE user_id=? AND status='running' AND boot!='other-boot'", user.id)); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}
const inCluster = async <T>(fn: () => Promise<T>) => {
  process.env.FLOWPLAN_CLUSTER = "1";
  try {
    return await fn();
  } finally {
    delete process.env.FLOWPLAN_CLUSTER;
  }
};

test("a launched job's outcome is in the database: any instance answers the poll", async () => {
  const owner = await person();
  const job = await jobs.launchJob(owner, "import", "big.zip", async () => ({ pages: 4 }));
  await settled(owner);
  const row = await one<{ launched: number; instance: string; outcome: string; expires_at: number; status: string }>("SELECT launched,instance,outcome,expires_at,status FROM background_jobs WHERE id=?", job);
  assert.equal(Number(row?.launched), 1);
  assert.ok(row?.instance, "the instance that ran it");
  assert.deepEqual(JSON.parse(row!.outcome), { value: { pages: 4 } });
  assert.ok(Number(row?.expires_at) > Date.now() + 50 * 60_000, "kept for an hour");
  // Another instance (another process) reads the same row.
  await inCluster(async () => assert.deepEqual(await jobs.jobOutcome(owner, job), { status: "done", value: { pages: 4 } }));
  assert.equal(await jobs.jobOutcome({ id: "someone-else" }, job), null, "only for its person");
  // After the hour: emptied by the sweep, unknown to the poll.
  assert.equal(await jobs.jobOutcome(owner, job, Date.now() + 61 * 60_000), null);
  await jobs.sweepBackgroundJobs(Date.now() + 61 * 60_000);
  assert.equal((await one<{ outcome: string | null }>("SELECT outcome FROM background_jobs WHERE id=?", job))?.outcome, null);
});

test("errors keep what the route answers: status and text, invalid input, or a plain failure", async () => {
  const owner = await person();
  const failing = (error: unknown) => jobs.launchJob(owner, "import", "bad.zip", () => Promise.reject(error));
  const http = await failing(new HttpError(413, "ZIP darf maximal 100 MB groß sein."));
  let input: unknown;
  try {
    z.object({ spaceId: z.uuid() }).parse({ spaceId: "x" });
  } catch (error) {
    input = error;
  }
  const invalid = await failing(input);
  const plain = await failing(new Error("disk on fire"));
  await settled(owner);
  const httpOutcome = (await jobs.jobOutcome(owner, http)) as { status: "failed"; error: unknown };
  assert.equal(httpOutcome.status, "failed");
  assert.ok(httpOutcome.error instanceof HttpError);
  assert.equal((httpOutcome.error as InstanceType<typeof HttpError>).status, 413);
  assert.equal((httpOutcome.error as Error).message, "ZIP darf maximal 100 MB groß sein.");
  const invalidOutcome = (await jobs.jobOutcome(owner, invalid)) as { error: unknown };
  assert.ok(invalidOutcome.error instanceof z.ZodError);
  assert.equal((invalidOutcome.error as z.ZodError).issues.length, 1);
  assert.deepEqual((invalidOutcome.error as z.ZodError).issues[0].path, ["spaceId"]);
  const plainOutcome = (await jobs.jobOutcome(owner, plain)) as { error: unknown };
  assert.ok(!(plainOutcome.error instanceof HttpError));
  assert.equal((plainOutcome.error as Error).message, "disk on fire");
});

test("an import running on another instance blocks a second one; one whose instance died is interrupted", async () => {
  const owner = await person();
  // Marked alive 10 s ago by its instance.
  const alive = await foreignJob(owner, { status: "running", updatedAgo: 10_000 });
  await inCluster(async () => {
    assert.equal(await jobs.runningJob(owner, "import"), true);
    assert.deepEqual(await jobs.jobOutcome(owner, alive), { status: "running", progress: 0.5 });
  });
  // Not marked for over a minute: its instance stopped (the poll answers
  // 410 "Der Import wurde unterbrochen …").
  await run("UPDATE background_jobs SET updated_at=? WHERE id=?", Date.now() - jobs.JOB_ALIVE_LIMIT - 1000, alive);
  await inCluster(async () => {
    assert.equal(await jobs.runningJob(owner, "import"), false);
    assert.equal(await jobs.jobOutcome(owner, alive), null);
    assert.equal((await jobs.personJobs(owner)).find((j) => j.id === alive)?.status, "interrupted");
  });
  // Single container: a job of an earlier process is interrupted at once.
  await run("UPDATE background_jobs SET updated_at=? WHERE id=?", Date.now(), alive);
  assert.equal(await jobs.runningJob(owner, "import"), false);
  assert.equal(await jobs.jobOutcome(owner, alive), null);
  // Finished on another instance: its outcome, from the row.
  const done = await foreignJob(owner, { status: "done", updatedAgo: 1000, outcome: { value: { preview: true } }, expiresIn: 3_600_000 });
  await inCluster(async () => assert.deepEqual(await jobs.jobOutcome(owner, done), { status: "done", value: { preview: true } }));
  // A job of this process counts in both modes, and only while it runs.
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const mine = await jobs.launchJob(owner, "import", "mine.zip", async () => {
    await waiting;
    return 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await jobs.runningJob(owner, "import"), true);
  await inCluster(async () => assert.equal(await jobs.runningJob(owner, "import"), true));
  assert.equal(await jobs.runningJob(owner, "export"), false, "per kind");
  release();
  await settled(owner);
  assert.equal(await jobs.runningJob(owner, "import"), false);
  assert.deepEqual(await jobs.jobOutcome(owner, mine), { status: "done", value: 1 });
  // Jobs that only record their request (trackJob) are no launched job.
  await jobs.trackJob(owner, "import", "inline.zip", async () => {
    assert.equal(await jobs.runningJob(owner, "import"), false);
  });
});

test("parallel AI answers per person: in memory without cluster mode", async () => {
  const releases = [];
  for (let i = 0; i < 3; i++) releases.push(await takeAiSlot("ai-local", 3));
  assert.ok(releases.every(Boolean));
  assert.equal(await takeAiSlot("ai-local", 3), null);
  releases[0]!();
  releases[0]!();
  const again = await takeAiSlot("ai-local", 3);
  assert.ok(again, "a slot given back is free again (once)");
  assert.equal(await takeAiSlot("ai-local", 3), null);
  for (const release of [again, ...releases.slice(1)]) release!();
});

test("parallel AI answers per person: shared through Redis in cluster mode, slots of a crashed instance lapse", async () => {
  process.env.REDIS_URL = process.env.FLOWPLAN_TEST_REDIS_URL || fake!.url;
  await inCluster(async () => {
    const now = Date.now();
    const user = `ai-${randomBytes(3).toString("hex")}`;
    const a = await takeAiSlot(user, 3, now);
    const b = await takeAiSlot(user, 3, now);
    const c = await takeAiSlot(user, 3, now);
    assert.ok(a && b && c);
    // The fourth – on whichever instance – is refused.
    assert.equal(await takeAiSlot(user, 3, now), null);
    a!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const d = await takeAiSlot(user, 3, now);
    assert.ok(d, "a slot given back is free for every instance");
    // An instance that crashed never gives its slots back: they lapse.
    assert.equal(await takeAiSlot(user, 3, now + 1000), null);
    const later = await takeAiSlot(user, 3, now + SLOT_TTL_MS + 1000);
    assert.ok(later, "lapsed after the slot time");
    for (const release of [b, c, d, later]) release!();
  });
  delete process.env.REDIS_URL;
});

test("parallel AI answers: without Redis each instance counts on its own (logged once)", async () => {
  await closeBus();
  // Nothing listens there.
  process.env.REDIS_URL = "redis://127.0.0.1:1/0";
  const errors: string[] = [];
  const error = console.error;
  console.error = (...line: unknown[]) => void errors.push(line.map(String).join(" "));
  try {
    await inCluster(async () => {
      const user = "ai-no-redis";
      const slots = [await takeAiSlot(user, 2), await takeAiSlot(user, 2)];
      assert.ok(slots.every(Boolean), "fail open");
      assert.equal(await takeAiSlot(user, 2), null, "still limited per instance");
      for (const release of slots) release!();
    });
  } finally {
    console.error = error;
    delete process.env.REDIS_URL;
    await closeBus();
  }
  assert.equal(errors.filter((line) => /Redis unavailable, parallel AI answers are counted per instance/.test(line)).length, 1);
});
