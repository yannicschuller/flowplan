// The Helm chart (deploy/helm/flowplan): deploys the current release and
// never runs two pods on one SQLite database – several pods only in cluster
// mode (PostgreSQL, Redis, S3; docs/architecture/database.md §14). These are
// checks of the chart's sources; the chart itself is linted, rendered with
// both examples and validated by .github/workflows/helm.yml (helm,
// kubeconform).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const dir = "deploy/helm/flowplan";
const read = (path: string) => readFileSync(`${dir}/${path}`, "utf8");
const chart = read("Chart.yaml");
const deployment = read("templates/deployment.yaml");
const helpers = read("templates/_helpers.tpl");
const values = read("values.yaml");

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
  assert.match(values, /^cluster:\n {2}enabled: false$/m);
});

test("cluster mode: connection strings and shared keys only as Secret references, refused without database, Redis, bucket or keys", () => {
  assert.doesNotMatch(values, /postgres:\/\/[^<…]*@|redis:\/\/:[^<…]/, "no connection string with credentials in values");
  for (const name of ["DATABASE_URL", "REDIS_URL", "FLOWPLAN_ENCRYPTION_KEY", "WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY", "DATABASE_SESSION_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])
    assert.match(helpers, new RegExp(`- name: ${name}\\n {2}valueFrom:\\n {4}secretKeyRef:`), name);
  for (const required of ["cluster.database.existingSecret", "cluster.redis.existingSecret", "s3.bucket", "cluster.keys.existingSecret"]) assert.match(helpers, new RegExp(`fail "cluster\\.enabled: set ${required.replace(/\./g, "\\.")}`));
  assert.match(deployment, /include "flowplan.check"/);
  // No PVC in cluster mode; the schema Job runs before install and upgrade.
  assert.match(read("templates/pvc.yaml"), /\(not \.Values\.cluster\.enabled\)/);
  const job = read("templates/job-migration.yaml");
  assert.match(job, /"helm.sh\/hook": pre-install,pre-upgrade/);
  assert.match(job, /command: \["node", "\/app\/scripts\/db-schema.mjs"\]/);
  assert.match(readFileSync("Dockerfile", "utf8"), /COPY --chmod=644 scripts\/db-migrate.mjs scripts\/db-search-rebuild.mjs scripts\/db-schema.mjs \/app\/scripts\//);
});

test("no secret is a value of the chart: every password, key and token is a reference", () => {
  const plain = values.replace(/^\s*#.*\n/gm, "");
  for (const key of [/^encryptionKey:/m, /^setupToken: "/m, /^\s+clientSecret:/m, /^\s+password:/m, /^\s+accessKeyId:/m, /^\s+secretAccessKey:/m]) assert.doesNotMatch(plain, key, String(key));
  assert.doesNotMatch(helpers, /secretEnv|\.Values\.oidc\.clientSecret|\.Values\.smtp\.password/);
  // The schema refuses the old value keys instead of ignoring them.
  const schema = JSON.parse(read("values.schema.json"));
  assert.equal(schema.properties.oidc.additionalProperties, false);
  assert.equal(schema.properties.s3.additionalProperties, false);
  assert.equal(schema.additionalProperties, false);
});

test("the setup token: a Secret of yours, or one the chart generates once and keeps – not in the pods' checksum", () => {
  assert.match(values, /^setupToken:\n(?: {2}#.*\n)* {2}existingSecret: ""\n {2}key: FLOWPLAN_SETUP_TOKEN$/m);
  // An upgrade keeps the token of the existing Secret instead of a new one.
  assert.match(helpers, /lookup "v1" "Secret" \.Release\.Namespace \(include "flowplan.setupTokenSecret" \.\)/);
  assert.match(helpers, /randAlphaNum 40/);
  const secret = read("templates/secret.yaml");
  assert.match(secret, /helm.sh\/resource-policy: keep/);
  assert.doesNotMatch(deployment, /checksum\/secret/);
  assert.match(deployment, /- name: FLOWPLAN_SETUP_TOKEN\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: \{\{ include "flowplan.setupTokenSecret" \. \}\}/);
});

test("the schema Job and the test pod are no Flowplan servers: no selector labels, so neither Service nor PodDisruptionBudget counts them", () => {
  const job = read("templates/job-migration.yaml");
  const probe = read("templates/tests/test-health.yaml");
  for (const [name, text] of [["job", job], ["test", probe]] as const) {
    assert.doesNotMatch(text, /flowplan\.selectorLabels|flowplan\.labels"/, name);
    assert.match(text, /flowplan\.otherPodLabels/, name);
  }
  assert.match(helpers, /define "flowplan.otherPodLabels"[\s\S]*?app.kubernetes.io\/name: \{\{ printf "%s-%s"/);
  // The Job gets the whole database configuration and leaves the pods'
  // own check (the advisory lock) on.
  assert.match(job, /include "flowplan.databaseEnv"/);
  assert.match(helpers, /define "flowplan.databaseEnv"[\s\S]*DATABASE_SESSION_URL[\s\S]*FLOWPLAN_PG_SCHEMA/);
  assert.doesNotMatch(helpers + deployment + job, /FLOWPLAN_PG_SCHEMA_AUTO/);
});

test("Kubernetes defaults: read-only root, scratch volumes, resources of the sizing guide, readiness without Redis, SSE-friendly ingress, graceful stop", () => {
  assert.match(values, /readOnlyRootFilesystem: true/);
  for (const path of ["/tmp", "/app/.next/cache", "/home/node"]) assert.match(deployment, new RegExp(`mountPath: ${path.replace(/\//g, "\\/").replace(/\./g, "\\.")}\\n`));
  assert.match(values, /resources:\n {2}requests:\n {4}cpu: "1"\n {4}memory: 2Gi\n {2}limits:\n {4}memory: 4Gi/);
  assert.match(values, /readyRequire: database,objectStorage/);
  assert.match(helpers, /- name: FLOWPLAN_READY_REQUIRE\n {2}value: \{\{ \.Values\.cluster\.readyRequire \| quote \}\}/);
  const ingress = read("templates/ingress.yaml");
  for (const annotation of ["proxy-buffering\" \"off\"", "proxy-read-timeout\" \"3600\"", "proxy-send-timeout\" \"3600\"", "proxy-body-size"]) assert.ok(ingress.includes(annotation), annotation);
  assert.match(deployment, /- name: FLOWPLAN_SHUTDOWN_SECONDS\n\s+value: \{\{ include "flowplan.shutdownSeconds" \. \| quote \}\}/);
  assert.match(helpers, /- name: FLOWPLAN_CACHE_MAX_MB/);
});

test("the examples and the optional extras exist: small and HA values, ServiceMonitor, NetworkPolicy, values schema", () => {
  for (const file of ["values-small.yaml", "values-ha.yaml", "values.schema.json", "templates/servicemonitor.yaml", "templates/networkpolicy.yaml", "README.md"]) assert.ok(existsSync(`${dir}/${file}`), file);
  const ha = read("values-ha.yaml");
  assert.match(ha, /^cluster:\n {2}enabled: true$/m);
  assert.doesNotMatch(read("values-small.yaml"), /^cluster:\n {2}enabled: true$/m);
  // Placeholders only, never a credential.
  for (const file of ["values-small.yaml", "values-ha.yaml"]) assert.doesNotMatch(read(file), /^[ \t]*(password|clientSecret|secretAccessKey|accessKeyId|encryptionKey|token)[ \t]*:[ \t]*\S|:\/\/[^\s/]+:[^\s@<]+@/im, file);
  assert.match(read("templates/servicemonitor.yaml"), /path: \/api\/metrics/);
  assert.ok(existsSync(".github/workflows/helm.yml"), "the chart is linted and rendered in CI");
});
