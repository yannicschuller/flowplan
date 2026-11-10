// The one-click deployments: Render (render.yaml), DigitalOcean App Platform
// (.do/deploy.template.yaml) and any server (deploy/cloud-init.yaml calling
// deploy/install.sh). They run the published image, keep the data where it
// survives a deploy, and never carry a secret in the repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const render = readFileSync("render.yaml", "utf8");
const digitalOcean = readFileSync(".do/deploy.template.yaml", "utf8");
const cloudInit = readFileSync("deploy/cloud-init.yaml", "utf8");
const install = readFileSync("deploy/install.sh", "utf8");
const entrypoint = readFileSync("docker/entrypoint.sh", "utf8");

test("Render: the image on a paid plan with a disk on the data folder, health check and generated setup token", () => {
  assert.match(render, /^\s+runtime: image$/m);
  assert.match(render, /^\s+url: ghcr\.io\/yannicschuller\/flowplan:latest$/m);
  assert.match(render, /^\s+plan: starter$/m);
  assert.match(render, /^\s+numInstances: 1$/m);
  assert.match(render, /^\s+healthCheckPath: \/api\/health$/m);
  assert.match(render, /disk:\s*\n\s+name: flowplan-data\s*\n\s+mountPath: \/app\/data/);
  assert.match(render, /key: PORT\s*\n\s+value: "3000"/);
  assert.match(render, /key: FLOWPLAN_SETUP_TOKEN\s*\n\s+generateValue: true/);
  // APP_URL comes from Render's own address in the entrypoint.
  assert.doesNotMatch(render, /key: APP_URL/);
  assert.match(entrypoint, /APP_URL="\$RENDER_EXTERNAL_URL"/);
  assert.match(entrypoint, /APP_URL="https:\/\/\$RENDER_EXTERNAL_HOSTNAME"/);
});

test("DigitalOcean: the image, a PostgreSQL database and the app's own address", () => {
  assert.match(digitalOcean, /^spec:$/m);
  assert.match(digitalOcean, /registry_type: GHCR\s*\n\s+registry: yannicschuller\s*\n\s+repository: flowplan\s*\n\s+tag: latest/);
  assert.match(digitalOcean, /http_port: 3000/);
  assert.match(digitalOcean, /http_path: \/api\/health/);
  assert.match(digitalOcean, /key: APP_URL\s*\n\s+scope: RUN_TIME\s*\n\s+value: \$\{APP_URL\}/);
  // No volume on App Platform: the database is PostgreSQL ≥ 16.
  assert.match(digitalOcean, /value: \$\{db\.DATABASE_URL\}&uselibpqcompat=true/);
  assert.match(digitalOcean, /- name: db\s*\n\s+engine: PG\s*\n\s+version: "(\d+)"/);
  assert.ok(Number(digitalOcean.match(/engine: PG\s*\n\s+version: "(\d+)"/)?.[1]) >= 16);
  // Secrets are entered when the app is created, never stored here.
  for (const key of ["FLOWPLAN_SETUP_TOKEN", "FLOWPLAN_ENCRYPTION_KEY", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "WEB_PUSH_PRIVATE_KEY"])
    assert.match(digitalOcean, new RegExp(`key: ${key}\\s*\\n\\s+scope: RUN_TIME\\s*\\n\\s+type: SECRET\\s*\\n\\s+value: ""`));
});

test("cloud-init: the domain is the one setting, the install script does the rest", () => {
  assert.equal(cloudInit.split("\n")[0], "#cloud-config");
  assert.match(cloudInit, /^ {6}FLOWPLAN_DOMAIN=$/m);
  assert.match(cloudInit, /raw\.githubusercontent\.com\/yannicschuller\/flowplan\/main\/deploy\/install\.sh/);
});

test("install.sh: generated secrets in a private .env, Caddy in front, the data in a volume", () => {
  execFileSync("bash", ["-n", "deploy/install.sh"]);
  assert.match(install, /^set -euo pipefail$/m);
  // The whole script is read before it runs (curl … | bash).
  assert.match(install, /\nmain "\$@"\n$/);
  assert.match(install, /FLOWPLAN_SETUP_TOKEN=\$\(openssl rand -hex 24\)/);
  assert.match(install, /FLOWPLAN_ENCRYPTION_KEY=\$\(openssl rand -base64 32\)/);
  assert.match(install, /chmod 600 "\$DIR\/\.env"/);
  assert.match(install, /image: ghcr\.io\/yannicschuller\/flowplan:\$\{FLOWPLAN_VERSION:-latest\}/);
  assert.match(install, /- flowplan-data:\/app\/data/);
  assert.match(install, /reverse_proxy flowplan:3000/);
  assert.match(install, /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/health'\)/);
  // Flowplan's port stays inside Docker's network; only Caddy is published.
  assert.doesNotMatch(install, /"3000:3000"/);
});

test("no secret values in the deployment files", () => {
  for (const text of [render, digitalOcean, cloudInit, install])
    assert.doesNotMatch(text, /(TOKEN|KEY|PASSWORD|SECRET)[A-Z_]*[:=]\s*["']?[A-Za-z0-9+/]{20,}/);
});
