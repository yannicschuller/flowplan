// Starts the production build like the Docker image does (`node server.js`
// in the standalone output) with an empty data directory and the load-test
// measurements on, for scripts/loadtest/run.mjs. Needs `npm run build`.
//
//   node scripts/loadtest/serve.mjs --work /tmp/lt --port 3497 [--cpu-prof]
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
const args = opt["cpu-prof"] ? ["--cpu-prof", `--cpu-prof-dir=${join(work, "profiles")}`, "server.js"] : ["server.js"];
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
