// The production build for the browser specs (tests/browser): `next build`
// with FLOWPLAN_E2E_BUILD=1, so its server takes the demo sign-in the specs
// use (lib/e2e-build.ts), into .next-e2e – a normal build in .next stays as
// it is. The standalone server gets its static files and public/ next to
// itself, as in the Docker image, so .next-e2e/standalone runs on its own
// (playwright.config.ts with TEST_SERVERS, scripts/e2e-server.mjs).
// Usage: node scripts/build-e2e.mjs
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
export const distDir = ".next-e2e";

if (process.env.FLOWPLAN_CHANNEL) {
  console.error("FLOWPLAN_CHANNEL is set: this is an image build, not the browser specs' build.");
  process.exit(1);
}
// `next build` writes its distDir into these two; they stay as checked in.
const kept = ["next-env.d.ts", "tsconfig.json"].map((file) => [file, readFileSync(join(root, file), "utf8")]);
let status = 1;
try {
  const result = spawnSync(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      FLOWPLAN_E2E_BUILD: "1",
      FLOWPLAN_DIST_DIR: distDir,
    },
  });
  status = result.status ?? 1;
} finally {
  for (const [file, text] of kept) writeFileSync(join(root, file), text);
}
if (status !== 0) process.exit(status);

const standalone = join(root, distDir, "standalone");
for (const [from, to] of [
  [join(root, distDir, "static"), join(standalone, distDir, "static")],
  [join(root, "public"), join(standalone, "public")],
]) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}
console.log(`Browser specs' build in ${join(distDir, "standalone")}.`);
