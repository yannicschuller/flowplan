import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { offlineKind } from "../lib/offline-kind";
import { appOfflineFetch } from "../lib/offline-app";
import {
  appStore,
  browserStore,
  entryResponse,
  fromBase64,
  responseEntry,
  toBase64,
  type AppOfflineBridge,
  type StoredEntry,
} from "../lib/offline-store";
import { storeApp } from "../components/offline";

const ORIGIN = "https://flowplan.example";

// The app's side of the bridge, in memory (flowplan-app keeps it in files).
class FakeBridge implements AppOfflineBridge {
  version = 1;
  copy = false;
  unreachable = false;
  caches = new Map<string, Map<string, StoredEntry>>();
  refuse = (_cache: string, _key: string) => false;
  async names() {
    return [...this.caches.keys()];
  }
  async keys(cache: string) {
    return [...(this.caches.get(cache)?.keys() || [])];
  }
  async match(cache: string | null, key: string) {
    if (cache !== null) return this.caches.get(cache)?.get(key) ?? null;
    for (const entries of this.caches.values()) if (entries.has(key)) return entries.get(key)!;
    return null;
  }
  async put(cache: string, key: string, entry: StoredEntry) {
    if (this.refuse(cache, key)) return false;
    if (!this.caches.has(cache)) this.caches.set(cache, new Map());
    this.caches.get(cache)!.set(key, JSON.parse(JSON.stringify(entry)));
    return true;
  }
  async delete(cache: string, key: string) {
    return !!this.caches.get(cache)?.delete(key);
  }
  async remove(cache: string) {
    return this.caches.delete(cache);
  }
  async estimate() {
    return { quota: 1e9, usage: 0 };
  }
}
const text = (body: string, type = "application/json") => new Response(body, { headers: { "content-type": type } });
const enable = async (bridge: FakeBridge) =>
  bridge.put("flowplan-settings", "/__flowplan-offline", await responseEntry(text(JSON.stringify({ user: "u1", since: 1 }))));

test("the page asks for the same requests the service worker answers", () => {
  const context: Record<string, unknown> = { self: { addEventListener() {}, location: { origin: ORIGIN } }, URL };
  runInNewContext(`${readFileSync("public/sw.js", "utf8")}\nself.offlineKind = offlineKind;`, context);
  const worker = (context.self as { offlineKind: (r: unknown, u: URL) => string | null }).offlineKind;
  const cases: { method?: string; url: string; navigate?: boolean; header?: string }[] = [
    { url: "/" , navigate: true },
    { url: "/settings", navigate: true },
    { url: "/_next/static/chunks/a.js" },
    { url: "/fonts.css" },
    { url: "/fonts/sans.woff2" },
    { url: "/icons/icon-192.png" },
    { url: "/api/bootstrap?workspace=w" },
    { url: "/api/pages/0b7f7c56-0f3d-4f39-8d4c-8a2b9c3d4e5f/rows/0b7f7c56-0f3d-4f39-8d4c-8a2b9c3d4e5f" },
    { url: "/api/files/0b7f7c56-0f3d-4f39-8d4c-8a2b9c3d4e5f?thumb=1" },
    { url: "/api/command", method: "POST" },
    { url: "/api/pages/x", method: "POST" },
    { url: "/api/search?q=a" },
    { url: "/api/bootstrap", header: "1" },
    { url: "https://elsewhere.example/_next/static/chunks/a.js" },
  ];
  for (const c of cases) {
    const url = new URL(c.url, ORIGIN);
    const request = {
      method: c.method || "GET",
      mode: c.navigate ? "navigate" : "cors",
      headers: { get: (name: string) => (name.toLowerCase() === "x-flowplan-offline" ? c.header ?? null : null) },
    };
    assert.equal(
      offlineKind({ method: c.method || "GET", url: url.href, navigate: c.navigate, offlineHeader: c.header ?? null }, ORIGIN),
      worker(request, url),
      c.url,
    );
  }
});

test("entries keep status, headers and every byte", async () => {
  const bytes = new Uint8Array(70000).map((_, i) => (i * 7) % 256);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  const entry = await responseEntry(new Response(bytes, { status: 200, statusText: "OK", headers: { "content-type": "image/png" } }));
  const back = entryResponse(entry);
  assert.equal(back.status, 200);
  assert.equal(back.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);
});

test("the app's store and the browser's hold the same caches under the same keys", async () => {
  const bridge = new FakeBridge();
  const store = appStore(bridge);
  const data = await store.open("flowplan-data-v1");
  await data.put("/api/pages/p1", text('{"id":"p1"}'));
  assert.deepEqual(await data.keys(), ["/api/pages/p1"]);
  assert.equal(await (await data.match("/api/pages/p1"))?.text(), '{"id":"p1"}');
  assert.equal(await store.match("/api/pages/p1").then((r) => r?.text()), '{"id":"p1"}');
  assert.deepEqual(await store.names(), ["flowplan-data-v1"]);
  assert.equal(await data.delete("/api/pages/p1"), true);
  assert.equal(await store.remove("flowplan-data-v1"), true);
  assert.deepEqual(await store.names(), []);
  // What the app refuses fails like a request.
  bridge.refuse = () => true;
  await assert.rejects(data.put("/api/pages/p2", text("{}")), /refused/);

  // The browser's Cache Storage answers with Requests; the store with keys.
  const requests = new Map<string, Response>();
  const cache = {
    match: async (k: string) => requests.get(k),
    put: async (k: string, r: Response) => void requests.set(k, r),
    delete: async (k: string) => requests.delete(k),
    keys: async () => [...requests.keys()].map((k) => new Request(ORIGIN + k)),
  };
  const storage = { open: async () => cache, keys: async () => ["flowplan-data-v1"], delete: async () => true, match: async () => undefined } as unknown as CacheStorage;
  const browser = await browserStore(storage).open("flowplan-data-v1");
  await browser.put("/api/bootstrap?workspace=w", text("{}"));
  assert.deepEqual(await browser.keys(), ["/api/bootstrap?workspace=w"]);
});

test("the app's page goes to the network first, keeps what it fetched and answers from the copy offline", async () => {
  const bridge = new FakeBridge();
  let network = true;
  const calls: string[] = [];
  const original = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (!network) throw new TypeError("Load failed");
    return text(`{"from":"network","url":${JSON.stringify(url)}}`);
  }) as typeof fetch;
  const shim = appOfflineFetch(bridge, original, ORIGIN);
  const page = `${ORIGIN}/api/pages/p1`;

  // Off: nothing is kept, nothing answered from the copy.
  await shim.fetch(page);
  assert.equal(bridge.caches.size, 0);

  await enable(bridge);
  shim.reset();
  assert.equal(await (await shim.fetch(page)).json().then((b) => b.from), "network");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(bridge.caches.get("flowplan-data-v1")?.has("/api/pages/p1"));
  // Writes and requests the copy has no part in pass through untouched.
  await shim.fetch(`${ORIGIN}/api/command`, { method: "POST", body: "{}" });
  await shim.fetch(`${ORIGIN}/api/search?q=x`);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...bridge.caches.get("flowplan-data-v1")!.keys()], ["/api/pages/p1"]);

  network = false;
  assert.equal(await (await shim.fetch(page)).json().then((b) => b.from), "network");
  await assert.rejects(shim.fetch(`${ORIGIN}/api/pages/never-opened`), TypeError);
  await assert.rejects(shim.fetch(`${ORIGIN}/api/search?q=x`), TypeError);

  // The app's files are looked up in every build's cache.
  await bridge.put("flowplan-static-B1", "/_next/static/chunks/editor.js", await responseEntry(text("editor()", "text/javascript")));
  assert.equal(await (await shim.fetch(`${ORIGIN}/_next/static/chunks/editor.js`)).text(), "editor()");

  // A cancelled request is no reason to answer from the copy.
  const aborting = appOfflineFetch(bridge, (async () => {
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch, ORIGIN);
  await assert.rejects(aborting.fetch(page), /aborted/);

  // The stored copy of a server that is down: the copy first, no waiting.
  network = true;
  calls.length = 0;
  bridge.unreachable = true;
  const stored = await (await shim.fetch(page)).json();
  assert.equal(stored.from, "network");
  assert.deepEqual(calls, []);
});

test("pictures of the copy that fail to load are shown from it", async () => {
  const bridge = new FakeBridge();
  await enable(bridge);
  await bridge.put("flowplan-data-v1", "/api/files/f1", await responseEntry(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })));
  const shim = appOfflineFetch(bridge, fetch, ORIGIN, () => "blob:flowplan/1");
  const img = (src: string) => {
    const element = { src, currentSrc: src, removed: [] as string[], removeAttribute(name: string) { this.removed.push(name); } };
    return element as unknown as HTMLImageElement & { removed: string[] };
  };
  const picture = img(`${ORIGIN}/api/files/f1`);
  assert.equal(await shim.image(picture), true);
  assert.equal(picture.src, "blob:flowplan/1");
  assert.deepEqual(picture.removed, ["srcset"]);
  // Once per picture; foreign pictures and ones the copy lacks stay.
  assert.equal(await shim.image(picture), false);
  assert.equal(await shim.image(img("https://elsewhere.example/a.png")), false);
  assert.equal(await shim.image(img(`${ORIGIN}/api/files/f2`)), false);
});

test("the app's files are stored through the app's bridge like into Cache Storage", async () => {
  const bridge = new FakeBridge();
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, fetch: g.fetch };
  g.window = { FlowplanApp: { offline: bridge }, isSecureContext: true, addEventListener() {}, dispatchEvent() {} };
  g.fetch = async (path: string) => new Response(`body of ${path}`);
  try {
    await bridge.put("flowplan-static-B1", "/_next/static/chunks/shared.js", await responseEntry(new Response("shared")));
    const app = await storeApp(
      { build: "B2", version: "0.7.0", files: ["shared.js", "editor.js"].map((f) => ({ path: `/_next/static/chunks/${f}`, size: 10 })), bytes: 20 },
      { shell: true, live: async () => true },
    );
    assert.equal(app.complete, true);
    assert.deepEqual(await bridge.names(), ["flowplan-static-B2"]);
    assert.equal(entryResponse((await bridge.match("flowplan-static-B2", "/_next/static/chunks/shared.js"))!).status, 200);
    assert.equal(await entryResponse((await bridge.match(null, "/_next/static/chunks/editor.js"))!).text(), "body of /_next/static/chunks/editor.js");
  } finally {
    g.window = saved.window;
    g.fetch = saved.fetch;
  }
});
