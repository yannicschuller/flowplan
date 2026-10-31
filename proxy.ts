import { NextResponse, type NextRequest } from "next/server";
import {
  CUSTOM_HOST_HEADER,
  customHostPolicy,
  customHostRoute,
  type HostState,
} from "./lib/custom-domain-routing";
import { upgradeInsecureRequests } from "./lib/instance-https";
import { BUILD_HEADER } from "./lib/stale-copy";

// Content Security Policy for every page. Scripts run only with the nonce
// of this request (Next.js adds it to its own scripts), so an injected
// script tag does nothing even if it slips past the HTML cleaning. Styles
// stay 'unsafe-inline' (the editor, KaTeX and Mermaid set inline styles);
// images may come from any HTTPS address (pasted pictures, link cards);
// frames only from the supported embed players and block extensions.
// "upgrade-insecure-requests" only where the instance is served over HTTPS
// (lib/instance-https.ts): on plain http it would send every script and
// style to an https address nobody answers (#62).
const players = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://open.spotify.com",
  "https://www.figma.com",
  "https://codepen.io",
];

export function contentSecurityPolicy(nonce: string | null, dev: boolean, pluginOrigins: string[] = [], https = true) {
  const scripts = nonce
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : // Static pages without user content (documentation) have no nonce.
      "'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval': the PDF viewer decodes some images with WebAssembly.
    `script-src ${scripts} 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    // Block extensions (lib/plugins.ts) load their frames from their own origins.
    `frame-src 'self' ${[...players, ...pluginOrigins].join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(dev || !https ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

// Lookups the proxy would repeat for every request, kept for a few seconds:
// host → custom domain state, and the origins of block extensions.
const CACHE_MS = 10_000;
const hostCache = new Map<string, { at: number; state: HostState }>();
let pluginOriginCache: { at: number; origins: string[] } | null = null;
async function pluginOrigins() {
  if (pluginOriginCache && Date.now() - pluginOriginCache.at < CACHE_MS) return pluginOriginCache.origins;
  let origins: string[] = [];
  try {
    const { pluginFrameOrigins } = await import("./lib/plugin-origins");
    origins = pluginFrameOrigins();
  } catch {}
  pluginOriginCache = { at: Date.now(), origins };
  return origins;
}
// Host names that may be custom domains: not the instance's own, not an IP
// address or a name without a dot.
function candidateHost(host: string) {
  if (!host || !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  try {
    if (host === new URL(process.env.APP_URL || "http://localhost:3000").hostname.toLowerCase()) return false;
  } catch {}
  return true;
}
async function customHostState(host: string): Promise<HostState> {
  if (!candidateHost(host)) return { status: "none" };
  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  let state: HostState = { status: "none" };
  try {
    const { hostState } = await import("./lib/custom-domains");
    state = hostState(host);
  } catch {}
  if (hostCache.size > 1000) hostCache.clear();
  hostCache.set(host, { at: Date.now(), state });
  return state;
}
// Requests that get no policy: API answers, build files, icons and fonts;
// prefetches keep the nonce of the page that loads them.
const POLICY_EXCLUDED =
  /^\/(api\/|_next\/static|_next\/image|fonts\/|icons\/|sw\.js$|fonts\.css$|manifest\.webmanifest$|icon\.svg$|favicon\.ico$)/;
const servedOverHttps = (request: NextRequest) =>
  upgradeInsecureRequests({ forwardedProto: request.headers.get("x-forwarded-proto"), requestProtocol: request.nextUrl.protocol });
const prefetch = (request: NextRequest) =>
  request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch";

// The running build (Next's BUILD_ID, lib/offline-assets-server.ts) in
// every answer that passes here, pages and API alike: stored copies of the
// app compare it with the build they belong to (#61, lib/stale-copy.ts).
// The pages carry the id anyway, so it tells a visitor nothing new.
let build: string | null = null;
async function withBuild(response: NextResponse) {
  if (build === null) {
    try {
      const { runningBuild } = await import("./lib/offline-assets-server");
      build = runningBuild();
    } catch {
      build = "";
    }
  }
  if (build) response.headers.set(BUILD_HEADER, build);
  return response;
}

// Addresses and networks the administrators blocked (Administration →
// Sicherheit, lib/security-events.ts) get nothing but a short refusal.
async function blocked(request: NextRequest) {
  try {
    const { blockedRequest } = await import("./lib/security-events");
    return blockedRequest(request.headers);
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  if (await blocked(request))
    return new NextResponse("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const path = request.nextUrl.pathname;
  const host = (request.headers.get("host") || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  // A custom domain (lib/custom-domains.ts) shows one publication and
  // nothing else; its requests never carry the app's cookies or tokens.
  const custom = await customHostState(host);
  if (custom.status !== "none") return customHostResponse(request, custom, host);
  // The custom domain marker is set here only; nobody brings their own.
  const forged = request.headers.has(CUSTOM_HOST_HEADER);
  const pass = () => {
    if (!forged) return withBuild(NextResponse.next());
    const headers = new Headers(request.headers);
    headers.delete(CUSTOM_HOST_HEADER);
    return withBuild(NextResponse.next({ request: { headers } }));
  };
  // CalDAV speaks PROPFIND and REPORT, which route handlers do not accept.
  if (path.startsWith("/api/caldav") || path.startsWith("/.well-known/caldav")) {
    const { handleCalDav } = await import("./lib/caldav");
    return handleCalDav(request);
  }
  if (POLICY_EXCLUDED.test(path) || prefetch(request)) return pass();
  // Trailing slashes are kept for CalDAV (next.config.ts); pages redirect
  // to the address without one, as before.
  if (path.length > 1 && path.endsWith("/")) {
    const url = request.nextUrl.clone();
    url.pathname = path.replace(/\/+$/, "");
    return NextResponse.redirect(url, 308);
  }
  const dev = process.env.NODE_ENV === "development";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce, dev, await pluginOrigins(), servedOverHttps(request));
  const headers = new Headers(request.headers);
  headers.delete(CUSTOM_HOST_HEADER);
  if (nonce) headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return withBuild(response);
}

async function customHostResponse(request: NextRequest, state: HostState, host: string) {
  const route = customHostRoute(state, request.nextUrl.pathname, request.method);
  const secure = (response: NextResponse) => {
    // Never a cookie on a custom domain, never framed.
    response.headers.delete("set-cookie");
    response.headers.set("X-Frame-Options", "DENY");
    return response;
  };
  const plain = (body: string, status = 200) =>
    secure(
      new NextResponse(body, {
        status,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        },
      }),
    );
  if (route.kind === "notFound") return plain("Not found", 404);
  if (route.kind === "text") return plain(route.body);
  if (route.kind === "redirect") {
    const url = request.nextUrl.clone();
    url.pathname = route.path;
    return secure(NextResponse.redirect(url, 308));
  }
  // Without the visitor's cookies and credentials: the app's session never
  // applies here, even if a browser held one for this host.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set(CUSTOM_HOST_HEADER, host);
  const page = route.kind === "rewrite" && route.path.startsWith("/share/");
  let policy = "default-src 'none'; frame-ancestors 'none'";
  if (page) {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    policy = customHostPolicy(
      contentSecurityPolicy(nonce, process.env.NODE_ENV === "development", await pluginOrigins(), servedOverHttps(request)),
    );
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", policy);
  }
  let response: NextResponse;
  if (route.kind === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = route.path;
    response = NextResponse.rewrite(url, { request: { headers } });
  } else response = NextResponse.next({ request: { headers } });
  // Static assets and the publication's read endpoints keep their own type;
  // only pages get the full policy.
  if (page || route.kind === "rewrite") response.headers.set("Content-Security-Policy", policy);
  return secure(response);
}

export const config = {
  matcher: [
    // Every request without a body: custom domains (lib/custom-domains.ts)
    // must not reach the app. Requests with a body are left out – the proxy
    // would buffer uploads in memory (proxyClientMaxBodySize) – and are
    // guarded by the origin check and by never carrying cookies there.
    { source: "/:path*", missing: [{ type: "header", key: "content-length" }] },
    "/api/caldav",
    "/api/caldav/:path*",
    "/.well-known/caldav",
    "/.well-known/caldav/:path*",
    // Pages with a body (forms posting to themselves).
    "/((?!api/|_next/static|_next/image|fonts/|icons/|sw\\.js|fonts\\.css|manifest\\.webmanifest|icon\\.svg|favicon\\.ico).*)",
  ],
};
