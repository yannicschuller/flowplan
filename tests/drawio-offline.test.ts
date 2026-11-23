// The shipped draw.io offline (#454, lib/drawio-offline.ts): the service
// worker keeps its files in a cache per version – only on a device with
// offline use on, only the shipped copy's answers, older versions removed –
// and answers from it without a connection. public/sw.js repeats the
// plan of lib/drawio-offline.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as plan from "../lib/drawio-offline";

const ORIGIN = "https://example.test";
const keyOf = (r: string | Request) => {
  const url = new URL(typeof r === "string" ? r : r.url, ORIGIN);
  return url.pathname + url.search;
};
class FakeCache {
  entries = new Map<string, Response>();
  async match(r: string | Request) {
    return this.entries.get(keyOf(r))?.clone();
  }
  async put(r: string | Request, response: Response) {
    this.entries.set(keyOf(r), response);
  }
  async keys() {
    return [...this.entries.keys()].map((k) => new Request(new URL(k, ORIGIN)));
  }
}
class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(r: string | Request, options?: { cacheName?: string }) {
    const names = options?.cacheName ? [options.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(r);
      if (hit) return hit;
    }
    return undefined;
  }
}

function worker(caches: FakeCaches, fetch: (request: Request) => Promise<Response>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const context: Record<string, unknown> = {
    self: {
      addEventListener(type: string, listener: (event: unknown) => void) {
        listeners[type] = listener;
      },
      location: { origin: ORIGIN },
    },
    caches,
    fetch,
    URL,
    Request,
    Response,
  };
  runInNewContext(`${readFileSync("public/sw.js", "utf8")}\nself.drawioOffline = drawioOffline;`, context);
  // A request as the browser hands it to the worker: answered or passed on.
  const request = async (path: string, mode: RequestMode | "navigate" = "cors") => {
    let answer = null as Promise<Response> | null;
    const req = new Request(new URL(path, ORIGIN));
    Object.defineProperty(req, "mode", { value: mode });
    listeners.fetch({ request: req, respondWith: (p: Promise<Response>) => (answer = p) });
    return answer ? await (answer as Promise<Response>) : null;
  };
  return { request, plan: (context.self as { drawioOffline: typeof plan }).drawioOffline };
}

test("the plan: a cache per version, keys without draw.io's parameters", () => {
  assert.equal(plan.drawioCacheName("32.6.9"), "flowplan-drawio-32.6.9");
  assert.deepEqual(plan.staleDrawioCaches(["flowplan-data-v1", "flowplan-static-A", "flowplan-drawio-32.6.8", "flowplan-drawio-32.6.9"], "32.6.9"), [
    "flowplan-drawio-32.6.8",
  ]);
  assert.deepEqual(plan.drawioRequest("/drawio/32.6.9/"), { version: "32.6.9", key: "/drawio/32.6.9/", fresh: true });
  assert.deepEqual(plan.drawioRequest("/drawio/32.6.9/js/PreConfig.js"), { version: "32.6.9", key: "/drawio/32.6.9/js/PreConfig.js", fresh: true });
  assert.deepEqual(plan.drawioRequest("/drawio/32.6.9/js/app.min.js"), { version: "32.6.9", key: "/drawio/32.6.9/js/app.min.js", fresh: false });
  for (const path of ["/drawio/", "/drawio/x/app.js", "/api/drawio/32.6.9/a.js", "/drawio/32.6.9"]) assert.equal(plan.drawioRequest(path), null, path);
  assert.equal(plan.drawioLanguageFile("de"), "resources/dia_de.txt");
  assert.equal(plan.drawioLanguageFile("en"), "resources/dia.txt");
  assert.equal(plan.drawioLanguageFile(undefined), "resources/dia.txt");
  assert.equal(plan.drawioLanguageFile("zh"), "resources/dia_zh.txt");
});

test("public/sw.js plans the same way", () => {
  const { plan: same } = worker(new FakeCaches(), async () => new Response(""));
  const names = ["flowplan-drawio-1.0.0", "flowplan-drawio-2.0.0", "flowplan-static-B"];
  assert.deepEqual(same.staleDrawioCaches(names, "2.0.0"), plan.staleDrawioCaches(names, "2.0.0"));
  assert.equal(same.drawioCacheName("2.0.0"), plan.drawioCacheName("2.0.0"));
  for (const path of ["/drawio/2.0.0/", "/drawio/2.0.0/index.html", "/drawio/2.0.0/flowplan-offline.json", "/drawio/2.0.0/img/a b.svg", "/drawio/x/", "/x"])
    assert.deepEqual(JSON.parse(JSON.stringify(same.drawioRequest(path))), plan.drawioRequest(path), path);
  assert.equal(same.isDrawioCache("flowplan-drawio-2.0.0"), true);
  assert.equal(same.isDrawioCache("flowplan-static-2.0.0"), false);
});

// A same-origin answer as the browser's fetch gives it (type "basic").
const basic = (response: Response) => Object.defineProperty(response, "type", { value: "basic" });
const drawio = (version: string, body: string) => basic(new Response(body, { headers: { "X-Flowplan-Drawio": version } }));

test("the service worker keeps draw.io's files only with offline use on, and serves them offline", async () => {
  const caches = new FakeCaches();
  let online = true;
  const fetched: string[] = [];
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    fetched.push(path);
    if (!online) throw new TypeError("Failed to fetch");
    if (path.endsWith("/foreign.js")) return basic(new Response("not draw.io"));
    return drawio(path.split("/")[2], `body of ${path}`);
  };
  // Offline use off: passed on, nothing kept.
  let sw = worker(caches, fetch);
  assert.equal(await (await sw.request("/drawio/32.6.9/js/app.min.js"))!.text(), "body of /drawio/32.6.9/js/app.min.js");
  assert.deepEqual(await caches.keys(), ["flowplan-settings"]);

  // On: the frame's page (a navigation, with draw.io's parameters) and its files are kept.
  await (await caches.open("flowplan-settings")).put("/__flowplan-offline", new Response(JSON.stringify({ user: "u" })));
  await (await caches.open("flowplan-drawio-32.6.8")).put("/drawio/32.6.8/js/app.min.js", drawio("32.6.8", "old"));
  sw = worker(caches, fetch);
  await sw.request("/drawio/32.6.9/?embed=1&proto=json&lang=de", "navigate");
  await sw.request("/drawio/32.6.9/js/app.min.js");
  await sw.request("/drawio/32.6.9/foreign.js");
  const kept = await caches.open("flowplan-drawio-32.6.9");
  assert.deepEqual([...kept.entries.keys()].sort(), ["/drawio/32.6.9/", "/drawio/32.6.9/js/app.min.js"]);
  // The older version is gone, nothing else was touched.
  assert.deepEqual((await caches.keys()).sort(), ["flowplan-drawio-32.6.9", "flowplan-settings"]);

  // Files of a version come from the cache, the page from the network first.
  fetched.length = 0;
  await sw.request("/drawio/32.6.9/js/app.min.js");
  assert.deepEqual(fetched, []);
  await sw.request("/drawio/32.6.9/?embed=1", "navigate");
  assert.deepEqual(fetched, ["/drawio/32.6.9/"]);

  // Offline: the editor still loads; what was never loaded fails.
  online = false;
  assert.equal(await (await sw.request("/drawio/32.6.9/?embed=1&dark=1", "navigate"))!.text(), "body of /drawio/32.6.9/");
  assert.equal(await (await sw.request("/drawio/32.6.9/js/app.min.js"))!.text(), "body of /drawio/32.6.9/js/app.min.js");
  await assert.rejects(sw.request("/drawio/32.6.9/js/extensions.min.js"));
  // Other requests are not answered differently.
  assert.equal(await sw.request("/somewhere/else.js"), null);
});
