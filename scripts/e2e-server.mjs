// One server of the browser specs' build (scripts/build-e2e.mjs) on an
// empty data directory: playwright.config.ts starts one per worker with
// TEST_SERVERS=n (PORT, FLOWPLAN_DATA_DIR and APP_URL from there). Its log
// goes to a file next to the data directory (<data dir>.log), for CI to show
// when a spec failed.
// Usage: PORT=3800 FLOWPLAN_DATA_DIR=/tmp/flowplan-inline-e2e.x node scripts/e2e-server.mjs
// FLOWPLAN_PROCESSES=3 runs it as three processes behind the port
// (scripts/processes.mjs), as the image does with that setting.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const app = join(root, ".next-e2e/standalone");
const data = process.env.FLOWPLAN_DATA_DIR;
const port = process.env.PORT;
if (!data || !port) {
  console.error("PORT and FLOWPLAN_DATA_DIR are required.");
  process.exit(2);
}
if (!existsSync(join(app, "server.js"))) {
  console.error("No build for the browser specs – run `node scripts/build-e2e.mjs` first.");
  process.exit(2);
}
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
const log = openSync(`${data}.log`, "w");
const origin = `http://127.0.0.1:${port}`;
const several = !["", "1"].includes(String(process.env.FLOWPLAN_PROCESSES ?? "").trim());
const child = spawn(process.execPath, several ? [join(root, "scripts/processes.mjs"), "server.js"] : ["server.js"], {
  cwd: app,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: port,
    APP_URL: process.env.APP_URL || origin,
    FLOWPLAN_DATA_DIR: data,
    NEXT_TELEMETRY_DISABLED: "1",
    // The runtime half of the demo sign-in's switch (lib/e2e-build.ts).
    FLOWPLAN_E2E_DEMO: "1",
    // The BookStack import's spec asks a mock on 127.0.0.1 (#329).
    FLOWPLAN_IMPORT_ALLOW_PRIVATE: "true",
  },
  stdio: ["ignore", log, log],
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
