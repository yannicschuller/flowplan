// Quick capture suggestions (lib/ai/capture-suggest.ts): databases of a
// workspace where the AI may not run for the person – e.g. one they are a
// guest in while "no AI for guests" is set – never reach the model, also
// when they are not the first candidate. Stub provider (tests/helpers/ai-mock.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-capture-suggest-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { suggestCapture, checkDeviceSuggestion } = await import("../lib/ai/capture-suggest");
const { resolveAi } = await import("../lib/ai/resolve");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Admin"), isAdmin: true };
const user = person("User");
// Own workspace first (sorted by name it comes second), the client's one
// where the person is a guest.
const own = createWorkspace(admin.id, "Zeta-own");
run("INSERT INTO members VALUES(?,?,?)", own, user.id, "editor");
const client = createWorkspace(admin.id, "Alpha-client");
run("INSERT INTO members VALUES(?,?,?)", client, user.id, "editor");
run("INSERT INTO workspace_guests VALUES(?,?)", client, user.id);
const ownSpace = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", own)!.id;
const clientSpace = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", client)!.id;
const inbox = createPage(own, ownSpace, user.id, "AAA Inbox", "database");
const guestDb = createPage(client, clientSpace, admin.id, "Kunde Übernahmeziele 2027", "database");
run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", guestDb, user.id, "editor");

const mock = await startOllamaMock();
after(() => mock.close());
mock.answer = () => JSON.stringify({ targetId: inbox, title: "Notiz", fields: [] });

test("a guest workspace's databases never reach the model when AI is off for guests", async () => {
  command(admin, { action: "admin.ai", settings: { enabled: true, guests: false, device: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
  assert.equal(resolveAi(user, "actions", { workspaceId: client }).ok, false);
  assert.equal(resolveAi(user, "actions", { workspaceId: own }).ok, true);
  const chats = mock.chats.length;
  const result = (await suggestCapture(user, { text: "notiz zum testen", today: "2026-11-07" })) as { suggestion: { targetId: string | null } };
  assert.equal(result.suggestion.targetId, inbox);
  const prompts = mock.chats.slice(chats).map((c) => c.prompt);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("AAA Inbox"));
  assert.ok(!prompts[0].includes("Kunde Übernahmeziele 2027"), "the guest workspace's database is not in the catalogue");
});

test("the on-device prompt and its check leave the guest workspace out as well", async () => {
  const result = (await suggestCapture(user, { text: "notiz zum testen", today: "2026-11-07", device: true })) as { device: { prompt: string } };
  assert.ok(result.device.prompt.includes("AAA Inbox"));
  assert.ok(!result.device.prompt.includes("Kunde Übernahmeziele 2027"));
  const checked = await checkDeviceSuggestion(user, { answer: { targetId: guestDb, title: "x", fields: [] } });
  assert.equal(checked.suggestion.targetId, null, "an answer naming the guest database is not accepted");
});

test("with AI for guests allowed, the guest workspace's databases are offered", async () => {
  command(admin, { action: "admin.ai", settings: { guests: true } });
  const chats = mock.chats.length;
  await suggestCapture(user, { text: "notiz zum testen", today: "2026-11-07" });
  assert.ok(mock.chats[chats].prompt.includes("Kunde Übernahmeziele 2027"));
});
