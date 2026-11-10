// Two-way sync between a database and the issues of a GitHub, GitLab or
// Forgejo/Gitea repository (lib/git-integration.ts only links commits and
// pull requests). Forgejo and Gitea share one REST API (/api/v1) and are one
// provider here ("forgejo").
//
// A workspace owner (or an administrator) connects a provider with an
// access token (sealed with lib/secret-box.ts). Per database, a mapping
// names the repository, which properties match which parts of an issue and
// the direction (both ways, or only one). The sync acts as the person who
// set up the connection: it needs edit rights on the database, and records
// that person may not read are skipped.
//
// Pull: issues updated since the cursor (updated_at), bounded per run.
// Push: records queued by the write paths (lib/issue-sync-queue.ts) or found
// changed by the poll. Each record and issue are linked once in issue_links
// (unique per provider, repository and issue), with the last state seen on
// either side; when both changed since then, the later change wins and the
// decision is written to the audit log. Webhooks of the provider (issues,
// comments) start a pull at once; a worker polls every 10 minutes. 403/429
// answers with Retry-After or an exhausted rate limit pause the connection.
//
// Hosts: github.com, gitlab.com and codeberg.org (Forgejo; its address is
// still entered – there is no default) always; a self-hosted GitHub
// Enterprise or GitLab and any other Forgejo/Gitea server only when its host
// is listed in ISSUE_SYNC_ALLOWED_HOSTS
// (and with ISSUE_SYNC_ALLOW_PRIVATE=true it may have an internal address). All
// requests go through lib/safe-fetch.ts (resolved and pinned addresses, no
// redirects with credentials).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { all, audit, id, one, run, transaction, nowText, lockFor } from "./db";
import { appUrl, HttpError } from "./auth";
import { isGuest, memberRole, pageRole, requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { journalLocked, requireUnlocked } from "./journal-extras";
import { requireRow, replaceRowDocument } from "./row-documents";
import { rowChanged, rowCreated } from "./automations";
import { cellText } from "./cell-text";
import { validDateValue } from "./date-values";
import { markdownSource } from "./markdown";
import { markdownToHtml } from "./markdown-import";
import { privateAddress, safeFetch } from "./safe-fetch";
import { openSecret, sealSecret } from "./secret-box";
import { onIssueQueued, quietly } from "./issue-sync-queue";
import { noteWorkerRun } from "./ops-events";
import type { Field, Identity, Page, User } from "./types";
import { mapAsync } from "./each-async";
import { isLeader } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";

export type IssueProvider = "github" | "gitlab" | "forgejo";
export const ISSUE_PROVIDERS = ["github", "gitlab", "forgejo"] as const;
const MINUTE = 60_000;
const POLL_EVERY = 10 * MINUTE;
const PER_PAGE = 50;
const MAX_PULL_PAGES = 4;
const MAX_PUSH = 25;
const MAX_COMMENTS = 20;
const MAX_BACKOFF = 60 * MINUTE;
// Forgejo/Gitea list issues by creation, not by change: the issues changed
// since the cursor are fetched completely (a window narrowed with `before`
// until it fits) and sorted here. Probes narrowing the window, at most.
const MAX_WINDOW_PROBES = 32;
const providerName = { github: "GitHub", gitlab: "GitLab", forgejo: "Forgejo/Gitea" } as const;

/* ---------- Configuration ---------- */

const fieldId = z.string().max(100);
export const issueSyncConfigSchema = z.object({
  direction: z.enum(["both", "pull", "push"]).default("both"),
  title: fieldId,
  // A text property or "@document" (the record's page), "" for none.
  body: fieldId.default(""),
  status: z
    .object({
      field: fieldId,
      map: z
        .array(z.object({ value: z.string().max(200), state: z.enum(["open", "closed"]), label: z.string().max(100).default("") }))
        .max(50),
    })
    .nullable()
    .default(null),
  labels: fieldId.default(""),
  assignee: fieldId.default(""),
  milestone: fieldId.default(""),
  number: fieldId.default(""),
  url: fieldId.default(""),
  comments: z.object({ pull: z.boolean().default(false), push: z.boolean().default(false) }).default({ pull: false, push: false }),
  // Also take over issues that existed before the mapping was saved.
  importExisting: z.boolean().default(false),
});
export type IssueSyncConfig = z.infer<typeof issueSyncConfigSchema>;
const peopleSchema = z.array(z.object({ login: z.string().trim().min(1).max(100), email: z.string().trim().toLowerCase().max(200) })).max(500);
type People = z.infer<typeof peopleSchema>;

type ConnectionRow = {
  id: string;
  workspace_id: string;
  provider: IssueProvider;
  base_url: string;
  repo: string;
  token: string;
  hook_token: string;
  hook_secret: string;
  people: string;
  state: string;
  created_by: string;
  created_at: number;
};
type MapRow = { page_id: string; connection_id: string; repo: string; config: string; state: string; created_by: string | null; created_at: number };
type LinkRow = {
  id: string;
  page_id: string;
  row_id: string;
  provider: IssueProvider;
  repo: string;
  issue_id: string;
  number: number;
  url: string;
  remote: string;
  local_hash: string;
  remote_updated: number;
  synced_at: number;
};
type ConnectionState = { checkedAt?: number; account?: string; error?: string | null; backoffUntil?: number; admin?: boolean };
export type MapState = {
  lastPull?: number;
  lastPush?: number;
  cursor?: number;
  scanAt?: number;
  error?: string | null;
  pulled?: number;
  pushed?: number;
  conflicts?: number;
  skipped?: number;
};
const parse = <T>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/* ---------- Hosts ---------- */

export const issueSyncHosts = () =>
  (process.env.ISSUE_SYNC_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
const PUBLIC_HOST: Partial<Record<IssueProvider, string>> = { github: "github.com", gitlab: "gitlab.com" };
const API_PATH = { github: "/api/v3", gitlab: "/api/v4", forgejo: "/api/v1" } as const;
const CODEBERG = "codeberg.org";

// The web and API address of a provider. github.com, gitlab.com and (for
// Forgejo) codeberg.org are always allowed; any other server only when the
// administrator listed it. Forgejo/Gitea has no default: its address is
// always needed.
export function issueEndpoint(provider: IssueProvider, raw: string) {
  const text = raw.trim().replace(/\/+$/, "");
  const fallback = PUBLIC_HOST[provider];
  if (!text && !fallback) throw new HttpError(400, "Für Forgejo / Gitea bitte die Adresse des Servers angeben.");
  let url: URL;
  try {
    url = new URL(text || `https://${fallback}`);
  } catch {
    throw new HttpError(400, "Ungültige Adresse.");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "Nur https-Adressen sind erlaubt.");
  if (url.username || url.password || url.search || url.hash)
    throw new HttpError(400, "Die Adresse darf keine Zugangsdaten enthalten – das Token gehört in sein eigenes Feld.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (fallback && (host === fallback || (provider === "github" && host === "api.github.com"))) {
    return {
      web: `https://${fallback}`,
      api: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4",
      allowPrivate: false,
      selfHosted: false,
    };
  }
  // codeberg.org, the public Forgejo, like github.com and gitlab.com. Its
  // address is stored all the same (`selfHosted`): Forgejo has no default.
  if (provider === "forgejo" && url.host.toLowerCase() === CODEBERG)
    return { web: `https://${CODEBERG}`, api: `https://${CODEBERG}/api/v1`, allowPrivate: false, selfHosted: true };
  const hosts = issueSyncHosts();
  if (!hosts.includes(host) && !hosts.includes(url.host.toLowerCase()))
    throw new HttpError(400, "Dieser Git-Server ist für die Issue-Synchronisierung nicht freigegeben (ISSUE_SYNC_ALLOWED_HOSTS).");
  const allowPrivate = process.env.ISSUE_SYNC_ALLOW_PRIVATE === "true";
  if (!allowPrivate && isIP(host) && privateAddress(host)) throw new HttpError(400, "Interne Adressen sind nicht erlaubt.");
  const web = `${url.origin}${path}`;
  return { web, api: `${web}${API_PATH[provider]}`, allowPrivate, selfHosted: true };
}
export function checkedRepo(provider: IssueProvider, raw: unknown) {
  const repo = z.string().trim().max(300).parse(raw).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const ok = provider === "gitlab" ? /^(\d+|[\w.-]+(\/[\w.-]+)+)$/.test(repo) : /^[\w.-]+\/[\w.-]+$/.test(repo);
  if (!ok) throw new HttpError(400, provider === "gitlab" ? "Projekt bitte als „gruppe/projekt“ oder Projekt-ID angeben." : "Repository bitte als „besitzer/name“ angeben.");
  return repo;
}

/* ---------- HTTP ---------- */

export type IssueHttpRequest = { method: string; url: string; headers: Record<string, string>; body?: string; allowPrivate: boolean };
export type IssueHttpResponse = { status: number; headers: Record<string, string>; body: string };
export type IssueHttp = (request: IssueHttpRequest) => Promise<IssueHttpResponse>;
const safeTransport: IssueHttp = async (request) => {
  const response = await safeFetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    allowPrivate: request.allowPrivate,
    accept: "application/json",
    timeout: 15_000,
    maxBytes: 5_000_000,
  });
  return { status: response.status, headers: response.headers, body: response.body };
};
const runtime = globalThis as typeof globalThis & {
  flowplanIssueHttp?: IssueHttp;
  flowplanIssueRunning?: Set<string>;
  flowplanIssueTimer?: ReturnType<typeof setInterval>;
  flowplanIssuePushTimers?: Map<string, ReturnType<typeof setTimeout>>;
};
// Tests replace the transport; undefined restores the real one.
export function setIssueSyncTransport(http?: IssueHttp) {
  runtime.flowplanIssueHttp = http;
}
const transport = () => runtime.flowplanIssueHttp || safeTransport;

export class IssueRateLimit extends HttpError {
  constructor(public until: number) {
    super(429, "Der Git-Anbieter begrenzt gerade die Anfragen – die Synchronisierung macht später weiter.");
  }
}
// A refusal of the provider (502 to our caller) with the provider's own
// HTTP status (the Git connection's back-link shows it).
export class ProviderError extends HttpError {
  constructor(
    message: string,
    public upstream: number,
  ) {
    super(502, message);
  }
}
// How long to wait after a 403/429: Retry-After (seconds or a date), else
// the reset time of the rate limit, else a minute; at most an hour.
export function retryAfter(headers: Record<string, string>, now = Date.now()) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  let wait = MINUTE;
  const retry = h["retry-after"];
  const reset = Number(h["x-ratelimit-reset"] || h["ratelimit-reset"]);
  if (retry && /^\d+$/.test(retry.trim())) wait = Number(retry) * 1000;
  else if (retry && !Number.isNaN(Date.parse(retry))) wait = Date.parse(retry) - now;
  else if (reset > 0) wait = reset * 1000 - now;
  return now + Math.min(MAX_BACKOFF, Math.max(1000, wait));
}
const limited = (status: number, headers: Record<string, string>) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return status === 429 || (status === 403 && (h["x-ratelimit-remaining"] === "0" || h["ratelimit-remaining"] === "0" || !!h["retry-after"]));
};

type Endpoint = Awaited<ReturnType<typeof issueEndpoint>>;
type Client = { provider: IssueProvider; endpoint: Endpoint; token: string; repo: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
function authHeaders(client: Client): Record<string, string> {
  if (client.provider === "github")
    return { authorization: `Bearer ${client.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Flowplan-IssueSync" };
  if (client.provider === "gitlab") return { "private-token": client.token, accept: "application/json", "user-agent": "Flowplan-IssueSync" };
  return { authorization: `token ${client.token}`, accept: "application/json", "user-agent": "Flowplan-IssueSync" };
}
async function call(client: Client, method: string, path: string, body?: unknown): Promise<any> {
  return (await request(client, method, path, body)).data;
}
// The answer with its headers (Forgejo/Gitea: X-Total-Count, Link).
async function request(client: Client, method: string, path: string, body?: unknown): Promise<{ data: any; headers: Record<string, string> }> {
  const headers = authHeaders(client);
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await transport()({
    method,
    url: client.endpoint.api + path,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    allowPrivate: client.endpoint.allowPrivate,
  });
  if (limited(response.status, response.headers)) throw new IssueRateLimit(retryAfter(response.headers));
  const refused = (message: string) => new ProviderError(message, response.status);
  if (response.status === 401) throw refused("Der Git-Anbieter lehnt das Token ab.");
  if (response.status === 403) throw refused("Dem Token fehlt die Berechtigung für dieses Repository.");
  if (response.status === 404) throw refused("Repository oder Issue nicht gefunden – oder das Token hat keinen Zugriff.");
  if (response.status < 200 || response.status >= 300) throw refused(`Der Git-Anbieter antwortet mit HTTP ${response.status}.`);
  const lower = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
  try {
    return { data: response.body ? JSON.parse(response.body) : null, headers: lower };
  } catch {
    throw new HttpError(502, `Der Git-Anbieter antwortet mit HTTP ${response.status}.`);
  }
}

// One authenticated call to a provider's API outside of the issue sync
// (the back-link comments of the Git connection, lib/git-backlinks.ts):
// the same transport, address checks and error handling.
export type ProviderEndpoint = Endpoint;
export async function providerCall(provider: IssueProvider, endpoint: Endpoint, token: string, method: string, path: string, body?: unknown): Promise<any> {
  return await call({ provider, endpoint, token, repo: "" }, method, path, body);
}

// An issue as both providers describe it.
export type RemoteIssue = {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  milestone: { id: number; due: string | null } | null;
  updatedAt: number;
  comments: number;
  pull: boolean;
};
type RemoteComment = { id: string; author: string; body: string; url: string };
type IssueChange = { title?: string; body?: string; state?: "open" | "closed"; labels?: string[]; assignees?: string[]; milestone?: number | null };
const str = (v: unknown) => (typeof v === "string" ? v : "");

function githubIssue(i: any): RemoteIssue {
  return {
    id: String(i.id),
    number: Number(i.number),
    url: str(i.html_url),
    title: str(i.title),
    body: str(i.body),
    state: i.state === "closed" ? "closed" : "open",
    labels: (Array.isArray(i.labels) ? i.labels : []).map((l: any) => (typeof l === "string" ? l : str(l?.name))).filter(Boolean),
    assignees: (Array.isArray(i.assignees) ? i.assignees : i.assignee ? [i.assignee] : []).map((a: any) => str(a?.login)).filter(Boolean),
    milestone: i.milestone ? { id: Number(i.milestone.number), due: str(i.milestone.due_on).slice(0, 10) || null } : null,
    updatedAt: Date.parse(i.updated_at) || 0,
    comments: Number(i.comments) || 0,
    pull: !!i.pull_request,
  };
}
function gitlabIssue(i: any): RemoteIssue {
  return {
    id: String(i.id),
    number: Number(i.iid),
    url: str(i.web_url),
    title: str(i.title),
    body: str(i.description),
    state: i.state === "closed" ? "closed" : "open",
    labels: (Array.isArray(i.labels) ? i.labels : []).map((l: any) => (typeof l === "string" ? l : str(l?.name))).filter(Boolean),
    assignees: (Array.isArray(i.assignees) ? i.assignees : i.assignee ? [i.assignee] : []).map((a: any) => str(a?.username)).filter(Boolean),
    milestone: i.milestone ? { id: Number(i.milestone.id), due: str(i.milestone.due_date).slice(0, 10) || null } : null,
    updatedAt: Date.parse(i.updated_at) || 0,
    comments: Number(i.user_notes_count) || 0,
    pull: false,
  };
}

// Forgejo and Gitea (the same API): pull requests are issues too, marked by
// `pull_request` (and left out by type=issues).
function forgejoIssue(i: any): RemoteIssue {
  return {
    id: String(i.id),
    number: Number(i.number),
    url: str(i.html_url),
    title: str(i.title),
    body: str(i.body),
    state: i.state === "closed" ? "closed" : "open",
    labels: (Array.isArray(i.labels) ? i.labels : []).map((l: any) => (typeof l === "string" ? l : str(l?.name))).filter(Boolean),
    assignees: (Array.isArray(i.assignees) ? i.assignees : i.assignee ? [i.assignee] : []).map((a: any) => str(a?.login)).filter(Boolean),
    milestone: i.milestone ? { id: Number(i.milestone.id), due: str(i.milestone.due_on).slice(0, 10) || null } : null,
    updatedAt: Date.parse(i.updated_at) || 0,
    comments: Number(i.comments) || 0,
    pull: !!i.pull_request,
  };
}
// Whether a Forgejo/Gitea list goes on after `page`: X-Total-Count, else
// the Link header, else a full page.
function morePages(headers: Record<string, string>, page: number, got: number, seen: number) {
  const total = Number(headers["x-total-count"]);
  if (headers["x-total-count"] !== undefined && Number.isFinite(total)) return got > 0 && seen < total;
  if (headers.link !== undefined) return /rel="?next"?/.test(headers.link);
  return got >= PER_PAGE;
}
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// The provider's API, reduced to what the sync needs.
function issueApi(client: Client) {
  const gh = client.provider === "github";
  const gl = client.provider === "gitlab";
  const fj = client.provider === "forgejo";
  const repo = gl ? `/projects/${encodeURIComponent(client.repo)}` : `/repos/${client.repo}`;
  const toIssue = gh ? githubIssue : gl ? gitlabIssue : forgejoIssue;
  const userIds = new Map<string, number | null>();
  const gitlabBody = async (change: IssueChange) => {
    const body: Record<string, unknown> = {};
    if (change.title !== undefined) body.title = change.title;
    if (change.body !== undefined) body.description = change.body;
    if (change.labels) body.labels = change.labels.join(",");
    if (change.milestone !== undefined) body.milestone_id = change.milestone ?? 0;
    if (change.assignees) {
      const ids: number[] = [];
      for (const login of change.assignees) {
        if (!userIds.has(login)) {
          const found = (await call(client, "GET", `/users?username=${encodeURIComponent(login)}`)) as any[];
          userIds.set(login, Array.isArray(found) && found[0]?.id ? Number(found[0].id) : null);
        }
        const uid = userIds.get(login);
        if (uid) ids.push(uid);
      }
      body.assignee_ids = ids.length ? ids : [0];
    }
    return body;
  };
  const githubBody = (change: IssueChange) => {
    const body: Record<string, unknown> = {};
    if (change.title !== undefined) body.title = change.title;
    if (change.body !== undefined) body.body = change.body;
    if (change.state) body.state = change.state;
    if (change.labels) body.labels = change.labels;
    if (change.assignees) body.assignees = change.assignees;
    if (change.milestone !== undefined) body.milestone = change.milestone;
    return body;
  };
  // Forgejo/Gitea lists: `limit` per page, as long as X-Total-Count or the
  // Link header say there is more (a server may allow fewer than asked).
  const pagedList = async (path: string, pages: number) => {
    const items: any[] = [];
    for (let page = 1; page <= pages; page++) {
      const { data, headers } = await request(client, "GET", `${path}${path.includes("?") ? "&" : "?"}limit=${PER_PAGE}&page=${page}`);
      const list = Array.isArray(data) ? data : [];
      items.push(...list);
      if (!morePages(headers, page, list.length, items.length)) break;
    }
    return items;
  };
  // Forgejo/Gitea set labels by ID: those of the repository and of its
  // organisation; a missing one is created – as GitHub and GitLab do.
  let labelIds: Map<string, number> | null = null;
  const forgejoLabels = async (names: string[]) => {
    if (!labelIds) {
      const known = new Map<string, number>();
      try {
        for (const l of await pagedList(`/orgs/${encodeURIComponent(client.repo.split("/")[0])}/labels`, 5)) if (str(l?.name)) known.set(str(l.name), Number(l.id));
      } catch (error) {
        // A person's repository has no organisation (404), or the token may not read it.
        if (error instanceof IssueRateLimit) throw error;
      }
      for (const l of await pagedList(`${repo}/labels`, 20)) if (str(l?.name)) known.set(str(l.name), Number(l.id));
      labelIds = known;
    }
    const ids: number[] = [];
    for (const name of names) {
      if (!labelIds.has(name)) labelIds.set(name, Number((await call(client, "POST", `${repo}/labels`, { name, color: "#9e9e9e" }))?.id));
      ids.push(labelIds.get(name)!);
    }
    return ids;
  };
  const forgejoBody = (change: IssueChange) => {
    const body: Record<string, unknown> = {};
    if (change.title !== undefined) body.title = change.title;
    if (change.body !== undefined) body.body = change.body;
    if (change.state) body.state = change.state;
    if (change.assignees) body.assignees = change.assignees;
    if (change.milestone !== undefined) body.milestone = change.milestone ?? 0;
    return body;
  };
  // Forgejo/Gitea: issues (no pull requests) changed between `since` and
  // `before` (both inclusive, to the second), and how many there are.
  const forgejoQuery = (since: number | null, before: number | null) =>
    `${repo}/issues?state=all&type=issues${since ? `&since=${iso(since)}` : ""}${before ? `&before=${iso(before)}` : ""}`;
  const forgejoCount = async (since: number | null, before: number | null) => {
    const { data, headers } = await request(client, "GET", `${forgejoQuery(since, before)}&limit=1&page=1`);
    const total = Number(headers["x-total-count"]);
    if (headers["x-total-count"] !== undefined && Number.isFinite(total)) return total;
    return Array.isArray(data) && data.length ? null : 0;
  };
  // The issues changed since the cursor, oldest change first – at most
  // about one run's share: when more changed, the window ends earlier
  // (`before`, halved until it fits) and the next run goes on from the
  // cursor. Forgejo/Gitea sort by creation, so the window is read whole.
  const forgejoChanged = async (since: number | null) => {
    const budget = MAX_PULL_PAGES * PER_PAGE;
    let before: number | null = null;
    const total = await forgejoCount(since, null);
    if (total === 0) return [];
    if (total !== null && total > budget) {
      let lo = Math.floor((since ?? Date.UTC(2005, 0, 1)) / 1000);
      let hi = Math.ceil(Date.now() / 1000) + 60;
      for (let probe = 0; probe < MAX_WINDOW_PROBES && hi - lo > 1; probe++) {
        const mid = Math.floor((lo + hi) / 2);
        if (((await forgejoCount(since, mid * 1000)) ?? 0) > budget) hi = mid;
        else lo = mid;
      }
      // More than a run's share within one second (an imported repository):
      // that second whole.
      before = Math.max(lo, Math.floor((since ?? 0) / 1000) + 1) * 1000;
    }
    const issues = new Map<string, RemoteIssue>();
    for (const item of await pagedList(forgejoQuery(since, before), 40)) {
      const issue = forgejoIssue(item);
      issues.set(issue.id, issue);
    }
    return [...issues.values()].sort((a, b) => a.updatedAt - b.updatedAt || a.number - b.number);
  };
  const list = async (since: number | null, page: number) => {
    const params = gh
      ? `state=all&sort=updated&direction=asc&per_page=${PER_PAGE}&page=${page}${since ? `&since=${new Date(since).toISOString()}` : ""}`
      : `scope=all&order_by=updated_at&sort=asc&per_page=${PER_PAGE}&page=${page}${since ? `&updated_after=${new Date(since).toISOString()}` : ""}`;
    const data = await call(client, "GET", `${repo}/issues?${params}`);
    return (Array.isArray(data) ? data : []).map(toIssue);
  };
  return {
    async verify() {
      const data = await call(client, "GET", repo);
      return { name: str(gl ? data?.path_with_namespace : data?.full_name) || client.repo };
    },
    // Issues updated since the cursor, a page at a time, oldest change first.
    async *changed(since: number | null): AsyncGenerator<RemoteIssue[]> {
      if (fj) {
        const issues = await forgejoChanged(since);
        for (let i = 0; i < issues.length; i += PER_PAGE) yield issues.slice(i, i + PER_PAGE);
        return;
      }
      for (let page = 1; page <= MAX_PULL_PAGES; page++) {
        const issues = await list(since, page);
        yield issues;
        if (issues.length < PER_PAGE) break;
      }
    },
    async get(number: number) {
      return toIssue(await call(client, "GET", `${repo}/issues/${number}`));
    },
    async create(change: IssueChange) {
      const body = gh
        ? githubBody({ ...change, state: undefined })
        : gl
          ? await gitlabBody(change)
          : { ...forgejoBody({ ...change, state: undefined }), ...(change.labels ? { labels: await forgejoLabels(change.labels) } : {}) };
      const created = toIssue(await call(client, "POST", `${repo}/issues`, body));
      // New issues start open; a closed status follows in a second step.
      return change.state === "closed" ? this.update(created.number, { state: "closed" }) : created;
    },
    async update(number: number, change: IssueChange) {
      if (gh) return toIssue(await call(client, "PATCH", `${repo}/issues/${number}`, githubBody(change)));
      if (fj) {
        // Labels have a call of their own; the edit after it answers with the whole issue.
        if (change.labels) await call(client, "PUT", `${repo}/issues/${number}/labels`, { labels: await forgejoLabels(change.labels) });
        return toIssue(await call(client, "PATCH", `${repo}/issues/${number}`, forgejoBody(change)));
      }
      const body = await gitlabBody(change);
      if (change.state) body.state_event = change.state === "closed" ? "close" : "reopen";
      return toIssue(await call(client, "PUT", `${repo}/issues/${number}`, body));
    },
    async comments(number: number): Promise<RemoteComment[]> {
      const data = fj
        ? await pagedList(`${repo}/issues/${number}/comments`, 2)
        : await call(client, "GET", gh ? `${repo}/issues/${number}/comments?per_page=100` : `${repo}/issues/${number}/notes?sort=asc&order_by=created_at&per_page=100`);
      return (Array.isArray(data) ? data : [])
        .filter((c: any) => !gl || !c.system)
        .map((c: any) => ({
          id: String(c.id),
          author: str(gl ? c.author?.name || c.author?.username : c.user?.login),
          body: str(c.body),
          url: gl ? "" : str(c.html_url),
        }));
    },
    async comment(number: number, body: string): Promise<RemoteComment> {
      const c = await call(client, "POST", gl ? `${repo}/issues/${number}/notes` : `${repo}/issues/${number}/comments`, { body });
      return { id: String(c?.id ?? ""), author: "", body, url: gl ? "" : str(c?.html_url) };
    },
    async milestones() {
      const data = fj ? await pagedList(`${repo}/milestones?state=all`, 10) : await call(client, "GET", `${repo}/milestones?${gh ? "state=all&" : ""}per_page=100`);
      return (Array.isArray(data) ? data : []).map((m: any) => ({ id: Number(gh ? m.number : m.id), due: str(gh || fj ? m.due_on : m.due_date).slice(0, 10) || null }));
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
type IssueApi = Awaited<ReturnType<typeof issueApi>>;

/* ---------- Permissions ---------- */

// Connections: workspace owners and administrators (as full members).
async function requireConnectionManager(user: Identity, workspaceId: string) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  const role = await memberRole(user, workspaceId);
  if (!role || await isGuest(user, workspaceId) || (role !== "owner" && !user.isAdmin))
    throw new HttpError(403, "Nur Eigentümer des Arbeitsbereichs und Administratoren verbinden GitHub, GitLab oder Forgejo/Gitea.");
}
const mayManage = async (user: Identity, workspaceId: string) => {
  try {
    await requireConnectionManager(user, workspaceId);
    return true;
  } catch {
    return false;
  }
};
// The person the sync acts as, while they still may: an active account,
// a full member who is owner (or was an administrator when connecting).
async function connector(connection: ConnectionRow): Promise<Identity | null> {
  const user = await one<User>("SELECT * FROM users WHERE id=? AND disabled=0", connection.created_by);
  if (!user) return null;
  const who = { ...user, groups: [], isAdmin: false } as Identity;
  const role = await memberRole(who, connection.workspace_id);
  if (!role || await isGuest(who, connection.workspace_id)) return null;
  if (role !== "owner" && !parse<ConnectionState>(connection.state, {}).admin) return null;
  return who;
}

/* ---------- Connections ---------- */

const tokenAad = (connectionId: string) => `issue-sync:${connectionId}`;
const hookAad = (connectionId: string) => `issue-sync-hook:${connectionId}`;
const connectionInput = z.object({
  id: z.string().uuid().optional(),
  provider: z.enum(ISSUE_PROVIDERS),
  baseUrl: z.string().max(500).default(""),
  repo: z.string().max(300).default(""),
  token: z.string().trim().max(1000).optional(),
  people: peopleSchema.optional(),
});
async function connectionRow(workspaceId: string, connectionId: string) {
  const row = await one<ConnectionRow>("SELECT * FROM issue_connections WHERE id=? AND workspace_id=?", connectionId, workspaceId);
  if (!row) throw new HttpError(404, "Verbindung nicht gefunden.");
  return row;
}
function clientFor(connection: Pick<ConnectionRow, "id" | "provider" | "base_url" | "token">, repo: string): Client {
  return {
    provider: connection.provider,
    endpoint: issueEndpoint(connection.provider, connection.base_url),
    token: openSecret(connection.token, tokenAad(connection.id)),
    repo,
  };
}
async function saveConnection(user: Identity, workspaceId: string, raw: unknown) {
  await requireConnectionManager(user, workspaceId);
  const input = connectionInput.parse(raw);
  const endpoint = issueEndpoint(input.provider, input.baseUrl);
  const base = endpoint.selfHosted ? endpoint.web : "";
  const repo = input.repo.trim() ? checkedRepo(input.provider, input.repo) : "";
  const people = JSON.stringify(input.people || []);
  if (input.id) {
    const row = await connectionRow(workspaceId, input.id);
    // Another server needs the token again: it must not travel elsewhere.
    if ((row.base_url !== base || row.provider !== input.provider) && !input.token)
      throw new HttpError(400, "Für einen anderen Server bitte das Token erneut eingeben.");
    const token = input.token ? sealSecret(input.token, tokenAad(row.id)) : row.token;
    // A new token makes the person saving it the one the sync acts as.
    const state = { ...parse<ConnectionState>(row.state, {}), error: null, ...(input.token ? { admin: user.isAdmin } : {}) };
    await run(
      "UPDATE issue_connections SET provider=?,base_url=?,repo=?,token=?,people=?,state=?,created_by=? WHERE id=?",
      input.provider,
      base,
      repo,
      token,
      input.people ? people : row.people,
      JSON.stringify(state),
      input.token ? user.id : row.created_by,
      row.id,
    );
    await audit(user.id, "issueSync.connection", row.id, `${input.provider} ${base || PUBLIC_HOST[input.provider]}`);
    return { id: row.id };
  }
  if (!input.token) throw new HttpError(400, "Bitte ein Zugangstoken eingeben.");
  await lockFor(`issue-connections:${workspaceId}`);
  if (((await one<{ n: number }>("SELECT COUNT(*) n FROM issue_connections WHERE workspace_id=?", workspaceId))?.n || 0) >= 20)
    throw new HttpError(400, "Höchstens 20 Verbindungen je Arbeitsbereich.");
  const cid = id();
  await run(
    "INSERT INTO issue_connections(id,workspace_id,provider,base_url,repo,token,hook_token,hook_secret,people,state,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    cid,
    workspaceId,
    input.provider,
    base,
    repo,
    sealSecret(input.token, tokenAad(cid)),
    randomBytes(24).toString("base64url"),
    sealSecret(randomBytes(24).toString("base64url"), hookAad(cid)),
    people,
    JSON.stringify({ admin: user.isAdmin && (await memberRole(user, workspaceId)) !== "owner" }),
    user.id,
    Date.now(),
  );
  await audit(user.id, "issueSync.connection", cid, `${input.provider} ${base || PUBLIC_HOST[input.provider]}`);
  return { id: cid };
}

// "Test": one API call with the entered (or stored) token.
export async function testIssueConnection(user: Identity, raw: unknown) {
  const input = connectionInput.extend({ workspaceId: z.string().uuid() }).parse(raw);
  await requireConnectionManager(user, input.workspaceId);
  const endpoint = issueEndpoint(input.provider, input.baseUrl);
  let token = input.token || "";
  if (!token && input.id) {
    const row = await connectionRow(input.workspaceId, input.id);
    if (row.provider !== input.provider || row.base_url !== (endpoint.selfHosted ? endpoint.web : ""))
      throw new HttpError(400, "Für einen anderen Server bitte das Token erneut eingeben.");
    token = openSecret(row.token, tokenAad(row.id));
  }
  if (!token) throw new HttpError(400, "Bitte ein Zugangstoken eingeben.");
  const repo = checkedRepo(input.provider, input.repo);
  const result = await issueApi({ provider: input.provider, endpoint, token, repo }).verify();
  if (input.id)
    await transaction(async () => {
      const row = await one<ConnectionRow>("SELECT * FROM issue_connections WHERE id=?", input.id!);
      if (row) await run("UPDATE issue_connections SET state=? WHERE id=?", JSON.stringify({ ...parse<ConnectionState>(row.state, {}), checkedAt: Date.now(), error: null }), row.id);
    });
  return { ok: true, repo: result.name };
}

/* ---------- Mapping ---------- */

const fieldTypes: Record<string, string[]> = {
  title: ["text", "url", "email", "phone"],
  body: ["text"],
  status: ["select"],
  labels: ["multiselect"],
  assignee: ["person"],
  milestone: ["date"],
  number: ["number", "text"],
  url: ["url", "text"],
};
function checkConfig(fields: Field[], config: IssueSyncConfig) {
  const want = (key: keyof typeof fieldTypes, value: string) => {
    if (!value || (key === "body" && value === "@document")) return;
    const field = fields.find((f) => f.id === value);
    if (!field || !fieldTypes[key].includes(field.type)) throw new HttpError(400, "Die Zuordnung passt nicht zu den Eigenschaften der Datenbank.");
  };
  want("title", config.title);
  want("body", config.body);
  want("labels", config.labels);
  want("assignee", config.assignee);
  want("milestone", config.milestone);
  want("number", config.number);
  want("url", config.url);
  if (config.status) {
    want("status", config.status.field);
    const field = fields.find((f) => f.id === config.status!.field)!;
    if (config.status.map.some((m) => !field.options?.includes(m.value))) throw new HttpError(400, "Unbekannte Auswahl.");
  }
  const used = [config.title, config.body, config.labels, config.assignee, config.milestone, config.number, config.url, config.status?.field].filter(
    (v) => v && v !== "@document",
  );
  if (new Set(used).size !== used.length) throw new HttpError(400, "Jede Eigenschaft nur einmal zuordnen.");
}
const databaseFields = async (pageId: string) => parse<Field[]>((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId))?.fields, []);

async function saveMapping(user: Identity, raw: unknown) {
  const input = z.object({ pageId: z.string().uuid(), connectionId: z.string().uuid(), repo: z.string().max(300).optional(), config: z.unknown() }).parse(raw);
  const page = await requirePage(user, input.pageId, true);
  if (page.kind !== "database") throw new HttpError(400, "Keine Datenbank.");
  await requireUnlocked(user, page);
  await requireConnectionManager(user, page.workspace_id);
  const connection = await connectionRow(page.workspace_id, input.connectionId);
  const repo = checkedRepo(connection.provider, input.repo?.trim() || connection.repo);
  const config = issueSyncConfigSchema.parse(input.config);
  checkConfig(await databaseFields(page.id), config);
  const taken = await one<{ page_id: string }>(
    "SELECT m.page_id FROM issue_sync_maps m JOIN issue_connections c ON c.id=m.connection_id WHERE c.provider=? AND c.base_url=? AND m.repo=? AND m.page_id!=?",
    connection.provider,
    connection.base_url,
    repo,
    page.id,
  );
  if (taken) throw new HttpError(409, "Dieses Repository ist schon mit einer anderen Datenbank verbunden.");
  const existing = await one<MapRow>("SELECT * FROM issue_sync_maps WHERE page_id=?", page.id);
  // Another repository starts over: links of the old one no longer apply.
  if (existing && (existing.repo !== repo || existing.connection_id !== connection.id)) {
    await run("DELETE FROM issue_links WHERE page_id=?", page.id);
    await run("DELETE FROM issue_comment_links WHERE page_id=?", page.id);
    await run("DELETE FROM issue_sync_queue WHERE page_id=?", page.id);
  }
  const fresh = !existing || existing.repo !== repo || existing.connection_id !== connection.id;
  await run(
    "INSERT INTO issue_sync_maps(page_id,connection_id,repo,config,state,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET connection_id=excluded.connection_id,repo=excluded.repo,config=excluded.config,state=CASE WHEN ? THEN excluded.state ELSE issue_sync_maps.state END,created_by=excluded.created_by,created_at=CASE WHEN ? THEN excluded.created_at ELSE issue_sync_maps.created_at END",
    page.id,
    connection.id,
    repo,
    JSON.stringify(config),
    "{}",
    user.id,
    Date.now(),
    fresh ? 1 : 0,
    fresh ? 1 : 0,
  );
  await audit(user.id, "issueSync.map", page.id, `${connection.provider}:${repo} ${config.direction}`);
  return { ok: true };
}

// Commands (lib/api.ts): issueSync.connect, .disconnect, .map, .unmap.
export async function issueSyncCommand(user: Identity, action: string, b: Record<string, unknown>) {
  if (user.apiScope === "read") throw new HttpError(403, "Dieses API-Token darf nur lesen.");
  if (action === "issueSync.connect") return await saveConnection(user, z.string().uuid().parse(b.workspaceId), b);
  if (action === "issueSync.disconnect") {
    const workspaceId = z.string().uuid().parse(b.workspaceId);
    await requireConnectionManager(user, workspaceId);
    const row = await connectionRow(workspaceId, z.string().uuid().parse(b.id));
    for (const m of await all<{ page_id: string }>("SELECT page_id FROM issue_sync_maps WHERE connection_id=?", row.id)) await dropMapping(m.page_id);
    await run("DELETE FROM issue_connections WHERE id=?", row.id);
    await audit(user.id, "issueSync.disconnect", row.id, row.provider);
    return { ok: true };
  }
  if (action === "issueSync.map") return await saveMapping(user, b);
  if (action === "issueSync.unmap") {
    const page = await requirePage(user, z.string().uuid().parse(b.pageId), true);
    await requireConnectionManager(user, page.workspace_id);
    await dropMapping(page.id);
    await audit(user.id, "issueSync.unmap", page.id, "");
    return { ok: true };
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}
async function dropMapping(pageId: string) {
  await run("DELETE FROM issue_sync_maps WHERE page_id=?", pageId);
  await run("DELETE FROM issue_links WHERE page_id=?", pageId);
  await run("DELETE FROM issue_comment_links WHERE page_id=?", pageId);
  await run("DELETE FROM issue_sync_queue WHERE page_id=?", pageId);
}

/* ---------- Status for the settings ---------- */

const hookUrl = (token: string) => `${appUrl().replace(/\/$/, "")}/api/issue-sync/hook/${token}`;
export async function issueSyncOverview(user: Identity, workspaceId: string) {
  if (!(await mayManage(user, workspaceId))) return { available: false as const };
  const connections = await all<ConnectionRow>("SELECT * FROM issue_connections WHERE workspace_id=? ORDER BY created_at", workspaceId);
  return {
    available: true as const,
    allowedHosts: issueSyncHosts(),
    connections: await mapAsync(connections, async (c) => {
      let secret = "";
      try {
        secret = openSecret(c.hook_secret, hookAad(c.id));
      } catch {
        /* key missing: the settings show no secret */
      }
      const state = parse<ConnectionState>(c.state, {});
      return {
        id: c.id,
        provider: c.provider,
        baseUrl: c.base_url,
        repo: c.repo,
        tokenSet: !!c.token,
        people: parse<People>(c.people, []),
        hookUrl: hookUrl(c.hook_token),
        hookSecret: secret,
        connectedBy: (await one<{ name: string }>("SELECT name FROM users WHERE id=?", c.created_by))?.name || "",
        active: !!(await connector(c)),
        checkedAt: state.checkedAt || null,
        error: state.error || null,
        backoffUntil: state.backoffUntil && state.backoffUntil > Date.now() ? state.backoffUntil : null,
        databases: (await all<{ page_id: string; title: string; repo: string; state: string }>(
          "SELECT m.page_id,p.title,m.repo,m.state FROM issue_sync_maps m JOIN pages p ON p.id=m.page_id WHERE m.connection_id=? AND p.deleted_at IS NULL",
          c.id,
        )).map((m) => ({ pageId: m.page_id, title: m.title, repo: m.repo, state: parse<MapState>(m.state, {}) })),
      };
    }),
  };
}
// The mapping dialog of a database.
export async function issueSyncDatabase(user: Identity, pageId: string) {
  const page = await requirePage(user, pageId);
  const map = await one<MapRow>("SELECT * FROM issue_sync_maps WHERE page_id=?", pageId);
  const manage = await mayManage(user, page.workspace_id) && (await pageRole(user, page)) !== "viewer";
  return {
    manage,
    connections: manage
      ? (await all<{ id: string; provider: IssueProvider; base_url: string; repo: string }>(
          "SELECT id,provider,base_url,repo FROM issue_connections WHERE workspace_id=? ORDER BY created_at",
          page.workspace_id,
        )).map((c) => ({ id: c.id, provider: c.provider, baseUrl: c.base_url, repo: c.repo }))
      : [],
    map: map
      ? {
          connectionId: manage ? map.connection_id : "",
          provider: (await one<{ provider: IssueProvider }>("SELECT provider FROM issue_connections WHERE id=?", map.connection_id))?.provider || "github",
          repo: map.repo,
          config: parse<IssueSyncConfig>(map.config, issueSyncConfigSchema.parse({ title: "" })),
          state: parse<MapState>(map.state, {}),
          links: (await one<{ n: number }>("SELECT COUNT(*) n FROM issue_links WHERE page_id=?", pageId))?.n || 0,
        }
      : null,
  };
}
// "GitHub #123" on a record.
export async function issueLinkOf(user: Identity, pageId: string, rowId: string) {
  await requirePage(user, pageId);
  await requireRow(user, pageId, rowId);
  const link = await one<{ provider: IssueProvider; number: number; url: string }>("SELECT provider,number,url FROM issue_links WHERE row_id=? AND page_id=?", rowId, pageId);
  return link ? { provider: link.provider, label: `${providerName[link.provider]} #${link.number}`, number: link.number, url: link.url } : null;
}

/* ---------- Mapping values ---------- */

type Cells = Record<string, unknown>;
type RowData = { id: string; cells: string; created_at: string; updated_at: string; access?: string; created_by?: string };
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const fromSql = (text: string | null | undefined) => (text ? Date.parse(text.replace(" ", "T") + (text.endsWith("Z") ? "" : "Z")) || 0 : 0);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = (list: string[]) => [...new Set(list)].sort();
const statusLabels = (config: IssueSyncConfig) => new Set((config.status?.map || []).map((m) => m.label).filter(Boolean));

async function documentMarkdown(rowId: string) {
  const html = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowId))?.html || "";
  if (!html.trim()) return "";
  try {
    return markdownSource(html).markdown.trim();
  } catch {
    return "";
  }
}
// What of a record the mapping covers, comparable between runs.
async function localView(config: IssueSyncConfig, people: Map<string, string>, rowId: string, cells: Cells) {
  const view: Record<string, unknown> = { title: cellText(cells[config.title]).trim() };
  if (config.body) view.body = config.body === "@document" ? (await documentMarkdown(rowId)) : cellText(cells[config.body]).trim();
  if (config.status) view.status = cellText(cells[config.status.field]);
  if (config.labels) view.labels = sorted(Array.isArray(cells[config.labels]) ? (cells[config.labels] as string[]) : []);
  if (config.assignee) view.assignee = people.get(String(cells[config.assignee] || "")) || "";
  if (config.milestone) view.due = String(cells[config.milestone] || "").slice(0, 10);
  return view;
}
type RemoteView = { title: string; body: string; state: string; labels: string[]; assignees: string[]; due: string | null };
const remoteView = (issue: RemoteIssue): RemoteView => ({
  title: issue.title,
  body: issue.body.trim(),
  state: issue.state,
  labels: sorted(issue.labels),
  assignees: sorted(issue.assignees),
  due: issue.milestone?.due || null,
});
// The parts of an issue the mapping covers (to tell whether it changed).
function remoteProjection(config: IssueSyncConfig, view: Partial<RemoteView>) {
  return hash([
    view.title,
    config.body ? view.body : null,
    config.status ? view.state : null,
    config.status || config.labels ? view.labels : null,
    config.assignee ? view.assignees : null,
    config.milestone ? view.due : null,
  ]);
}

// Property values from an issue (only the mapped ones).
function cellsFromIssue(config: IssueSyncConfig, fields: Field[], users: Map<string, string>, issue: RemoteIssue, current: Cells) {
  const patch: Cells = {};
  patch[config.title] = issue.title.slice(0, 10000);
  if (config.body && config.body !== "@document") patch[config.body] = issue.body.slice(0, 10000);
  if (config.status) {
    const labels = new Set(issue.labels);
    const candidates = config.status.map.filter((m) => m.state === issue.state);
    const fits = (m: { label: string }) => !m.label || labels.has(m.label);
    const now = String(current[config.status.field] || "");
    const keep = candidates.find((m) => m.value === now && fits(m));
    const pick = keep || candidates.find((m) => m.label && labels.has(m.label)) || candidates.find((m) => !m.label) || candidates[0];
    if (pick) patch[config.status.field] = pick.value;
  }
  if (config.labels) {
    const field = fields.find((f) => f.id === config.labels);
    const own = statusLabels(config);
    patch[config.labels] = issue.labels.filter((l) => !own.has(l) && field?.options?.includes(l));
  }
  if (config.assignee) {
    const uid = issue.assignees.map((login) => users.get(login.toLowerCase())).find(Boolean);
    patch[config.assignee] = uid || "";
  }
  if (config.milestone) patch[config.milestone] = issue.milestone?.due && validDateValue(issue.milestone.due) ? issue.milestone.due : "";
  Object.assign(patch, readOnlyCells(config, fields, issue));
  return patch;
}
function readOnlyCells(config: IssueSyncConfig, fields: Field[], issue: Pick<RemoteIssue, "number" | "url">) {
  const patch: Cells = {};
  if (config.number) patch[config.number] = fields.find((f) => f.id === config.number)?.type === "number" ? issue.number : `#${issue.number}`;
  if (config.url) patch[config.url] = issue.url;
  return patch;
}

// The issue fields from a record (only the mapped ones).
function issueFromView(
  config: IssueSyncConfig,
  fields: Field[],
  view: Record<string, unknown>,
  previous: RemoteView | null,
  milestones: { id: number; due: string | null }[] | null,
): IssueChange {
  const change: IssueChange = { title: String(view.title || "").slice(0, 250) || "Ohne Titel" };
  if (config.body) change.body = String(view.body || "");
  let labels: string[] | null = null;
  if (config.status || config.labels) {
    const own = statusLabels(config);
    const field = config.labels ? fields.find((f) => f.id === config.labels) : null;
    const managed = new Set([...own, ...(field?.options || [])]);
    labels = (previous?.labels || []).filter((l) => !managed.has(l));
  }
  if (config.status) {
    const entry = config.status.map.find((m) => m.value === view.status);
    if (entry) {
      change.state = entry.state;
      if (entry.label) labels!.push(entry.label);
    }
  }
  if (config.labels) labels!.push(...((view.labels as string[]) || []));
  if (labels) change.labels = sorted(labels);
  if (config.assignee) change.assignees = view.assignee ? [String(view.assignee)] : [];
  if (config.milestone && milestones) {
    const due = String(view.due || "");
    if (!due) change.milestone = null;
    else {
      const match = milestones.find((m) => m.due === due);
      if (match) change.milestone = match.id;
    }
  }
  return change;
}

/* ---------- The sync ---------- */

type Context = {
  page: Page;
  map: MapRow;
  config: IssueSyncConfig;
  connection: ConnectionRow;
  who: Identity;
  api: IssueApi;
  fields: Field[];
  // Flowplan user ID → login, login (lower case) → user ID.
  logins: Map<string, string>;
  users: Map<string, string>;
  hidden: Set<string>;
  state: MapState;
  milestones: { id: number; due: string | null }[] | null;
};
async function peopleMaps(connection: ConnectionRow) {
  const logins = new Map<string, string>(),
    users = new Map<string, string>();
  for (const entry of parse<People>(connection.people, [])) {
    const member = await one<{ id: string }>(
      "SELECT u.id FROM users u JOIN members m ON m.user_id=u.id WHERE m.workspace_id=? AND lower(u.email)=?",
      connection.workspace_id,
      entry.email.toLowerCase(),
    );
    if (!member) continue;
    logins.set(member.id, entry.login);
    users.set(entry.login.toLowerCase(), member.id);
  }
  return { logins, users };
}
async function saveMapState(pageId: string, patch: MapState) {
  const row = await one<{ state: string }>("SELECT state FROM issue_sync_maps WHERE page_id=?", pageId);
  if (row) await run("UPDATE issue_sync_maps SET state=? WHERE page_id=?", JSON.stringify({ ...parse<MapState>(row.state, {}), ...patch }), pageId);
}
async function saveConnectionState(connectionId: string, patch: ConnectionState) {
  const row = await one<{ state: string }>("SELECT state FROM issue_connections WHERE id=?", connectionId);
  if (row) await run("UPDATE issue_connections SET state=? WHERE id=?", JSON.stringify({ ...parse<ConnectionState>(row.state, {}), ...patch }), connectionId);
}
const rowOf = async (ctx: Context, rowId: string) =>
  await one<RowData>("SELECT id,cells,created_at,updated_at,access,created_by FROM rows WHERE id=? AND page_id=?", rowId, ctx.page.id);
const localUpdated = async (rowId: string, row: RowData) =>
  Math.max(fromSql(row.updated_at), fromSql((await one<{ updated_at: string }>("SELECT updated_at FROM row_documents WHERE row_id=?", rowId))?.updated_at));
const linkOfIssue = async (ctx: Context, issueId: string) =>
  await one<LinkRow>("SELECT * FROM issue_links WHERE provider=? AND repo=? AND issue_id=?", ctx.connection.provider, ctx.map.repo, issueId);
const currentHash = async (ctx: Context, rowId: string) => {
  const row = await rowOf(ctx, rowId);
  return row ? hash(await localView(ctx.config, ctx.logins, rowId, parse<Cells>(row.cells, {}))) : "";
};

// Writes an issue into its record (new or existing), as the connecting
// person, with workflow and automations; returns false when refused.
async function applyIssue(ctx: Context, issue: RemoteIssue, link: LinkRow | undefined): Promise<boolean> {
  try {
    return await transaction(async () =>
      await quietly(async () => {
        let rowId = link?.row_id;
        if (rowId && !(await rowOf(ctx, rowId))) return false; // in the trash
        if (!rowId) {
          rowId = id();
          const cells = cellsFromIssue(ctx.config, ctx.fields, ctx.users, issue, {});
          await run(
            "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
            rowId,
            ctx.page.id,
            JSON.stringify(cells),
            Date.now(),
            ctx.who.id,
            ctx.who.id,
          );
          if (ctx.config.body === "@document" && issue.body.trim()) await replaceRowDocument(rowId, markdownToHtml(issue.body), ctx.who.id);
          await rowCreated(ctx.who, ctx.page, rowId);
        } else {
          const row = (await rowOf(ctx, rowId))!;
          const before = parse<Cells>(row.cells, {});
          const after = { ...before, ...cellsFromIssue(ctx.config, ctx.fields, ctx.users, issue, before) };
          if (JSON.stringify(after) !== JSON.stringify(before)) {
            await run("UPDATE rows SET cells=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?", JSON.stringify(after), nowText(), ctx.who.id, rowId);
            await rowChanged(ctx.who, ctx.page, rowId, before, after, ctx.fields);
          }
          if (ctx.config.body === "@document" && (await documentMarkdown(rowId)) !== issue.body.trim())
            await replaceRowDocument(rowId, issue.body.trim() ? markdownToHtml(issue.body) : "", ctx.who.id);
        }
        await storeLink(ctx, rowId, issue, await currentHash(ctx, rowId), link);
        return true;
      }),
    );
  } catch (error) {
    ctx.state.error = (error as Error).message;
    return false;
  }
}
async function storeLink(ctx: Context, rowId: string, issue: RemoteIssue, localHash: string, link?: LinkRow) {
  await run(
    "INSERT INTO issue_links(id,page_id,row_id,provider,repo,issue_id,number,url,remote,local_hash,remote_updated,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(row_id) DO UPDATE SET issue_id=excluded.issue_id,number=excluded.number,url=excluded.url,remote=excluded.remote,local_hash=excluded.local_hash,remote_updated=excluded.remote_updated,synced_at=excluded.synced_at",
    link?.id || id(),
    ctx.page.id,
    rowId,
    ctx.connection.provider,
    ctx.map.repo,
    issue.id,
    issue.number,
    issue.url.slice(0, 1000),
    JSON.stringify(remoteView(issue)),
    localHash,
    issue.updatedAt,
    Date.now(),
  );
}
// Both sides changed since the last sync: the later change wins.
async function conflict(ctx: Context, rowId: string, issue: RemoteIssue, remoteWins: boolean) {
  ctx.state.conflicts = (ctx.state.conflicts || 0) + 1;
  await transaction(async () =>
    await audit(ctx.who.id, "issueSync.conflict", rowId, `${providerName[ctx.connection.provider]} #${issue.number}: ${remoteWins ? "remote" : "local"}`),
  );
}

async function pullComments(ctx: Context, rowId: string, issue: RemoteIssue) {
  if (!ctx.config.comments.pull || !issue.comments) return;
  const comments = await ctx.api.comments(issue.number);
  let added = 0;
  for (const c of comments) {
    if (added >= MAX_COMMENTS) break;
    if (await one("SELECT 1 FROM issue_comment_links WHERE provider=? AND repo=? AND remote_id=?", ctx.connection.provider, ctx.map.repo, c.id)) continue;
    const text = `${c.body.trim()}\n\n— ${c.author || "?"} (${providerName[ctx.connection.provider]})${c.url ? ` ${c.url}` : issue.url ? ` ${issue.url}` : ""}`;
    await transaction(async () => {
      const cid = id();
      await run("INSERT INTO comments(id,page_id,row_id,author_id,body) VALUES(?,?,?,?,?)", cid, ctx.page.id, rowId, ctx.who.id, text.slice(0, 5000));
      await run("INSERT INTO issue_comment_links(comment_id,page_id,provider,repo,remote_id) VALUES(?,?,?,?,?)", cid, ctx.page.id, ctx.connection.provider, ctx.map.repo, c.id);
    });
    added++;
  }
}
async function pushComments(ctx: Context, rowId: string, number: number) {
  if (!ctx.config.comments.push) return;
  const comments = await all<{ id: string; body: string; name: string | null }>(
    `SELECT c.id,c.body,u.name FROM comments c LEFT JOIN users u ON u.id=c.author_id
      WHERE c.page_id=? AND c.row_id=? AND c.created_at>=? AND NOT EXISTS(SELECT 1 FROM issue_comment_links l WHERE l.comment_id=c.id)
      ORDER BY c.created_at LIMIT ?`,
    ctx.page.id,
    rowId,
    sqlTime(ctx.map.created_at),
    MAX_COMMENTS,
  );
  for (const c of comments) {
    const posted = await ctx.api.comment(number, `**${c.name || "Flowplan"}** (Flowplan):\n\n${c.body}`);
    await transaction(async () =>
      await run("INSERT INTO issue_comment_links(comment_id,page_id,provider,repo,remote_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING", c.id, ctx.page.id, ctx.connection.provider, ctx.map.repo, posted.id),
    );
  }
}

async function pull(ctx: Context) {
  let cursor = ctx.state.cursor ?? (ctx.config.importExisting ? null : ctx.map.created_at);
  let pulled = 0;
  for await (const issues of ctx.api.changed(cursor ?? null)) {
    for (const issue of issues) {
      if (issue.pull) continue;
      const link = await linkOfIssue(ctx, issue.id);
      const remoteChanged = !link || remoteProjection(ctx.config, parse<RemoteView>(link.remote, {} as RemoteView)) !== remoteProjection(ctx.config, remoteView(issue));
      if (link && (!(await rowOf(ctx, link.row_id)) || ctx.hidden.has(link.row_id))) {
        ctx.state.skipped = (ctx.state.skipped || 0) + 1;
        continue;
      }
      if (remoteChanged) {
        let apply = true;
        if (link) {
          const row = (await rowOf(ctx, link.row_id))!;
          const localChanged = ctx.config.direction !== "pull" && (await currentHash(ctx, link.row_id)) !== link.local_hash;
          if (localChanged) {
            apply = issue.updatedAt > (await localUpdated(link.row_id, row));
            await conflict(ctx, link.row_id, issue, apply);
            // The record wins: the push overwrites this state of the issue.
            if (!apply)
              await transaction(async () => {
                await run("UPDATE issue_links SET remote=?,remote_updated=? WHERE id=?", JSON.stringify(remoteView(issue)), issue.updatedAt, link.id);
                await run("INSERT INTO issue_sync_queue(row_id,page_id,at) VALUES(?,?,?) ON CONFLICT DO NOTHING", link.row_id, ctx.page.id, Date.now());
              });
          }
        }
        if (apply && await applyIssue(ctx, issue, link)) pulled++;
      } else if (link && issue.updatedAt > link.remote_updated)
        await transaction(async () => await run("UPDATE issue_links SET remote_updated=? WHERE id=?", issue.updatedAt, link.id));
      const current = await linkOfIssue(ctx, issue.id);
      if (current && (!link || issue.updatedAt > link.remote_updated)) await pullComments(ctx, current.row_id, issue);
      cursor = Math.max(cursor || 0, issue.updatedAt);
    }
  }
  ctx.state.cursor = cursor ?? undefined;
  ctx.state.lastPull = Date.now();
  ctx.state.pulled = pulled;
}

// Records to push: queued ones and, on the poll, those changed since the
// last scan (also documents, whose edits do not pass the record hooks).
async function pushCandidates(ctx: Context, scan: boolean) {
  const ids = new Set(
    (await all<{ row_id: string }>("SELECT row_id FROM issue_sync_queue WHERE page_id=? ORDER BY at LIMIT ?", ctx.page.id, MAX_PUSH)).map((r) => r.row_id),
  );
  if (scan) {
    const since = sqlTime(ctx.state.scanAt ?? ctx.map.created_at);
    for (const r of await all<{ id: string }>(
      `SELECT r.id FROM rows r LEFT JOIN row_documents d ON d.row_id=r.id
        WHERE r.page_id=? AND (r.updated_at>=? OR d.updated_at>=?) ORDER BY r.updated_at LIMIT ?`,
      ctx.page.id,
      since,
      since,
      MAX_PUSH * 4,
    ))
      if (ids.size < MAX_PUSH) ids.add(r.id);
    ctx.state.scanAt = Date.now() - 1000;
  }
  return [...ids];
}

async function push(ctx: Context, scan: boolean) {
  let pushed = 0;
  for (const rowId of await pushCandidates(ctx, scan)) {
    const row = await rowOf(ctx, rowId);
    const done = async () => await transaction(async () => await run("DELETE FROM issue_sync_queue WHERE row_id=?", rowId));
    if (!row || ctx.hidden.has(rowId)) {
      if (row) ctx.state.skipped = (ctx.state.skipped || 0) + 1;
      await done();
      continue;
    }
    let link = await one<LinkRow>("SELECT * FROM issue_links WHERE row_id=?", rowId);
    // Only records created after the mapping become new issues.
    if (!link && fromSql(row.created_at) < ctx.map.created_at - 1000) {
      await done();
      continue;
    }
    const cells = parse<Cells>(row.cells, {});
    const view = await localView(ctx.config, ctx.logins, rowId, cells);
    const localHash = hash(view);
    if (link && localHash === link.local_hash) {
      await pushComments(ctx, rowId, link.number);
      await done();
      continue;
    }
    if (!view.title) {
      await done();
      continue;
    }
    let previous = link ? parse<RemoteView>(link.remote, null as unknown as RemoteView) : null;
    if (link && ctx.config.direction === "both") {
      // Changed on both sides since the last sync? The later change wins.
      const remote = await ctx.api.get(link.number);
      if (remoteProjection(ctx.config, remoteView(remote)) !== remoteProjection(ctx.config, previous || {})) {
        const remoteWins = remote.updatedAt > (await localUpdated(rowId, row));
        await conflict(ctx, rowId, remote, remoteWins);
        if (remoteWins) {
          await applyIssue(ctx, remote, link);
          await done();
          continue;
        }
      }
      previous = remoteView(remote);
    }
    if (ctx.config.milestone && !ctx.milestones) ctx.milestones = await ctx.api.milestones();
    const change = issueFromView(ctx.config, ctx.fields, view, previous, ctx.milestones);
    const issue = link ? await ctx.api.update(link.number, change) : await ctx.api.create(change);
    await transaction(async () =>
      await quietly(async () => {
        // Number and address are read-only copies of the issue.
        const fresh = await rowOf(ctx, rowId);
        if (fresh) {
          const before = parse<Cells>(fresh.cells, {});
          const after = { ...before, ...readOnlyCells(ctx.config, ctx.fields, issue) };
          if (JSON.stringify(after) !== JSON.stringify(before))
            await run("UPDATE rows SET cells=?,version=version+1 WHERE id=?", JSON.stringify(after), rowId);
        }
        await storeLink(ctx, rowId, issue, await currentHash(ctx, rowId), link);
        await run("DELETE FROM issue_sync_queue WHERE row_id=?", rowId);
      }),
    );
    link = await one<LinkRow>("SELECT * FROM issue_links WHERE row_id=?", rowId);
    if (link) await pushComments(ctx, rowId, link.number);
    pushed++;
  }
  ctx.state.lastPush = Date.now();
  ctx.state.pushed = pushed;
}

// One run for a database: pull, then push (so a remote change that won is
// not overwritten). `scan` (the poll) also looks for changed records.
export type IssueSyncResult = MapState & { ok: boolean; running?: boolean; backoffUntil?: number };
export async function syncIssues(pageId: string, options: { scan?: boolean; pushOnly?: boolean } = {}): Promise<IssueSyncResult> {
  const running = (runtime.flowplanIssueRunning ??= new Set());
  if (running.has(pageId)) return { ok: false, running: true };
  running.add(pageId);
  try {
    const map = await one<MapRow>("SELECT * FROM issue_sync_maps WHERE page_id=?", pageId);
    if (!map) return { ok: false };
    const connection = (await one<ConnectionRow>("SELECT * FROM issue_connections WHERE id=?", map.connection_id))!;
    const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", pageId);
    if (!page) return { ok: false };
    const cstate = parse<ConnectionState>(connection.state, {});
    if (cstate.backoffUntil && cstate.backoffUntil > Date.now()) return { ok: false, backoffUntil: cstate.backoffUntil };
    const state: MapState = { ...parse<MapState>(map.state, {}), error: null, conflicts: 0, skipped: 0 };
    const who = await connector(connection);
    const fail = async (message: string) => {
      await transaction(async () => await saveMapState(pageId, { error: message }));
      return { ok: false, error: message };
    };
    if (!who) return await fail("Die Person, die die Verbindung eingerichtet hat, ist nicht mehr Eigentümer des Arbeitsbereichs – bitte neu verbinden.");
    const role = await pageRole(who, page);
    if (!role || role === "viewer" || page.locked) return await fail("Die verbindende Person darf diese Datenbank nicht bearbeiten.");
    // Below a journal behind a PIN nothing goes out to the repository.
    if (await journalLocked(who, page)) return await fail("Dieses Journal ist gesperrt.");
    const config = parse<IssueSyncConfig>(map.config, issueSyncConfigSchema.parse({ title: "" }));
    const fields = await databaseFields(pageId);
    try {
      checkConfig(fields, config);
    } catch (error) {
      return await fail((error as Error).message);
    }
    let client: Client;
    try {
      client = clientFor(connection, map.repo);
    } catch (error) {
      return await fail((error as Error).message);
    }
    const ctx: Context = {
      page,
      map,
      config,
      connection,
      who,
      api: issueApi(client),
      fields,
      ...(await peopleMaps(connection)),
      hidden: await hiddenRowIds(who, page),
      state,
      milestones: null,
    };
    try {
      if (config.direction !== "push" && !options.pushOnly) await pull(ctx);
      if (config.direction !== "pull") await push(ctx, !!options.scan);
    } catch (error) {
      if (error instanceof IssueRateLimit) await transaction(async () => await saveConnectionState(connection.id, { backoffUntil: error.until }));
      ctx.state.error = (error as Error).message;
    }
    await transaction(async () => await saveMapState(pageId, ctx.state));
    return { ok: !ctx.state.error, ...ctx.state };
  } finally {
    running.delete(pageId);
  }
}

// "Sync now" in the database dialog.
export async function runIssueSync(user: Identity, pageId: string) {
  const page = await requirePage(user, pageId, true);
  if (!(await one("SELECT 1 FROM issue_sync_maps WHERE page_id=?", page.id))) throw new HttpError(404, "Diese Datenbank ist mit keinem Repository verbunden.");
  return syncIssues(page.id, { scan: true });
}

/* ---------- Webhooks ---------- */

function same(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
// Checks a webhook of GitHub (X-Hub-Signature-256), GitLab (X-Gitlab-Token)
// or Forgejo/Gitea (X-Forgejo-Signature or X-Gitea-Signature: the HMAC of
// the body in hex) and names the databases to pull.
export async function receiveIssueWebhook(token: string, headers: Headers, body: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "Nicht gefunden.");
  const connection = await one<ConnectionRow>("SELECT * FROM issue_connections WHERE hook_token=?", token);
  if (!connection) throw new HttpError(404, "Nicht gefunden.");
  let secret: string;
  try {
    secret = openSecret(connection.hook_secret, hookAad(connection.id));
  } catch {
    throw new HttpError(401, "Signatur ungültig.");
  }
  let event = "";
  if (connection.provider === "github") {
    event = headers.get("x-github-event") || "";
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    if (!event || !same(headers.get("x-hub-signature-256") || "", expected)) throw new HttpError(401, "Signatur ungültig.");
  } else if (connection.provider === "gitlab") {
    event = headers.get("x-gitlab-event") || "";
    if (!event || !same(headers.get("x-gitlab-token") || "", secret)) throw new HttpError(401, "Signatur ungültig.");
  } else {
    // Forgejo sends both its own headers and Gitea's.
    event = headers.get("x-forgejo-event") || headers.get("x-gitea-event") || "";
    const signature = headers.get("x-forgejo-signature") || headers.get("x-gitea-signature") || "";
    if (!event || !same(signature, createHmac("sha256", secret).update(body).digest("hex"))) throw new HttpError(401, "Signatur ungültig.");
  }
  if (event === "ping") return { ok: true, pages: [] as string[] };
  // Forgejo/Gitea name label, assignee and milestone changes "issues" (their
  // X-Gitea-Event-Type is finer); the finer names are taken as well.
  if (
    !["issues", "issue_comment", "issue_label", "issue_assign", "issue_milestone", "Issue Hook", "Note Hook", "Confidential Issue Hook", "Confidential Note Hook"].includes(event)
  )
    return { ok: true, pages: [] as string[] };
  let payload: { repository?: { full_name?: string }; project?: { path_with_namespace?: string; id?: number } };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Nur JSON-Webhooks werden unterstützt.");
  }
  const repos = new Set(
    [payload.repository?.full_name, payload.project?.path_with_namespace, payload.project?.id !== undefined ? String(payload.project.id) : undefined]
      .filter((v): v is string => !!v)
      .map((v) => v.toLowerCase()),
  );
  const pages = (await all<{ page_id: string; repo: string }>("SELECT page_id,repo FROM issue_sync_maps WHERE connection_id=?", connection.id))
    .filter((m) => repos.has(m.repo.toLowerCase()))
    .map((m) => m.page_id);
  return { ok: true, pages };
}

/* ---------- Worker ---------- */

async function pollAll() {
  let failure: unknown;
  for (const { page_id } of await all<{ page_id: string }>("SELECT page_id FROM issue_sync_maps")) {
    try {
      await syncIssues(page_id, { scan: true });
    } catch (error) {
      failure = error;
      console.error("Issue sync failed", error);
    }
  }
  // For the operations dashboard (Administration → Operations).
  await noteWorkerRun("issue-sync", failure);
}
// Every 10 minutes; a queued record is pushed a few seconds after the change.
export function startIssueSyncWorker() {
  if (runtime.flowplanIssueTimer) return;
  // Cluster mode: the poll on the leader only (lib/cluster/leader.ts); the
  // quick pushes below on the instance where the change was made.
  const poll = () =>
    void (isLeader() &&
      workersPaused().then(async (paused) => {
        if (!paused) await pollAll();
      }));
  runtime.flowplanIssueTimer = setInterval(poll, POLL_EVERY);
  runtime.flowplanIssueTimer.unref();
  setTimeout(poll, 90_000).unref();
  const timers = (runtime.flowplanIssuePushTimers ??= new Map());
  onIssueQueued((pageId) => {
    clearTimeout(timers.get(pageId));
    const timer = setTimeout(() => {
      timers.delete(pageId);
      void workersPaused()
        .then(async (paused) => {
          if (!paused) await syncIssues(pageId, { pushOnly: true });
        })
        .catch((error) => console.error("Issue push failed", error));
    }, 5000);
    timer.unref();
    timers.set(pageId, timer);
  });
}
