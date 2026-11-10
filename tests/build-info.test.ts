// The version line at the top of the server log (instrumentation.ts, #194).
import { test } from "node:test";
import assert from "node:assert/strict";
import { versionLine, type BuildInfo } from "../lib/build-info";

const build: BuildInfo = {
  version: "0.9.3",
  commit: "abc1234def5678abc1234def5678abc1234def56",
  builtAt: "2026-11-10T09:00:00.000Z",
  node: "v26.1.0",
  repository: "https://github.com/yannicschuller/flowplan",
};

test("the version line names version, channel, commit, build time and Node.js", () => {
  assert.equal(versionLine(build, "beta"), "Flowplan 0.9.3 (beta, build abc1234, built 2026-11-10T09:00:00.000Z, Node.js v26.1.0)");
  assert.equal(versionLine(build, " Release "), "Flowplan 0.9.3 (release, build abc1234, built 2026-11-10T09:00:00.000Z, Node.js v26.1.0)");
});

test("the version line leaves out what the build does not know", () => {
  assert.equal(versionLine({ ...build, commit: "", builtAt: "" }, ""), "Flowplan 0.9.3 (Node.js v26.1.0)");
  assert.equal(versionLine({ ...build, commit: "", builtAt: "", node: "" }, "nightly"), "Flowplan 0.9.3");
  assert.equal(versionLine({ ...build, version: "", commit: "", builtAt: "", node: "" }, ""), "Flowplan (version unknown)");
});
