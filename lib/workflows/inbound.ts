// Inbound workflow webhooks (docs/specs/workflows.md §9.6): one address per
// webhook trigger, POST /api/workflow-hooks/<token>. The token (32 bytes,
// base64url) is found by its hash and kept sealed with the signing secret.
// Signed (the default): X-Flowplan-Timestamp and X-Flowplan-Signature =
// sha256=HMAC(secret, timestamp + "." + body), at most 5 minutes off, each
// signature once (lib/replay-guard.ts: the sender's own retry gets the
// first run's id, another body 409). "Token only" is a deliberate choice
// for senders that cannot sign, with a stricter limit (10/min). The run
// starts right away (202 with its id); a sender's Idempotency-Key or
// X-Delivery-Id makes a delivery count once.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { all, audit, id, one, run, transaction } from "../db";
import { appUrl, HttpError } from "../auth";
import { allow } from "../action-limits";
import { claimOnce } from "../replay-guard";
import { securityEvent } from "../security-events";
import { openWorkflowHook, sealWorkflowHook, workflowHookTokenHash } from "../sealed-values";
import type { Identity, Page } from "../types";
import { graphOf, startLiveRun, type WorkflowRow } from "./engine";
import type { WorkflowEvent } from "./nodes/triggers";

export const HOOK_BODY_BYTES = 256 * 1024;
const SKEW_S = 300;
const REPLAY_MS = 10 * 60_000;
// Request headers a run may see (no credentials, no cookies, no signature).
const KEPT_HEADERS = ["content-type", "user-agent", "x-request-id", "x-delivery-id", "x-github-event", "x-gitlab-event", "x-event-type", "x-event-key"];

type HookRow = { id: string; page_id: string; node_id: string; token_hash: string; sealed: string; mode: string; created_at: number; rotated_at: number | null; last_used_at: number | null; last_error: string | null };

export const hookUrl = (token: string) => `${appUrl().replace(/\/$/, "")}/api/workflow-hooks/${token}`;
const newToken = () => randomBytes(32).toString("base64url");
const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

/* ---------- Addresses ---------- */

// The address of a webhook trigger: made on first use, a new one on
// rotation (the old one stops working at once). Audit both.
export async function ensureHook(user: Identity, page: Page, nodeId: string, rotate = false) {
  const existing = await one<HookRow>("SELECT * FROM workflow_hooks WHERE page_id=? AND node_id=?", page.id, nodeId);
  if (existing && !rotate) return existing;
  const token = newToken(),
    secret = newSecret();
  const hookId = existing?.id ?? id();
  const now = Date.now();
  if (existing) {
    await run("UPDATE workflow_hooks SET token_hash=?,sealed=?,rotated_at=?,last_error=NULL WHERE id=?", workflowHookTokenHash(token), sealWorkflowHook(hookId, { token, secret }), now, hookId);
    await audit(user.id, "workflow.hook.rotated", page.id, nodeId);
  } else {
    await run(
      "INSERT INTO workflow_hooks(id,page_id,node_id,token_hash,sealed,mode,created_at) VALUES(?,?,?,?,?,'signed',?) ON CONFLICT(page_id,node_id) DO NOTHING",
      hookId,
      page.id,
      nodeId,
      workflowHookTokenHash(token),
      sealWorkflowHook(hookId, { token, secret }),
      now,
    );
    await audit(user.id, "workflow.hook.created", page.id, nodeId);
  }
  return (await one<HookRow>("SELECT * FROM workflow_hooks WHERE page_id=? AND node_id=?", page.id, nodeId))!;
}
// What editors see of a page's addresses: the address and the signing
// secret (they set up the sender with it), when it was made and last used.
export async function hookViews(pageId: string) {
  const rows = await all<HookRow>("SELECT * FROM workflow_hooks WHERE page_id=? ORDER BY created_at", pageId);
  return rows.map((r) => {
    const open = openWorkflowHook(r);
    return { nodeId: r.node_id, url: open ? hookUrl(open.token) : null, secret: open?.secret ?? null, createdAt: r.created_at, rotatedAt: r.rotated_at, lastUsedAt: r.last_used_at, lastError: r.last_error };
  });
}

/* ---------- Receiving ---------- */

const sameHex = (expected: string, actual: string) => {
  const a = Buffer.from(expected, "utf8"),
    b = Buffer.from(actual.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
export const hookSignature = (secret: string, timestamp: string, body: Buffer | string) => createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");

function refuse(hook: HookRow | undefined, reason: string, status = 401): never {
  securityEvent("workflow.hook.refused", { detail: `${hook ? hook.page_id : "?"}: ${reason}`.slice(0, 300) });
  if (hook) void run("UPDATE workflow_hooks SET last_error=? WHERE id=?", reason.slice(0, 300), hook.id).catch(() => {});
  throw new HttpError(status, status === 401 ? "Signatur ungültig." : status === 404 ? "Webhook nicht gefunden." : status === 409 ? "Diese Signatur wurde schon verwendet." : reason);
}

// The body as data: JSON, a form, or text.
export function parseHookBody(contentType: string, body: Buffer): unknown {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const text = body.toString("utf8");
  if (!text.trim()) return null;
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, "Ungültiges JSON.");
    }
  }
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(text));
  return text.slice(0, HOOK_BODY_BYTES);
}

export type HookRequest = { token: string; headers: Headers; body: Buffer; query: URLSearchParams; now?: number };
export async function receiveWorkflowHook(req: HookRequest): Promise<{ status: number; runId: string | null; duplicate?: boolean }> {
  const now = req.now ?? Date.now();
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(req.token)) refuse(undefined, "unknown token", 404);
  const hook = await one<HookRow>("SELECT * FROM workflow_hooks WHERE token_hash=?", workflowHookTokenHash(req.token));
  if (!hook) refuse(undefined, "unknown token", 404);
  const workflow = await one<WorkflowRow>("SELECT * FROM workflows WHERE page_id=?", hook.page_id);
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", hook.page_id);
  if (!workflow || !page || page.deleted_at) throw new HttpError(404, "Webhook nicht gefunden.");
  if (workflow.status !== "active") throw new HttpError(409, "Der Workflow ist pausiert.");
  const trigger = await one<{ version_id: string; config: string }>("SELECT version_id,config FROM workflow_triggers WHERE page_id=? AND node_id=? AND kind='webhook'", hook.page_id, hook.node_id);
  if (!trigger) throw new HttpError(409, "Dieser Auslöser ist in der aktiven Version nicht (mehr) da.");
  const config = JSON.parse(trigger.config || "{}") as { mode?: string };
  const signed = config.mode !== "token";
  if (!allow(`wf-hook:${hook.id}`, signed ? 60 : 10, 60_000)) throw new HttpError(429, "Zu viele Aufrufe. Bitte später erneut versuchen.");
  if (req.body.length > HOOK_BODY_BYTES) throw new HttpError(413, "Der Inhalt ist größer als 256 KB.");
  const open = openWorkflowHook(hook);
  if (!open) refuse(hook, "sealed value does not open");
  const digest = createHash("sha256").update(req.body).digest("hex");
  let signature = "";
  if (signed) {
    const timestamp = (req.headers.get("x-flowplan-timestamp") || "").trim();
    signature = (req.headers.get("x-flowplan-signature") || "").trim().replace(/^sha256=/i, "").toLowerCase();
    if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) refuse(hook, "signature missing");
    if (Math.abs(now / 1000 - Number(timestamp)) > SKEW_S) refuse(hook, "timestamp out of range");
    if (!sameHex(hookSignature(open.secret, timestamp, req.body), signature)) refuse(hook, "signature mismatch");
    // Each signature once: the sender's retry (same body) gets the first run.
    let seen: "new" | "same" | "other";
    try {
      seen = await claimOnce(`wf-hook:${hook.id}:${signature}`, digest, REPLAY_MS, now);
    } catch {
      seen = await claimOnce(`wf-hook:${hook.id}:${signature}`, digest, REPLAY_MS, now);
    }
    if (seen === "other") refuse(hook, "replayed signature", 409);
  }
  const delivery = (req.headers.get("idempotency-key") || req.headers.get("x-delivery-id") || "").trim().slice(0, 200);
  const dedupe = delivery ? `wf-hook:${hook.id}:key:${delivery}` : signed ? `wf-hook:${hook.id}:sig:${signature}` : null;
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers[name] = v.slice(0, 500);
  }
  const query: Record<string, string> = {};
  for (const [k, v] of req.query) if (Object.keys(query).length < 50) query[k.slice(0, 100)] = v.slice(0, 2000);
  const body = parseHookBody(req.headers.get("content-type") || "", req.body);
  const payload = { workflow: page.id, node: hook.node_id, body, query, headers, receivedAt: new Date(now).toISOString() };
  return await transaction(async () => {
    if (dedupe) {
      const earlier = await one<{ id: string }>("SELECT id FROM workflow_events WHERE dedupe_key=?", dedupe);
      if (earlier) {
        const r = await one<{ id: string }>("SELECT id FROM workflow_runs WHERE event_id=?", earlier.id);
        return { status: 200, runId: r?.id ?? null, duplicate: true };
      }
    }
    // The event, dispatched at once (the run is answered with its id).
    const eventId = id();
    await run(
      "INSERT INTO workflow_events(id,workspace_id,kind,scope_id,page_id,row_id,payload,actor_id,origin_run_id,depth,dedupe_key,due_at,dispatched_at,created_at) VALUES(?,?,'webhook',?,NULL,NULL,?,NULL,NULL,0,?,?,?,?)",
      eventId,
      page.workspace_id,
      page.id,
      JSON.stringify(payload).slice(0, 500_000),
      dedupe,
      now,
      now,
      now,
    );
    const graph = await graphOf({ id: "", version_id: trigger.version_id });
    const node = graph?.nodes.find((n) => n.id === hook.node_id);
    if (!graph || !node) throw new HttpError(409, "Dieser Auslöser ist in der aktiven Version nicht (mehr) da.");
    const event: Pick<WorkflowEvent, "id" | "workspace_id" | "page_id" | "row_id" | "actor_id" | "depth" | "origin_run_id"> = { id: eventId, workspace_id: page.workspace_id, page_id: null, row_id: null, actor_id: null, depth: 0, origin_run_id: null };
    const runId = await startLiveRun({ workflow, page, graph, node, event, payload, skipObserve: true });
    await run("UPDATE workflow_hooks SET last_used_at=?,last_error=NULL WHERE id=?", now, hook.id);
    if (!runId) {
      // No run (paused just now, or too many runs): the delivery may come again.
      await run("DELETE FROM workflow_events WHERE id=?", eventId);
      const state = await one<{ status: string }>("SELECT status FROM workflows WHERE page_id=?", page.id);
      return { status: state?.status !== "active" ? 409 : 429, runId: null };
    }
    return { status: 202, runId };
  });
}
export const hookCommandSchema = z.object({ pageId: z.string().uuid(), nodeId: z.string().regex(/^n_[a-z0-9]{6,12}$/), rotate: z.boolean().default(false) });
