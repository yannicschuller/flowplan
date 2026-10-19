// The Helm chart (deploy/helm/flowplan): deploys the current release and
// never runs two pods on one SQLite database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chart = readFileSync("deploy/helm/flowplan/Chart.yaml", "utf8");
const deployment = readFileSync("deploy/helm/flowplan/templates/deployment.yaml", "utf8");

test("the chart's appVersion is the app's version (the default image tag)", () => {
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  assert.equal(chart.match(/^appVersion:\s*"?([^"\n]+)"?$/m)?.[1], version);
});

test("exactly one replica, replaced with Recreate, probes on /api/health", () => {
  assert.match(deployment, /^\s*replicas: 1$/m);
  assert.doesNotMatch(deployment, /replicas:\s*\{\{/, "replicas are not configurable");
  assert.match(deployment, /strategy:\s*\n\s*type: Recreate/);
  assert.equal(deployment.match(/path: \/api\/health/g)?.length, 3);
  assert.match(deployment, /mountPath: \/app\/data/);
});
