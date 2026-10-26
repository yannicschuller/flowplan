// What an instance tells visitors without a session (issue #41): the API
// description only with a session or API token (or FLOWPLAN_PUBLIC_API_DOCS),
// never the exact version to visitors, the health check without details
// unless the metrics token or an administrator asks, no X-Powered-By.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-disclosure-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_VERSION = "0.6.0";
delete process.env.FLOWPLAN_PUBLIC_API_DOCS;
delete process.env.FLOWPLAN_METRICS_TOKEN;
const { run, id } = await import("../lib/db");
const { hash, cookieName } = await import("../lib/auth");
const { createApiToken } = await import("../lib/api-tokens");
const { disclosedVersion, apiDocsAllowed } = await import("../lib/instance-disclosure");
const openapiRoute = await import("../app/api/openapi.json/route");
const healthRoute = await import("../app/api/health/route");

function account(name: string, groups: string[] = []) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `sub-${uid}`, name, `${name}@example.test`);
  const session = `session-${uid}`;
  run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", hash(session), uid, JSON.stringify(groups), Date.now() + 3_600_000, Date.now());
  const identity: Identity = { id: uid, name, email: `${name}@example.test`, groups, isAdmin: false, disabled: 0, created_at: "" };
  return { identity, cookie: `theme=dark; ${cookieName}=${session}` };
}
const member = account("member");
const admin = account("admin", ["flowplan-admins"]);
const apiToken = createApiToken(member.identity, { name: "docs", scope: "read" }).token;

const request = (path: string, headers: Record<string, string> = {}) => new Request(`https://flowplan.example.test${path}`, { headers });
const openapi = (headers?: Record<string, string>) => openapiRoute.GET(request("/api/openapi.json", headers));
const health = async (headers?: Record<string, string>) => {
  const response = await healthRoute.GET(request("/api/health", headers));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

test("visitors only learn the major version", () => {
  assert.equal(disclosedVersion("0.6.0", false), "0.x");
  assert.equal(disclosedVersion("1.2.3-beta.4", false), "1.x");
  assert.equal(disclosedVersion("0.6.0", true), "0.6.0");
  assert.equal(disclosedVersion("", false), "dev");
  assert.equal(disclosedVersion("nightly", false), "unknown");
  assert.equal(apiDocsAllowed(null), false);
  assert.equal(apiDocsAllowed({ ...member.identity, twoFactorSetup: true }), false);
  assert.equal(apiDocsAllowed(member.identity), true);
});

test("/api/openapi.json needs a session or an API token by default", async () => {
  const anonymous = openapi();
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(anonymous.headers.get("Access-Control-Allow-Origin"), null);
  const body = (await anonymous.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.ok(!JSON.stringify(body).includes("0.6"));
  // A cookie that is not a session, and a made-up token, change nothing.
  assert.equal(openapi({ cookie: `${cookieName}=nope` }).status, 401);
  assert.equal(openapi({ authorization: "Bearer fp_madeupmadeupmadeupmadeup" }).status, 401);

  for (const headers of [{ cookie: member.cookie }, { authorization: `Bearer ${apiToken}` }] as Record<string, string>[]) {
    const response = openapi(headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const doc = (await response.json()) as { openapi: string; info: { version: string }; paths: Record<string, unknown> };
    assert.equal(doc.openapi, "3.1.0");
    assert.equal(doc.info.version, "0.6.0");
    assert.ok(doc.paths["/api/command"]);
  }
});

test("FLOWPLAN_PUBLIC_API_DOCS=true keeps the description public, without the exact version", async () => {
  process.env.FLOWPLAN_PUBLIC_API_DOCS = "true";
  try {
    const response = openapi();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    const text = await response.text();
    assert.equal((JSON.parse(text) as { info: { version: string } }).info.version, "0.x");
    assert.ok(!text.includes("0.6.0"));
    // Signed in, the exact version is still there.
    const signedIn = (await openapi({ cookie: member.cookie }).json()) as { info: { version: string } };
    assert.equal(signedIn.info.version, "0.6.0");
  } finally {
    delete process.env.FLOWPLAN_PUBLIC_API_DOCS;
  }
});

test("the public health check answers only what the apps need", async () => {
  const anonymous = await health();
  assert.equal(anonymous.status, 200);
  // The desktop and mobile apps recognise an instance by service: "flowplan".
  assert.deepEqual(anonymous.body, { service: "flowplan", status: "ok" });
  // Members and API tokens see the same; tokens never administer.
  assert.deepEqual((await health({ cookie: member.cookie })).body, { service: "flowplan", status: "ok" });
  assert.deepEqual((await health({ authorization: `Bearer ${apiToken}` })).body, { service: "flowplan", status: "ok" });
});

test("details with the metrics token or for a signed-in administrator", async () => {
  const details = ["service", "status", "checks", "searchBacklog", "failedPushDeliveries", "objectStorage", "uptimeSeconds", "version", "commit", "builtAt"];
  // Without FLOWPLAN_METRICS_TOKEN no bearer value unlocks them.
  assert.deepEqual(Object.keys((await health({ authorization: "Bearer " })).body), ["service", "status"]);
  process.env.FLOWPLAN_METRICS_TOKEN = "metrics-token-0123456789";
  try {
    const monitored = await health({ authorization: "Bearer metrics-token-0123456789" });
    assert.equal(monitored.status, 200);
    assert.deepEqual(Object.keys(monitored.body), details);
    assert.deepEqual(monitored.body.checks, { database: "ok", storage: "ok" });
    assert.equal(monitored.body.objectStorage, "off");
    assert.deepEqual(Object.keys((await health({ authorization: "Bearer metrics-token-wrong-value" })).body), ["service", "status"]);
  } finally {
    delete process.env.FLOWPLAN_METRICS_TOKEN;
  }
  assert.deepEqual(Object.keys((await health({ cookie: admin.cookie })).body), details);
});

test("a failing check answers 503 with service and status only", async () => {
  const previous = process.env.FLOWPLAN_DATA_DIR;
  // The upload directory cannot be created below a file.
  const blocker = join(previous!, "not-a-directory");
  writeFileSync(blocker, "");
  process.env.FLOWPLAN_DATA_DIR = blocker;
  try {
    const failing = await health();
    assert.equal(failing.status, 503);
    assert.deepEqual(failing.body, { service: "flowplan", status: "error" });
  } finally {
    process.env.FLOWPLAN_DATA_DIR = previous;
  }
});

test("next.config.ts turns off X-Powered-By and keeps API answers private", async () => {
  const { default: config } = await import("../next.config");
  assert.equal(config.poweredByHeader, false);
  const rules = await config.headers!();
  const openapiRule = rules.find((rule) => rule.source === "/api/openapi.json");
  assert.equal(openapiRule, undefined, "no public cache rule for the API description");
  const api = rules.find((rule) => rule.source === "/api/:path*");
  assert.deepEqual(api?.headers, [{ key: "Cache-Control", value: "private, no-store" }]);
});
