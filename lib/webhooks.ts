// Webhooks: workspace owners (in the settings, or with a write API token,
// e.g. the n8n community node) register an address that receives a POST for
// selected events (new, changed or finished records, form answers, new
// pages, comments, mentions, a daily digest of due records). Each delivery
// is signed (X-Flowplan-Signature: sha256=HMAC of the body with the
// webhook's secret), queued and retried. Internal addresses are refused
// unless FLOWPLAN_WEBHOOK_ALLOW_PRIVATE=true (e.g. Home Assistant or n8n in
// the same network).
//
// Besides the JSON envelope a webhook can speak a chat platform's format
// (Slack, Matrix, Microsoft Teams, Discord): the message is rendered from
// the event at delivery time with the webhook's templates
// (lib/notification-templates.ts). Credentials for the Matrix client API
// and Slack's chat.postMessage are sealed (lib/ai/secrets.ts), and so are
// the signing secret and the address (the credential itself for Slack,
// Discord and Teams incoming webhooks) – lib/sealed-values.ts.
//
// A webhook speaks for the person who set it up: it only receives what
// they may read (pages, private spaces, private records); properties with
// a read rule are never sent at all.
import { publicHiddenFieldIds, stripCells } from "./field-access";
import { metadataOnly } from "./e2ee-server";
import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { all, id, lockFor, one, run, transaction } from "./db";
import { HttpError } from "./auth";
import { privateAddress, safeSend } from "./safe-fetch";
import { pageRole, requirePage } from "./permissions";
import { rowRoleResolver } from "./row-access";
import { journalLocked, requireUnlocked } from "./journal-extras";
import { openWebhookSecret, openWebhookUrl, sealWebhookSecret, sealWebhookUrl } from "./sealed-values";
import { openSecret, sealSecret } from "./ai/secrets";
import {
  chatFormats,
  hookConfigSchema,
  matrixSendUrl,
  matrixWebhookBody,
  noticeEvents,
  renderPayload,
  renderMatrix,
  sampleNotice,
  SLACK_POST_MESSAGE,
  templatesSchema,
  type ChatFormat,
  type HookConfig,
  type Notice,
  type Templates,
} from "./notification-templates";
import { buildNotice, dueItems, localClock, recordUrl } from "./notification-events";
import type { Identity, Page, User } from "./types";
import { mapAsync } from "./each-async";
import { mentionEvent } from "./workflows/hooks";
import { workersPaused } from "./instance-read-only";

export const webhookEvents = {
  "row.created": "Neuer Eintrag in einer Datenbank",
  "row.updated": "Eintrag geändert",
  "row.done": "Eintrag erledigt",
  "form.submitted": "Formularantwort",
  "page.created": "Neue Seite",
  "comment.created": "Neuer Kommentar",
  mention: "Erwähnung",
  "digest.due": "Tägliche Übersicht fälliger Einträge",
} as const satisfies Record<(typeof noticeEvents)[number], string>;
export type WebhookEvent = keyof typeof webhookEvents;
const eventIds = noticeEvents as unknown as [WebhookEvent, ...WebhookEvent[]];
const allowPrivate = () => process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE === "true";

type Credentials = { token?: string; signingSecret?: string };
type HookRow = {
  id: string;
  workspace_id: string;
  created_by: string | null;
  url: string;
  secret: string;
  format: ChatFormat;
  config: string;
  templates: string;
  credentials: string | null;
};

async function requireOwner(user: Identity, workspaceId: string) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar.");
  const member = await one<{ role: string }>(
    "SELECT role FROM members WHERE workspace_id=? AND user_id=?",
    workspaceId,
    user.id,
  );
  if (member?.role !== "owner") throw new HttpError(403, "Nur Eigentümer verwalten Webhooks.");
}
// A webhook for one page: only one its owner may read, in this workspace.
async function requireHookPage(user: Identity, workspaceId: string, pageId: string | null | undefined) {
  if (!pageId) return;
  const page = await requirePage(user, pageId);
  if (page.workspace_id !== workspaceId) throw new HttpError(404, "Seite nicht gefunden.");
  await requireUnlocked(user, page);
}

// The person a webhook speaks for: who set it up (webhooks from before
// that was kept: the workspace's first owner). None when they are gone.
async function hookReader(hook: { workspace_id: string; created_by: string | null }): Promise<Identity | null> {
  const userId =
    hook.created_by ??
    // (The one who created the workspace, if still an owner.)
    (await one<{ user_id: string }>(
      "SELECT m.user_id FROM members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=? AND m.role='owner' ORDER BY CASE WHEN m.user_id=w.created_by THEN 0 ELSE 1 END,m.user_id LIMIT 1",
      hook.workspace_id,
    ))?.user_id;
  const user = userId ? (await one<User>("SELECT * FROM users WHERE id=? AND disabled=0", userId)) : undefined;
  return user ? ({ ...user, groups: [], isAdmin: false } as Identity) : null;
}
// Whether that person may read the page (and record) an event is about.
async function readerMaySee(reader: Identity | null, pageId: string, rowId: unknown) {
  if (!reader) return false;
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  const role = page ? (await pageRole(reader, page)) : null;
  // Below a journal behind a PIN the reader has not entered: nothing goes out.
  if (!page || !role || await journalLocked(reader, page)) return false;
  if (typeof rowId !== "string") return true;
  const row = await one<{ id: string; access: string; created_by: string | null }>("SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?", rowId, page.id);
  return !!row && !!(await rowRoleResolver(reader, page, role))(row);
}
// Address and signing secret; unsealed values from before are read as
// they are. Throws when they were sealed with a key that is not here.
const hookUrl = (hook: { id: string; url: string }) => openWebhookUrl(hook);
function shownUrl(hook: { id: string; url: string }) {
  try {
    return hookUrl(hook);
  } catch {
    return "";
  }
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

const sealedFor = (hookId: string) => `webhook:${hookId}`;
function openCredentials(hook: { id: string; credentials: string | null }): Credentials {
  if (!hook.credentials) return {};
  try {
    return JSON.parse(openSecret(hook.credentials, sealedFor(hook.id))) as Credentials;
  } catch {
    return {};
  }
}
const parseConfig = (raw: string): HookConfig => {
  const parsed = hookConfigSchema.safeParse(JSON.parse(raw || "{}"));
  return parsed.success ? parsed.data : hookConfigSchema.parse({});
};
const parseTemplates = (raw: string): Templates => {
  const parsed = templatesSchema.safeParse(JSON.parse(raw || "{}"));
  return parsed.success ? parsed.data : {};
};

const credentialsInput = z.object({
  token: z.string().trim().min(8).max(500).optional(),
  signingSecret: z.string().trim().min(8).max(200).optional(),
});
const hookFields = {
  events: z.array(z.enum(eventIds)).min(1),
  pageId: z.uuid().nullable().optional(),
  format: z.enum(chatFormats).default("json"),
  templates: templatesSchema.default({}),
  config: hookConfigSchema.prefault({}),
};
const createInput = z.object({ workspaceId: z.uuid(), url: z.string().max(2000), ...hookFields, credentials: credentialsInput.optional() });
const updateInput = z.object({
  workspaceId: z.uuid(),
  id: z.string().max(60),
  url: z.string().max(2000).optional(),
  ...hookFields,
  // Left out: unchanged; null: removed; given: replaced (empty parts keep
  // what was stored).
  credentials: credentialsInput.nullable().optional(),
});

// The address a webhook sends to, and the checks per format.
function resolveTarget(format: ChatFormat, url: string, config: HookConfig, credentials: Credentials) {
  if (format === "slack" && credentials.token) {
    if (!config.slackChannel) throw new HttpError(400, "Mit einem Bot-Token braucht Slack eine Kanal-ID.");
    return SLACK_POST_MESSAGE;
  }
  if (format === "matrix" && credentials.token && !config.matrixRoom)
    throw new HttpError(400, "Mit einem Zugriffstoken braucht Matrix einen Raum (!id:server oder #alias:server).");
  if (credentials.signingSecret && !(format === "slack" && credentials.token))
    throw new HttpError(400, "Antworten aus Slack brauchen einen Bot-Token.");
  return url;
}
// An address as it is stored (normalized), "" when it is none.
function normalizedAddress(raw: string) {
  try {
    return new URL(raw).href;
  } catch {
    return "";
  }
}
function storedCredentials(format: ChatFormat, credentials: Credentials) {
  const kept: Credentials = {};
  if (credentials.token && (format === "slack" || format === "matrix")) kept.token = credentials.token;
  if (credentials.signingSecret && format === "slack" && kept.token) kept.signingSecret = credentials.signingSecret;
  return kept;
}

export async function createWebhook(user: Identity, input: unknown) {
  const b = createInput.parse(input);
  // Write tokens of an owner may register webhooks (e.g. the n8n trigger
  // node registers and removes its own); read tokens may not.
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  await requireOwner(user, b.workspaceId);
  await requireHookPage(user, b.workspaceId, b.pageId);
  const credentials = storedCredentials(b.format, b.credentials || {});
  const url = await checkTarget(resolveTarget(b.format, b.url, b.config, credentials));
  // Counted and written in one go (one workspace's webhooks take turns).
  const secret = randomBytes(24).toString("base64url");
  const hookId = id();
  await transaction(async () => {
    await lockFor(`webhooks:${b.workspaceId}`);
    if (Number((await one<{ n: number }>("SELECT COUNT(*) n FROM webhooks WHERE workspace_id=?", b.workspaceId))?.n) >= 20)
      throw new HttpError(409, "Höchstens 20 Webhooks pro Arbeitsbereich.");
    await run(
      "INSERT INTO webhooks(id,workspace_id,url,events,page_id,secret,created_by,created_at,format,templates,config,credentials) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      hookId,
      b.workspaceId,
      sealWebhookUrl(hookId, url.href),
      JSON.stringify(b.events),
      b.pageId || null,
      sealWebhookSecret(hookId, secret),
      user.id,
      Date.now(),
      b.format,
      JSON.stringify(b.templates),
      JSON.stringify(b.config),
      Object.keys(credentials).length ? sealSecret(JSON.stringify(credentials), sealedFor(hookId)) : null,
    );
  }, user);
  return { id: hookId, secret };
}

// Changes events, format, templates, settings, credentials and (checked
// again) the address of a webhook; its secret stays.
export async function updateWebhook(user: Identity, input: unknown) {
  const b = updateInput.parse(input);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  await requireOwner(user, b.workspaceId);
  const hook = await one<HookRow>("SELECT * FROM webhooks WHERE id=? AND workspace_id=?", b.id, b.workspaceId);
  if (!hook) throw new HttpError(404, "Unbekannter Webhook.");
  await requireHookPage(user, b.workspaceId, b.pageId);
  const previous = openCredentials(hook);
  const merged = b.credentials === null ? {} : b.credentials ? { ...previous, ...b.credentials } : previous;
  let credentials = storedCredentials(b.format, merged);
  const stored = shownUrl(hook);
  let target = resolveTarget(b.format, b.url ?? stored, b.config, credentials);
  // A stored token stays with the server and platform it was entered for
  // (as for issue sync and messengers): another address or format needs it
  // again. Compared by where it would be sent, so a Slack bot-token hook
  // (always slack.com) keeps it.
  if (b.format !== hook.format || normalizedAddress(target) !== stored) {
    if (credentials.token && credentials.token === previous.token)
      throw new HttpError(400, "Für eine neue Adresse oder ein anderes Format bitte die Zugangsdaten erneut eingeben.");
    // A new token: nothing of the old credentials comes along.
    credentials = storedCredentials(b.format, b.credentials || {});
    target = resolveTarget(b.format, b.url ?? stored, b.config, credentials);
  }
  const url = stored && target === stored ? stored : (await checkTarget(target)).href;
  await run(
    "UPDATE webhooks SET url=?,events=?,page_id=?,format=?,templates=?,config=?,credentials=? WHERE id=?",
    sealWebhookUrl(hook.id, url),
    JSON.stringify(b.events),
    b.pageId || null,
    b.format,
    JSON.stringify(b.templates),
    JSON.stringify(b.config),
    Object.keys(credentials).length ? sealSecret(JSON.stringify(credentials), sealedFor(hook.id)) : null,
    hook.id,
  );
  return { ok: true };
}

const appBase = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export async function listWebhooks(user: Identity, workspaceId: string) {
  await requireOwner(user, workspaceId);
  return await mapAsync(await all<HookRow & { events: string; page_id: string | null; created_at: number }>(
    "SELECT * FROM webhooks WHERE workspace_id=? ORDER BY created_at",
    workspaceId,
  ), async (h) => {
    const last = await one<{ status: number | null; error: string | null; delivered_at: number | null }>(
      "SELECT status,error,delivered_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC LIMIT 1",
      h.id,
    );
    const lastError = await one<{ error: string | null; created_at: number }>(
      "SELECT error,created_at FROM webhook_deliveries WHERE webhook_id=? AND error IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      h.id,
    );
    const credentials = openCredentials(h);
    return {
      id: h.id,
      url: shownUrl(h),
      events: JSON.parse(h.events) as WebhookEvent[],
      page_id: h.page_id,
      created_at: h.created_at,
      format: h.format,
      templates: parseTemplates(h.templates),
      config: parseConfig(h.config),
      credentials: { token: !!credentials.token, signingSecret: !!credentials.signingSecret },
      // Slack's Event Subscriptions "Request URL" for thread replies.
      repliesUrl: credentials.signingSecret ? `${appBase()}/api/webhooks/slack/${h.id}` : null,
      last: last || null,
      lastError: lastError?.error ? { error: lastError.error, at: lastError.created_at } : null,
    };
  });
}

export async function deleteWebhook(user: Identity, input: unknown) {
  const b = z.object({ workspaceId: z.uuid(), id: z.string() }).parse(input);
  await requireOwner(user, b.workspaceId);
  await run("DELETE FROM webhooks WHERE id=? AND workspace_id=?", b.id, b.workspaceId);
}

// The webhook whose own Slack thread a reply came from gets no echo of it.
const runtime = globalThis as unknown as {
  flowplanHookRun?: Promise<void>;
  flowplanHookTimer?: ReturnType<typeof setInterval>;
  flowplanHookQuiet?: string | null;
};
export async function quietly<T>(hookId: string, fn: () => T): Promise<T> {
  runtime.flowplanHookQuiet = hookId;
  try {
    return await fn();
  } finally {
    runtime.flowplanHookQuiet = null;
  }
}

async function queueDelivery(hook: { id: string; format: string }, workspaceId: string, event: WebhookEvent | "test", data: Record<string, unknown>, notice: () => Notice | Promise<Notice>) {
  const envelope: Record<string, unknown> = { event, id: id(), createdAt: new Date().toISOString(), workspaceId, data };
  // Chat formats render at delivery time (current template); the notice
  // holds what is needed, taken now from the database.
  if (hook.format !== "json") envelope.notice = await notice();
  const deliveryId = id();
  await run(
    "INSERT INTO webhook_deliveries(id,webhook_id,body,next_at,created_at) VALUES(?,?,?,?,?)",
    deliveryId,
    hook.id,
    JSON.stringify(envelope),
    Date.now(),
    Date.now(),
  );
  return deliveryId;
}

// Queues the event for every matching webhook of the workspace whose owner
// may read the page (and record) it is about – a member's private space
// stays private. Runs inside the command transaction; delivery happens
// afterwards in the worker. `actor` is the name of the person who caused it
// (chat messages show it).
export async function emitWebhook(
  workspaceId: string,
  event: WebhookEvent,
  data: Record<string, unknown> & { pageId?: string },
  actor?: string | null,
) {
  const hooks = await all<{ id: string; workspace_id: string; events: string; page_id: string | null; format: string; created_by: string | null }>(
    "SELECT id,workspace_id,events,page_id,format,created_by FROM webhooks WHERE workspace_id=?",
    workspaceId,
  );
  let queued = 0;
  // Pages of end-to-end encrypted spaces: ids only, never content.
  data = (await metadataOnly(data)) as typeof data;
  // Receivers are outside: properties with a read rule are never sent
  // (lib/field-access.ts).
  if (data.pageId && (data.cells || data.changed) && hooks.length) {
    const hidden = publicHiddenFieldIds(
      JSON.parse(
        String((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", data.pageId))?.fields || "[]"),
      ),
    );
    if (hidden.size)
      data = {
        ...data,
        ...(data.cells ? { cells: stripCells(data.cells, hidden) } : {}),
        ...(Array.isArray(data.changed)
          ? { changed: (data.changed as string[]).filter((key) => !hidden.has(key)) }
          : {}),
      };
  }
  // One notice per reader: titles of related records as they may read them.
  const notices = new Map<string, Notice>();
  for (const hook of hooks) {
    if (hook.id === runtime.flowplanHookQuiet) continue;
    if (!(JSON.parse(hook.events) as string[]).includes(event)) continue;
    if (hook.page_id && hook.page_id !== data.pageId) continue;
    const reader = await hookReader(hook);
    if (data.pageId && !(await readerMaySee(reader, data.pageId, data.rowId))) continue;
    await queueDelivery(hook, workspaceId, event, data, async () => {
      const key = reader?.id || "";
      if (!notices.has(key)) notices.set(key, await buildNotice(event, data, actor, reader));
      return notices.get(key)!;
    });
    queued++;
  }
  if (queued) queueMicrotask(() => void dispatchWebhooks());
}

// A person was mentioned in a page or record document.
export async function mentionWebhook(workspaceId: string, pageId: string, rowId: string | null, userId: string, actor: string, actorId?: string) {
  const name = (await one<{ name: string }>("SELECT name FROM users WHERE id=?", userId))?.name || "";
  await emitWebhook(workspaceId, "mention", { pageId, rowId, userId, text: name }, actor);
  // Workflows with a mention trigger (lib/workflows/hooks.ts).
  await mentionEvent(pageId, rowId, userId, actorId);
}

type Delivery = HookRow & { delivery_id: string; body: string; attempts: number };

// Sends one delivery; resolves with the status and an error text (or null).
async function deliver(delivery: Delivery): Promise<{ status: number | null; error: string | null }> {
  const envelope = JSON.parse(delivery.body) as { event: string; data: Record<string, unknown>; notice?: Notice };
  const credentials = openCredentials(delivery);
  const secret = openWebhookSecret(delivery);
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Flowplan-Webhook/1.0" };
  const address = hookUrl(delivery);
  let url = address,
    body = delivery.body,
    method: "POST" | "PUT" = "POST";
  const config = parseConfig(delivery.config);
  const options = { templates: parseTemplates(delivery.templates), config };
  const format = delivery.format;
  if (format === "json" || !envelope.notice) {
    headers["X-Flowplan-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    headers["X-Flowplan-Event"] = envelope.event;
  } else if (format === "slack" && credentials.token && config.slackChannel) {
    url = SLACK_POST_MESSAGE;
    headers.Authorization = `Bearer ${credentials.token}`;
    body = JSON.stringify({ channel: config.slackChannel, ...renderPayload("slack", envelope.notice, options) });
  } else if (format === "matrix") {
    const content = renderMatrix(envelope.notice, options);
    if (credentials.token && config.matrixRoom) {
      url = matrixSendUrl(address, config.matrixRoom, delivery.delivery_id);
      method = "PUT";
      headers.Authorization = `Bearer ${credentials.token}`;
      body = JSON.stringify(content);
    } else body = JSON.stringify(matrixWebhookBody(content));
  } else body = JSON.stringify(renderPayload(format, envelope.notice, options));
  if (!headers.Authorization && format !== "json")
    headers["X-Flowplan-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  // The address is checked again: DNS may point elsewhere by now.
  await checkTarget(url);
  // Sent to the address that was checked (pinned DNS, no redirects).
  const slackApi = url === SLACK_POST_MESSAGE;
  const response = await safeSend(url, body, headers, { method, allowPrivate: allowPrivate(), maxBytes: slackApi ? 20_000 : 0 });
  if (response.status < 200 || response.status >= 300) return { status: response.status, error: `HTTP ${response.status}` };
  if (slackApi) {
    // chat.postMessage answers 200 with ok:false on errors.
    let answer: { ok?: boolean; error?: string; ts?: string } = {};
    try {
      answer = JSON.parse(response.body);
    } catch {}
    if (!answer.ok) return { status: response.status, error: `Slack: ${String(answer.error || "unknown_error").slice(0, 100)}` };
    const pageId = envelope.data?.pageId;
    if (answer.ts && typeof pageId === "string" && credentials.signingSecret && envelope.event !== "digest.due" && envelope.event !== "test")
      await run(
        "INSERT INTO webhook_messages(webhook_id,ts,page_id,row_id,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pages WHERE id=?) ON CONFLICT DO NOTHING",
        delivery.id,
        answer.ts,
        pageId,
        typeof envelope.data.rowId === "string" ? envelope.data.rowId : null,
        Date.now(),
        pageId,
      );
  }
  return { status: response.status, error: null };
}

async function deliverAndRecord(delivery: Delivery) {
  let result: { status: number | null; error: string | null };
  try {
    result = await deliver(delivery);
  } catch (e) {
    result = { status: null, error: String((e as Error).message || e).slice(0, 300) };
  }
  if (!result.error)
    await run("UPDATE webhook_deliveries SET delivered_at=?,status=?,error=NULL WHERE id=?", Date.now(), result.status, delivery.delivery_id);
  else {
    const attempts = delivery.attempts + 1;
    await run(
      "UPDATE webhook_deliveries SET attempts=?,status=?,error=?,next_at=? WHERE id=?",
      attempts,
      result.status,
      result.error,
      Date.now() + Math.min(3600_000, 30_000 * 2 ** attempts),
      delivery.delivery_id,
    );
  }
  return result;
}

const deliveryColumns = "d.id delivery_id,d.body,d.attempts,w.id,w.workspace_id,w.created_by,w.url,w.secret,w.format,w.config,w.templates,w.credentials";
export async function flushWebhooks(now = Date.now()) {
  if (await workersPaused()) return;
  const due = await all<Delivery>(
    `SELECT ${deliveryColumns} FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id
     WHERE d.delivered_at IS NULL AND d.attempts<6 AND d.next_at<=? ORDER BY d.next_at LIMIT 50`,
    now,
  );
  for (const delivery of due) {
    // Claimed first, so parallel runs never deliver twice.
    if (!(await run("UPDATE webhook_deliveries SET next_at=? WHERE id=? AND delivered_at IS NULL AND next_at<=?", Date.now() + 10 * 60_000, delivery.delivery_id, now)).changes)
      continue;
    await deliverAndRecord(delivery);
  }
  await run("DELETE FROM webhook_deliveries WHERE created_at<?", now - 7 * 86400_000);
  await run("DELETE FROM webhook_messages WHERE created_at<?", now - 30 * 86400_000);
}

// "Testnachricht senden": a sample message, sent right away and not retried.
export async function testWebhook(user: Identity, input: unknown) {
  const b = z.object({ workspaceId: z.uuid(), id: z.string().max(60) }).parse(input);
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  await requireOwner(user, b.workspaceId);
  const hook = await one<HookRow>("SELECT * FROM webhooks WHERE id=? AND workspace_id=?", b.id, b.workspaceId);
  if (!hook) throw new HttpError(404, "Unbekannter Webhook.");
  const workspace = await one<{ name: string }>("SELECT name FROM workspaces WHERE id=?", b.workspaceId);
  const lang = parseConfig(hook.config).language;
  const deliveryId = await queueDelivery(hook, b.workspaceId, "test", { workspace: workspace?.name || "" }, () => ({
    ...sampleNotice("test", lang),
    title: workspace?.name || "Flowplan",
    url: appBase(),
    actor: user.name,
  }));
  // Only this attempt: a failed test is not retried.
  await run("UPDATE webhook_deliveries SET attempts=5,next_at=? WHERE id=?", Date.now() + 10 * 60_000, deliveryId);
  const delivery = (await one<Delivery>(`SELECT ${deliveryColumns} FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=?`, deliveryId))!;
  const result = await deliverAndRecord(delivery);
  return { ok: !result.error, status: result.status, error: result.error };
}

// The daily digest: once per local day, after the configured time, a list
// of due and overdue open records (nothing is sent when there are none).
export async function processDigests(now = Date.now()) {
  let queued = 0;
  for (const hook of await all<{ id: string; workspace_id: string; page_id: string | null; events: string; format: string; config: string; digest_day: string | null; created_by: string | null }>(
    "SELECT id,workspace_id,page_id,events,format,config,digest_day,created_by FROM webhooks WHERE events LIKE '%digest.due%'",
  )) {
    if (!(JSON.parse(hook.events) as string[]).includes("digest.due")) continue;
    const config = parseConfig(hook.config);
    const clock = localClock(now, config.timeZone);
    if (clock.time < config.digestTime || hook.digest_day === clock.day) continue;
    if (!(await run("UPDATE webhooks SET digest_day=? WHERE id=? AND digest_day IS DISTINCT FROM ?", clock.day, hook.id, clock.day)).changes) continue;
    // Only databases and records the webhook's owner may read.
    const reader = await hookReader(hook);
    if (!reader) continue;
    const items = await dueItems(hook.workspace_id, hook.page_id, clock.day, 100, reader);
    if (!items.length) continue;
    const data = { date: clock.day, ...(hook.page_id ? { pageId: hook.page_id } : {}), items };
    await queueDelivery(hook, hook.workspace_id, "digest.due", data, () => ({
      event: "digest.due",
      title: "",
      page: "",
      url: hook.page_id ? recordUrl(hook.page_id) : appBase(),
      actor: "Flowplan",
      at: new Date(now).toISOString(),
      changes: [],
      items: items.map(({ title, page, due, url, overdue }) => ({ title, page, due, url, overdue })),
      date: clock.day,
    }));
    queued++;
  }
  return queued;
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
  runtime.flowplanHookTimer = setInterval(async () => {
    if (await workersPaused()) return;
    try {
      await transaction(async () => await processDigests());
    } catch (error) {
      console.error("Webhook-Übersicht fehlgeschlagen", error);
    }
    void dispatchWebhooks();
  }, 30_000);
  runtime.flowplanHookTimer.unref?.();
}

// The chat webhooks an owner released for workflows (config.workflows,
// docs/specs/workflows.md §6.4): what the "Chat message" node may post to.
export async function workflowChatHooks(workspaceId: string) {
  const rows = await all<{ id: string; format: string; config: string; url: string }>("SELECT id,format,config,url FROM webhooks WHERE workspace_id=? ORDER BY created_at", workspaceId);
  return rows
    .filter((r) => parseConfig(r.config).workflows === true)
    .map((r) => {
      let host = "";
      try {
        host = new URL(hookUrl(r as never)).hostname;
      } catch {}
      return { id: r.id, format: r.format, host };
    });
}
// A workflow's message to a released chat webhook: delivered like every
// other event (retries, sealed credentials, the platform's formatter).
export async function queueWorkflowMessage(input: { hookId: string; workspaceId: string; pageId: string; page: string; title: string; text: string; url: string; actor: string; runId: string }) {
  const hook = await one<{ id: string; format: string; config: string }>("SELECT id,format,config FROM webhooks WHERE id=? AND workspace_id=?", input.hookId, input.workspaceId);
  if (!hook || parseConfig(hook.config).workflows !== true) return null;
  const notice: Notice = { event: "workflow.message", title: input.title, page: input.page, url: input.url, actor: input.actor, at: new Date().toISOString(), changes: [], text: input.text };
  const data = { pageId: input.pageId, runId: input.runId, title: input.title, text: input.text, url: input.url };
  const deliveryId = await queueDelivery(hook, input.workspaceId, "workflow.message" as WebhookEvent, data, () => notice);
  queueMicrotask(() => void dispatchWebhooks());
  return deliveryId;
}
