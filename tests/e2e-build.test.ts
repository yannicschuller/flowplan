// The browser specs' build takes the demo sign-in (lib/e2e-build.ts); an
// image must never be that build. The build itself is checked by
// check:standalone (403 with both variables set at runtime, the constant
// compiled in as ""); here the places that keep the switch out of images.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(file, "utf8");

test("the Dockerfile builds with FLOWPLAN_E2E_BUILD emptied and never takes it as an argument", () => {
  const dockerfile = read("Dockerfile");
  const builds = dockerfile.split("\n").filter((line) => /\bnpm run build\b/.test(line));
  assert.ok(builds.length > 0);
  for (const line of builds) assert.match(line, /\sFLOWPLAN_E2E_BUILD= npm run build\b/);
  assert.doesNotMatch(dockerfile, /^\s*(ARG|ENV)\s+FLOWPLAN_E2E_/m);
});

test("the image and release workflows never mention the switch", () => {
  for (const file of [".github/workflows/docker.yml", ".github/workflows/release.yml", "render.yaml", "compose.yaml"]) {
    let text = "";
    try {
      text = read(file);
    } catch {
      continue;
    }
    assert.doesNotMatch(text, /FLOWPLAN_E2E_/, file);
  }
});

test("next.config.ts refuses the switch in an image build (FLOWPLAN_CHANNEL)", () => {
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'const c = (await import("./next.config.ts")).default; console.log(JSON.stringify(c.default?.env ?? c.env));'], {
      encoding: "utf8",
      env: { ...process.env, FLOWPLAN_E2E_BUILD: "", FLOWPLAN_CHANNEL: "", GIT_COMMIT: "test", ...env },
    });
  const refused = load({ FLOWPLAN_E2E_BUILD: "1", FLOWPLAN_CHANNEL: "release" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /FLOWPLAN_E2E_BUILD=1 is for the browser specs' build only/);
  // Without the switch the constant is still defined, as "": the server's
  // code holds the literal, not a lookup at runtime.
  const normal = load({ FLOWPLAN_CHANNEL: "release" });
  assert.equal(normal.status, 0, normal.stderr);
  assert.equal(JSON.parse(normal.stdout.trim().split("\n").at(-1)!).FLOWPLAN_E2E_BUILD, "");
  const specs = load({ FLOWPLAN_E2E_BUILD: "1" });
  assert.equal(specs.status, 0, specs.stderr);
  assert.equal(JSON.parse(specs.stdout.trim().split("\n").at(-1)!).FLOWPLAN_E2E_BUILD, "1");
});

test("the demo sign-in outside production as before; in production only with both halves", async () => {
  const { demoSignInAllowed } = await import("../lib/e2e-build");
  const env = process.env as Record<string, string | undefined>;
  const before = { NODE_ENV: env.NODE_ENV, FLOWPLAN_E2E_DEMO: env.FLOWPLAN_E2E_DEMO };
  try {
    env.NODE_ENV = "development";
    delete env.FLOWPLAN_E2E_DEMO;
    assert.equal(demoSignInAllowed(), true);
    // Under tsx nothing is compiled in: the module was loaded without
    // FLOWPLAN_E2E_BUILD=1, like a normal build.
    env.NODE_ENV = "production";
    env.FLOWPLAN_E2E_DEMO = "1";
    assert.equal(demoSignInAllowed(), false);
  } finally {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete env[key];
      else env[key] = value;
  }
});
