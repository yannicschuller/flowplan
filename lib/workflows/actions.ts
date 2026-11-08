// Wave 2 actions on workflows (docs/specs/workflows.md §8.6, §8.7, §9.5,
// §9.6, §10.4): retrying a run from the failed node, deciding approvals,
// the credentials of HTTP nodes (sealed, bound to a host, never read back)
// and the addresses of webhook triggers, and what the editor may pick
// (released chat webhooks, inbound addresses to this workflow).
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { all, audit, id, one, run } from "../db";
import { HttpError } from "../auth";
import { allow } from "../action-limits";
import { securityEvent } from "../security-events";
import type { MobileDevice } from "../mobile-devices";
import { pageRole } from "../permissions";
import { sealWorkflowCredential } from "../sealed-values";
import { workflowChatHooks } from "../webhooks";
import type { Identity, Page } from "../types";
import { afterStep, graphOf, type RunRow } from "./engine";
import { approvalResult } from "./nodes/logic";
import { personValue } from "./nodes/data";
import { requireWorkflow, draftOf } from "./store";
import { workflowLimits } from "./limits";
import { wakeAfterCommit } from "./queue";
import { ensureHook, hookCommandSchema, hookViews } from "./inbound";
import { RESERVED_HEADERS } from "./nodes/http";

const uuid = z.string().uuid();

/* ---------- Retry from the failed node (§8.6) ---------- */

// A new attempt for the failed step with the same input (the outputs before
// it stay), on the run's pinned version; the branches cancelled with the
// failure go on as they were. Only within the retention, for editors, and
// only while the workflow is active (or for a test run).
export async function retryRun(user: Identity, raw: unknown) {
  const b = z.object({ runId: uuid, fromNode: z.string().max(40).optional() }).parse(raw);
  const r = await one<RunRow & { finished_at: number | null; failed_node_id: string | null }>("SELECT * FROM workflow_runs WHERE id=?", b.runId);
  if (!r) throw new HttpError(404, "Lauf nicht gefunden.");
  await requireWorkflow(user, r.page_id, true);
  if (r.status !== "failed") throw new HttpError(409, "Nur fehlgeschlagene Läufe lassen sich wiederholen.");
  const limits = await workflowLimits();
  if (r.finished_at && r.finished_at < Date.now() - limits.runDays * 86_400_000) throw new HttpError(409, "Dieser Lauf ist zu alt zum Wiederholen.");
  const wf = await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", r.page_id);
  if (r.mode === "live" && wf?.status !== "active") throw new HttpError(409, "Der Workflow ist nicht aktiv.");
  const failed = await one<{ id: string; node_id: string }>("SELECT id,node_id FROM workflow_steps WHERE run_id=? AND status='failed' ORDER BY finished_at DESC,seq DESC LIMIT 1", r.id);
  if (!failed) throw new HttpError(409, "Kein fehlgeschlagener Schritt zum Wiederholen.");
  if (b.fromNode && b.fromNode !== failed.node_id) throw new HttpError(400, "Wiederholen geht nur ab dem fehlgeschlagenen Knoten.");
  const now = Date.now();
  await run(
    "UPDATE workflow_steps SET status='queued',attempt=attempt+1,due_at=?,error=NULL,error_kind=NULL,finished_at=NULL,lease_token=NULL,lease_until=0,claimed_by=NULL WHERE id=?",
    now,
    failed.id,
  );
  // The steps the failure cancelled: waits, approvals and loops wait again, the rest is queued.
  const since = (r.finished_at ?? now) - 5000;
  for (const s of await all<{ id: string; output: string | null; due_at: number }>("SELECT id,output,due_at FROM workflow_steps WHERE run_id=? AND status='cancelled' AND finished_at>=?", r.id, since)) {
    let state: Record<string, unknown> = {};
    try {
      state = s.output ? JSON.parse(s.output) : {};
    } catch {}
    const waits = !!state.$wait || Array.isArray(state.items);
    await run("UPDATE workflow_steps SET status=?,finished_at=NULL,lease_token=NULL,lease_until=0,claimed_by=NULL,due_at=? WHERE id=?", waits ? "waiting" : "queued", waits ? s.due_at : now, s.id);
    if (state.approvalId) await run("UPDATE workflow_approvals SET decision=NULL,decided_at=NULL WHERE id=? AND decision='cancelled'", String(state.approvalId));
  }
  await run("UPDATE workflow_runs SET status='running',failed_node_id=NULL,error=NULL,error_kind=NULL,finished_at=NULL WHERE id=?", r.id);
  await audit(user.id, "workflow.run.retried", r.page_id, `${r.id} ${failed.node_id}`);
  wakeAfterCommit();
  return { ok: true, stepId: failed.id };
}

/* ---------- Approvals (§8.7) ---------- */

type ApprovalRow = { id: string; step_id: string; run_id: string; page_id: string; approvers: string; message: string; decision: string | null; decided_by: string | null; comment: string; expires_at: number | null; created_at: number; decided_at: number | null };
const approvalView = async (a: ApprovalRow, user: Identity, page: Page) => {
  const approvers = JSON.parse(a.approvers) as string[];
  return {
    id: a.id,
    pageId: a.page_id,
    title: page.title,
    runId: a.run_id,
    message: a.message,
    decision: a.decision,
    decidedBy: await personValue(a.decided_by, page.workspace_id),
    comment: a.comment,
    approvers: (await Promise.all(approvers.map((uid) => personValue(uid, page.workspace_id)))).filter(Boolean),
    canDecide: !a.decision && approvers.includes(user.id) && !user.apiScope,
    expiresAt: a.expires_at,
    createdAt: a.created_at,
    decidedAt: a.decided_at,
  };
};
// Approvals of a workflow page (its "Approvals" tab) or the open ones of
// the person asking (mine).
export async function listApprovals(user: Identity, query: { pageId?: string; mine?: boolean; workspaceId?: string }) {
  if (query.pageId) {
    const page = await requireWorkflow(user, query.pageId);
    const rows = await all<ApprovalRow>("SELECT * FROM workflow_approvals WHERE page_id=? ORDER BY created_at DESC LIMIT 100", page.id);
    return { approvals: await Promise.all(rows.map((a) => approvalView(a, user, page))) };
  }
  const rows = await all<ApprovalRow>("SELECT * FROM workflow_approvals WHERE decision IS NULL AND approvers LIKE ? ORDER BY created_at DESC LIMIT 100", `%"${user.id}"%`);
  const out = [];
  for (const a of rows) {
    const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", a.page_id);
    if (!page || (query.workspaceId && page.workspace_id !== query.workspaceId)) continue;
    try {
      await requireWorkflow(user, page.id);
    } catch {
      continue;
    }
    out.push(await approvalView(a, user, page));
  }
  return { approvals: out };
}
export async function approvalDetail(user: Identity, approvalId: string) {
  const a = await one<ApprovalRow>("SELECT * FROM workflow_approvals WHERE id=?", uuid.parse(approvalId));
  if (!a) throw new HttpError(404, "Freigabe nicht gefunden.");
  const page = await requireWorkflow(user, a.page_id);
  return await approvalView(a, user, page);
}

// workflow.approve: one approver decides – the first decision wins, only
// signed in (no API token, no MCP: a decision of a person, open question 6).
// The run goes on as the person it runs as, not as the approver.
export async function decideApproval(user: Identity, raw: unknown) {
  if (user.apiScope) throw new HttpError(403, "Freigaben werden nur angemeldet entschieden, nicht mit einem API-Token.");
  const b = z.object({ approvalId: uuid, decision: z.enum(["approved", "rejected"]), comment: z.string().trim().max(2000).default("") }).parse(raw);
  return await settleApproval(user, b.approvalId, b.decision, b.comment, "");
}

// The decision itself, for a person already identified as themselves (a
// signed-in session, or the app's device after its checks, §11.8): only
// an approver, only while open and within its deadline; the same decision
// by the same person again is answered as done (a retried button).
async function settleApproval(user: Identity, approvalId: string, decision: "approved" | "rejected", comment: string, via: string) {
  const a = await one<ApprovalRow>("SELECT * FROM workflow_approvals WHERE id=?", approvalId);
  if (!a) throw new HttpError(404, "Freigabe nicht gefunden.");
  const page = await requireWorkflow(user, a.page_id);
  if (!(JSON.parse(a.approvers) as string[]).includes(user.id)) throw new HttpError(403, "Du bist für diese Freigabe nicht eingetragen.");
  if (a.decision === decision && a.decided_by === user.id) return { ok: true, decision, already: true };
  const now = Date.now();
  if (!a.decision && a.expires_at && a.expires_at <= now) throw new HttpError(409, "Die Frist dieser Freigabe ist abgelaufen.");
  const decided = await run("UPDATE workflow_approvals SET decision=?,decided_by=?,comment=?,decided_at=? WHERE id=? AND decision IS NULL AND (expires_at IS NULL OR expires_at>?)", decision, user.id, comment, now, a.id, now);
  if (!decided.changes) throw new HttpError(409, "Diese Freigabe ist schon entschieden oder nicht mehr nötig.");
  const runRow = await one<RunRow>("SELECT * FROM workflow_runs WHERE id=?", a.run_id);
  const step = await one<{ id: string; node_id: string; iteration: string; via: string; status: string }>("SELECT id,node_id,iteration,via,status FROM workflow_steps WHERE id=?", a.step_id);
  // A step a worker holds right now (its deadline just passed) sees the decision itself.
  if (runRow && step?.status === "waiting") {
    const graph = await graphOf(runRow);
    const node = graph?.nodes.find((n) => n.id === step.node_id);
    if (graph && node) {
      const fresh = (await one<ApprovalRow>("SELECT * FROM workflow_approvals WHERE id=?", a.id))!;
      const result = await approvalResult(fresh, String((node.config as { onTimeout?: string }).onTimeout || "timeout"), page.workspace_id);
      const done = await run("UPDATE workflow_steps SET status='succeeded',port=?,output=?,finished_at=? WHERE id=? AND status='waiting'", result.port, JSON.stringify(result.output), now, step.id);
      if (done.changes) {
        await run("UPDATE workflow_runs SET steps=steps+1 WHERE id=?", runRow.id);
        await afterStep(step, runRow, graph, node, result, result.port);
      }
    }
  }
  await audit(user.id, decision === "approved" ? "workflow.approved" : "workflow.rejected", a.page_id, via ? `${a.id} ${via}` : a.id);
  wakeAfterCommit();
  return { ok: true, decision };
}

/* ---------- Approvals on the apps' push notifications (§11.8) ---------- */

// A device unused for longer than this decides nothing from a notification
// (the app opens the approval view instead and registers again).
export const DEVICE_APPROVAL_IDLE_MS = 14 * 86_400_000;
const digestKey = (secret: string) => createHash("sha256").update(secret).digest("base64url");
const refuse = (user: Identity, device: MobileDevice, reason: string, approvalId: string, status: number, message: string) => {
  securityEvent("workflow.approval.refused", { actorId: user.id, detail: `${reason} ${approvalId} device ${device.id}` });
  return new HttpError(status, message);
};

// "Approve" / "Reject" tapped on a push notification: the person behind the
// device token (lib/mobile-devices.ts deviceFromToken), on the approval the
// notification asks for. The device must be registered for a living
// session (the token lookup), seen within DEVICE_APPROVAL_IDLE_MS before
// this request, and – to approve – bring the secret of its confirmation
// key, which the phone opens only with Face ID / Touch ID / the fingerprint.
// Rejecting needs no confirmation: it is the safe direction (§11.8).
export async function decideApprovalOnDevice(
  user: Identity,
  device: MobileDevice,
  input: { approvalId: string; decision: "approved" | "rejected"; confirmation?: string },
  now = Date.now(),
) {
  if (now - device.lastSeenAt > DEVICE_APPROVAL_IDLE_MS)
    throw refuse(user, device, "idle", input.approvalId, 403, "Dieses Gerät war zu lange nicht aktiv. Bitte in Flowplan öffnen.");
  if (input.decision === "approved") {
    const given = input.confirmation ? Buffer.from(digestKey(input.confirmation)) : null;
    const stored = device.approvalKey ? Buffer.from(device.approvalKey) : null;
    if (!stored) throw refuse(user, device, "no-key", input.approvalId, 403, "Freigeben auf diesem Gerät ist nicht eingerichtet. Bitte in Flowplan öffnen.");
    // Ten approvals per device and ten minutes, confirmed or not.
    if (!allow(`device-approval:${device.id}`, 10, 600_000)) throw new HttpError(429, "Zu viele Versuche. Bitte später in Flowplan öffnen.");
    if (!given || given.length !== stored.length || !timingSafeEqual(given, stored))
      throw refuse(user, device, "confirmation", input.approvalId, 403, "Die Bestätigung auf dem Gerät fehlt. Bitte in Flowplan öffnen.");
  }
  // The person themselves, not the device token's reading rights: the
  // checks above stand in for the signed-in session.
  const person: Identity = { ...user, apiScope: undefined };
  return await settleApproval(person, input.approvalId, input.decision, "", `app:${device.id}`);
}

/* ---------- Credentials (§9.5) ---------- */

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
const credentialInput = z.object({
  pageId: uuid,
  id: uuid.optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["bearer", "basic", "header", "query"]),
  host: z.string().trim().toLowerCase().max(260),
  // Left out when the stored value stays (same host); required for a new one or a new host.
  secret: z
    .object({ token: z.string().max(8000).optional(), username: z.string().max(500).optional(), password: z.string().max(2000).optional(), name: z.string().max(100).optional(), value: z.string().max(8000).optional() })
    .optional(),
});
function secretFor(kind: string, s: NonNullable<z.infer<typeof credentialInput>["secret"]>): Record<string, string> {
  if (kind === "bearer" && s.token) return { token: s.token };
  if (kind === "basic" && (s.username || s.password)) return { username: s.username || "", password: s.password || "" };
  if ((kind === "header" || kind === "query") && s.name && s.value && /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(s.name) && !(kind === "header" && RESERVED_HEADERS.has(s.name.toLowerCase()))) return { name: s.name, value: s.value };
  throw new HttpError(400, "Die Zugangsdaten sind unvollständig.");
}
export async function setCredential(user: Identity, raw: unknown) {
  const b = credentialInput.parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  if (!HOST.test(b.host)) throw new HttpError(400, "Ungültiger Host.");
  const now = Date.now();
  if (b.id) {
    const existing = await one<{ id: string; host: string; kind: string }>("SELECT id,host,kind FROM workflow_credentials WHERE id=? AND page_id=?", b.id, page.id);
    if (!existing) throw new HttpError(404, "Zugangsdaten nicht gefunden.");
    // A new host (or kind) never takes the old secret along.
    if ((existing.host !== b.host || existing.kind !== b.kind) && !b.secret) throw new HttpError(400, "Für einen neuen Host braucht es das Geheimnis neu.");
    const sealed = b.secret ? sealWorkflowCredential(existing.id, secretFor(b.kind, b.secret)) : null;
    await run(`UPDATE workflow_credentials SET name=?,kind=?,host=?,${sealed ? "sealed=?," : ""}updated_at=? WHERE id=?`, b.name, b.kind, b.host, ...(sealed ? [sealed] : []), now, existing.id);
    await audit(user.id, "workflow.credential.set", page.id, `${existing.id} ${b.host}`);
    return { id: existing.id };
  }
  if (!b.secret) throw new HttpError(400, "Die Zugangsdaten sind unvollständig.");
  if (Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workflow_credentials WHERE page_id=?", page.id))?.n || 0) >= 50) throw new HttpError(409, "Höchstens 50 Zugangsdaten je Workflow.");
  const credentialId = id();
  await run(
    "INSERT INTO workflow_credentials(id,page_id,name,kind,host,sealed,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    credentialId,
    page.id,
    b.name,
    b.kind,
    b.host,
    sealWorkflowCredential(credentialId, secretFor(b.kind, b.secret)),
    user.id,
    now,
    now,
  );
  await audit(user.id, "workflow.credential.set", page.id, `${credentialId} ${b.host}`);
  return { id: credentialId };
}
export async function removeCredential(user: Identity, raw: unknown) {
  const b = z.object({ pageId: uuid, id: uuid }).parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  const gone = await run("DELETE FROM workflow_credentials WHERE id=? AND page_id=?", b.id, page.id);
  if (!gone.changes) throw new HttpError(404, "Zugangsdaten nicht gefunden.");
  await audit(user.id, "workflow.credential.removed", page.id, b.id);
  return { ok: true };
}
// Name, kind and host – never the secret (§9.5).
export async function listCredentials(user: Identity, pageId: string) {
  const page = await requireWorkflow(user, pageId, true);
  const rows = await all<{ id: string; name: string; kind: string; host: string; created_by: string | null; updated_at: number }>("SELECT id,name,kind,host,created_by,updated_at FROM workflow_credentials WHERE page_id=? ORDER BY name", page.id);
  return { credentials: await Promise.all(rows.map(async (c) => ({ id: c.id, name: c.name, kind: c.kind, host: c.host, updatedAt: c.updated_at, createdBy: await personValue(c.created_by, page.workspace_id) }))) };
}

/* ---------- Webhook addresses (§9.6) ---------- */

export async function hookCommand(user: Identity, raw: unknown) {
  const b = hookCommandSchema.parse(raw);
  const page = await requireWorkflow(user, b.pageId, true);
  const draft = await draftOf(page);
  const active = await one<{ graph: string }>("SELECT v.graph FROM workflows w JOIN workflow_versions v ON v.id=w.active_version_id WHERE w.page_id=?", page.id);
  const known = draft.nodes.some((n) => n.id === b.nodeId && n.type === "trigger.webhook") || (active && JSON.parse(active.graph).nodes?.some((n: { id: string; type: string }) => n.id === b.nodeId && n.type === "trigger.webhook"));
  if (!known) throw new HttpError(400, "Kein Webhook-Auslöser.");
  await ensureHook(user, page, b.nodeId, b.rotate);
  return { hook: (await hookViews(page.id)).find((h) => h.nodeId === b.nodeId) ?? null };
}
export async function listHooks(user: Identity, pageId: string) {
  const page = await requireWorkflow(user, pageId, true);
  return { hooks: await hookViews(page.id) };
}

/* ---------- What the editor may pick ---------- */

// Released chat webhooks, inbound addresses that go to this workflow, the
// journals the person sees.
export async function workflowResources(user: Identity, pageId: string) {
  const page = await requireWorkflow(user, pageId, true);
  const addresses = await all<{ id: string; label: string; token: string; senders: string; secret: string }>("SELECT id,label,token,senders,secret FROM inbound_addresses WHERE page_id=? ORDER BY created_at", page.id);
  const journals = [];
  for (const j of await all<Page>("SELECT * FROM pages WHERE workspace_id=? AND kind='journal' AND deleted_at IS NULL ORDER BY title", page.workspace_id))
    if (await pageRole(user, j)) journals.push({ id: j.id, title: j.title, locked: !!(await one("SELECT 1 FROM journal_settings WHERE page_id=? AND lock_hash IS NOT NULL", j.id)) });
  return {
    chatHooks: await workflowChatHooks(page.workspace_id),
    addresses: addresses.map((a) => ({ id: a.id, label: a.label, signed: !!a.secret, senders: JSON.parse(a.senders) as string[] })),
    journals,
  };
}
