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
const secretSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,encrypted) VALUES(?,?,?,?,?,1)", secretSpace, wid, "Geheim", "team", admin.id);
const page = createPage(wid, space, admin.id, "Notizen");
const closed = createPage(wid, space, admin.id, "Gesperrt");
const sealed = createPage(wid, secretSpace, admin.id, "Verschlüsselt");
const visible = [page, closed, sealed].map((pageId) => ({ id: pageId }));
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });
const device = (user: Identity) => aiStatus(user, wid, visible).device;

test("without any provider and with the server's AI off, the light features may run on the device", () => {
  assert.equal(instanceAiSettings().enabled, false);
  assert.equal(instanceAiSettings().device, true, "on unless switched off");
  assert.equal(userAiSettings(ben.id).device, "prefer");
  const status = aiStatus(ben, wid, visible);
  assert.equal(status.enabled, false);
  assert.equal(status.features.write.ok, false);
  assert.deepEqual(status.device, { mode: "prefer", features: { write: true, summarize: true }, excludedPages: [] });
  // The server's AI is not opened by it.
  assert.deepEqual(resolveAi(ben, "write", { workspaceId: wid }), { ok: false, reason: "off" });
  // Heavy features never on the device.
  for (const feature of ["ask", "database", "actions", "nonsense"]) assert.equal(deviceGate(ben, feature, { workspaceId: wid }), "unknown-feature");
});

test("pages closed to the AI are closed to the device; encrypted spaces are open only to it", () => {
  command(admin, { action: "ai.block", targetId: closed, kind: "page", blocked: true });
  setAi({ enabled: true, provider: { kind: "ollama", baseUrl: "http://ollama:11434", model: "m", embeddingModel: "" } });
  const status = aiStatus(ben, wid, visible);
  assert.equal(status.enabled, true);
  assert.deepEqual([...status.excludedPages].sort(), [closed, sealed].sort(), "the server's AI reads neither");
  assert.deepEqual(status.device?.excludedPages, [closed]);
  // The person's own rules count as well.
  command(ben, { action: "ai.rule", targetId: page, mode: "exclude" });
  assert.deepEqual([...device(ben)!.excludedPages].sort(), [page, closed].sort());
  command(ben, { action: "ai.rule", targetId: page, mode: null });
  // With the server's AI off, the device still learns what is closed.
  setAi({ enabled: false });
  assert.deepEqual(aiStatus(ben, wid, visible).excludedPages, []);
  assert.deepEqual(device(ben)?.excludedPages, [closed]);
  command(admin, { action: "ai.block", targetId: closed, kind: "page", blocked: false });
});

test("the administration switches it off for the instance, the feature switches and policies apply", () => {
  setAi({ device: false });
  assert.equal(device(ben), null);
  assert.equal(deviceGate(ben, "write", { workspaceId: wid }), "off");
  setAi({ device: true });
  setAi({ features: { summarize: false } });
  assert.deepEqual(device(ben)?.features, { write: true, summarize: false });
  setAi({ features: { summarize: true, write: false } });
  assert.deepEqual(device(ben)?.features, { write: false, summarize: true });
  setAi({ features: { write: true } });
  // Only selected people.
  setAi({ access: "selected" });
  assert.equal(device(ben), null);
  command(admin, { action: "admin.aiUser", userId: ben.id, allowed: true });
  assert.ok(device(ben));
  setAi({ access: "everyone" });
  // Guests: as for the server's AI.
  assert.equal(device(gus), null);
  setAi({ guests: true });
  assert.ok(device(gus));
  setAi({ guests: false });
  // FLOWPLAN_AI_DEVICE=off as the default before an administrator saves.
  assert.equal(instanceAiSettings().device, true);
});

test("each person switches it off, or wants it only without server AI", () => {
  command(ben, { action: "ai.settings", device: "fallback" });
  assert.equal(device(ben)?.mode, "fallback");
  command(ben, { action: "ai.settings", device: "off" });
  assert.equal(device(ben), null);
  assert.equal(deviceGate(ben, "summarize", { workspaceId: wid }), "user-off");
  command(ben, { action: "ai.settings", device: "prefer" });
  assert.equal(device(ben)?.mode, "prefer");
  // All AI off: the device too.
  command(ben, { action: "ai.settings", enabled: false });
  assert.equal(device(ben), null);
  command(ben, { action: "ai.settings", enabled: true });
  // One feature off.
  command(ben, { action: "ai.settings", features: { write: false } });
  assert.deepEqual(device(ben)?.features, { write: false, summarize: true });
  command(ben, { action: "ai.settings", features: { write: true } });
  assert.throws(() => command(ben, { action: "ai.settings", device: "always" }));
  assert.equal(userAiSettings(ben.id).device, "prefer");
});

test("never with an API token; in the demo with the defaults (nothing reaches the server)", () => {
  const { token } = command(ben, { action: "token.create", name: "Skript", scope: "write" }) as { token: string };
  const viaToken = identityFromApiToken(`Bearer ${token}`)!;
  assert.equal(device(viaToken), null);
  const demo = { ...person("Demo"), demo: true };
  run("INSERT INTO members VALUES(?,?,?)", wid, demo.id, "editor");
  assert.deepEqual(device(demo)?.features, { write: true, summarize: true });
  assert.deepEqual(resolveAi(demo, "write"), { ok: false, reason: "demo" });
  assert.throws(() => command(demo, { action: "ai.settings", device: "off" }), /Demo/);
});
