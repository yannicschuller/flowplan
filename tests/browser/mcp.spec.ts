import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// MCP over HTTP: the connection help in the settings, a demo session is
// refused, a person's token reaches only what they may see.
test("MCP endpoint answers tokens with the person's rights only", async ({ page, playwright }, info) => {
  test.skip(info.project.name !== "desktop", "Same on mobile.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server's data directory.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();

  await page.goto("/#settings/api");
  await expect(page.getByRole("heading", { name: "KI-Assistenten (MCP)" })).toBeVisible();
  await expect(page.getByLabel("MCP-Adresse")).toHaveText(`${origin}/api/mcp`);
  await page.getByRole("tab", { name: "Claude Code" }).click();
  await expect(page.getByLabel("Beispielkonfiguration")).toContainText("claude mcp add --transport http flowplan");

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } };
  // The demo's browser session does not open MCP.
  const demo = await page.request.post("/api/mcp", { data: initialize });
  expect(demo.status()).toBe(401);
  expect(demo.headers()["www-authenticate"]).toContain("Bearer");

  // A real person with a read and a write token, member of the demo workspace.
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  const uid = randomUUID();
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, uid, "MCP Person", `mcp-${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
  const token = (scope: string) => {
    const value = `fp_${randomBytes(30).toString("base64url")}`;
    db.prepare("INSERT INTO api_tokens(id,user_id,name,scope,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?,?)").run(
      randomUUID(), uid, scope, scope, createHash("sha256").update(value).digest("hex"), value.slice(0, 10), Date.now(),
    );
    return value;
  };
  const write = token("write"),
    read = token("read");
  db.close();

  const bare = await playwright.request.newContext({ baseURL: origin });
  const rpc = async (auth: string, method: string, params: object = {}) => {
    const res = await bare.post("/api/mcp", {
      headers: { Authorization: `Bearer ${auth}`, Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: Date.now(), method, params },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).result;
  };
  expect((await rpc(write, "initialize", initialize.params)).serverInfo.name).toBe("flowplan");
  const notified = await bare.post("/api/mcp", {
    headers: { Authorization: `Bearer ${write}` },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(notified.status()).toBe(202);
  expect((await rpc(read, "tools/list")).tools.map((t: { name: string }) => t.name)).not.toContain("create_page");

  const team = boot.spaces.find((s: { visibility: string }) => s.visibility === "team") || boot.spaces[0];
  const created = await rpc(write, "tools/call", {
    name: "create_page",
    arguments: { workspaceId: boot.workspace.id, spaceId: team.id, title: "Notiz aus MCP", markdown: "- [ ] Prüfen" },
  });
  expect(created.isError).toBeFalsy();
  const pageId = JSON.parse(created.content[0].text).id;
  const markdown = await rpc(read, "tools/call", { name: "read_page", arguments: { pageId } });
  expect(markdown.content[0].text).toContain("Prüfen");
  const refused = await rpc(read, "tools/call", { name: "append_to_page", arguments: { pageId, markdown: "x" } });
  expect(refused.isError).toBe(true);
  // A foreign origin (DNS rebinding) and an unknown token are refused.
  expect((await bare.post("/api/mcp", { headers: { Authorization: `Bearer ${write}`, Origin: "https://evil.example" }, data: initialize })).status()).toBe(403);
  expect((await bare.post("/api/mcp", { headers: { Authorization: "Bearer fp_wrongwrongwrongwrongwrong" }, data: initialize })).status()).toBe(401);
  expect((await bare.get("/api/mcp", { headers: { Authorization: `Bearer ${write}` } })).status()).toBe(405);
  await bare.dispose();

  // The demo person sees the page in the app.
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByText("Prüfen", { exact: true })).toBeVisible();
});
