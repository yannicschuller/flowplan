// The API's one catch-all route (app/api/[...path]/route.ts, lib/api-routes.ts):
// every handler under app/api is in its table, and the table routes like
// Next.js would route the same files as route files of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { apiRoutes, matchApiRoute, routeMethod, type RouteModule } from "../lib/api-routes";

const require = createRequire(import.meta.url);
const { getSortedRoutes } = require("next/dist/shared/lib/router/utils/sorted-routes") as {
  getSortedRoutes: (pages: string[]) => string[];
};
const { getRouteRegex } = require("next/dist/shared/lib/router/utils/route-regex") as {
  getRouteRegex: (route: string) => unknown;
};
const { getRouteMatcher } = require("next/dist/shared/lib/router/utils/route-matcher") as {
  getRouteMatcher: (regex: unknown) => (pathname: string) => Record<string, string | string[]> | false;
};
const { HTTP_METHODS } = require("next/dist/server/web/http") as { HTTP_METHODS: string[] };
const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods") as {
  autoImplementMethods: (handlers: Record<string, unknown>) => Record<string, (...args: unknown[]) => Response>;
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const dispatcher = readFileSync("app/api/[...path]/route.ts", "utf8");
// The patterns in the dispatcher's table, in its order.
const table = [...dispatcher.matchAll(/^\s+\["([^"]+)", (\w+)\],$/gm)].map((m) => ({ pattern: m[1], name: m[2] }));
const handlers = walk("app/api")
  .filter((f) => f.endsWith("/handler.ts"))
  .map((f) => f.replace(/^app\/api\//, "").replace(/\/handler\.ts$/, ""))
  .filter((p) => p !== "[...path]");

test("app/api has one route file, and its table names every handler under the pattern of its folder", () => {
  assert.deepEqual(
    walk("app/api").filter((f) => /\/route\.[jt]sx?$/.test(f)),
    ["app/api/[...path]/route.ts"],
    "a route file under app/api is a server entry of its own again – make it a handler.ts and add it to the table",
  );
  assert.ok(table.length > 50);
  assert.deepEqual(table.map((t) => t.pattern).sort(), [...handlers].sort());
  for (const { pattern, name } of table)
    assert.ok(dispatcher.includes(`import * as ${name} from "../${pattern}/handler";`), `${pattern} imports its own handler`);
});

test("the table's order is Next.js's route order", () => {
  const fake = Object.fromEntries(handlers.map((p) => [p, { GET: () => new Response(p) } as RouteModule]));
  const ours = apiRoutes(handlers.map((p) => [p, fake[p]])).map((r) => r.pattern);
  const next = getSortedRoutes([...handlers.map((p) => `/api/${p}`), "/api/[...path]"])
    .filter((r) => r !== "/api/[...path]")
    .map((r) => r.replace(/^\/api\//, ""));
  assert.deepEqual(ours, next);
});

test("addresses reach the handler and params Next.js would give them", () => {
  const modules = Object.fromEntries(handlers.map((p) => [p, { GET: () => new Response(p) } as RouteModule]));
  const routes = apiRoutes(handlers.map((p) => [p, modules[p]]));
  const sorted = getSortedRoutes([...handlers.map((p) => `/api/${p}`), "/api/[...path]"]);
  const matchers = sorted.map((route) => ({ route, match: getRouteMatcher(getRouteRegex(route)) }));
  // Every pattern filled in, one segment more and less, and some by hand.
  const fill = (p: string, extra: string[]) =>
    p
      .split("/")
      .flatMap((s) => (s.startsWith("[[...") ? extra : s.startsWith("[...") ? ["a", ...extra] : s.startsWith("[") ? ["x1"] : [s]));
  const samples = new Set<string>();
  for (const p of handlers) {
    for (const extra of [[], ["b"], ["b", "c"]]) {
      const segments = fill(p, extra);
      samples.add(segments.join("/"));
      samples.add(segments.slice(0, -1).join("/"));
    }
  }
  for (const s of [
    "health", "health/live", "health/ready", "health/other", "mobile/capture", "mobile/capture/photo", "mobile/widgets",
    "meetings", "meetings/x/y", "share/t", "share/t/files", "share/t/files/f", "share/t/files/f/ink", "share/t/files/f/other",
    "share/t/plugins/p", "forms/t/x", "ai", "scim", "scim/v2", "scim/v2/Users", "export", "export/pdf/x", "bootstrap",
    "command", "pages/p", "pages/p/ink", "files/f", "files/f/ink", "openapi.json", "issue-sync/hook", "issue-sync/hook/t",
  ])
    samples.add(s);
  samples.delete("");
  for (const sample of samples) {
    const path = sample.split("/");
    const next = matchers.find((m) => m.match(`/api/${sample}`));
    assert.ok(next, sample);
    const ours = matchApiRoute(routes, path);
    if (next.route === "/api/[...path]") {
      assert.equal(ours, null, `/api/${sample} goes to the general handler, not ${ours?.route.pattern}`);
      continue;
    }
    assert.equal(ours && `/api/${ours.route.pattern}`, next.route, `/api/${sample}`);
    assert.deepEqual(ours?.params, next.match(`/api/${sample}`), `/api/${sample} params`);
  }
});

test("methods like a route file: own ones, HEAD from GET, OPTIONS with Allow, 405 otherwise", async () => {
  const GET = () => new Response("get");
  const POST = () => new Response("post");
  const HEAD = () => new Response("head");
  const OPTIONS = () => new Response("options");
  for (const module of [{ GET }, { POST }, { GET, POST }, { GET, HEAD }, { GET, OPTIONS }, { POST, DELETE: POST, PUT: POST }, {}] as RouteModule[]) {
    const next = autoImplementMethods(module);
    for (const method of [...HTTP_METHODS, "PROPFIND"]) {
      if (!HTTP_METHODS.includes(method)) {
        assert.equal((await routeMethod(module, method)({}, {})).status, 405);
        continue;
      }
      const a = await routeMethod(module, method)({}, {});
      const b = await next[method]();
      assert.equal(a.status, b.status, method);
      assert.equal(a.headers.get("allow"), b.headers.get("allow"), method);
      assert.equal(await a.text(), await b.text(), method);
    }
  }
});

test("two handlers for the same addresses are refused", () => {
  assert.throws(() => apiRoutes([["a/[x]", {}], ["a/[y]", {}]]), /match the same addresses/);
  assert.throws(() => apiRoutes([["a/[...x]/b", {}]]), /last segment/);
});

test("handlers set no route segment options the catch-all would not keep", () => {
  // Next.js reads them from route files only; the catch-all's are nodejs
  // and force-dynamic, which every handler had (or was by its params).
  for (const pattern of [...handlers, "[...path]"]) {
    const source = readFileSync(`app/api/${pattern}/handler.ts`, "utf8");
    for (const m of source.matchAll(/^export const (runtime|dynamic|dynamicParams|revalidate|fetchCache|preferredRegion|maxDuration|experimental_ppr)\b[^\n]*/gm))
      assert.ok(
        /^export const (runtime = "nodejs"|dynamic = "force-dynamic");/.test(m[0]),
        `app/api/${pattern}/handler.ts: ${m[0]} – route segment options belong to app/api/[...path]/route.ts`,
      );
  }
});
