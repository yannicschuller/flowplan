// Which requests a custom domain answers (proxy.ts). A verified domain shows
// exactly one publication: its pages, the publication's own read endpoints,
// the files the pages need and the build's static assets – never the app,
// the rest of the API or sign-in. Pure, so tests check it without a server.
export const CUSTOM_HOST_HEADER = "x-flowplan-custom-host";
export const VERIFY_PATH = "/.well-known/flowplan-verify.txt";

export type HostState =
  | { status: "none" }
  // Added, not verified yet: only the verification file is served.
  | { status: "pending"; verifyToken: string }
  // Verified, but the publication ended (or has a password).
  | { status: "gone"; verifyToken: string }
  | { status: "verified"; verifyToken: string; token: string };

export type HostRoute =
  | { kind: "rewrite"; path: string }
  | { kind: "redirect"; path: string }
  | { kind: "next" }
  | { kind: "text"; body: string }
  | { kind: "notFound" };

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Build output and public assets every page needs.
const ASSET = /^\/(_next\/static\/|_next\/image$|fonts\/|icons\/|pdfjs\/)|^\/(fonts\.css|icon\.svg|favicon\.ico)$/;

export function customHostRoute(state: HostState, pathname: string, method: string): HostRoute {
  if (state.status === "none") return { kind: "next" };
  const read = method === "GET" || method === "HEAD";
  if (pathname === VERIFY_PATH && read) return { kind: "text", body: state.verifyToken };
  if (state.status !== "verified" || !read) return { kind: "notFound" };
  const token = state.token.replace(/[^\w-]/g, "");
  if (!token) return { kind: "notFound" };
  if (ASSET.test(pathname) && !pathname.includes("..")) return { kind: "next" };
  if (pathname === "/") return { kind: "rewrite", path: `/share/${token}` };
  if (pathname === "/robots.txt") return { kind: "rewrite", path: "/api/domains/robots" };
  if (pathname === "/sitemap.xml") return { kind: "rewrite", path: "/api/domains/sitemap" };
  const page = new RegExp(`^/(${ID})$`, "i").exec(pathname);
  if (page) return { kind: "rewrite", path: `/share/${token}/${page[1]}` };
  // Old links inside the publication: to the short address.
  if (pathname === `/share/${token}`) return { kind: "redirect", path: "/" };
  const shared = new RegExp(`^/share/${token}/(${ID})$`, "i").exec(pathname);
  if (shared) return { kind: "redirect", path: `/${shared[1]}` };
  // The publication's own read endpoints (files, live updates, plugin
  // blocks); unlocking a password is not one of them.
  const api = new RegExp(`^/api/share/${token}(/(files/${ID}|live|plugins/${ID}))?$`, "i").exec(pathname);
  if (api) return { kind: "next" };
  return { kind: "notFound" };
}

// The Content Security Policy on a custom domain: as strict as the app's,
// and the pages may not be framed anywhere.
export function customHostPolicy(policy: string) {
  return policy.replace(/frame-ancestors [^;]+/, "frame-ancestors 'none'");
}
