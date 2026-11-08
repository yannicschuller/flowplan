// http.request (docs/specs/workflows.md §6.6, §9.4, §9.5): a request to an
// HTTPS address whose scheme and host are fixed text – placeholders only in
// the path and the query (URL-encoded), so no input value (a webhook, an
// e-mail, an AI answer) can point it elsewhere. Every hop goes through the
// pinned lookup of lib/safe-fetch.ts (private, loopback, link-local, CGNAT
// and IPv4-in-IPv6 addresses refused, blocked.ssrf recorded), at most three
// redirects, each checked; a credential goes to its own host only and is
// never in the run's data (answers that echo it are redacted). The
// Idempotency-Key is the same on every retry (§8.5).
import { one } from "../../db";
import { allow } from "../../action-limits";
import { safeSend } from "../../safe-fetch";
import { redactSecrets } from "../../ai/redact";
import { openWorkflowCredential } from "../../sealed-values";
import { fixedHost } from "../catalog";
import { workflowLimits } from "../limits";
import { headerSafe, parseTemplate, renderTemplate, renderText } from "../placeholders";
import { dryRun, StepError, type NodeImpl, type NodeRun } from "./types";

const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
// Kept from an answer's headers (no cookies, no auth).
const ANSWER_HEADERS = new Set(["content-type", "content-length", "date", "etag", "last-modified", "location", "retry-after", "x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]);
// Headers a node may not set itself.
const RESERVED = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie", "user-agent", "idempotency-key", "expect", "upgrade", "te", "trailer", "proxy-authorization", "keep-alive"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

type Credential = { kind: string; host: string; secret: Record<string, string> };
async function credentialOf(ctx: NodeRun, credentialId: string): Promise<Credential | null> {
  if (!credentialId) return null;
  const row = await one<{ id: string; kind: string; host: string; sealed: string }>("SELECT id,kind,host,sealed FROM workflow_credentials WHERE id=? AND page_id=?", credentialId, ctx.run.pageId);
  if (!row) throw new StepError("Die Zugangsdaten gibt es nicht (mehr).", "validation");
  const secret = openWorkflowCredential(row);
  if (!secret) throw new StepError("Die Zugangsdaten lassen sich auf dieser Instanz nicht öffnen.", "permission");
  return { kind: row.kind, host: row.host.toLowerCase(), secret };
}
const secretValues = (c: Credential | null) => (c ? Object.values(c.secret).filter((v) => v && v.length >= 4) : []);
// Adds the credential to a request to its host.
function withCredential(url: URL, headers: Record<string, string>, c: Credential | null) {
  if (!c || url.host.toLowerCase() !== c.host) return;
  if (c.kind === "bearer") headers.authorization = `Bearer ${c.secret.token}`;
  else if (c.kind === "basic") headers.authorization = `Basic ${Buffer.from(`${c.secret.username ?? ""}:${c.secret.password ?? ""}`).toString("base64")}`;
  else if (c.kind === "header" && c.secret.name && HEADER_NAME.test(c.secret.name)) headers[c.secret.name.toLowerCase()] = headerSafe(c.secret.value ?? "");
  else if (c.kind === "query" && c.secret.name) url.searchParams.set(c.secret.name, c.secret.value ?? "");
}
const retryAfter = (value: string | undefined) => {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(3_600_000, ms) : undefined;
};

// The URL: the fixed part as it is, placeholders after the host URL-encoded.
export function renderUrl(template: string, ctx: Pick<NodeRun, "scope">): URL {
  const host = fixedHost(template);
  if (!host) throw new StepError("Die Adresse muss mit https:// und einem festen Host beginnen.", "validation");
  const rendered = String(renderTemplate(template.trim(), ctx.scope, { encode: encodeURIComponent }));
  let url: URL;
  try {
    url = new URL(rendered);
  } catch {
    throw new StepError("Ungültige Adresse.", "validation");
  }
  if (url.protocol !== "https:" || url.host.toLowerCase() !== host || url.username || url.password) throw new StepError("Die Adresse muss beim festen Host bleiben.", "validation");
  return url;
}
// A JSON body (§7.4): a whole placeholder becomes a JSON value, one inside
// a string a JSON-escaped string.
export function renderJsonBody(template: string, ctx: Pick<NodeRun, "scope">): string {
  const segments = parseTemplate(template);
  const text =
    segments.length === 1 && typeof segments[0] !== "string"
      ? JSON.stringify(renderTemplate(template, ctx.scope, { whole: true }) ?? null)
      : String(renderTemplate(template, ctx.scope, { encode: (s) => JSON.stringify(s).slice(1, -1) }));
  try {
    JSON.parse(text);
  } catch {
    throw new StepError("Der JSON-Körper ist kein gültiges JSON.", "validation");
  }
  return text;
}

export const httpRequest: NodeImpl = async (ctx) => {
  const c = ctx.config as {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    query: { name: string; value: string }[];
    headers: { name: string; value: string }[];
    bodyKind: "none" | "json" | "form" | "text";
    body: string;
    credential: string;
    timeoutSeconds: number;
    failOnStatus: boolean;
    runInDry: boolean;
  };
  const limits = await workflowLimits();
  if (!limits.http) throw new StepError("HTTP-Anfragen sind auf dieser Instanz abgeschaltet.", "permission");
  const url = renderUrl(c.url, ctx);
  const host = url.host.toLowerCase();
  if (limits.httpHosts.length && !limits.httpHosts.includes(url.hostname.toLowerCase()) && !limits.httpHosts.includes(host))
    throw new StepError(`Der Host ${url.hostname} ist auf dieser Instanz nicht erlaubt.`, "permission");
  for (const q of c.query || []) if (q.name.trim()) url.searchParams.append(q.name.trim(), renderText(q.value || "", ctx.scope));
  const headers: Record<string, string> = {};
  for (const h of c.headers || []) {
    const name = h.name.trim().toLowerCase();
    if (!name || !HEADER_NAME.test(name) || RESERVED.has(name)) continue;
    headers[name] = headerSafe(renderText(h.value || "", ctx.scope));
  }
  let body = "";
  if (c.method !== "GET" && c.bodyKind !== "none") {
    if (c.bodyKind === "json") {
      body = renderJsonBody(c.body || "", ctx);
      headers["content-type"] ??= "application/json; charset=utf-8";
    } else if (c.bodyKind === "form") {
      body = String(renderTemplate(c.body || "", ctx.scope, { encode: encodeURIComponent }));
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    } else {
      body = renderText(c.body || "", ctx.scope);
      headers["content-type"] ??= "text/plain; charset=utf-8";
    }
  }
  const shown = `${url.origin}${url.pathname}`;
  // Dry runs: GET only, and only when the node says so (§10.3).
  if (dryRun(ctx) && (c.method !== "GET" || !c.runInDry)) return { port: "out", output: { wouldRequest: { method: c.method, url: shown } } };
  const credential = await credentialOf(ctx, c.credential);
  if (credential && credential.host !== host) throw new StepError(`Diese Zugangsdaten gelten nur für ${credential.host}.`, "permission");
  // Load on others (§9.10): 60 a minute per workflow, 120 per host on the instance.
  if (!allow(`wf-http:${ctx.run.pageId}`, 60, 60_000) || !allow(`wf-http-host:${host}`, 120, 60_000)) throw new StepError("Zu viele HTTP-Anfragen in der letzten Minute.", "transient", 30_000);
  const base = { "user-agent": "Flowplan-Workflow/1.0", "idempotency-key": `${ctx.run.id}:${ctx.node.id}:${ctx.iteration}`, accept: "application/json, text/*;q=0.9, */*;q=0.5" };
  const secrets = secretValues(credential);
  let current = url;
  let method = c.method;
  let payload = body;
  let answer: { status: number; body: string; headers: Record<string, string> } | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current.href);
    const sent: Record<string, string> = { ...base, ...headers };
    if (method === "GET" || !payload) delete sent["content-type"];
    // The credential only to its own host (a redirect elsewhere goes without it).
    withCredential(target, sent, credential);
    try {
      answer = await safeSend(target.href, method === "GET" ? "" : payload, sent, { method, allowPrivate: limits.httpAllowPrivate, timeout: c.timeoutSeconds * 1000, maxBytes: MAX_BYTES + 1 });
    } catch (error) {
      const message = redactSecrets(String((error as Error)?.message || error), secrets);
      if (/Interne Adressen|Nur https/.test(message)) throw new StepError(message, "permission");
      throw new StepError(`Anfrage fehlgeschlagen: ${message}`, "transient");
    }
    const location = answer.headers.location;
    if (answer.status >= 300 && answer.status < 400 && location && [301, 302, 303, 307, 308].includes(answer.status)) {
      if (hop === MAX_REDIRECTS) throw new StepError("Zu viele Weiterleitungen.", "external");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new StepError("Ungültige Weiterleitung.", "external");
      }
      if (next.protocol !== "https:" && !(limits.httpAllowPrivate && next.protocol === "http:")) throw new StepError("Weiterleitung auf eine Adresse ohne HTTPS.", "permission");
      if (next.username || next.password) throw new StepError("Ungültige Weiterleitung.", "external");
      if (limits.httpHosts.length && !limits.httpHosts.includes(next.hostname.toLowerCase()) && !limits.httpHosts.includes(next.host.toLowerCase()))
        throw new StepError(`Weiterleitung auf ${next.hostname}, der auf dieser Instanz nicht erlaubt ist.`, "permission");
      if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method !== "GET")) {
        method = "GET";
        payload = "";
      }
      current = next;
      continue;
    }
    break;
  }
  if (!answer) throw new StepError("Keine Antwort.", "transient");
  if (Buffer.byteLength(answer.body) > MAX_BYTES) throw new StepError("Antwort größer als 1 MB.", "limit");
  const text = redactSecrets(answer.body, secrets);
  if (answer.status >= 400 && c.failOnStatus) {
    const detail = `HTTP ${answer.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`;
    if (answer.status >= 500 || answer.status === 429 || answer.status === 408) throw new StepError(detail, "transient", retryAfter(answer.headers["retry-after"]));
    throw new StepError(detail, "external");
  }
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(answer.headers)) if (ANSWER_HEADERS.has(k.toLowerCase())) kept[k.toLowerCase()] = redactSecrets(v, secrets).slice(0, 1000);
  let json: unknown = null;
  if (/json/i.test(answer.headers["content-type"] || "") || /^\s*[[{]/.test(text))
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  // The output stays below the limit of 256 KB (§8.9).
  const bodyOut = text.length > 100_000 ? `${text.slice(0, 100_000)}…` : text;
  if (json !== null && JSON.stringify(json).length > 120_000) {
    ctx.warn("Die JSON-Antwort ist zu groß für die Ausgabe (nur gekürzt als Text).");
    json = null;
  }
  return { port: "out", output: { status: answer.status, headers: kept, body: bodyOut, json } };
};
