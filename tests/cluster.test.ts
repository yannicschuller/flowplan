// Cluster mode (lib/cluster, docs/architecture/database.md §13): the
// configuration check, the Redis client, and – with PostgreSQL – several
// instances as child processes on one database and one Redis: leader
// election and failover, heartbeats, live document updates between
// instances, rate limits shared across them.
//
// Redis: FLOWPLAN_TEST_REDIS_URL (a real one; CI's postgres job has one),
// else an in-process double (tests/helpers/fake-redis.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { onPostgres } from "./helpers/backend";
import { startFakeRedis } from "./helpers/fake-redis";
import { clusterConfigProblems, clusterMode, requireClusterConfig } from "../lib/cluster/config";
import { RedisClient, encodeCommand, parseReply, parseRedisUrl } from "../lib/cluster/redis";
import { postgresTimeouts } from "../lib/db-driver/postgres";

const fake = process.env.FLOWPLAN_TEST_REDIS_URL ? null : await startFakeRedis();
const redisUrl = process.env.FLOWPLAN_TEST_REDIS_URL || fake!.url;
after(async () => {
  await fake?.close();
});

test("cluster mode needs PostgreSQL, Redis and S3 – and says what is missing", () => {
  assert.equal(clusterMode({}), false);
  assert.equal(clusterMode({ FLOWPLAN_CLUSTER: "1" }), true);
  assert.equal(clusterMode({ FLOWPLAN_MODE: "cluster" }), true);
  // Off: nothing is required (the single container as always).
  assert.equal(requireClusterConfig({ DATABASE_URL: "" }), false);
  const problems = clusterConfigProblems({ FLOWPLAN_CLUSTER: "1", DATABASE_URL: "./data/flowplan.sqlite" });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /DATABASE_URL must point to PostgreSQL/);
  assert.match(problems[1], /REDIS_URL is missing/);
  assert.match(problems[2], /S3_BUCKET/);
  assert.throws(() => requireClusterConfig({ FLOWPLAN_CLUSTER: "1", DATABASE_URL: "postgres://x/y", S3_BUCKET: "b" }), /cannot start:\n {2}- REDIS_URL is missing/);
  assert.equal(requireClusterConfig({ FLOWPLAN_CLUSTER: "1", DATABASE_URL: "postgres://x/y", REDIS_URL: "redis://r:6379", S3_BUCKET: "b" }), true);
  assert.match(clusterConfigProblems({ FLOWPLAN_CLUSTER: "1", DATABASE_URL: "postgres://x/y", REDIS_URL: "http://r", S3_BUCKET: "b" })[0], /redis:\/\//);
});

test("pool limits come from the environment, with the bridge's 10 s lock timeout by default", () => {
  assert.deepEqual(postgresTimeouts({}), { statementTimeout: 120_000, lockTimeout: 10_000, idleInTransactionTimeout: 60_000, connectTimeout: 30_000 });
  assert.equal(postgresTimeouts({ FLOWPLAN_PG_LOCK_TIMEOUT: "0" }).lockTimeout, 0);
  assert.throws(() => postgresTimeouts({ FLOWPLAN_PG_STATEMENT_TIMEOUT: "soon" }), /milliseconds/);
});

test("liveness answers without the database; readiness checks it and turns 503 while stopping; FLOWPLAN_READY_REQUIRE", async () => {
  const { readinessRequires } = await import("../lib/cluster/health");
  assert.deepEqual([...readinessRequires({})].sort(), ["database", "objectStorage", "redis"]);
  assert.deepEqual([...readinessRequires({ FLOWPLAN_READY_REQUIRE: "database, objectStorage" })], ["database", "objectStorage"]);
  const live = await (await import("../app/api/health/live/route")).GET();
  assert.equal(live.status, 200);
  const { GET: ready } = await import("../app/api/health/ready/route");
  const answer = await ready(new Request("http://localhost/api/health/ready"));
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { service: "flowplan", status: "ok", checks: { database: "ok" } });
  // Stopping: open live streams are closed, readiness says so.
  const { onShutdown, stopInstance } = await import("../lib/cluster/runtime");
  let closed = 0;
  onShutdown(() => closed++);
  await stopInstance("test");
  assert.equal(closed, 1);
  const stopping = await ready(new Request("http://localhost/api/health/ready"));
  assert.equal(stopping.status, 503);
  assert.equal((await stopping.json()).status, "stopping");
});

test("the Redis protocol: commands out, replies in – also split across packets", () => {
  assert.equal(encodeCommand(["SET", "k", "vä"]).toString(), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\nvä\r\n");
  const reply = Buffer.from("*4\r\n+OK\r\n:42\r\n$-1\r\n$5\r\nhällo\r\n".replace("$5", `$${Buffer.byteLength("hällo")}`));
  assert.deepEqual(parseReply(reply)?.value, ["OK", 42, null, "hällo"]);
  // Incomplete: nothing yet, whatever the cut.
  for (let cut = 1; cut < reply.length; cut++) assert.equal(parseReply(reply.subarray(0, cut)), null, `cut at ${cut}`);
  const error = parseReply(Buffer.from("-ERR wrong\r\n"))!.value;
  assert.ok(error instanceof Error && error.message === "ERR wrong");
  assert.deepEqual(parseRedisUrl("rediss://user:p%40ss@cache.example:6380/2"), { host: "cache.example", port: 6380, tls: true, username: "user", password: "p@ss", db: 2 });
  assert.throws(() => parseRedisUrl("http://x"), /redis:\/\//);
});

test("the Redis client: commands, pub/sub, and a reconnect after the connection drops", async () => {
  const client = new RedisClient(redisUrl);
  const subscriber = new RedisClient(redisUrl, { subscriber: true });
  try {
    assert.equal(await client.command("PING"), "PONG");
    const key = `flowplan-test:${randomBytes(4).toString("hex")}`;
    assert.equal(await client.command("HSET", key, "a", "1"), 1);
    assert.deepEqual(await client.command("HGETALL", key), ["a", "1"]);
    await client.command("HDEL", key, "a");
    const received: string[] = [];
    await subscriber.subscribe(`${key}:channel`, (message) => received.push(message));
    for (let i = 0; i < 50 && (await client.command("PUBLISH", `${key}:channel`, "hello")) === 0; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received.slice(0, 1), ["hello"]);
    if (fake) {
      // Connections drop (a Redis restart): commands work again, the
      // subscriber subscribes again.
      fake.dropConnections();
      let pong: unknown = null;
      for (let i = 0; i < 100 && pong !== "PONG"; i++) pong = await client.command("PING").catch(() => null);
      assert.equal(pong, "PONG");
      received.length = 0;
      for (let i = 0; i < 100 && !received.length; i++) {
        await client.command("PUBLISH", `${key}:channel`, "again").catch(() => 0);
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(received.includes("again"), "resubscribed after the drop");
    }
  } finally {
    await client.close();
    await subscriber.close();
  }
});

/* ---------- Several instances (child processes) ---------- */

type Instance = {
  child: ChildProcessWithoutNullStreams;
  messages: Record<string, unknown>[];
  leader: boolean;
  send: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
  waitFor: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
};
const instances: Instance[] = [];
after(() => {
  for (const i of instances) i.child.kill("SIGKILL");
});
const prefix = `flowplan-test-${randomBytes(4).toString("hex")}:`;
let requests = 0;
function startInstance(name: string): Instance {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/cluster-instance.ts"], {
    env: {
      ...process.env,
      FLOWPLAN_CLUSTER: "1",
      REDIS_URL: redisUrl,
      FLOWPLAN_REDIS_PREFIX: prefix,
      FLOWPLAN_INSTANCE_ID: name,
      FLOWPLAN_LEADER_INTERVAL: "300",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const instance: Instance = {
    child,
    messages: [],
    leader: false,
    send: async (command) => {
      const id = ++requests;
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      return instance.waitFor((m) => m.id === id);
    },
    waitFor: (pred, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const found = instance.messages.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`${name}: timed out; got ${JSON.stringify(instance.messages.slice(-5))}`)), ms);
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
      const message = JSON.parse(line);
      if (typeof message.leader === "boolean") instance.leader = message.leader;
      instance.messages.push(message);
      child.stdout.emit("line");
    } catch {}
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    if (!/ExperimentalWarning|trace-warnings/.test(text)) process.stderr.write(`[${name}] ${text}`);
  });
  instances.push(instance);
  return instance;
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function oneLeader(list: Instance[], ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const leaders = list.filter((i) => i.leader);
    if (leaders.length === 1) {
      // Still one a little later (no second one coming up).
      await settle(700);
      if (list.filter((i) => i.leader).length === 1) return list.find((i) => i.leader)!;
    }
    await settle(100);
  }
  throw new Error(`no single leader: ${list.map((i) => i.leader).join(",")}`);
}

const needsPostgres = !onPostgres && "needs DATABASE_URL=postgres://… (the leader lock is a PostgreSQL advisory lock)";

test("two instances: one leader, heartbeats of both, live updates and rate limits across them, failover", { skip: needsPostgres, timeout: 90_000 }, async () => {
  const a = startInstance("instance-a");
  const b = startInstance("instance-b");
  const leader = await oneLeader([a, b]);
  const follower = leader === a ? b : a;

  // Heartbeats: each sees both.
  let seen: string[] = [];
  for (let i = 0; i < 50 && seen.length < 2; i++) {
    seen = ((await a.send({ op: "instances" })).instances as { id: string }[]).map((x) => x.id).sort();
    if (seen.length < 2) await settle(200);
  }
  assert.deepEqual(seen, ["instance-a", "instance-b"]);

  // A document update stored through one instance reaches an editor
  // connected to the other (server-sent event of its hub).
  const key = `page-${randomBytes(3).toString("hex")}::gen`;
  await b.send({ op: "watch", key });
  await b.waitFor((m) => typeof m.event === "string" && (m.event as string).includes('"ready"'));
  await settle(200);
  await a.send({ op: "publish", key, update: "AAEC" });
  const event = await b.waitFor((m) => typeof m.event === "string" && (m.event as string).includes("AAEC"));
  assert.match(event.event as string, /"type":"update","update":"AAEC"/);

  // A limit of 6 per minute holds across both: at most one more (the
  // action of the second instance in flight when it learns of it).
  const limitKey = `test-limit-${randomBytes(3).toString("hex")}`;
  let allowed = 0;
  for (let i = 0; i < 6; i++) allowed += (await a.send({ op: "allow", key: limitKey, max: 6, window: 60_000 })).allowed ? 1 : 0;
  assert.equal(allowed, 6);
  await settle(200);
  for (let i = 0; i < 6; i++) allowed += (await b.send({ op: "allow", key: limitKey, max: 6, window: 60_000 })).allowed ? 1 : 0;
  assert.ok(allowed <= 7, `allowed ${allowed} of 12 (limit 6)`);
  assert.ok(allowed >= 6);

  // The leader stops gracefully: the other takes over within a round.
  const started = Date.now();
  await leader.send({ op: "stop" });
  await follower.waitFor((m) => m.leader === true, 10_000);
  assert.ok(Date.now() - started < 5000, `took over after ${Date.now() - started} ms`);

  // A third instance joins; the new leader is killed outright (no
  // goodbye): PostgreSQL frees the lock with its connection, and the third
  // takes over.
  const c = startInstance("instance-c");
  await settle(1500);
  assert.equal(c.leader, false, "the lock is held");
  follower.child.kill("SIGKILL");
  await c.waitFor((m) => m.leader === true, 15_000);
  await c.send({ op: "stop" });
});
