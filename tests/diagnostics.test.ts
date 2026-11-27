// "Für Bug-Report kopieren" (#630): the installation details in one line
// (lib/diagnostics-text.ts), the backend part filtered by the reader's
// rights (lib/diagnostics.ts), GET /api/diagnostics and the MCP tool
// get_diagnostics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-diagnostics-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_VERSION = "0.12.2";
process.env.FLOWPLAN_COMMIT = "28c0c38a0123456789abcdef0123456789abcdef";
process.env.FLOWPLAN_BUILT_AT = "2026-11-27T12:10:28.014Z";
process.env.FLOWPLAN_CHANNEL = "beta";
delete process.env.FLOWPLAN_INSTALL_METHOD;

const text = await import("../lib/diagnostics-text");
const { backendDiagnostics, detectInstallMethod, installMethod } = await import("../lib/diagnostics");
const { inRequestScope } = await import("./helpers/next-request");
const { run, id } = await import("../lib/db");
const { createSession, cookieName, adminGroup } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { handleMcpMessage, mcpToolNames } = await import("../lib/mcp");
const general = await import("../app/api/[...path]/handler");
import type { Probe } from "../lib/diagnostics";

const ADMIN_ONLY = ["node", "database", "databaseVersion", "storage", "mode", "installMethod", "installMethodSource"];
const probe = (over: Partial<Probe> = {}): Probe => ({
  exists: () => false,
  read: () => null,
  databaseKind: () => "sqlite",
  postgresMajor: async () => null,
  storage: () => "local",
  cluster: () => false,
  ...over,
});

const IPHONE_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.1.7";
const IPAD_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) FlowplanMobile/1.1.7";
const ANDROID_APP = "Mozilla/5.0 (Linux; Android 15; 24117RN76G Build/AP3A.240617.008; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36 FlowplanMobile/1.1.6";
const DESKTOP_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/38.0.0 Safari/537.36 FlowplanDesktop/1.3.14";
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

test("the backend line: version, channel, short build and the build date to the minute", () => {
  const base = { version: "0.12.1", channel: "beta" as const, commit: "28c0c38", builtAt: "2026-11-27T12:10:28.014Z" };
  assert.equal(text.backendLine(base), "Backend: Flowplan 0.12.1 (beta, build 28c0c38, built 2026-11-27T12:10Z)");
  assert.equal(
    text.backendLine({ ...base, node: "v26.13.1", installMethod: "docker-compose", database: "sqlite", databaseVersion: null, storage: "local", mode: "single" }),
    "Backend: Flowplan 0.12.1 (beta, build 28c0c38, built 2026-11-27T12:10Z, Node.js v26.13.1, docker-compose, SQLite, local disk, single instance)",
  );
  assert.equal(
    text.backendLine({ ...base, channel: "release", node: "v26.13.1", installMethod: "helm", database: "postgres", databaseVersion: 17, storage: "s3", mode: "cluster" }),
    "Backend: Flowplan 0.12.1 (release, build 28c0c38, built 2026-11-27T12:10Z, Node.js v26.13.1, helm, PostgreSQL 17, S3 storage, cluster)",
  );
  // Nothing known (a development build).
  assert.equal(text.backendLine({ version: "", channel: "", commit: "", builtAt: "" }), "Backend: Flowplan (version unknown)");
  assert.equal(text.shortBuildDate("not a date"), "");
  assert.equal(text.databaseLabel("postgres", null), "PostgreSQL");
});

test("the frontend: browser and system from the user agent, the app from its name or bridge", () => {
  const line = (hints: Parameters<typeof text.clientDiagnostics>[0]) => text.clientSummary(text.clientDiagnostics(hints));
  assert.equal(line({ userAgent: IPHONE_APP }), "iPhone, iOS 27.0.1, Flowplan app 1.1.7");
  // The iPad app asks for desktop pages; the bridge and the touch screen tell.
  assert.equal(line({ userAgent: IPAD_APP, maxTouchPoints: 5, app: { platform: "ios", version: "1.1.7" } }), "iPad, iPadOS, Flowplan app 1.1.7");
  assert.equal(line({ userAgent: IPAD_APP, app: { platform: "ios", version: "1.1.7" } }), "iPad, iPadOS, Flowplan app 1.1.7");
  assert.equal(line({ userAgent: ANDROID_APP }), "24117RN76G, Android 15, Flowplan app 1.1.6");
  // An older app without the user agent: the bridge alone.
  assert.equal(line({ userAgent: CHROME_ANDROID, app: { platform: "android", version: "1.0.2" } }), "Android 10, Flowplan app 1.0.2");
  assert.equal(line({ userAgent: DESKTOP_APP }), "macOS, Flowplan desktop 1.3.14, Electron 38");
  assert.equal(line({ userAgent: FIREFOX }), "Firefox 140, Windows");
  assert.equal(line({ userAgent: SAFARI }), "Safari 18.2, macOS");
  assert.equal(line({ userAgent: EDGE }), "Edge 141, Windows");
  assert.equal(line({ userAgent: CHROME_ANDROID }), "Chrome 141, Android 10", "Chrome's reduced user agent names no model");
  assert.equal(line({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36" }), "Chrome 141, Linux");
  assert.equal(line({}), "unknown");
  // A bridge version that is not a version is left out.
  assert.equal(line({ userAgent: CHROME_ANDROID, app: { platform: "android", version: "<b>x</b>" } }), "Android 10, Flowplan app");
});

test("the whole paragraph joins backend and frontend", () => {
  const backend = { text: "Backend: Flowplan 0.12.1 (beta, build 28c0c38, built 2026-11-27T12:10Z)" };
  assert.equal(
    text.diagnosticsText(backend, text.clientDiagnostics({ userAgent: IPHONE_APP })),
    "Backend: Flowplan 0.12.1 (beta, build 28c0c38, built 2026-11-27T12:10Z) · Frontend: iPhone, iOS 27.0.1, Flowplan app 1.1.7",
  );
});

test("a member gets version and build only – never Node, database, storage or the install method", async () => {
  const member = await backendDiagnostics({ isAdmin: false }, { FLOWPLAN_INSTALL_METHOD: "coolify", FLOWPLAN_CHANNEL: "beta" }, probe({ databaseKind: () => "postgres", storage: () => "s3", cluster: () => true }));
  assert.equal(member.scope, "member");
  for (const key of ADMIN_ONLY) assert.equal(key in member, false, key);
  assert.equal(member.text, "Backend: Flowplan 0.12.2 (beta, build 28c0c38, built 2026-11-27T12:10Z)");
  assert.doesNotMatch(member.text, /Node|coolify|PostgreSQL|S3|cluster/);
});

test("an admin gets the instance details", async () => {
  const admin = await backendDiagnostics({ isAdmin: true }, { FLOWPLAN_CHANNEL: "release", KUBERNETES_SERVICE_HOST: "10.0.0.1" }, probe({ databaseKind: () => "postgres", postgresMajor: async () => 17, storage: () => "s3", cluster: () => true }));
  assert.equal(admin.scope, "admin");
  assert.equal(admin.node, process.version);
  assert.deepEqual([admin.database, admin.databaseVersion, admin.storage, admin.mode, admin.installMethod, admin.installMethodSource], ["postgres", 17, "s3", "cluster", "kubernetes", "detected"]);
  assert.equal(admin.text, `Backend: Flowplan 0.12.2 (release, build 28c0c38, built 2026-11-27T12:10Z, Node.js ${process.version}, kubernetes, PostgreSQL 17, S3 storage, cluster)`);
  // The Kubernetes service address never goes in.
  assert.doesNotMatch(JSON.stringify(admin), /10\.0\.0\.1/);
  const sqlite = await backendDiagnostics({ isAdmin: true }, {}, probe({ exists: (p) => p === "/.dockerenv" }));
  assert.deepEqual([sqlite.database, sqlite.databaseVersion, sqlite.storage, sqlite.mode, sqlite.installMethod], ["sqlite", null, "local", "single", "docker"]);
});

test("the install method: the variable wins, otherwise Kubernetes, Podman, Docker or none", () => {
  const none = probe();
  assert.equal(detectInstallMethod({}, none), "no container");
  assert.equal(detectInstallMethod({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }, none), "kubernetes");
  assert.equal(detectInstallMethod({}, probe({ exists: (p) => p === "/run/.containerenv" })), "podman");
  assert.equal(detectInstallMethod({}, probe({ exists: (p) => p === "/.dockerenv" })), "docker");
  assert.equal(detectInstallMethod({}, probe({ read: () => "0::/system.slice/docker-abc.scope\n" })), "docker");
  assert.equal(detectInstallMethod({}, probe({ read: () => "0::/kubepods/besteffort/pod1\n" })), "kubernetes");
  assert.deepEqual(installMethod({ FLOWPLAN_INSTALL_METHOD: " docker-compose " }, probe({ exists: () => true })), { method: "docker-compose", source: "setting" });
  // A value that is nothing after cleaning falls back to detection.
  assert.deepEqual(installMethod({ FLOWPLAN_INSTALL_METHOD: "https://nas.example.org" }, probe({ exists: (p) => p === "/.dockerenv" })), { method: "docker", source: "detected" });
});

test("the install method is cleaned: no hosts, addresses, URLs or e-mail addresses, at most 40 characters", () => {
  for (const ok of ["docker-compose", "coolify", "kubernetes", "helm", "yunohost", "casaos", "bare-metal", "docker compose v2.30", "Unraid 7.1"]) assert.equal(text.cleanInstallMethod(ok), ok);
  assert.equal(text.cleanInstallMethod("docker on nas.example.org"), "docker on");
  assert.equal(text.cleanInstallMethod("portainer at 192.168.1.20"), "portainer at");
  assert.equal(text.cleanInstallMethod("proxmox lxc [2001:db8::1] host:8080"), "proxmox lxc");
  assert.equal(text.cleanInstallMethod("ask admin@example.org"), "ask");
  assert.equal(text.cleanInstallMethod("see https://wiki.example.org/flowplan"), "see");
  assert.equal(text.cleanInstallMethod("<script>alert(1)</script> helm"), "script alert 1 /script helm");
  assert.equal(text.cleanInstallMethod("a\nb\tc"), "a b c");
  assert.equal(text.cleanInstallMethod(""), "");
  assert.equal(text.cleanInstallMethod(undefined), "");
  const long = text.cleanInstallMethod("word ".repeat(30));
  assert.ok(long.length <= text.INSTALL_METHOD_MAX && long.endsWith("word"), long);
});

// ---- GET /api/diagnostics and the MCP tool ----

const APP = "https://flowplan.example.test";
async function person(name: string, groups: string[]) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  return (await createSession(uid, groups, undefined, {}, new Headers())).token;
}
const memberToken = await person("Mia", []);
const adminToken = await person("Ada", [adminGroup()]);
async function get(token: string, path = ["diagnostics"]) {
  const req = new Request(`${APP}/api/${path.join("/")}`, { headers: { cookie: `${cookieName}=${token}` } });
  const { value } = await inRequestScope(req, () => general.GET(req as never, { params: Promise.resolve({ path }) }));
  return value;
}

test("GET /api/diagnostics: the member view for members, the instance details for admins", async () => {
  const member = await get(memberToken);
  assert.equal(member.status, 200);
  assert.equal(member.headers.get("cache-control"), "no-store");
  const m = await member.json();
  assert.equal(m.scope, "member");
  assert.equal(m.version, "0.12.2");
  assert.equal(m.commit, "28c0c38");
  for (const key of ADMIN_ONLY) assert.equal(key in m, false, key);
  const a = await (await get(adminToken)).json();
  assert.equal(a.scope, "admin");
  assert.equal(a.node, process.version);
  assert.equal(a.database, "sqlite");
  assert.match(a.text, /^Backend: Flowplan 0\.12\.2 \(beta, build 28c0c38, built 2026-11-27T12:10Z, Node\.js v[\d.]+, .+, SQLite, local disk, single instance\)$/);
  // Nothing about the instance's address.
  assert.doesNotMatch(JSON.stringify(a), /example\.test/);
  // Without a session: 401.
  const req = new Request(`${APP}/api/diagnostics`);
  const { value } = await inRequestScope(req, () => general.GET(req as never, { params: Promise.resolve({ path: ["diagnostics"] }) }));
  assert.equal(value.status, 401);
});

test("the MCP tool get_diagnostics: read tokens may use it and get the member view", async () => {
  const adminIdentity = (await (await import("../lib/auth")).identityFromToken(adminToken))!;
  assert.equal(adminIdentity.isAdmin, true);
  const { token } = (await command(adminIdentity, { action: "token.create", name: "MCP read", scope: "read" })) as { token: string };
  const client = (await identityFromApiToken(`Bearer ${token}`))!;
  assert.ok(mcpToolNames(client).includes("get_diagnostics"));
  const answer = (await handleMcpMessage(client, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_diagnostics", arguments: {} } })) as unknown as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  assert.notEqual(answer.result.isError, true);
  const value = JSON.parse(answer.result.content[0].text);
  assert.equal(value.scope, "member", "API tokens never carry admin rights");
  assert.equal(value.text, "Backend: Flowplan 0.12.2 (beta, build 28c0c38, built 2026-11-27T12:10Z)");
  for (const key of ADMIN_ONLY) assert.equal(key in value, false, key);
  const listed = (await handleMcpMessage(client, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as unknown as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
  assert.equal(listed.result.tools.find((t) => t.name === "get_diagnostics")?.annotations?.readOnlyHint, true);
});
