// Webhooks: workspace owners register an address that receives a POST for
// selected events (new or changed records, form answers, new pages). Each
// delivery is signed (X-Flowplan-Signature: sha256=HMAC of the body with the
// webhook's secret), queued and retried. Internal addresses are refused
// unless FLOWPLAN_WEBHOOK_ALLOW_PRIVATE=true (e.g. Home Assistant or n8n in
// the same network).
import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { privateAddress } from "./safe-fetch";
import type { Identity } from "./types";

export const webhookEvents = {
  "row.created": "Neuer Eintrag in einer Datenbank",
  "row.updated": "Eintrag geändert",
  "form.submitted": "Formularantwort",
  "page.created": "Neue Seite",
} as const;
export type WebhookEvent = keyof typeof webhookEvents;
const eventIds = Object.keys(webhookEvents) as [WebhookEvent, ...WebhookEvent[]];
const allowPrivate = () => process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE === "true";

function requireOwner(user: Identity, workspaceId: string) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar.");
  const member = one<{ role: string }>(
    "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
    workspaceId,
    user.id,
  );
  if (member?.role !== "owner") throw new HttpError(403, "Nur Eigentümer verwalten Webhooks.");
}

async function checkTarget(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Ungültige Adresse.");
  }
  if (url.protocol !== "https:" && !(allowPrivate() && url.protocol === "http:"))
    throw new HttpError(400, "Webhooks brauchen eine HTTPS-Adresse.");
  if (url.username || url.password) throw new HttpError(400, "Zugangsdaten gehören nicht in die Adresse.");
  if (allowPrivate()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new HttpError(400, "Die Adresse ist nicht erreichbar.");
  if (addresses.some(privateAddress))
    throw new HttpError(400, "Interne Adressen sind für Webhooks gesperrt (FLOWPLAN_WEBHOOK_ALLOW_PRIVATE).");
  return url;
}

export async function createWebhook(user: Identity, input: unknown) {
  const b = z
    .object({
      workspaceId: z.uuid(),
      url: z.string().max(2000),
      events: z.array(z.enum(eventIds)).min(1),
      pageId: z.uuid().nullable().optional(),
    })
    .parse(input);
  requireOwner(user, b.workspaceId);
  const url = await checkTarget(b.url);
  if (Number(one<{ n: number }>("SELECT COUNT(*) n FROM webhooks WHERE workspace_id=?", b.workspaceId)?.n) >= 20)
    throw new HttpError(409, "Höchstens 20 Webhooks pro Arbeitsbereich.");
  const secret = randomBytes(24).toString("base64url");
  const hookId = id();
  run(
    "INSERT INTO webhooks(id,workspace_id,url,events,page_id,secret,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
    hookId,
    b.workspaceId,
    url.href,
    JSON.stringify(b.events),
    b.pageId || null,
    secret,
    user.id,
    Date.now(),
  );
  return { id: hookId, secret };
}

export function listWebhooks(user: Identity, workspaceId: string) {
  requireOwner(user, workspaceId);
  return all<{ id: string; url: string; events: string; page_id: string | null; created_at: number }>(
    "SELECT id,url,events,page_id,created_at FROM webhooks WHERE workspace_id=? ORDER BY created_at",
    workspaceId,
  ).map((h) => {
    const last = one<{ status: number | null; error: string | null; delivered_at: number | null }>(
      "SELECT status,error,delivered_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 1",
      h.id,
    );
    return { ...h, events: JSON.parse(h.events) as WebhookEvent[], last: last || null };
  });
}

export function deleteWebhook(user: Identity, input: unknown) {
  const b = z.object({ workspaceId: z.uuid(), id: z.string() }).parse(input);
  requireOwner(user, b.workspaceId);
  run("DELETE FROM webhooks WHERE id=? AND workspace_id=?", b.id, b.workspaceId);
}

// Queues the event for every matching webhook of the workspace. Runs inside
// the command transaction; delivery happens afterwards in the worker.
export function emitWebhook(
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown> & { pageId?: string },
) {
  const hooks = all<{ id: string; events: string; page_id: string | null }>(
    "SELECT id,events,page_id FROM webhooks WHERE workspace_id=?",
    workspaceId,
  );
  let queued = 0;
  for (const hook of hooks) {
    if (!(JSON.parse(hook.events) as string[]).includes(event)) continue;
    if (hook.page_id && hook.page_id !== data.pageId) continue;
    const body = JSON.stringify({
      event,
      id: id(),
      createdAt: new Date().toISOString(),
      workspaceId,
      data,
    });
    run(
      "INSERT INTO webhook_deliveries(id,webhook_id,body,next_at,created_at) VALUES(?,?,?,?,?)",
      id(),
      hook.id,
      body,
      Date.now(),
      Date.now(),
    );
    queued++;
  }
  if (queued) queueMicrotask(() => void dispatchWebhooks());
}

const runtime = globalThis as unknown as {
  flowplanHookRun?: Promise<void>;
  flowplanHookTimer?: ReturnType<typeof setInterval>;
};

export async function flushWebhooks(now = Date.now()) {
  const due = all<{ id: string; body: string; attempts: number; url: string; secret: string }>(
    `SELECT d.id,d.body,d.attempts,w.url,w.secret FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
     WHERE d.delivered_at IS NULL AND d.attempts<6 AND d.next_at<=? ORDER BY d.next_at LIMIT 50`,
    now,
  );
  for (const delivery of due) {
    // Claimed first, so parallel runs never deliver twice.
    if (!run("UPDATE webhook_deliveries SET next_at=? WHERE id=? AND delivered_at IS NULL AND next_at<=?", Date.now() + 10 * 60_000, delivery.id, now).changes)
      continue;
    let status: number | null = null,
      error: string | null = null;
    try {
      // The address is checked again: DNS may point elsewhere by now.
      await checkTarget(delivery.url);
      const signature = createHmac("sha256", delivery.secret).update(delivery.body).digest("hex");
      const response = await fetch(delivery.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Flowplan-Webhook/1.0",
          "X-Flowplan-Signature": `sha256=${signature}`,
          "X-Flowplan-Event": (JSON.parse(delivery.body) as { event: string }).event,
        },
        body: delivery.body,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (e) {
      error = String((e as Error).message || e).slice(0, 300);
    }
    if (!error)
      run("UPDATE webhook_deliveries SET delivered_at=?,status=?,error=NULL WHERE id=?", Date.now(), status, delivery.id);
    else {
      const attempts = delivery.attempts + 1;
      run(
        "UPDATE webhook_deliveries SET attempts=?,status=?,error=?,next_at=? WHERE id=?",
        attempts,
        status,
        error,
        Date.now() + Math.min(3600_000, 30_000 * 2 ** attempts),
        delivery.id,
      );
    }
  }
  run("DELETE FROM webhook_deliveries WHERE created_at<?", now - 7 * 86400_000);
}

export function dispatchWebhooks() {
  runtime.flowplanHookRun ??= flushWebhooks()
    .catch((error) => console.error("Webhook-Zustellung fehlgeschlagen", error))
    .finally(() => {
      runtime.flowplanHookRun = undefined;
    });
  return runtime.flowplanHookRun;
}

export function startWebhookWorker() {
  if (runtime.flowplanHookTimer) return;
  runtime.flowplanHookTimer = setInterval(() => void dispatchWebhooks(), 30_000);
  runtime.flowplanHookTimer.unref?.();
}
