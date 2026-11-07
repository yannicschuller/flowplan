// Load test of cluster mode for the sizing guide (docs/architecture/
// database.md §14): how many concurrent active people 1 and 2 instances
// serve against one PostgreSQL, with Redis between them. For each instance
// count it starts a fresh schema, the instances (the standalone build,
// FLOWPLAN_CLUSTER=1), a round-robin balancer in front
// (scripts/loadtest/balancer.mjs), an S3 stand-in, seeds through the
// balancer (scripts/loadtest/seed.mjs --database), ramps virtual users with
// scripts/loadtest/run.mjs and reports the knee (read p95 > 500 ms, write
// p95 > 1 s or errors > 1 %, scripts/loadtest/README.md).
//
//   npm run build
//   DATABASE_URL=postgres://… REDIS_URL=redis://… node scripts/load-test-cluster.mjs \
//     --instances 1,2 --steps 10,20,30,40,50,60,80 --duration 45 --out /tmp/lt-cluster.json
//
// Never against a database or Redis with real data: it creates and drops
// its own schema (flowplan_lt_*), and uses its own Redis key prefix.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";

const { values: opt } = parseArgs({
  options: {
    instances: { type: "string", default: "1,2" },
    steps: { type: "string", default: "10,20,30,40,50,60,80" },
    duration: { type: "string", default: "45" },
    settle: { type: "string", default: "5" },
    users: { type: "string", default: "200" },
    docs: { type: "string", default: "120" },
    records: { type: "string", default: "2000" },
    pool: { type: "string", default: "20" },
    workers: { type: "string", default: "2" },
    port: { type: "string", default: "3600" },
    out: { type: "string", default: "load-test-cluster.json" },
    work: { type: "string", default: join(tmpdir(), "flowplan-lt-cluster") },
    "keep-going": { type: "boolean", default: false },
    // CPUs to pin the instances to, one per instance (taskset), e.g. "0,1":
    // each instance gets one core of its own, so the instance count is what
    // changes – not how much of a shared machine the instances happen to get.
    pin: { type: "string", default: "" },
  },
});
const databaseUrl = process.env.DATABASE_URL || "";
const redisUrl = process.env.REDIS_URL || "";
if (!/^postgres(ql)?:\/\//.test(databaseUrl) || !/^rediss?:\/\//.test(redisUrl)) {
  console.error("DATABASE_URL=postgres://… and REDIS_URL=redis://… are needed.");
  process.exit(2);
}
const root = process.cwd();
const standalone = join(root, ".next/standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("No standalone build – run `npm run build` first.");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metricsToken = "loadtest-metrics-token-0123456789";
const children = new Set();
const stopAll = () => {
  for (const child of children) child.kill("SIGINT");
};
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

// --- S3 stand-in: keeps objects in memory, answers listings ----------------
function startS3() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = decodeURIComponent(new URL(req.url, "http://s3").pathname);
      if (req.method === "PUT") {
        objects.set(path, Buffer.concat(chunks));
        res.writeHead(200).end();
      } else if (req.method === "GET" && objects.has(path)) res.writeHead(200).end(objects.get(path));
      else if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204).end();
      } else if (req.method === "GET" && /\?|list-type/.test(req.url)) res.writeHead(200, { "content-type": "application/xml" }).end("<ListBucketResult></ListBucketResult>");
      else res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function app(dir) {
  // As scripts/loadtest/serve.mjs: server.js with static files next to it.
  if (existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(standalone))
    if (entry === "node_modules") symlinkSync(join(standalone, entry), join(dir, entry), "dir");
    else cpSync(join(standalone, entry), join(dir, entry), { recursive: true });
  for (const sub of [".next/static", "public"]) {
    rmSync(join(dir, sub), { recursive: true, force: true });
    symlinkSync(join(root, sub), join(dir, sub), "dir");
  }
  return dir;
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`))));
  });
}
async function waitReady(url, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`${url} not ready`);
}

async function measure(count, s3) {
  const schema = `flowplan_lt_${count}_${process.pid}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await run(process.execPath, ["scripts/db-schema.mjs"], { FLOWPLAN_PG_SCHEMA: schema });
  const work = resolve(opt.work);
  const port = Number(opt.port);
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    APP_URL: origin,
    FLOWPLAN_CLUSTER: "1",
    FLOWPLAN_PG_SCHEMA: schema,
    FLOWPLAN_PG_POOL: opt.pool,
    FLOWPLAN_PG_SCHEMA_AUTO: "off",
    REDIS_URL: redisUrl,
    FLOWPLAN_REDIS_PREFIX: `flowplan-lt-${process.pid}-${count}:`,
    S3_ENDPOINT: s3.url,
    S3_BUCKET: "loadtest",
    S3_ACCESS_KEY_ID: "loadtest",
    S3_SECRET_ACCESS_KEY: "loadtest",
    FLOWPLAN_METRICS_TOKEN: metricsToken,
    FLOWPLAN_METRICS_LOOP: "1",
    FLOWPLAN_TRUSTED_PROXIES: "1",
  };
  const servers = [];
  for (let i = 1; i <= count; i++) {
    const dir = app(join(work, `app-${i}`));
    const cpu = opt.pin ? opt.pin.split(",")[(i - 1) % opt.pin.split(",").length] : null;
    const child = spawn(cpu !== null ? "taskset" : process.execPath, cpu !== null ? ["-c", cpu, process.execPath, "server.js"] : ["server.js"], {
      cwd: dir,
      env: { ...process.env, ...env, PORT: String(port + i), FLOWPLAN_DATA_DIR: join(work, `data-${count}-${i}`), FLOWPLAN_INSTANCE_ID: `lt-${i}` },
      stdio: ["ignore", "ignore", "inherit"],
    });
    children.add(child);
    servers.push(child);
  }
  for (let i = 1; i <= count; i++) await waitReady(`http://127.0.0.1:${port + i}/api/health/ready`);
  const balancer = spawn(process.execPath, ["scripts/loadtest/balancer.mjs", "--port", String(port), "--to", servers.map((_, i) => `127.0.0.1:${port + i + 1}`).join(",")], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.add(balancer);
  await waitReady(`${origin}/api/health/live`);
  const seedFile = join(work, `seed-${count}.json`);
  await run(process.execPath, ["scripts/loadtest/seed.mjs", "--url", origin, "--database", databaseUrl, "--schema", schema, "--users", opt.users, "--docs", opt.docs, "--records", opt.records, "--out", seedFile]);
  const resultFile = join(work, `result-${count}.json`);
  await run(process.execPath, [
    "scripts/loadtest/run.mjs",
    "--seed",
    seedFile,
    "--steps",
    opt.steps,
    "--duration",
    opt.duration,
    "--settle",
    opt.settle,
    "--workers",
    opt.workers,
    "--label",
    `${count} instance${count > 1 ? "s" : ""}`,
    "--out",
    resultFile,
  ]);
  for (const child of [balancer, ...servers]) {
    child.kill("SIGINT");
    children.delete(child);
  }
  await sleep(2000);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

// The knee (scripts/loadtest/README.md): the first step with read p95 above
// 500 ms, write p95 above 1 s or more than 1 % errors; the step before it is
// what the setup serves.
function knee(result) {
  const steps = result.steps || [];
  let served = 0;
  for (const step of steps) {
    const read = step.reads?.p95 ?? 0;
    const write = step.writes?.p95 ?? 0;
    const errorShare = step.errorRate ?? 0;
    if (read > 500 || write > 1000 || errorShare > 0.01) return { served, kneeAt: step.vus, read, write, errorShare };
    served = step.vus;
  }
  return { served, kneeAt: null };
}

const s3 = await startS3();
const counts = opt.instances.split(",").map(Number);
const report = { at: new Date().toISOString(), machine: { cpus: cpus().length, model: cpus()[0]?.model, load: loadavg() }, options: opt, runs: [] };
for (const count of counts) {
  console.log(`\n=== ${count} instance(s) ===`);
  try {
    const result = await measure(count, s3);
    report.runs.push({ instances: count, knee: knee(result), result });
    console.log(`→ ${count} instance(s): ${JSON.stringify(knee(result))}`);
  } catch (error) {
    console.error(error);
    if (!opt["keep-going"]) break;
  }
}
s3.server.close();
writeFileSync(opt.out, JSON.stringify(report, null, 1));
console.log(`\nwritten to ${opt.out}`);
for (const r of report.runs) console.log(`${r.instances} instance(s): serves ${r.knee.served} VUs; knee at ${r.knee.kneeAt ?? "not reached"}`);
rmSync(resolve(opt.work), { recursive: true, force: true });
process.exit(0);
