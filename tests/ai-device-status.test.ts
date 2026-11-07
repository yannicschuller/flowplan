// On-device AI on the server's side: what the bootstrap tells the browser
// (aiStatus → device) – allowed without any provider and with the server's
// AI off, switched off by the administration or the person, the feature
// switches, "selected people", guests, API tokens, pages closed to the AI
// (closed to the device too) and end-to-end encrypted spaces (open to the
// device only). The settings take only the known modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-device-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_AI;
delete process.env.FLOWPLAN_AI_DEVICE;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { aiStatus, deviceGate, resolveAi } = await import("../lib/ai/resolve");
const { instanceAiSettings, userAiSettings } = await import("../lib/ai/settings");
import type { Identity } from "../lib/types";

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
const secretSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,encrypted) VALUES(?,?,?,?,?,1)", secretSpace, wid, "Geheim", "team", admin.id);
const page = await createPage(wid, space, admin.id, "Notizen");
const closed = await createPage(wid, space, admin.id, "Gesperrt");
const sealed = await createPage(wid, secretSpace, admin.id, "Verschlüsselt");
const visible = [page, closed, sealed].map((pageId) => ({ id: pageId }));
const setAi = async (settings: Record<string, unknown>) => await command(admin, { action: "admin.ai", settings });
const device = async (user: Identity) => (await aiStatus(user, wid, visible)).device;

test("without any provider and with the server's AI off, the light features may run on the device", async () => {
  assert.equal((await instanceAiSettings()).enabled, false);
  assert.equal((await instanceAiSettings()).device, true, "on unless switched off");
  assert.equal((await userAiSettings(ben.id)).device, "prefer");
  const status = await aiStatus(ben, wid, visible);
  assert.equal(status.enabled, false);
  assert.equal(status.features.write.ok, false);
  assert.deepEqual(status.device, { mode: "prefer", features: { write: true, summarize: true }, excludedPages: [] });
  // The server's AI is not opened by it.
  assert.deepEqual(await resolveAi(ben, "write", { workspaceId: wid }), { ok: false, reason: "off" });
  // Heavy features never on the device.
  for (const feature of ["ask", "database", "actions", "nonsense"]) assert.equal(await deviceGate(ben, feature, { workspaceId: wid }), "unknown-feature");
});

test("pages closed to the AI are closed to the device; encrypted spaces are open only to it", async () => {
  await command(admin, { action: "ai.block", targetId: closed, kind: "page", blocked: true });
  await setAi({ enabled: true, provider: { kind: "ollama", baseUrl: "http://ollama:11434", model: "m", embeddingModel: "" } });
  const status = await aiStatus(ben, wid, visible);
  assert.equal(status.enabled, true);
  assert.deepEqual([...status.excludedPages].sort(), [closed, sealed].sort(), "the server's AI reads neither");
  assert.deepEqual(status.device?.excludedPages, [closed]);
  // The person's own rules count as well.
  await command(ben, { action: "ai.rule", targetId: page, mode: "exclude" });
  assert.deepEqual([...(await device(ben))!.excludedPages].sort(), [page, closed].sort());
  await command(ben, { action: "ai.rule", targetId: page, mode: null });
  // With the server's AI off, the device still learns what is closed.
  await setAi({ enabled: false });
  assert.deepEqual((await aiStatus(ben, wid, visible)).excludedPages, []);
  assert.deepEqual((await device(ben))?.excludedPages, [closed]);
  await command(admin, { action: "ai.block", targetId: closed, kind: "page", blocked: false });
});

test("the administration switches it off for the instance, the feature switches and policies apply", async () => {
  await setAi({ device: false });
  assert.equal(await device(ben), null);
  assert.equal(await deviceGate(ben, "write", { workspaceId: wid }), "off");
  await setAi({ device: true });
  await setAi({ features: { summarize: false } });
  assert.deepEqual((await device(ben))?.features, { write: true, summarize: false });
  await setAi({ features: { summarize: true, write: false } });
  assert.deepEqual((await device(ben))?.features, { write: false, summarize: true });
  await setAi({ features: { write: true } });
  // Only selected people.
  await setAi({ access: "selected" });
  assert.equal(await device(ben), null);
  await command(admin, { action: "admin.aiUser", userId: ben.id, allowed: true });
  assert.ok(await device(ben));
  await setAi({ access: "everyone" });
  // Guests: as for the server's AI.
  assert.equal(await device(gus), null);
  await setAi({ guests: true });
  assert.ok(await device(gus));
  await setAi({ guests: false });
  // FLOWPLAN_AI_DEVICE=off as the default before an administrator saves.
  assert.equal((await instanceAiSettings()).device, true);
});

test("each person switches it off, or wants it only without server AI", async () => {
  await command(ben, { action: "ai.settings", device: "fallback" });
  assert.equal((await device(ben))?.mode, "fallback");
  await command(ben, { action: "ai.settings", device: "off" });
  assert.equal(await device(ben), null);
  assert.equal(await deviceGate(ben, "summarize", { workspaceId: wid }), "user-off");
  await command(ben, { action: "ai.settings", device: "prefer" });
  assert.equal((await device(ben))?.mode, "prefer");
  // All AI off: the device too.
  await command(ben, { action: "ai.settings", enabled: false });
  assert.equal(await device(ben), null);
  await command(ben, { action: "ai.settings", enabled: true });
  // One feature off.
  await command(ben, { action: "ai.settings", features: { write: false } });
  assert.deepEqual((await device(ben))?.features, { write: false, summarize: true });
  await command(ben, { action: "ai.settings", features: { write: true } });
  await assert.rejects(async () => await command(ben, { action: "ai.settings", device: "always" }));
  assert.equal((await userAiSettings(ben.id)).device, "prefer");
});

test("never with an API token; in the demo with the defaults (nothing reaches the server)", async () => {
  const { token } = (await command(ben, { action: "token.create", name: "Skript", scope: "write" })) as { token: string };
  const viaToken = (await identityFromApiToken(`Bearer ${token}`))!;
  assert.equal(await device(viaToken), null);
  const demo = { ...(await person("Demo")), demo: true };
  await run("INSERT INTO members VALUES(?,?,?)", wid, demo.id, "editor");
  assert.deepEqual((await device(demo))?.features, { write: true, summarize: true });
  assert.deepEqual(await resolveAi(demo, "write"), { ok: false, reason: "demo" });
  await assert.rejects(async () => await command(demo, { action: "ai.settings", device: "off" }), /Demo/);
});
