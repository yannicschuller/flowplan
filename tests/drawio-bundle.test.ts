// The draw.io Flowplan ships (#454): the default editor without DRAWIO_URL,
// DRAWIO_URL still first, the editor's address without external services,
// the files under /drawio/<version>/ with their own Content Security
// Policy, and the proxy leaving them alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "flowplan-drawio-bundle-"));
process.env.FLOWPLAN_DATA_DIR = join(work, "data");
const bundle = join(work, "drawio");
process.env.FLOWPLAN_DRAWIO_DIR = bundle;
delete process.env.DRAWIO_URL;

const { drawioConfig, drawioEditorUrl, resolveDrawioConfig, BUNDLED_DRAWIO_PARAMS } = await import("../lib/drawio");
const { bundledDrawio, drawioServerConfig, drawioFileResponse, drawioFilePath, drawioContentSecurityPolicy, forgetBundledDrawio, DRAWIO_PRECONFIG } =
  await import("../lib/drawio-bundle");
const { editorFrameOrigins, contentSecurityPolicy } = await import("../proxy");

function makeBundle(version = "32.6.9") {
  mkdirSync(join(bundle, "js"), { recursive: true });
  mkdirSync(join(bundle, "img", "lib", "sap"), { recursive: true });
  writeFileSync(join(bundle, "index.html"), "<!DOCTYPE html><title>draw.io</title>");
  writeFileSync(join(bundle, "js", "app.min.js"), "var App={};");
  writeFileSync(join(bundle, "js", "bootstrap.js"), "var urlParams={};");
  writeFileSync(join(bundle, "js", "shapes-14-6-5.min.js"), "");
  writeFileSync(join(bundle, "js", "PreConfig.js"), "window.EXPORT_URL='https://convert.example';");
  writeFileSync(join(bundle, "img", "lib", "sap", "SAP_BTP,_ABAP (x).svg"), "<svg/>");
  writeFileSync(join(bundle, "LICENSE"), "Apache License");
  writeFileSync(join(bundle, ".flowplan-drawio.json"), JSON.stringify({ version }));
  forgetBundledDrawio();
}
const get = (path: string, method = "GET") => {
  const url = new URL(path, "https://flowplan.example.test");
  const parts = url.pathname.replace(/^\/drawio\//, "").split("/").map(decodeURIComponent);
  if (parts.at(-1) === "") parts.pop();
  return drawioFileResponse(new Request(url, { method }), parts);
};

test("without a shipped copy: the public diagrams.net, as before", () => {
  forgetBundledDrawio();
  assert.equal(bundledDrawio(), null);
  assert.deepEqual(drawioServerConfig(), { url: "https://embed.diagrams.net/", origin: "https://embed.diagrams.net", external: true });
  assert.deepEqual(editorFrameOrigins("/"), ["https://embed.diagrams.net"]);
});

test("the shipped copy is the default editor; DRAWIO_URL still overrides it", () => {
  makeBundle();
  assert.deepEqual(bundledDrawio(), { dir: bundle, version: "32.6.9" });
  assert.deepEqual(drawioServerConfig(), { url: "/drawio/32.6.9/", origin: "", external: false, bundled: "32.6.9" });
  // Same origin: frame-src 'self' covers it, the app's policy needs nothing new.
  assert.deepEqual(editorFrameOrigins("/"), []);
  assert.doesNotMatch(contentSecurityPolicy("n", false, [], true, editorFrameOrigins("/")), /diagrams\.net|drawio/);
  try {
    process.env.DRAWIO_URL = "https://drawio.example.com";
    assert.deepEqual(drawioServerConfig(), { url: "https://drawio.example.com/", origin: "https://drawio.example.com", external: false });
    assert.deepEqual(editorFrameOrigins("/"), ["https://drawio.example.com"]);
    process.env.DRAWIO_URL = "https://embed.diagrams.net";
    assert.equal(drawioServerConfig()?.external, true);
    // An unusable address switches draw.io off – never the shipped copy instead.
    process.env.DRAWIO_URL = "http://drawio.lan";
    assert.equal(drawioServerConfig(), null);
  } finally {
    delete process.env.DRAWIO_URL;
  }
  // A marker with something else than a version is no copy.
  assert.deepEqual(drawioConfig("", "../../etc"), drawioConfig("", null));
});

test("the editor's address: the shipped copy on the page's origin, without online services", () => {
  const config = resolveDrawioConfig(drawioConfig("", "32.6.9"), "https://flowplan.example.test")!;
  assert.deepEqual(config, { url: "https://flowplan.example.test/drawio/32.6.9/", origin: "https://flowplan.example.test", external: false, bundled: "32.6.9" });
  const url = new URL(drawioEditorUrl(config, { lang: "de" }));
  assert.equal(url.origin + url.pathname, "https://flowplan.example.test/drawio/32.6.9/");
  for (const [key, value] of Object.entries({ embed: "1", proto: "json", stealth: "1", lockdown: "1", pwa: "0", lang: "de" }))
    assert.equal(url.searchParams.get(key), value, key);
  // offline=1 would install draw.io's own service worker.
  assert.equal(url.searchParams.has("offline"), false);
  // Another draw.io gets the address it always got.
  const other = new URL(drawioEditorUrl(drawioConfig("https://drawio.example.com")!));
  for (const key of Object.keys(BUNDLED_DRAWIO_PARAMS)) assert.equal(other.searchParams.has(key), false, key);
  assert.deepEqual(resolveDrawioConfig(drawioConfig("https://drawio.example.com"), "https://x.test"), drawioConfig("https://drawio.example.com"));
  assert.equal(resolveDrawioConfig(null, "https://x.test"), null);
});

test("/drawio/<version>/: draw.io's files with their own policy, nothing else", async () => {
  makeBundle();
  const page = await get("/drawio/32.6.9/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await page.text(), /draw\.io/);
  assert.equal(page.headers.get("x-flowplan-drawio"), "32.6.9");
  assert.equal(page.headers.get("cache-control"), "public, max-age=3600");
  const policy = page.headers.get("content-security-policy")!;
  assert.equal(policy, drawioContentSecurityPolicy());
  const directives = Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
  assert.equal(directives["default-src"], "'none'");
  assert.equal(directives["script-src"], "'self' 'wasm-unsafe-eval'");
  assert.equal(directives["frame-ancestors"], "'self'");
  assert.equal(directives["form-action"], "'none'");
  // No external host anywhere, no inline scripts or eval.
  assert.doesNotMatch(policy, /https?:|\*|'unsafe-eval'|'strict-dynamic'/);
  assert.doesNotMatch(directives["script-src"], /unsafe-inline/);

  const app = await get("/drawio/32.6.9/js/app.min.js");
  assert.equal(app.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(app.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(app.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await app.text(), "var App={};");
  assert.equal((await get("/drawio/32.6.9/js/app.min.js", "HEAD")).status, 200);
  // Names as draw.io has them (spaces, commas, brackets).
  assert.equal((await get("/drawio/32.6.9/img/lib/sap/SAP_BTP%2C_ABAP%20(x).svg")).headers.get("content-type"), "image/svg+xml");
  // Flowplan's settings instead of draw.io's own PreConfig.js.
  const settings = await (await get("/drawio/32.6.9/js/PreConfig.js")).text();
  assert.equal(settings, DRAWIO_PRECONFIG);
  assert.match(settings, /EXPORT_URL = null/);
  assert.match(settings, /urlParams\["lockdown"\] = "1"/);
  assert.doesNotMatch(settings, /https?:/);
  // The start files for the offline copy.
  const list = await (await get("/drawio/32.6.9/flowplan-offline.json")).json();
  assert.deepEqual(list, { version: "32.6.9", files: ["", "js/PreConfig.js", "js/bootstrap.js", "js/app.min.js", "js/shapes-14-6-5.min.js"] });
  // The folder without its slash goes on to it.
  const bare = await get("/drawio/32.6.9");
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/drawio/32.6.9/");

  for (const path of [
    "/drawio/32.6.8/",
    "/drawio/32.6.8/js/app.min.js",
    "/drawio/32.6.9/.flowplan-drawio.json",
    "/drawio/32.6.9/LICENSE",
    "/drawio/32.6.9/js/missing.js",
    "/drawio/32.6.9/js/",
    "/drawio/32.6.9/%2E%2E/%2E%2E/package.json",
    "/drawio/32.6.9/js/..%2F..%2Fpackage.json",
    "/drawio/32.6.9/WEB-INF/web.xml",
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'", path);
  }
  assert.equal(drawioFilePath(bundle, ["..", "x.js"]), null);
  assert.equal(drawioFilePath(bundle, ["js", "a\\..\\b.js"]), null);
  assert.equal(drawioFilePath(bundle, [""]), null);
});

test("the proxy gives /drawio no policy of its own and leaves its slash alone", async () => {
  const { proxy } = await import("../proxy");
  const { NextRequest } = await import("next/server");
  const response = await proxy(new NextRequest("http://127.0.0.1:3000/drawio/32.6.9/"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), null);
  assert.equal(response.headers.get("location"), null);
});
