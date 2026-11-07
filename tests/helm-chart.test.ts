// The Helm chart (deploy/helm/flowplan): deploys the current release and
// never runs two pods on one SQLite database – several pods only in cluster
// mode (PostgreSQL, Redis, S3; docs/architecture/database.md §14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chart = readFileSync("deploy/helm/flowplan/Chart.yaml", "utf8");
const deployment = readFileSync("deploy/helm/flowplan/templates/deployment.yaml", "utf8");

test("the chart's appVersion is the app's version (the default image tag)", () => {
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  assert.equal(chart.match(/^appVersion:\s*"?([^"\n]+)"?$/m)?.[1], version);
});

// The replica/strategy block: the cluster branch and the single-pod one.
const replicaBlock = deployment.slice(deployment.indexOf("{{- if .Values.cluster.enabled }}"), deployment.indexOf("{{- end }}", deployment.indexOf("type: Recreate")));
const [clusterBranch, singleBranch] = replicaBlock.split("{{- else }}");

test("by default exactly one replica, replaced with Recreate, probes on /api/health", () => {
  assert.match(singleBranch, /^\s*replicas: 1$/m);
  assert.match(singleBranch, /strategy:\s*\n\s*type: Recreate/);
  // Replicas are configurable only in cluster mode.
  assert.equal(deployment.match(/replicas:\s*\{\{/g)?.length, 1);
  assert.match(clusterBranch, /replicas: \{\{ \.Values\.cluster\.replicas \}\}/);
  assert.match(clusterBranch, /type: RollingUpdate/);
  for (const probe of ["startupProbe", "livenessProbe", "readinessProbe"])
    assert.match(deployment, new RegExp(`${probe}:\\s*\\n\\s*httpGet:\\s*\\n\\s*path: \\{\\{ ternary "/api/health/(live|ready)" "/api/health" \\.Values\\.cluster\\.enabled \\}\\}`));
  assert.match(deployment, /mountPath: \/app\/data/);
  const values = readFileSync("deploy/helm/flowplan/values.yaml", "utf8");
  assert.match(values, /^cluster:\n {2}enabled: false$/m);
});

test("cluster mode: connection strings only as Secret references, refused without database, Redis or bucket", () => {
  const helpers = readFileSync("deploy/helm/flowplan/templates/_helpers.tpl", "utf8");
  const values = readFileSync("deploy/helm/flowplan/values.yaml", "utf8");
  assert.doesNotMatch(values, /postgres:\/\/[^…]*@|redis:\/\/:[^…]/, "no connection string with credentials in values");
  for (const name of ["DATABASE_URL", "REDIS_URL"]) assert.match(helpers, new RegExp(`- name: ${name}\\n {2}valueFrom:\\n {4}secretKeyRef:`));
  for (const required of ["cluster.database.existingSecret", "cluster.redis.existingSecret", "s3.bucket"]) assert.match(helpers, new RegExp(`fail "cluster\\.enabled: set ${required.replace(/\./g, "\\.")}`));
  assert.match(deployment, /include "flowplan.clusterCheck"/);
  // No PVC in cluster mode; the schema Job runs before install and upgrade.
  assert.match(readFileSync("deploy/helm/flowplan/templates/pvc.yaml", "utf8"), /\(not \.Values\.cluster\.enabled\)/);
  const job = readFileSync("deploy/helm/flowplan/templates/job-migration.yaml", "utf8");
  assert.match(job, /"helm.sh\/hook": pre-install,pre-upgrade/);
  assert.match(job, /command: \["node", "\/app\/db-schema.mjs"\]/);
  assert.match(readFileSync("Dockerfile", "utf8"), /COPY --chmod=644 scripts\/db-migrate.mjs scripts\/db-search-rebuild.mjs scripts\/db-schema.mjs \/app\/scripts\//);
});

test("the chart sets FLOWPLAN_SETUP_TOKEN: given, kept from the Secret or generated", () => {
  const helpers = readFileSync("deploy/helm/flowplan/templates/_helpers.tpl", "utf8");
  const values = readFileSync("deploy/helm/flowplan/values.yaml", "utf8");
  assert.match(values, /^setupToken: ""$/m);
  assert.match(helpers, /"FLOWPLAN_SETUP_TOKEN" \(include "flowplan.setupToken" \.\)/);
  // An upgrade keeps the token of the existing Secret instead of a new one.
  assert.match(helpers, /lookup "v1" "Secret"/);
  assert.match(helpers, /randAlphaNum 40/);
  assert.match(helpers, /hasSecretEnv[\s\S]*\.Values\.localLogin/);
});
