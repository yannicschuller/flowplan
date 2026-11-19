// The API's route table (app/api/[...path]/route.ts): every handler module
// under app/api is reached through that one catch-all route instead of
// being a route file – a server entry with its own copy of the shared core –
// of its own. The matching follows Next.js's: the same patterns ([param],
// [...rest], [[...optional]]) in the same order (getSortedRoutes: a route
// before its children, then static segments, [param], [...rest],
// [[...optional]]), the same params (decoded segments, as Next.js passes
// them to the catch-all), and the methods a route file would get (HEAD from
// GET, OPTIONS with an Allow header, 405 for the rest). tests/api-routes.test.ts
// compares it with Next.js's own matcher.

// Next.js's HTTP_METHODS (next/dist/server/web/http), in its order.
export const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE", "PATCH"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- every handler declares its own params
export type RouteHandler = (request: any, context: any) => Response | Promise<Response>;
export type RouteModule = Partial<Record<HttpMethod, RouteHandler>> & Record<string, unknown>;
export type RouteParams = Record<string, string | string[]>;

type Segment =
  | { kind: 0; name: string } // static
  | { kind: 1; name: string } // [name]
  | { kind: 2; name: string } // [...name]
  | { kind: 3; name: string }; // [[...name]]
export type ApiRoute = { pattern: string; segments: Segment[]; module: RouteModule };

function parse(pattern: string): Segment[] {
  const parts = pattern.split("/");
  return parts.map((part, i) => {
    const last = i === parts.length - 1;
    let m = /^\[\[\.\.\.([A-Za-z0-9_]+)\]\]$/.exec(part);
    if (m) {
      if (!last) throw new Error(`${pattern}: an optional catch-all must be the last segment`);
      return { kind: 3, name: m[1] };
    }
    m = /^\[\.\.\.([A-Za-z0-9_]+)\]$/.exec(part);
    if (m) {
      if (!last) throw new Error(`${pattern}: a catch-all must be the last segment`);
      return { kind: 2, name: m[1] };
    }
    m = /^\[([A-Za-z0-9_]+)\]$/.exec(part);
    if (m) return { kind: 1, name: m[1] };
    if (!part || /[[\]]/.test(part)) throw new Error(`${pattern}: invalid segment "${part}"`);
    return { kind: 0, name: part };
  });
}

// Next.js's order (getSortedRoutes): per level a route before its children,
// then static names, [param], [...rest], [[...optional]].
function compare(a: Segment[], b: Segment[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    if (a[i].kind !== b[i].kind) return a[i].kind - b[i].kind;
    if (a[i].kind === 0 && a[i].name !== b[i].name) return a[i].name < b[i].name ? -1 : 1;
  }
  return 0;
}

// Patterns relative to /api, e.g. "share/[token]/files/[fileId]".
export function apiRoutes(entries: [pattern: string, module: RouteModule][]): ApiRoute[] {
  const routes = entries.map(([pattern, module]) => ({ pattern, segments: parse(pattern), module }));
  routes.sort((a, b) => compare(a.segments, b.segments));
  for (let i = 1; i < routes.length; i++)
    if (compare(routes[i - 1].segments, routes[i].segments) === 0)
      throw new Error(`${routes[i - 1].pattern} and ${routes[i].pattern} match the same addresses`);
  return routes;
}

// The first route that matches the path's segments (below /api), with its
// params; null: none (the general handler answers).
export function matchApiRoute(routes: ApiRoute[], path: string[]): { route: ApiRoute; params: RouteParams } | null {
  next: for (const route of routes) {
    const params: RouteParams = {};
    const { segments } = route;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.kind >= 2) {
        // [...rest] needs one segment at least, [[...optional]] none – then
        // Next.js leaves its param out.
        const rest = path.slice(i);
        if (segment.kind === 2 && !rest.length) continue next;
        if (rest.length) params[segment.name] = rest;
        return { route, params };
      }
      if (i >= path.length || (segment.kind === 0 && path[i] !== segment.name)) continue next;
      if (segment.kind === 1) params[segment.name] = path[i];
    }
    if (path.length === segments.length) return { route, params };
  }
  return null;
}

const methodNotAllowed = () => new Response(null, { status: 405 });

// The handler for a method as Next.js makes it for a route file
// (autoImplementMethods in next/dist/server/route-modules/app-route): the
// module's own, HEAD from GET, OPTIONS answering 204 with the methods in
// Allow, otherwise 405 without a body.
export function routeMethod(module: RouteModule, method: string): RouteHandler {
  const own = (HTTP_METHODS as readonly string[]).includes(method) ? module[method as HttpMethod] : undefined;
  if (typeof own === "function") return own;
  if (method === "HEAD" && typeof module.GET === "function") return module.GET;
  if (method === "OPTIONS") {
    const implemented = HTTP_METHODS.filter((m) => typeof module[m] === "function");
    const allow: string[] = ["OPTIONS", ...implemented];
    if (!implemented.includes("HEAD") && implemented.includes("GET")) allow.push("HEAD");
    const headers = { Allow: allow.sort().join(", ") };
    return () => new Response(null, { status: 204, headers });
  }
  return methodNotAllowed;
}
