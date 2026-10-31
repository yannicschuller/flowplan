// Plain-http instances (#62): the Content Security Policy tells browsers to
// upgrade requests to https only where the instance is served over HTTPS –
// on plain http that sent every script and style to an address nobody
// answers (no CSS, no JavaScript, the sign-in form fell back to a GET with
// the password in the URL). HTTPS setups keep the directive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-https-"));
delete process.env.APP_URL;
const { httpsInstance, loopbackHost, plainHttpInstance, upgradeInsecureRequests } = await import("../lib/instance-https");
const { NextRequest } = await import("next/server");
const { contentSecurityPolicy, proxy } = await import("../proxy");

const UPGRADE = /(^|; )upgrade-insecure-requests($|;)/;

test("the policy: upgrade-insecure-requests only over HTTPS and never in development", () => {
  assert.match(contentSecurityPolicy("n", false, [], true), UPGRADE);
  assert.doesNotMatch(contentSecurityPolicy("n", false, [], false), UPGRADE);
  assert.doesNotMatch(contentSecurityPolicy("n", true, [], true), UPGRADE);
  // Callers that do not say keep the secure default.
  assert.match(contentSecurityPolicy("n", false), UPGRADE);
  // Everything else stays the same either way.
  const strip = (policy: string) => policy.replace(/; upgrade-insecure-requests$/, "");
  assert.equal(strip(contentSecurityPolicy("n", false, ["https://x.example"], true)), contentSecurityPolicy("n", false, ["https://x.example"], false));
});

test("an https address, a TLS proxy or an https request keep the upgrade", () => {
  assert.equal(upgradeInsecureRequests({ url: "https://flowplan.example.com" }), true);
  // An https APP_URL keeps it even for a request that reached the server over http.
  assert.equal(upgradeInsecureRequests({ url: "https://flowplan.example.com", forwardedProto: "http", requestProtocol: "http:" }), true);
  assert.equal(upgradeInsecureRequests({ url: "http://flowplan.lan:3000", forwardedProto: "https" }), true);
  assert.equal(upgradeInsecureRequests({ url: "http://flowplan.lan:3000", forwardedProto: "https, http" }), true);
  assert.equal(upgradeInsecureRequests({ url: "http://flowplan.lan:3000", requestProtocol: "https:" }), true);
  assert.equal(upgradeInsecureRequests({ url: "http://flowplan.lan:3000", forwardedProto: "http", requestProtocol: "http:" }), false);
  assert.equal(upgradeInsecureRequests({ url: "http://192.168.1.20:3000" }), false);
});

test("plain http is worth a note only off this machine", () => {
  assert.equal(plainHttpInstance("http://flowplan.lan:3000"), true);
  assert.equal(plainHttpInstance("http://192.168.1.20:3000"), true);
  assert.equal(plainHttpInstance("http://[fd00::1]:3000"), true);
  for (const url of ["https://flowplan.example.com", "http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "http://app.localhost", "not a url"])
    assert.equal(plainHttpInstance(url), false, url);
  assert.equal(httpsInstance("https://x.example"), true);
  assert.equal(httpsInstance("http://x.example"), false);
  assert.ok(loopbackHost("LOCALHOST") && loopbackHost("127.0.0.2") && loopbackHost("[::1]"));
  assert.ok(!loopbackHost("localhost.example.com") && !loopbackHost("10.0.0.1"));
});

test("the proxy follows APP_URL and X-Forwarded-Proto", async () => {
  const policy = async (appUrl: string, headers: Record<string, string> = {}) => {
    process.env.APP_URL = appUrl;
    const host = new URL(appUrl).host;
    const response = await proxy(new NextRequest(`http://${host}/login`, { headers: { host, ...headers } }));
    return response.headers.get("Content-Security-Policy") || "";
  };
  try {
    assert.doesNotMatch(await policy("http://flowplan.test:3000"), UPGRADE);
    assert.match(await policy("http://flowplan.test:3000", { "x-forwarded-proto": "https" }), UPGRADE);
    assert.match(await policy("https://flowplan.example.com"), UPGRADE);
    assert.match(await policy("https://flowplan.example.com", { "x-forwarded-proto": "http" }), UPGRADE);
  } finally {
    delete process.env.APP_URL;
  }
});
