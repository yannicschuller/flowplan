// "Modelle abrufen" (#290): the models of a provider as typed in the
// settings form (lib/ai/resolve.ts draftProviderConfig). Same reach as the
// saved provider's test, the saved key only for the saved kind and address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-models-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
delete process.env.FLOWPLAN_AI;
delete process.env.FLOWPLAN_AI_PROVIDER;
delete process.env.OLLAMA_URL;
const { run, id } = await import("../lib/db");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { draftProviderConfig } = await import("../lib/ai/resolve");
const { listModels } = await import("../lib/ai/providers");
import type { Identity } from "../lib/types";

const ADMIN_KEY = "sk-admin-0123456789-SECRET-abcd";
const USER_KEY = "sk-user-9876543210-PRIVATE-wxyz";
const TYPED_KEY = "sk-typed-5555555555-DRAFT-qrst";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const ben = await person("Ben");

// An OpenAI-compatible provider on this machine that lists two models.
const seen: { url: string; auth: string }[] = [];
const server = createServer((req, res) => {
  seen.push({ url: String(req.url), auth: String(req.headers.authorization || "") });
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "llama-3.3-70b" }, { id: "qwen2.5" }] }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
server.unref();
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/v1`;
const last = () => seen[seen.length - 1];

await command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "openai", baseUrl: base, model: "m1", embeddingModel: "" } }, apiKey: ADMIN_KEY });

test("instance: the typed provider is listed even unsaved; the saved key only for the saved address", async () => {
  // Same address as saved, no key typed: the saved key goes along.
  let config = await draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: base + "/" } });
  assert.equal(config.trusted, true);
  assert.deepEqual(await listModels(config), ["llama-3.3-70b", "qwen2.5"]);
  assert.equal(last().auth, `Bearer ${ADMIN_KEY}`);
  assert.equal(last().url, "/v1/models");
  // An empty key field means the same.
  config = await draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: base }, apiKey: "" });
  assert.equal(config.apiKey, ADMIN_KEY);
  // A typed key wins.
  await listModels(await draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: base }, apiKey: TYPED_KEY }));
  assert.equal(last().auth, `Bearer ${TYPED_KEY}`);
  // The key marked for removal: none.
  await listModels(await draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: base }, apiKey: null }));
  assert.equal(last().auth, "");
  // Another address or kind (still unsaved): the saved key stays home.
  await listModels(await draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: `http://127.0.0.1:${port}/v2` } }));
  assert.equal(last().auth, "");
  assert.equal(last().url, "/v2/models");
  config = await draftProviderConfig(admin, "instance", { provider: { kind: "ollama", baseUrl: base } });
  assert.equal(config.apiKey, undefined);
});

test("instance: invalid input is refused", async () => {
  await assert.rejects(draftProviderConfig(admin, "instance", { provider: { kind: "nope", baseUrl: base } }));
  await assert.rejects(draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: base }, apiKey: "with space" }), /Ungültiger API-Schlüssel/);
  await assert.rejects(draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: "ftp://example.com" } }), /https/);
  await assert.rejects(draftProviderConfig(admin, "instance", { provider: { kind: "openai", baseUrl: "http://user:pw@example.com/v1" } }), /https/);
});

test("own provider: only when allowed, never private addresses or http", async () => {
  await assert.rejects(draftProviderConfig(ben, "user", { provider: { kind: "openai", baseUrl: "https://api.example.com/v1" } }), /nicht erlaubt/);
  await command(admin, { action: "admin.ai", settings: { userProviders: true } });
  for (const url of [base, "http://api.example.com/v1", "https://127.0.0.1/v1", "https://10.0.0.8/v1", "https://169.254.169.254/latest", "https://[::1]/v1"])
    await assert.rejects(draftProviderConfig(ben, "user", { provider: { kind: "openai", baseUrl: url } }), /https|Interne/, url);
  // A name that resolves to this machine passes the address check but not
  // the connection (pinned lookup, like the saved provider's test).
  const config = await draftProviderConfig(ben, "user", { provider: { kind: "openai", baseUrl: `https://localhost:${port}/v1` }, apiKey: TYPED_KEY });
  assert.equal(config.trusted, false);
  const before = seen.length;
  await assert.rejects(listModels(config), /Interne Adressen/);
  assert.equal(seen.length, before, "the local server was never reached");
});

test("own provider: the saved key only for the saved address, never another person's", async () => {
  const provider = { kind: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-x", embeddingModel: "" };
  await command(ben, { action: "ai.provider", provider, apiKey: USER_KEY });
  let config = await draftProviderConfig(ben, "user", { provider: { kind: "openai", baseUrl: "https://API.example.com/v1/" } });
  assert.equal(config.apiKey, USER_KEY);
  config = await draftProviderConfig(ben, "user", { provider: { kind: "openai", baseUrl: "https://other.example.com/v1" } });
  assert.equal(config.apiKey, undefined);
  config = await draftProviderConfig(ben, "user", { provider: { kind: "anthropic", baseUrl: "https://api.example.com/v1" } });
  assert.equal(config.apiKey, undefined);
  // The admin's own draft for the same address does not get Ben's key, nor the instance key.
  config = await draftProviderConfig(admin, "user", { provider: { kind: "openai", baseUrl: "https://api.example.com/v1" } });
  assert.equal(config.apiKey, undefined);
  // An unreadable saved key is reported, not sent.
  await run("UPDATE ai_user_settings SET key_cipher=? WHERE user_id=?", "fps1:broken", ben.id);
  await assert.rejects(draftProviderConfig(ben, "user", { provider: { kind: "openai", baseUrl: "https://api.example.com/v1" } }), /entschlüsseln/);
});
