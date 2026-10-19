import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const dataDir = mkdtempSync(join(tmpdir(), "flowplan-ai-"));
process.env.FLOWPLAN_DATA_DIR = dataDir;
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command, bootstrap } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { resolveAi, aiStatus } = await import("../lib/ai/resolve");
const { adminAiView, userAiSettings, userKeyInfo, instanceAiSettings } = await import("../lib/ai/settings");
const { sealSecret, openSecret, secretsKeyFile } = await import("../lib/ai/secrets");
const { aiStreamResponse, aiComplete } = await import("../lib/ai/run");
const { limitAi } = await import("../lib/action-limits");
const { instanceBackupStream } = await import("../lib/instance-backup");
const { exportArchive } = await import("../lib/archive");
const { exportMarkdown } = await import("../lib/markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");
import type { Identity } from "../lib/types";

const ADMIN_KEY = "sk-admin-0123456789-SECRET-abcd";
const USER_KEY = "sk-user-9876543210-PRIVATE-wxyz";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben"),
  gus = person("Gus");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, gus.id, "viewer");
run("INSERT INTO workspace_guests VALUES(?,?)", wid, gus.id);
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const page = createPage(wid, space, admin.id, "Notizen");

// An OpenAI-compatible provider on this machine.
let lastAuth = "";
const server = createServer((req, res) => {
  lastAuth = String(req.headers.authorization || "");
  req.resume();
  req.on("end", () => {
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "m1" }] }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\n');
    if (req.url?.includes("/broken/")) {
      res.write(`data: {"error":{"message":"overloaded, key ${ADMIN_KEY}"}}\n\n`);
      return res.end();
    }
    res.write('data: {"choices":[{"delta":{"content":" Welt"}}]}\n\ndata: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
after(() => server.close());

const ask = { messages: [{ role: "user" as const, content: "Hallo?" }] };
const setAi = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => command(admin, { action: "admin.ai", settings, ...extra });
const json = (value: unknown) => JSON.stringify(value);

test("AI is off by default and nothing resolves", () => {
  assert.equal(instanceAiSettings().enabled, false);
  assert.deepEqual(resolveAi(ben, "write"), { ok: false, reason: "off" });
  assert.equal(aiStatus(ben, wid).enabled, false);
  assert.equal(bootstrap(ben, wid).ai?.enabled, false);
});

test("the admin sets up a provider; the key is sealed and never returned", () => {
  const view = setAi({ enabled: true, provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  assert.ok(!json(view).includes(ADMIN_KEY));
  assert.equal(adminAiView().key.stored, true);
  assert.equal(adminAiView().key.hint, "abcd");
  const row = one<{ key_cipher: string; config: string }>("SELECT key_cipher,config FROM ai_instance")!;
  assert.ok(row.key_cipher.startsWith("fps1:") && !row.key_cipher.includes(ADMIN_KEY) && !row.config.includes(ADMIN_KEY));
  // The generated key file is private to the server user.
  assert.ok(existsSync(secretsKeyFile()));
  assert.equal(statSync(secretsKeyFile()).mode & 0o777, 0o600);
  const resolved = resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "instance" && resolved.config.apiKey === ADMIN_KEY && resolved.config.trusted);
  for (const user of [admin, ben]) {
    const boot = bootstrap(user, wid);
    assert.ok(!json(boot).includes(ADMIN_KEY), "bootstrap");
    assert.ok(!json(boot).includes(base), "no full provider address in the bootstrap");
    assert.equal(boot.ai?.provider?.local, true);
    assert.equal(boot.ai?.features.write.ok, true);
  }
  assert.ok(!one<{ detail: string }>("SELECT group_concat(detail) detail FROM audit")!.detail.includes(ADMIN_KEY));
});

test("ciphertext only opens for its owner and purpose", () => {
  const sealed = sealSecret("geheim", "ai-key:user:a");
  assert.equal(openSecret(sealed, "ai-key:user:a"), "geheim");
  assert.throws(() => openSecret(sealed, "ai-key:user:b"));
  assert.throws(() => openSecret(sealed, "ai-key:instance"));
  const tampered = sealed.slice(0, -3) + (sealed.endsWith("A") ? "BBB" : "AAA");
  assert.throws(() => openSecret(tampered, "ai-key:user:a"));
});

test("changing the provider's address or kind deletes the stored key", () => {
  setAi({ provider: { kind: "openai", baseUrl: base, model: "m2", embeddingModel: "" } });
  assert.equal(adminAiView().key.stored, true, "a new model keeps the key");
  setAi({ provider: { kind: "openai", baseUrl: base.replace("/v1", "/v2"), model: "m2", embeddingModel: "" } });
  assert.equal(adminAiView().key.stored, false, "another address drops it");
  setAi({ provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  setAi({ provider: { kind: "ollama", baseUrl: base, model: "m1", embeddingModel: "" } });
  assert.equal(adminAiView().key.stored, false, "another kind drops it");
  setAi({ provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
});

test("own providers: only when allowed, only public https, key bound to the person and the address", () => {
  const provider = { kind: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-x", embeddingModel: "" };
  assert.throws(() => command(ben, { action: "ai.provider", provider, apiKey: USER_KEY }), /nicht erlaubt/);
  setAi({ userProviders: true });
  for (const url of ["http://api.example.com/v1", "https://127.0.0.1/v1", "https://10.0.0.8/v1", "https://169.254.169.254/latest", "https://[::1]/v1"])
    assert.throws(() => command(ben, { action: "ai.provider", provider: { ...provider, baseUrl: url }, apiKey: USER_KEY }), /https|Interne/, url);
  command(ben, { action: "ai.provider", provider, apiKey: USER_KEY });
  assert.deepEqual(userKeyInfo(ben.id), { stored: true, hint: "wxyz", unreadable: false });
  assert.ok(!json(userAiSettings(ben.id)).includes(USER_KEY));
  // The instance stays the default; the person can choose their own.
  let resolved = resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "instance");
  command(ben, { action: "ai.settings", source: "user" });
  resolved = resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "user" && resolved.config.apiKey === USER_KEY && !resolved.config.trusted);
  assert.ok(!json(bootstrap(ben, wid)).includes(USER_KEY));
  // Copied into another person's row, the sealed key does not open.
  const cipher = one<{ key_cipher: string }>("SELECT key_cipher FROM ai_user_settings WHERE user_id=?", ben.id)!.key_cipher;
  run("INSERT INTO ai_user_settings(user_id,config,key_cipher,key_hint) VALUES(?,?,?,?)", admin.id, JSON.stringify({ provider, source: "user" }), cipher, "wxyz");
  assert.equal(userKeyInfo(admin.id).unreadable, true);
  const fallback = resolveAi(admin, "write", { workspaceId: wid });
  assert.ok(fallback.ok && fallback.source === "instance" && fallback.config.apiKey === ADMIN_KEY, "the unreadable copy is never used");
  run("DELETE FROM ai_user_settings WHERE user_id=?", admin.id);
  // Another address: the key is gone.
  command(ben, { action: "ai.provider", provider: { ...provider, baseUrl: "https://other.example.com/v1" } });
  assert.equal(userKeyInfo(ben.id).stored, false);
  command(ben, { action: "ai.provider", provider, apiKey: USER_KEY });
  // Own providers switched off by the admin: back to the instance.
  setAi({ userProviders: false });
  resolved = resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "instance");
  // Only own providers (hosted instance): instance provider off, own key on.
  setAi({ userProviders: true, provider: null });
  resolved = resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "user");
  assert.deepEqual(resolveAi(admin, "write", { workspaceId: wid }), { ok: false, reason: "no-provider" });
  setAi({ userProviders: false, provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  command(ben, { action: "ai.provider", provider: null });
  assert.equal(userKeyInfo(ben.id).stored, false, "removing the provider removes the key");
});

test("API tokens and demo accounts neither change AI settings nor use AI", () => {
  const { token } = command(ben, { action: "token.create", name: "Skript", scope: "write" }) as { token: string };
  const viaToken = identityFromApiToken(`Bearer ${token}`)!;
  for (const action of [
    { action: "ai.settings", enabled: false },
    { action: "ai.provider", provider: null },
    { action: "ai.rule", targetId: wid, mode: "exclude" },
    { action: "ai.block", targetId: page, kind: "page", blocked: true },
  ])
    assert.throws(() => command(viaToken, action), /API-Token/);
  assert.throws(() => command({ ...viaToken, isAdmin: true }, { action: "admin.ai", settings: { enabled: false } }), /API-Token/);
  assert.deepEqual(resolveAi(viaToken, "write", { workspaceId: wid }), { ok: false, reason: "api-token" });
  assert.equal(aiStatus(viaToken, wid).enabled, false);
  const demo = { ...person("Demo"), demo: true };
  assert.throws(() => command(demo, { action: "ai.settings", enabled: false }), /Demo/);
  assert.deepEqual(resolveAi(demo, "write"), { ok: false, reason: "demo" });
  assert.throws(() => command(ben, { action: "admin.ai", settings: { enabled: false } }), /Administrator/);
  assert.throws(() => command(ben, { action: "admin.aiUser", userId: ben.id, allowed: true }), /Administrator/);
});

test("resolver rules: features, people, guests, own switches", () => {
  const ok = (user: Identity, feature = "write") => resolveAi(user, feature, { workspaceId: wid });
  assert.equal(ok(ben).ok, true);
  assert.deepEqual(ok(ben, "nonsense"), { ok: false, reason: "unknown-feature" });
  // Feature forbidden by the admin.
  setAi({ features: { summarize: false } });
  assert.deepEqual(ok(ben, "summarize"), { ok: false, reason: "feature-off" });
  assert.equal(ok(ben, "write").ok, true);
  setAi({ features: { summarize: true } });
  // Feature and AI switched off by the person.
  command(ben, { action: "ai.settings", features: { ask: false } });
  assert.deepEqual(ok(ben, "ask"), { ok: false, reason: "user-feature-off" });
  assert.equal(ok(ben, "write").ok, true);
  command(ben, { action: "ai.settings", enabled: false });
  assert.deepEqual(ok(ben, "write"), { ok: false, reason: "user-off" });
  command(ben, { action: "ai.settings", enabled: true, features: { ask: true } });
  // Only selected people.
  setAi({ access: "selected" });
  assert.deepEqual(ok(ben), { ok: false, reason: "not-allowed" });
  command(admin, { action: "admin.aiUser", userId: ben.id, allowed: true });
  assert.equal(ok(ben).ok, true);
  assert.deepEqual(resolveAi(admin, "write", { workspaceId: wid }), { ok: false, reason: "not-allowed" });
  command(admin, { action: "admin.aiUser", userId: ben.id, allowed: false });
  assert.deepEqual(ok(ben), { ok: false, reason: "not-allowed" });
  setAi({ access: "everyone" });
  // Guests: off unless allowed.
  assert.deepEqual(ok(gus), { ok: false, reason: "guest" });
  assert.deepEqual(resolveAi(gus, "write"), { ok: false, reason: "guest" }, "guest everywhere");
  setAi({ guests: true });
  assert.equal(ok(gus).ok, true);
  setAi({ guests: false });
  // Master switch.
  setAi({ enabled: false });
  assert.deepEqual(ok(ben), { ok: false, reason: "off" });
  setAi({ enabled: true });
});

test("streaming through the core: plain text, late errors marked, keys redacted", async () => {
  const controller = new AbortController();
  const response = await aiStreamResponse(ben, "write", ask, { workspaceId: wid, signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), "Hallo Welt");
  assert.equal(lastAuth, `Bearer ${ADMIN_KEY}`);
  assert.equal(await aiComplete(ben, "write", { ...ask, system: "Kurz." }, { workspaceId: wid }), "Hallo Welt");
  // Refusals come before anything streams.
  await assert.rejects(aiStreamResponse(gus, "write", ask, { workspaceId: wid, signal: controller.signal }), /Gäste/);
  await assert.rejects(aiStreamResponse(ben, "write", { messages: [{ role: "user", content: "x".repeat(200_001) }] }, { workspaceId: wid, signal: controller.signal }));
  // A provider failing mid-way: text, then U+001E and the error – without the key.
  setAi({ provider: { kind: "openai", baseUrl: base.replace("/v1", "/broken/v1"), model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  const broken = await (await aiStreamResponse(ben, "write", ask, { workspaceId: wid, signal: controller.signal })).text();
  assert.ok(broken.startsWith("Hallo\u001e"));
  assert.match(JSON.parse(broken.split("\u001e")[1]).error, /overloaded/);
  assert.ok(!broken.includes(ADMIN_KEY));
  setAi({ provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
});

test("AI calls are rate-limited per person", () => {
  const someone = id();
  for (let i = 0; i < 30; i++) limitAi(someone);
  assert.throws(() => limitAi(someone), /Zu viele KI-Anfragen/);
});

test("no plaintext key in the instance backup, workspace export or Markdown export; the key file stays out", async () => {
  command(ben, { action: "ai.provider", provider: null });
  setAi({ userProviders: true });
  command(ben, { action: "ai.provider", provider: { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", embeddingModel: "" }, apiKey: USER_KEY });
  const chunks: Buffer[] = [];
  for await (const chunk of instanceBackupStream() as Readable) chunks.push(chunk as Buffer);
  const backup = await readExportZip(Buffer.concat(chunks));
  assert.ok(backup.has("flowplan.sqlite"));
  assert.ok(![...backup.keys()].some((name) => name.includes("secrets")), "secrets.key is not in the backup");
  for (const [name, bytes] of backup) {
    assert.ok(!bytes.includes(ADMIN_KEY), name);
    assert.ok(!bytes.includes(USER_KEY), name);
  }
  assert.ok(!readFileSync(join(dataDir, "flowplan.sqlite")).includes(USER_KEY));
  const archive = await readExportZip(await exportArchive(admin, wid));
  for (const [name, bytes] of archive) assert.ok(!bytes.includes(ADMIN_KEY) && !bytes.includes(USER_KEY) && !bytes.includes("fps1:"), name);
  const markdown = await exportMarkdown(admin, { pageId: page, format: "zip", includeSubpages: true, history: true });
  const text = Buffer.from(markdown.bytes as Uint8Array).toString("latin1");
  assert.ok(!text.includes(ADMIN_KEY) && !text.includes(USER_KEY));
});

test("deleting an account removes its AI settings and key", () => {
  const temp = person("Temp");
  setAi({ userProviders: true });
  command(temp, { action: "ai.provider", provider: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-x", embeddingModel: "" }, apiKey: USER_KEY });
  assert.ok(one("SELECT 1 FROM ai_user_settings WHERE user_id=?", temp.id));
  run("DELETE FROM users WHERE id=?", temp.id);
  assert.equal(one("SELECT 1 FROM ai_user_settings WHERE user_id=?", temp.id), undefined);
});
