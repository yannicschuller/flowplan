// Starts the production build like the Docker image does (`node server.js`
// in the standalone output) with an empty data directory and the load-test
// measurements on, for scripts/loadtest/run.mjs. Needs `npm run build`.
//
//   node scripts/loadtest/serve.mjs --work /tmp/lt --port 3497 [--cpu-prof] [--processes 4]
//
// --processes n (or "auto"): n processes behind the port (FLOWPLAN_PROCESSES,
// scripts/processes.mjs, #383 wave 5); server.pid is then the supervisor's
// pid and run.mjs --pid counts its child processes too.
// --data-from <dir>: the data directory starts as a copy of <dir> (a seeded
// instance kept aside, so interleaved runs start from the same state).
//
// Writes <work>/server.pid; stops the server on SIGINT/SIGTERM. The data
// directory is <work>/data – delete <work> afterwards.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    work: { type: "string" },
    port: { type: "string", default: "3497" },
    "metrics-token": { type: "string", default: "loadtest-metrics-token-0123456789" },
    "cpu-prof": { type: "boolean", default: false },
    fresh: { type: "boolean", default: true },
    processes: { type: "string", default: "1" },
    balance: { type: "string", default: "" },
    "data-from": { type: "string", default: "" },
  },
});
if (!opt.work) throw new Error("--work <directory> is required");
const root = process.cwd();
const standalone = join(root, ".next/standalone");
if (!existsSync(join(standalone, "server.js"))) throw new Error("No standalone build – run `npm run build` first.");
const work = resolve(opt.work),
  app = join(work, "app"),
  data = join(work, "data");
if (opt.fresh) rmSync(work, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
if (opt["data-from"]) {
  rmSync(data, { recursive: true, force: true });
  cpSync(resolve(opt["data-from"]), data, { recursive: true });
}
if (!existsSync(app)) {
  mkdirSync(app);
  // Like the image: server.js with .next/static and public next to it; the
  // traced node_modules are only read, a link is enough.
  for (const entry of readdirSync(standalone))
    if (entry === "node_modules") symlinkSync(join(standalone, entry), join(app, entry), "dir");
    else cpSync(join(standalone, entry), join(app, entry), { recursive: true });
  for (const dir of [".next/static", "public"]) {
    rmSync(join(app, dir), { recursive: true, force: true });
    symlinkSync(join(root, dir), join(app, dir), "dir");
  }
}
const origin = `http://127.0.0.1:${opt.port}`;
const several = opt.processes !== "1";
const main = several ? [join(root, "scripts/processes.mjs"), "server.js"] : ["server.js"];
const args = opt["cpu-prof"] ? ["--cpu-prof", `--cpu-prof-dir=${join(work, "profiles")}`, ...main] : main;
const child = spawn(process.execPath, args, {
  cwd: app,
  env: {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: opt.port,
    HOSTNAME: "127.0.0.1",
    FLOWPLAN_DATA_DIR: data,
    APP_URL: origin,
    FLOWPLAN_METRICS_TOKEN: opt["metrics-token"],
    FLOWPLAN_METRICS_LOOP: "1",
    ...(several ? { FLOWPLAN_PROCESSES: opt.processes } : {}),
    ...(opt.balance ? { FLOWPLAN_PROCESS_BALANCE: opt.balance } : {}),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(join(work, "server.pid"), String(child.pid));
console.log(`server pid ${child.pid} on ${origin}, data ${data}`);
const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code, signal) => {
  console.log(`server exited (${code ?? signal})`);
  process.exit(0);
});
