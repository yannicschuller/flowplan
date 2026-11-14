// While the server restarts (#284) the reverse proxy answers instead of
// Flowplan – Traefik's "404 page not found", or 502/503. The service worker
// shows the stored app for such a page, never for an answer of Flowplan
// itself (which names its build in X-Flowplan-Build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const ORIGIN = "https://flowplan.example";
const STORED = "<!doctype html><title>Flowplan</title><p>stored app</p>";

function worker(network: () => Response) {
  const store = new Map<string, Response>([["/", new Response(STORED, { headers: { "content-type": "text/html" } })]]);
  const cache = {
    match: async (key: string) => store.get(key)?.clone(),
    put: async (key: string, response: Response) => void store.set(key, response),
  };
  const context: Record<string, unknown> = {
    self: { addEventListener() {}, location: { origin: ORIGIN } },
    URL,
    Response,
    fetch: async () => network(),
    caches: { open: async () => cache, match: async (key: string) => store.get(key)?.clone() },
  };
  runInNewContext(`${readFileSync("public/sw.js", "utf8")}\nself.networkFirst = networkFirst;`, context);
  const networkFirst = (context.self as { networkFirst: (r: unknown, c: string, k: string, a?: boolean) => Promise<Response> }).networkFirst;
  return (navigate = true) => networkFirst({ url: `${ORIGIN}/`, mode: navigate ? "navigate" : "cors" }, "flowplan-data-v1", "/");
}

test("a proxy's error page for the app's page is replaced by the stored app", async () => {
  for (const status of [404, 502, 503]) {
    const open = worker(() => new Response("404 page not found", { status, headers: { "content-type": "text/plain" } }));
    assert.equal(await (await open()).text(), STORED, `proxy ${status}`);
  }
});

test("Flowplan's own answers and other requests pass through", async () => {
  const own = worker(() => new Response("{}", { status: 404, headers: { "X-Flowplan-Build": "b1" } }));
  assert.equal((await own()).status, 404);
  const proxied = worker(() => new Response("404 page not found", { status: 404 }));
  assert.equal((await proxied(false)).status, 404);
  const fresh = worker(() => new Response("<p>fresh</p>", { status: 200, headers: { "X-Flowplan-Build": "b2" } }));
  assert.equal(await (await fresh()).text(), "<p>fresh</p>");
});
