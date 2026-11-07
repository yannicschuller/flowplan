import { test } from "node:test";
import { onPostgres } from "./helpers/backend";
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
const { run, one, id, sql } = await import("../lib/db");
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

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben"),
  gus = await person("Gus");
const wid = await createWorkspace(admin.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, gus.id, "viewer");
await run("INSERT INTO workspace_guests VALUES(?,?)", wid, gus.id);
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const page = await createPage(wid, space, admin.id, "Notizen");

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
// Not closed in an after() hook: node:test may run a top-level hook while
// the file still awaits between tests, and later tests would find the
// server gone. unref() lets the process end without it.
server.unref();

const ask = { messages: [{ role: "user" as const, content: "Hallo?" }] };
const setAi = async (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => await command(admin, { action: "admin.ai", settings, ...extra });
const json = (value: unknown) => JSON.stringify(value);

test("AI is off by default and nothing resolves", async () => {
  assert.equal((await instanceAiSettings()).enabled, false);
  assert.deepEqual(await resolveAi(ben, "write"), { ok: false, reason: "off" });
  assert.equal((await aiStatus(ben, wid)).enabled, false);
  assert.equal((await bootstrap(ben, wid)).ai?.enabled, false);
});

test("the admin sets up a provider; the key is sealed and never returned", async () => {
  const view = await setAi({ enabled: true, provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  assert.ok(!json(view).includes(ADMIN_KEY));
  assert.equal((await adminAiView()).key.stored, true);
  assert.equal((await adminAiView()).key.hint, "abcd");
  const row = (await one<{ key_cipher: string; config: string }>("SELECT key_cipher,config FROM ai_instance"))!;
  assert.ok(row.key_cipher.startsWith("fps1:") && !row.key_cipher.includes(ADMIN_KEY) && !row.config.includes(ADMIN_KEY));
  // The generated key file is private to the server user.
  assert.ok(existsSync(secretsKeyFile()));
  assert.equal(statSync(secretsKeyFile()).mode & 0o777, 0o600);
  const resolved = await resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "instance" && resolved.config.apiKey === ADMIN_KEY && resolved.config.trusted);
  for (const user of [admin, ben]) {
    const boot = await bootstrap(user, wid);
    assert.ok(!json(boot).includes(ADMIN_KEY), "bootstrap");
    assert.ok(!json(boot).includes(base), "no full provider address in the bootstrap");
    assert.equal(boot.ai?.provider?.local, true);
    assert.equal(boot.ai?.features.write.ok, true);
  }
  assert.ok(!(await one<{ detail: string }>(`SELECT ${sql.groupConcat("detail")} detail FROM audit`))!.detail.includes(ADMIN_KEY));
});

test("ciphertext only opens for its owner and purpose", () => {
  const sealed = sealSecret("geheim", "ai-key:user:a");
  assert.equal(openSecret(sealed, "ai-key:user:a"), "geheim");
  assert.throws(() => openSecret(sealed, "ai-key:user:b"));
  assert.throws(() => openSecret(sealed, "ai-key:instance"));
  const tampered = sealed.slice(0, -3) + (sealed.endsWith("A") ? "BBB" : "AAA");
  assert.throws(() => openSecret(tampered, "ai-key:user:a"));
});

test("changing the provider's address or kind deletes the stored key", async () => {
  await setAi({ provider: { kind: "openai", baseUrl: base, model: "m2", embeddingModel: "" } });
  assert.equal((await adminAiView()).key.stored, true, "a new model keeps the key");
  await setAi({ provider: { kind: "openai", baseUrl: base.replace("/v1", "/v2"), model: "m2", embeddingModel: "" } });
  assert.equal((await adminAiView()).key.stored, false, "another address drops it");
  await setAi({ provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  await setAi({ provider: { kind: "ollama", baseUrl: base, model: "m1", embeddingModel: "" } });
  assert.equal((await adminAiView()).key.stored, false, "another kind drops it");
  await setAi({ provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
});

test("own providers: only when allowed, only public https, key bound to the person and the address", async () => {
  const provider = { kind: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-x", embeddingModel: "" };
  await assert.rejects(async () => await command(ben, { action: "ai.provider", provider, apiKey: USER_KEY }), /nicht erlaubt/);
  await setAi({ userProviders: true });
  for (const url of ["http://api.example.com/v1", "https://127.0.0.1/v1", "https://10.0.0.8/v1", "https://169.254.169.254/latest", "https://[::1]/v1"])
    await assert.rejects(async () => await command(ben, { action: "ai.provider", provider: { ...provider, baseUrl: url }, apiKey: USER_KEY }), /https|Interne/, url);
  await command(ben, { action: "ai.provider", provider, apiKey: USER_KEY });
  assert.deepEqual(await userKeyInfo(ben.id), { stored: true, hint: "wxyz", unreadable: false });
  assert.ok(!json(await userAiSettings(ben.id)).includes(USER_KEY));
  // The instance stays the default; the person can choose their own.
  let resolved = await resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "instance");
  await command(ben, { action: "ai.settings", source: "user" });
  resolved = await resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "user" && resolved.config.apiKey === USER_KEY && !resolved.config.trusted);
  assert.ok(!json(await bootstrap(ben, wid)).includes(USER_KEY));
  // Copied into another person's row, the sealed key does not open.
  const cipher = (await one<{ key_cipher: string }>("SELECT key_cipher FROM ai_user_settings WHERE user_id=?", ben.id))!.key_cipher;
  await run("INSERT INTO ai_user_settings(user_id,config,key_cipher,key_hint) VALUES(?,?,?,?)", admin.id, JSON.stringify({ provider, source: "user" }), cipher, "wxyz");
  assert.equal((await userKeyInfo(admin.id)).unreadable, true);
  const fallback = await resolveAi(admin, "write", { workspaceId: wid });
  assert.ok(fallback.ok && fallback.source === "instance" && fallback.config.apiKey === ADMIN_KEY, "the unreadable copy is never used");
  await run("DELETE FROM ai_user_settings WHERE user_id=?", admin.id);
  // Another address: the key is gone.
  await command(ben, { action: "ai.provider", provider: { ...provider, baseUrl: "https://other.example.com/v1" } });
  assert.equal((await userKeyInfo(ben.id)).stored, false);
  await command(ben, { action: "ai.provider", provider, apiKey: USER_KEY });
  // Own providers switched off by the admin: back to the instance.
  await setAi({ userProviders: false });
  resolved = await resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "instance");
  // Only own providers (hosted instance): instance provider off, own key on.
  await setAi({ userProviders: true, provider: null });
  resolved = await resolveAi(ben, "write", { workspaceId: wid });
  assert.ok(resolved.ok && resolved.source === "user");
  assert.deepEqual(await resolveAi(admin, "write", { workspaceId: wid }), { ok: false, reason: "no-provider" });
  await setAi({ userProviders: false, provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  await command(ben, { action: "ai.provider", provider: null });
  assert.equal((await userKeyInfo(ben.id)).stored, false, "removing the provider removes the key");
});

test("API tokens and demo accounts neither change AI settings nor use AI", async () => {
  const { token } = (await command(ben, { action: "token.create", name: "Skript", scope: "write" })) as { token: string };
  const viaToken = (await identityFromApiToken(`Bearer ${token}`))!;
  for (const action of [
    { action: "ai.settings", enabled: false },
    { action: "ai.provider", provider: null },
    { action: "ai.rule", targetId: wid, mode: "exclude" },
    { action: "ai.block", targetId: page, kind: "page", blocked: true },
  ])
    await assert.rejects(async () => await command(viaToken, action), /API-Token/);
  await assert.rejects(async () => await command({ ...viaToken, isAdmin: true }, { action: "admin.ai", settings: { enabled: false } }), /API-Token/);
  assert.deepEqual(await resolveAi(viaToken, "write", { workspaceId: wid }), { ok: false, reason: "api-token" });
  assert.equal((await aiStatus(viaToken, wid)).enabled, false);
  const demo = { ...(await person("Demo")), demo: true };
  await assert.rejects(async () => await command(demo, { action: "ai.settings", enabled: false }), /Demo/);
  assert.deepEqual(await resolveAi(demo, "write"), { ok: false, reason: "demo" });
  await assert.rejects(async () => await command(ben, { action: "admin.ai", settings: { enabled: false } }), /Administrator/);
  await assert.rejects(async () => await command(ben, { action: "admin.aiUser", userId: ben.id, allowed: true }), /Administrator/);
});

test("resolver rules: features, people, guests, own switches", async () => {
  const ok = async (user: Identity, feature = "write") => await resolveAi(user, feature, { workspaceId: wid });
  assert.equal((await ok(ben)).ok, true);
  assert.deepEqual(await ok(ben, "nonsense"), { ok: false, reason: "unknown-feature" });
  // Feature forbidden by the admin.
  await setAi({ features: { summarize: false } });
  assert.deepEqual(await ok(ben, "summarize"), { ok: false, reason: "feature-off" });
  assert.equal((await ok(ben, "write")).ok, true);
  await setAi({ features: { summarize: true } });
  // Feature and AI switched off by the person.
  await command(ben, { action: "ai.settings", features: { ask: false } });
  assert.deepEqual(await ok(ben, "ask"), { ok: false, reason: "user-feature-off" });
  assert.equal((await ok(ben, "write")).ok, true);
  await command(ben, { action: "ai.settings", enabled: false });
  assert.deepEqual(await ok(ben, "write"), { ok: false, reason: "user-off" });
  await command(ben, { action: "ai.settings", enabled: true, features: { ask: true } });
  // Only selected people.
  await setAi({ access: "selected" });
  assert.deepEqual(await ok(ben), { ok: false, reason: "not-allowed" });
  await command(admin, { action: "admin.aiUser", userId: ben.id, allowed: true });
  assert.equal((await ok(ben)).ok, true);
  assert.deepEqual(await resolveAi(admin, "write", { workspaceId: wid }), { ok: false, reason: "not-allowed" });
  await command(admin, { action: "admin.aiUser", userId: ben.id, allowed: false });
  assert.deepEqual(await ok(ben), { ok: false, reason: "not-allowed" });
  await setAi({ access: "everyone" });
  // Guests: off unless allowed.
  assert.deepEqual(await ok(gus), { ok: false, reason: "guest" });
  assert.deepEqual(await resolveAi(gus, "write"), { ok: false, reason: "guest" }, "guest everywhere");
  await setAi({ guests: true });
  assert.equal((await ok(gus)).ok, true);
  await setAi({ guests: false });
  // Master switch.
  await setAi({ enabled: false });
  assert.deepEqual(await ok(ben), { ok: false, reason: "off" });
  await setAi({ enabled: true });
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
  await setAi({ provider: { kind: "openai", baseUrl: base.replace("/v1", "/broken/v1"), model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
  const broken = await (await aiStreamResponse(ben, "write", ask, { workspaceId: wid, signal: controller.signal })).text();
  assert.ok(broken.startsWith("Hallo\u001e"));
  assert.match(JSON.parse(broken.split("\u001e")[1]).error, /overloaded/);
  assert.ok(!broken.includes(ADMIN_KEY));
  await setAi({ provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, { apiKey: ADMIN_KEY });
});

test("AI calls are rate-limited per person", () => {
  const someone = id();
  for (let i = 0; i < 30; i++) limitAi(someone);
  assert.throws(() => limitAi(someone), /Zu viele KI-Anfragen/);
});

test("no plaintext key in the instance backup, workspace export or Markdown export; the key file stays out", async () => {
  await command(ben, { action: "ai.provider", provider: null });
  await setAi({ userProviders: true });
  await command(ben, { action: "ai.provider", provider: { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", embeddingModel: "" }, apiKey: USER_KEY });
  const chunks: Buffer[] = [];
  for await (const chunk of (await instanceBackupStream()) as Readable) chunks.push(chunk as Buffer);
  const backup = await readExportZip(Buffer.concat(chunks));
  assert.ok(backup.has("flowplan.sqlite"));
  assert.ok(![...backup.keys()].some((name) => name.includes("secrets")), "secrets.key is not in the backup");
  for (const [name, bytes] of backup) {
    assert.ok(!bytes.includes(ADMIN_KEY), name);
    assert.ok(!bytes.includes(USER_KEY), name);
  }
  if (!onPostgres) assert.ok(!readFileSync(join(dataDir, "flowplan.sqlite")).includes(USER_KEY));
  const archive = await readExportZip(await exportArchive(admin, wid));
  for (const [name, bytes] of archive) assert.ok(!bytes.includes(ADMIN_KEY) && !bytes.includes(USER_KEY) && !bytes.includes("fps1:"), name);
  const markdown = await exportMarkdown(admin, { pageId: page, format: "zip", includeSubpages: true, history: true });
  const text = Buffer.from(markdown.bytes as Uint8Array).toString("latin1");
  assert.ok(!text.includes(ADMIN_KEY) && !text.includes(USER_KEY));
});

test("deleting an account removes its AI settings and key", async () => {
  const temp = await person("Temp");
  await setAi({ userProviders: true });
  await command(temp, { action: "ai.provider", provider: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-x", embeddingModel: "" }, apiKey: USER_KEY });
  assert.ok(await one("SELECT 1 FROM ai_user_settings WHERE user_id=?", temp.id));
  await run("DELETE FROM users WHERE id=?", temp.id);
  assert.equal(await one("SELECT 1 FROM ai_user_settings WHERE user_id=?", temp.id), undefined);
});
