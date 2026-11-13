// Per-person AI limits (lib/user-limits.ts, lib/ai/resolve.ts): limits.ai
// switches AI off for an account, limits.aiTokensPerMonth caps the tokens a
// month through the instance's provider – with instance defaults, admins
// unlimited – against a provider on this machine.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-billing-ai-"));
delete process.env.FLOWPLAN_AI;
delete process.env.FLOWPLAN_ENCRYPTION_KEY;
delete process.env.FLOWPLAN_ADMIN_API_TOKEN;
const { run, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { aiComplete } = await import("../lib/ai/run");
const { resolveAi } = await import("../lib/ai/resolve");
const limits = await import("../lib/user-limits");
const { isLimitError } = await import("../lib/upgrade-link");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

const person = async (name: string, isAdmin = false): Promise<Identity> => {
  const id = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `test:${id}`, name, `${id}@example.test`);
  return { id, name, email: `${id}@example.test`, groups: [], isAdmin } as never as Identity;
};
const admin = await person("Ada", true);
const wid = await createWorkspace(admin.id, "Team");
const member = async (name: string) => {
  const p = await person(name);
  await run("INSERT INTO members VALUES(?,?,?)", wid, p.id, "editor");
  return p;
};
const mock = await startOllamaMock();
after(() => mock.close());
await command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
const ask = (user: Identity) => aiComplete(user, "write", { messages: [{ role: "user", content: "x".repeat(400) }] }, { workspaceId: wid });

test("without limits AI works as before and nothing is counted", async () => {
  const ben = await member("Ben");
  assert.equal(await ask(ben), "OK");
  assert.equal(await limits.aiTokensThisMonth(ben.id), 0, "no budget, no admin API: no counter rows");
  assert.equal(await one("SELECT 1 FROM ai_usage_monthly WHERE user_id=?", ben.id), undefined);
});

test("limits.ai false switches AI off for the account, with an upgrade hint", async () => {
  const cem = await member("Cem");
  await limits.setUserLimits(cem.id, { ai: false });
  const resolved = await resolveAi(cem, "write", { workspaceId: wid });
  assert.deepEqual(resolved, { ok: false, reason: "account-off" });
  await assert.rejects(ask(cem), (e: Error & { status?: number }) => e.message === "KI ist für dein Konto nicht enthalten." && e.status === 403 && isLimitError(e));
  // The instance default, and the account's own value beating it.
  await limits.setUserLimits(cem.id, {});
  await saveInstanceSettings({ defaultUserAi: false });
  try {
    await assert.rejects(ask(cem), /nicht enthalten/);
    await limits.setUserLimits(cem.id, { ai: true });
    assert.equal(await ask(cem), "OK");
    // Admins are not limited.
    assert.equal(await ask(admin), "OK");
  } finally {
    await saveInstanceSettings({ defaultUserAi: true });
  }
});

test("a monthly token budget counts the instance provider's tokens and refuses once used up", async () => {
  const dora = await member("Dora");
  // 400 characters in, 2 out: estimated 100 + 1 tokens per request.
  await limits.setUserLimits(dora.id, { aiTokensPerMonth: 150 });
  assert.equal(await ask(dora), "OK");
  assert.equal(await limits.aiTokensThisMonth(dora.id), 101);
  assert.equal(await ask(dora), "OK", "under the budget before the request");
  assert.equal(await limits.aiTokensThisMonth(dora.id), 202);
  const chats = mock.chats.length;
  await assert.rejects(ask(dora), (e: Error & { status?: number }) => /KI-Kontingent für diesen Monat ist aufgebraucht/.test(e.message) && e.status === 429 && isLimitError(e));
  assert.equal(mock.chats.length, chats, "the provider is not asked");
  // A new month starts from zero; raising the budget or 0 (unlimited) helps at once.
  assert.equal(await limits.aiTokensThisMonth(dora.id, Date.UTC(2099, 0, 15)), 0);
  await limits.setUserLimits(dora.id, { aiTokensPerMonth: 0 });
  assert.equal(await ask(dora), "OK");
  // The instance default applies without an own value.
  await limits.setUserLimits(dora.id, {});
  await saveInstanceSettings({ defaultUserAiTokensPerMonth: 100 });
  try {
    await assert.rejects(ask(dora), /aufgebraucht/);
  } finally {
    await saveInstanceSettings({ defaultUserAiTokensPerMonth: null });
  }
});

test("with the admin API on, tokens are counted without a budget", async () => {
  const eli = await member("Eli");
  process.env.FLOWPLAN_ADMIN_API_TOKEN = "t".repeat(40);
  try {
    assert.equal(await ask(eli), "OK");
    assert.equal(await limits.aiTokensThisMonth(eli.id), 101);
  } finally {
    delete process.env.FLOWPLAN_ADMIN_API_TOKEN;
  }
});
