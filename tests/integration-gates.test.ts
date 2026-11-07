// The doors next to /api/command honour the same gates: while an instance
// move has frozen the source (lib/instance-read-only.ts) MCP write tools,
// the browser extension and SCIM provisioning answer 423 and change
// nothing; an address the administrators blocked (Administration →
// Sicherheit) is signed out on /api/mcp and the extension's endpoints too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-gates-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_TRUSTED_PROXIES = "1";
const { run, one, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { identityFromToken, checkOrigin } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { MOVE_KEY } = await import("../lib/instance-read-only");
const { handleMcpMessage } = await import("../lib/mcp");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { createScimToken, handleScim } = await import("../lib/scim");
const { securityAction } = await import("../lib/security-admin");
const mcpRoute = await import("../app/api/mcp/route");
const clipperRoute = await import("../app/api/clipper/[action]/route");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ana", "ana@example.test");
const st = randomBytes(16).toString("hex");
run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(st).digest("hex"), uid, "[]", Date.now() + 3600_000);
const ana = identityFromToken(st)!;
const wid = createWorkspace(ana.id, "Team");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const { token } = command(ana, { action: "token.create", name: "mcp", scope: "write" }) as { token: string };
const pages = () => Number(one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=?", wid)!.n);

const createPageCall = (title: string) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_page", arguments: { workspaceId: wid, spaceId: space, title } } });
const mcp = (body: string, headers: Record<string, string> = {}) =>
  mcpRoute.POST(
    new Request("https://flowplan.example.test/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body,
    }),
  );
const clip = (headers: Record<string, string> = {}) =>
  clipperRoute.POST(
    new Request("https://flowplan.example.test/api/clipper/save", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ mode: "page", target: { workspaceId: wid, spaceId: space }, url: "https://news.example/a", title: "Clip", html: "<p>x</p>" }),
    }),
    { params: Promise.resolve({ action: "save" }) },
  );
const freeze = () => run("INSERT OR REPLACE INTO instance_settings(key,value) VALUES(?,?)", MOVE_KEY, JSON.stringify({ id: "m", hash: "x", readOnlyAt: Date.now() }));
const thaw = () => run("DELETE FROM instance_settings WHERE key=?", MOVE_KEY);

test("while the instance moves: MCP write tools, the extension and SCIM answer 423 and change nothing", async () => {
  freeze();
  try {
    assert.throws(
      () => checkOrigin(new Request("https://flowplan.example.test/api/command", { method: "POST", headers: { authorization: `Bearer ${token}` } })),
      (e: { status?: number }) => e.status === 423,
      "/api/command as the reference",
    );
    const before = pages();
    const res = await mcp(createPageCall("Written while read-only"));
    assert.equal(res.status, 423);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /schreibgeschützt/);
    assert.equal(pages(), before, "no page from MCP");
    // Reading tools keep working.
    const read = (await handleMcpMessage(identityFromApiToken(`Bearer ${token}`)!, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_workspaces", arguments: {} } })) as {
      result?: { isError?: boolean };
    };
    assert.ok(read.result && !read.result.isError);

    const clipped = await clip();
    assert.equal(clipped.status, 423);
    assert.equal(pages(), before, "no page from the extension");

    const admin = id();
    run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", admin, `local:${admin}`, "Admin", "admin@example.test");
    const scim = createScimToken(admin, "Okta").token;
    const call = (method: string, path: string[], body = "") =>
      handleScim({ method, path, query: new URLSearchParams(), authorization: `Bearer ${scim}`, body });
    const users = Number(one<{ n: number }>("SELECT COUNT(*) n FROM users")!.n);
    const created = call("POST", ["Users"], JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "neu@example.test", emails: [{ value: "neu@example.test", primary: true }] }));
    assert.equal(created.status, 423);
    assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM users")!.n), users, "no account from SCIM");
    assert.equal(call("GET", ["Users"]).status, 200, "SCIM reads keep working");
  } finally {
    thaw();
  }
  // Afterwards it works again.
  const before = pages();
  assert.equal((await clip()).status, 200);
  assert.equal(pages(), before + 1);
});

test("a blocked address is signed out on /api/mcp and the extension's endpoints", async () => {
  // The administrator's own address is elsewhere.
  securityAction({ ...ana, isAdmin: true }, { action: "block.add", kind: "network", value: "203.0.113.0/24", hours: 24, reason: "" }, new Headers({ "x-forwarded-for": "198.51.100.1" }));
  const before = pages();
  const blocked = { "x-forwarded-for": "203.0.113.7" };
  assert.equal((await mcp(createPageCall("from a blocked address"), blocked)).status, 401);
  assert.equal((await clip(blocked)).status, 401);
  const targets = await clipperRoute.GET(
    new Request("https://flowplan.example.test/api/clipper/targets", { headers: { authorization: `Bearer ${token}`, ...blocked } }),
    { params: Promise.resolve({ action: "targets" }) },
  );
  assert.equal(targets.status, 401);
  assert.equal(pages(), before);
  // Another address still gets through.
  assert.equal((await clip({ "x-forwarded-for": "198.51.100.9" })).status, 200);
});
