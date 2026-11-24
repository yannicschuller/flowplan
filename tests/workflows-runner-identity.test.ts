// Who a workflow run runs as: a live run keeps the person it started for
// (#471), and an API token's AI restriction reaches activation and manual
// starts (#482).
import { test, after, mock as mocking } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wf-runner-"));
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { one } = await import("../lib/db");
const { drainWorkflows } = await import("../lib/workflows/queue");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { workflowPost } = await import("../lib/workflows/rest");
const { startOllamaMock } = await import("./helpers/ai-mock");
const S = await import("./helpers/workflow-setup");
const { act, owner, editor, node, chain, workflow, runsOf, wid, space } = S;

const html = async (p: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", p))?.html || "";

/* ---------- #471: a live run runs as the person it started for ---------- */

async function secretPage(tag: string) {
  const vault = (await act({ action: "space.create", workspaceId: wid, name: `Vault ${tag}`, private: true })).id as string;
  const p = (await act({ action: "page.create", workspaceId: wid, spaceId: vault, kind: "document", title: `Secret ${tag}` })).id as string;
  await assert.rejects(act({ action: "page.get", pageId: p }, editor));
  return p;
}
async function ownerActivatesHarmlessDraft(pageId: string) {
  const t = node("trigger.manual", { inputs: [] });
  const set = node("logic.set", { values: [{ name: "x", value: "1", type: "text" }] });
  await act({ action: "workflow.draft", pageId, graph: chain(t, set) }, editor);
  assert.equal((await act({ action: "workflow.activate", pageId }, owner)).ok, true);
}

test("#471: a waiting run of an editor's version does not gain a later activator's rights", async () => {
  const p = await secretPage("wait");
  const t = node("trigger.manual", { inputs: [{ name: "target", type: "text", required: false }] });
  const w = node("logic.wait", { mode: "duration", amount: 2, unit: "hours" });
  const a = node("action.page.append", { page: `{{${t.id}.inputs.target}}`, where: { kind: "end" }, blocks: [{ type: "paragraph", text: "MARK-WAIT" }] });
  const { pageId } = await workflow("Wait as editor", chain(t, w, a), editor);
  await act({ action: "workflow.run", pageId, inputs: { target: p } }, editor);
  await drainWorkflows();
  await ownerActivatesHarmlessDraft(pageId);
  mocking.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600_000 + 5000 });
  try {
    await drainWorkflows();
  } finally {
    mocking.timers.reset();
  }
  const r = (await runsOf(pageId)).at(-1)!;
  assert.equal(r.status, "failed");
  assert.equal(r.error_kind, "permission");
  assert.equal((await html(p)).includes("MARK-WAIT"), false);
  // The workflow itself goes on, as the owner.
  assert.equal((await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", pageId))!.status, "active");
});

test("#471: a failed run of an earlier runner is not retried in the new runner's name", async () => {
  const p = await secretPage("retry");
  const t = node("trigger.manual", { inputs: [{ name: "target", type: "text", required: false }] });
  const a = node("action.page.append", { page: `{{${t.id}.inputs.target}}`, where: { kind: "end" }, blocks: [{ type: "paragraph", text: "MARK-RETRY" }] });
  const { pageId } = await workflow("Retry as editor", chain(t, a), editor);
  await act({ action: "workflow.run", pageId, inputs: { target: p } }, editor);
  await drainWorkflows();
  const r = (await runsOf(pageId)).at(-1)!;
  assert.equal(r.status, "failed");
  await ownerActivatesHarmlessDraft(pageId);
  await assert.rejects(act({ action: "workflow.run.retry", runId: r.id }, editor), (e: { status?: number }) => e.status === 409);
  await drainWorkflows();
  assert.equal((await html(p)).includes("MARK-RETRY"), false);
});

test("#471: runs of the same runner still continue after an activation", async () => {
  const t = node("trigger.manual", { inputs: [] });
  const w = node("logic.wait", { mode: "duration", amount: 2, unit: "hours" });
  const s = node("logic.set", { values: [{ name: "y", value: "2", type: "text" }] });
  const { pageId } = await workflow("Same runner", chain(t, w, s), owner);
  await act({ action: "workflow.run", pageId, inputs: {} }, owner);
  await drainWorkflows();
  await act({ action: "workflow.draft", pageId, graph: chain(node("trigger.manual", { inputs: [] }), node("logic.set", { values: [] })) }, owner);
  assert.equal((await act({ action: "workflow.activate", pageId }, owner)).ok, true);
  mocking.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600_000 + 5000 });
  try {
    await drainWorkflows();
  } finally {
    mocking.timers.reset();
  }
  assert.equal((await runsOf(pageId)).at(-1)!.status, "succeeded");
});

/* ---------- #482: a token's AI restriction reaches the runner ---------- */

const admin = { ...owner, isAdmin: true };
const aiMock = await startOllamaMock();
after(() => aiMock.close());
const provider = { kind: "ollama", baseUrl: aiMock.base, model: "chat", embeddingModel: "" };

async function tokenFor(ai: boolean) {
  const created = await act({ action: "token.create", name: `t-${ai}`, scope: "write", ai });
  return (await identityFromApiToken(`Bearer ${created.token}`))!;
}
async function aiWorkflow(title: string, who = owner) {
  const t = node("trigger.manual", { inputs: [] });
  const pr = node("ai.prompt", { prompt: "PROMPT", format: "text", maxTokens: 20 });
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "workflow", title }, who)).id as string;
  await act({ action: "workflow.draft", pageId, graph: chain(t, pr) }, who);
  return pageId;
}

test("#482: a write token without the AI permission activates and starts no AI workflow", async () => {
  await act({ action: "admin.ai", settings: { enabled: true, provider } }, admin);
  const token = await tokenFor(false);
  const pageId = await aiWorkflow("Token AI");
  const before = aiMock.chats.length;
  const activated = (await workflowPost(token, ["workflows", pageId, "activate"], {})) as { ok: boolean; issues: { code: string }[] };
  assert.equal(activated.ok, false);
  assert.ok(activated.issues.some((i) => i.code === "ai_unavailable"));
  // Activated by the owner in a session: the token may not start it either.
  assert.equal((await act({ action: "workflow.activate", pageId }, owner)).ok, true);
  await assert.rejects(workflowPost(token, ["workflows", pageId, "run"], { inputs: {} }), (e: { status?: number }) => e.status === 403);
  await drainWorkflows();
  assert.equal(aiMock.chats.length, before);
  assert.equal((await runsOf(pageId)).length, 0);
  // With the permission the token activates it.
  const allowed = await tokenFor(true);
  const other = await aiWorkflow("Token AI allowed");
  assert.equal(((await workflowPost(allowed, ["workflows", other, "activate"], {})) as { ok: boolean }).ok, true);
});

test("#482: with AI switched off for tokens even a token with the permission activates no AI workflow", async () => {
  await act({ action: "admin.ai", settings: { enabled: true, provider, tokens: false } }, admin);
  const token = await tokenFor(true);
  const pageId = await aiWorkflow("Token AI off");
  const activated = (await workflowPost(token, ["workflows", pageId, "activate"], {})) as { ok: boolean; issues: { code: string }[] };
  assert.equal(activated.ok, false);
  assert.ok(activated.issues.some((i) => i.code === "ai_unavailable"));
  // A session is not affected.
  assert.equal((await act({ action: "workflow.activate", pageId }, owner)).ok, true);
  await act({ action: "admin.ai", settings: { enabled: true, provider, tokens: true } }, admin);
});
