import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-domains-"));
process.env.APP_URL = "https://app.example.org";
const { id, one, run } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const domains = await import("../lib/custom-domains");
const { setTxtResolver } = await import("../lib/dns-txt");
const { customHostRoute, customHostPolicy, VERIFY_PATH, CUSTOM_HOST_HEADER } = await import("../lib/custom-domain-routing");
const { NextRequest } = await import("next/server");
const { proxy } = await import("../proxy");

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { status?: number }).status ?? 400;
  }
  return 200;
};
async function rejectsWith(fn: () => Promise<unknown>, code: number) {
  await assert.rejects(fn, (error: { status?: number }) => error.status === code);
}
const owner = person("domain-owner"),
  viewer = person("domain-viewer");
const wid = createWorkspace(owner.id, "Wiki");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const create = (title: string, parentId?: string) =>
  (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title, parentId }) as { id: string }).id;
const root = create("Handbuch");
const child = create("Kapitel 1", root);
const other = create("Anderes");
const token = () => one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", root)!.public_token;

// DNS answers for the tests.
const txt = new Map<string, string[][]>();
setTxtResolver(async (name) => {
  const records = txt.get(name);
  if (!records) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return records;
});
const files = new Map<string, string>();
domains.setDomainHttpCheck(async (url) => (files.has(url) ? { status: 200, body: files.get(url)! } : { status: 404, body: "" }));

test("host names: normalised, no IPs, ports, local names or the instance itself", () => {
  assert.equal(domains.normalizeHost("Docs.Example.ORG."), "docs.example.org");
  assert.equal(domains.normalizeHost("https://docs.example.org/some/path"), "docs.example.org");
  for (const bad of ["localhost", "127.0.0.1", "docs", "docs.example.org:8443", "-docs.example.org", "docs..example.org", "do cs.example.org", "intranet.local", "app.example.org", "x".repeat(64) + ".example.org", "[::1]"])
    assert.throws(() => domains.normalizeHost(bad), Error, bad);
});

test("adding a domain: switched on by admins, published pages, editors only", () => {
  assert.equal(status(() => command(owner, { action: "domain.add", pageId: root, host: "docs.example.org" })), 403);
  saveInstanceSettings({ customDomains: true });
  assert.equal(status(() => command(owner, { action: "domain.add", pageId: root, host: "docs.example.org" })), 400, "not published");
  command(owner, { action: "page.publish", pageId: root, enabled: true, includeChildren: true });
  assert.equal(status(() => command(viewer, { action: "domain.add", pageId: root, host: "docs.example.org" })), 403);
  const added = command(owner, { action: "domain.add", pageId: root, host: "Docs.Example.org" }) as ReturnType<typeof domains.domainSettings>;
  assert.equal(added.domain?.host, "docs.example.org");
  assert.equal(added.domain?.verified, false);
  assert.equal(added.domain?.record.name, "_flowplan-verify.docs.example.org");
  assert.match(added.domain!.record.value, /^flowplan-verify-[0-9a-f]{32}$/);
  // Another publication cannot take the same host.
  command(owner, { action: "page.publish", pageId: other, enabled: true });
  assert.equal(status(() => command(owner, { action: "domain.add", pageId: other, host: "docs.example.org" })), 409);
  // Password-protected publications stay off custom domains.
  command(owner, { action: "publication.protect", pageId: other, password: "geheim-12345" });
  assert.equal(status(() => command(owner, { action: "domain.add", pageId: other, host: "other.example.org" })), 400);
  // Viewers see the status, without changing anything.
  assert.equal(domains.domainSettings(viewer, root).domain?.host, "docs.example.org");
});

test("verification: TXT record (chunked) or the verification file", async () => {
  const value = domains.domainSettings(owner, root).domain!.record.value;
  // Unverified: only the verification file is served under the host.
  assert.deepEqual(domains.hostState("docs.example.org"), { status: "pending", verifyToken: value });
  assert.deepEqual(customHostRoute(domains.hostState("docs.example.org"), VERIFY_PATH, "GET"), { kind: "text", body: value });
  assert.deepEqual(customHostRoute(domains.hostState("docs.example.org"), "/", "GET"), { kind: "notFound" });
  assert.equal(domains.domainAllowed("docs.example.org"), false);
  await rejectsWith(() => domains.verifyDomain(viewer, { pageId: root }), 403);
  txt.set("_flowplan-verify.docs.example.org", [["something-else"]]);
  const failed = await domains.verifyDomain(owner, { pageId: root });
  assert.equal(failed.method, null);
  assert.equal(failed.domain?.verified, false);
  assert.ok(failed.domain?.lastError);
  txt.set("_flowplan-verify.docs.example.org", [["v=other"], [value.slice(0, 20), value.slice(20)]]);
  const verified = await domains.verifyDomain(owner, { pageId: root });
  assert.equal(verified.method, "dns");
  assert.equal(verified.domain?.verified, true);
  assert.equal(domains.domainAllowed("docs.example.org"), true);
  assert.equal(domains.domainAllowed("DOCS.example.org"), true);
  assert.equal(domains.domainAllowed("unknown.example.org"), false);
  assert.equal(domains.domainAllowed("app.example.org"), false);
  assert.equal(domains.domainAllowed(""), false);
  // The verification file works as well.
  command(owner, { action: "publication.protect", pageId: other, password: null });
  command(owner, { action: "domain.add", pageId: other, host: "other.example.org" });
  const otherValue = domains.domainSettings(owner, other).domain!.record.value;
  files.set(`https://other.example.org${VERIFY_PATH}`, `${otherValue}\n`);
  assert.equal((await domains.verifyDomain(owner, { pageId: other })).method, "http");
  command(owner, { action: "domain.remove", pageId: other });
  assert.equal(domains.hostState("other.example.org").status, "none");
});

test("routing under a verified domain: the publication and nothing else", () => {
  const state = domains.hostState("docs.example.org");
  assert.equal(state.status, "verified");
  const t = token();
  const route = (path: string, method = "GET") => customHostRoute(state, path, method);
  assert.deepEqual(route("/"), { kind: "rewrite", path: `/share/${t}` });
  assert.deepEqual(route(`/${child}`), { kind: "rewrite", path: `/share/${t}/${child}` });
  assert.deepEqual(route(`/share/${t}/${child}`), { kind: "redirect", path: `/${child}` });
  assert.deepEqual(route(`/share/${t}`), { kind: "redirect", path: "/" });
  assert.deepEqual(route("/sitemap.xml"), { kind: "rewrite", path: "/api/domains/sitemap" });
  assert.deepEqual(route("/robots.txt"), { kind: "rewrite", path: "/api/domains/robots" });
  assert.deepEqual(route("/_next/static/chunks/app.js"), { kind: "next" });
  assert.deepEqual(route("/fonts.css"), { kind: "next" });
  assert.deepEqual(route(`/api/share/${t}/files/${child}`), { kind: "next" });
  assert.deepEqual(route(`/api/share/${t}`), { kind: "next" });
  assert.deepEqual(route(`/api/share/${t}/live`), { kind: "next" });
  for (const path of [
    "/login",
    "/register",
    "/api/command",
    "/api/bootstrap",
    "/api/auth/login",
    "/api/files/" + child,
    `/api/share/${t}/unlock`,
    `/api/share/other-token/files/${child}`,
    `/share/other-token/${child}`,
    "/templates",
    "/manifest.webmanifest",
    "/sw.js",
    "/demo",
    "/_next/static/../../api/command",
  ])
    assert.deepEqual(route(path), { kind: "notFound" }, path);
  // Nothing is written through a custom domain.
  assert.deepEqual(route("/", "POST"), { kind: "notFound" });
  assert.deepEqual(route(`/api/share/${t}/files/${child}`, "POST"), { kind: "notFound" });
  assert.match(customHostPolicy("default-src 'self'; frame-ancestors 'self'"), /frame-ancestors 'none'/);
});

test("the proxy: Host spoofing never reaches the app, no cookies or credentials pass", async () => {
  const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    new NextRequest(`https://docs.example.org${path}`, { method, headers: { host: "docs.example.org", ...headers } });
  for (const path of ["/login", "/api/bootstrap", "/api/command", "/templates"]) {
    const response = await proxy(request(path, { cookie: "flowplan_session=abc" }));
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const page = await proxy(request("/", { cookie: "flowplan_session=abc", authorization: "Bearer fp_x" }));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("x-middleware-rewrite") || "", new RegExp(`/share/${token()}$`));
  assert.match(page.headers.get("Content-Security-Policy") || "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("X-Frame-Options"), "DENY");
  const overridden = (page.headers.get("x-middleware-override-headers") || "").split(",");
  assert.ok(!overridden.includes("cookie") || !page.headers.get("x-middleware-request-cookie"));
  assert.equal(page.headers.get("x-middleware-request-cookie"), null);
  assert.equal(page.headers.get("x-middleware-request-authorization"), null);
  assert.equal(page.headers.get(`x-middleware-request-${CUSTOM_HOST_HEADER}`), "docs.example.org");
  // On the instance's own host the marker cannot be forged.
  const own = await proxy(
    new NextRequest("https://app.example.org/", { headers: { host: "app.example.org", [CUSTOM_HOST_HEADER]: "docs.example.org" } }),
  );
  assert.equal(own.headers.get(`x-middleware-request-${CUSTOM_HOST_HEADER}`), null);
  // Unknown hosts are the app as before (other proxies in front of it).
  const unknown = await proxy(new NextRequest("https://unknown.example.net/login", { headers: { host: "unknown.example.net" } }));
  assert.notEqual(unknown.status, 404);
});

test("sitemap, robots and canonical addresses for the custom host", () => {
  const sitemap = domains.domainSitemap("docs.example.org")!;
  assert.match(sitemap, /<loc>https:\/\/docs\.example\.org\/<\/loc>/);
  assert.ok(sitemap.includes(`<loc>https://docs.example.org/${child}</loc>`));
  assert.ok(!sitemap.includes(token()), "no share token in the sitemap");
  assert.match(domains.domainRobots("docs.example.org")!, /Sitemap: https:\/\/docs\.example\.org\/sitemap\.xml/);
  assert.equal(domains.domainSitemap("app.example.org"), null);
  assert.equal(domains.domainRobots("unknown.example.org"), null);
  assert.equal(domains.publicationHost(root), "docs.example.org");
  assert.equal(domains.customHostFor("docs.example.org", token()), "docs.example.org");
  assert.equal(domains.customHostFor("docs.example.org", "another-token"), null);
  assert.equal(domains.customHostFor(null, token()), null);
});

test("the look of a publication: validated, files only when published", () => {
  assert.equal(status(() => command(owner, { action: "publication.theme", pageId: root, theme: { accent: "red" } })), 400);
  assert.equal(status(() => command(owner, { action: "publication.theme", pageId: root, theme: { logo: "javascript:alert(1)" } })), 400);
  assert.equal(status(() => command(owner, { action: "publication.theme", pageId: root, theme: { logo: "http://example.org/a.png" } })), 400);
  assert.equal(status(() => command(viewer, { action: "publication.theme", pageId: root, theme: {} })), 403);
  const fileId = id();
  command(owner, {
    action: "publication.theme",
    pageId: root,
    theme: { accent: "#ff6600", logo: `/api/files/${fileId}`, favicon: "https://example.org/icon.png", footer: "© Beispiel", hideBranding: true },
  });
  const theme = domains.renderedTheme(token(), root);
  assert.equal(theme.accent, "#ff6600");
  assert.equal(theme.logo, undefined, "an unpublished file is not shown");
  assert.equal(theme.favicon, "https://example.org/icon.png");
  assert.equal(theme.footer, "© Beispiel");
  assert.equal(theme.hideBranding, true);
});

test("ending the publication or switching the feature off ends the domain", () => {
  command(owner, { action: "page.publish", pageId: root, enabled: false });
  assert.equal(domains.hostState("docs.example.org").status, "gone");
  assert.deepEqual(customHostRoute(domains.hostState("docs.example.org"), "/", "GET"), { kind: "notFound" });
  assert.equal(domains.domainAllowed("docs.example.org"), false);
  command(owner, { action: "page.publish", pageId: root, enabled: true });
  assert.equal(domains.hostState("docs.example.org").status, "verified");
  saveInstanceSettings({ customDomains: false });
  assert.equal(domains.hostState("docs.example.org").status, "none");
  assert.equal(domains.domainAllowed("docs.example.org"), false);
  saveInstanceSettings({ customDomains: true });
});
