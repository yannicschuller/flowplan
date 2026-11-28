// The status of linked issues, pull requests and merge requests (#654): the
// hover card and the small state icon of a link to GitHub, GitLab or
// Forgejo/Gitea in a document (components/issue-links.tsx).
//
// The address is read strictly (lib/issue-link-url.ts); the hosts are those
// of the issue sync (github.com, gitlab.com, codeberg.org, and others only
// from ISSUE_SYNC_ALLOWED_HOSTS – lib/issue-sync.ts decides, with
// ISSUE_SYNC_ALLOW_PRIVATE for internal addresses), and every request goes
// through its transport (lib/safe-fetch.ts: pinned addresses, no redirects
// with credentials), with a short timeout.
//
// Public repositories are read without a token. A private one only with the
// token of an issue sync connection to that very server in one of the
// person's workspaces (full members; lib/issue-sync.ts issueReadCredentials):
// those tokens are tried first, then none. The token never leaves the
// server and never goes to another host. Nothing of the Flowplan user goes
// to the provider: no name, no address, no cookie – a fixed user agent.
//
// Answers are kept for five minutes (refusals as well, rate limits for one),
// per address and per set of credentials the person may use, so nobody sees
// what another's token read. Each person may cause at most 60 lookups a
// minute; the rest answer "rate_limited" until then.
import { allow } from "./action-limits";
import { issueEndpoint, issueRateLimited, issueReadCredentials, issueServersOf, issueSyncHosts, issueTransport, type IssueProvider, type IssueReadCredential } from "./issue-sync";
import { parseIssueUrl, type IssueLinkKind, type IssueLinkRef } from "./issue-link-url";
import type { Identity } from "./types";

export type IssueState = "open" | "closed" | "merged" | "draft";
export type IssueLabel = { name: string; color: string };
export type IssuePreview = {
  url: string;
  provider: IssueProvider;
  host: string;
  repo: string;
  number: number;
  kind: IssueLinkKind;
  state: IssueState;
  title: string;
  author: string;
  createdAt: string;
  excerpt: string;
  labels: IssueLabel[];
};
// unsupported: no issue link of an allowed host; private: not readable
// without a token (no connection to that server); not_found: not there,
// or the token may not read it; rate_limited: the provider or the per-person
// limit; unavailable: the provider did not answer.
export type IssuePreviewError = "unsupported" | "private" | "not_found" | "rate_limited" | "unavailable";
export type IssuePreviewResult = IssuePreview | { url: string; error: IssuePreviewError };

export const MAX_PREVIEW_URLS = 20;
const TTL = 5 * 60_000;
const RATE_LIMITED_TTL = 60_000;
const MAX_CACHE = 2000;
const PER_MINUTE = 60;
const TIMEOUT = 4000;
const MAX_BYTES = 400_000;
const EXCERPT = 200;

/* ---------- Plain text from Markdown ---------- */

// The beginning of an issue's body as plain text: no HTML, no Markdown
// marks, no images, link texts without their address, at most `max`
// characters (with "…" when cut).
export function plainExcerpt(markdown: string, max = EXCERPT) {
  let text = String(markdown || "").slice(0, 20_000);
  text = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/* ---------- The providers' answers ---------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
const color = (v: unknown) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(typeof v === "string" ? v.trim() : "");
  return m ? `#${m[1].toLowerCase()}` : "";
};
const labelsOf = (raw: unknown): IssueLabel[] =>
  (Array.isArray(raw) ? raw : [])
    .map((l: any) => (typeof l === "string" ? { name: str(l, 60), color: "" } : { name: str(l?.name, 60), color: color(l?.color) }))
    .filter((l) => l.name)
    .slice(0, 12);
const date = (v: unknown) => {
  const ms = Date.parse(str(v, 40));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
};
type Mapped = Omit<IssuePreview, "url" | "provider" | "host" | "repo">;

// GitHub's issues API answers pull requests too (with `pull_request`).
export function githubPreview(i: any): Mapped {
  const pull = !!i?.pull_request;
  const merged = pull && !!i.pull_request?.merged_at;
  const closed = i?.state === "closed";
  return {
    number: Number(i?.number) || 0,
    kind: pull ? "pull" : "issue",
    state: merged ? "merged" : closed ? "closed" : pull && i?.draft ? "draft" : "open",
    title: str(i?.title),
    author: str(i?.user?.login, 100),
    createdAt: date(i?.created_at),
    excerpt: plainExcerpt(str(i?.body, 20_000)),
    labels: labelsOf(i?.labels),
  };
}
export function gitlabPreview(i: any, kind: IssueLinkKind): Mapped {
  const state = str(i?.state, 20);
  return {
    number: Number(i?.iid) || 0,
    kind,
    state:
      state === "merged" ? "merged" : state === "closed" || state === "locked" ? "closed" : kind === "pull" && (i?.draft || i?.work_in_progress) ? "draft" : "open",
    title: str(i?.title),
    author: str(i?.author?.username, 100),
    createdAt: date(i?.created_at),
    excerpt: plainExcerpt(str(i?.description, 20_000)),
    labels: labelsOf(i?.labels),
  };
}
// Forgejo and Gitea: pull requests are issues with `pull_request`; a draft
// is marked by `draft` (newer servers) or a "WIP:"/"[WIP]" title.
export function forgejoPreview(i: any): Mapped {
  const pull = !!i?.pull_request;
  const merged = pull && (!!i.pull_request?.merged || !!i.pull_request?.merged_at);
  const title = str(i?.title);
  const draft = pull && (!!i.pull_request?.draft || /^\s*(wip:|\[wip\])/i.test(title));
  return {
    number: Number(i?.number) || 0,
    kind: pull ? "pull" : "issue",
    state: merged ? "merged" : i?.state === "closed" ? "closed" : draft ? "draft" : "open",
    title,
    author: str(i?.user?.login, 100),
    createdAt: date(i?.created_at),
    excerpt: plainExcerpt(str(i?.body, 20_000)),
    labels: labelsOf(i?.labels),
  };
}

/* ---------- Fetching ---------- */

type Endpoint = ReturnType<typeof issueEndpoint>;
const apiPath = (provider: IssueProvider, ref: IssueLinkRef) =>
  provider === "gitlab"
    ? `/projects/${encodeURIComponent(ref.repo)}/${ref.kind === "pull" ? "merge_requests" : "issues"}/${ref.number}`
    : `/repos/${ref.repo}/issues/${ref.number}`;
const publicHeaders = (provider: IssueProvider): Record<string, string> =>
  provider === "github"
    ? { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Flowplan-IssuePreview" }
    : { accept: "application/json", "user-agent": "Flowplan-IssuePreview" };

type Attempt = { kind: "ok"; data: any } | { kind: "refused" } | { kind: "limited" } | { kind: "failed" };
async function attempt(endpoint: Endpoint, path: string, headers: Record<string, string>): Promise<Attempt> {
  try {
    const response = await issueTransport()({
      method: "GET",
      url: endpoint.api + path,
      headers,
      allowPrivate: endpoint.allowPrivate,
      timeout: TIMEOUT,
      maxBytes: MAX_BYTES,
    });
    if (issueRateLimited(response.status, response.headers)) return { kind: "limited" };
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) return { kind: "refused" };
    if (response.status < 200 || response.status >= 300) return { kind: "failed" };
    const data = JSON.parse(response.body || "null");
    return data && typeof data === "object" && !Array.isArray(data) ? { kind: "ok", data } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

// What to try for a link: per candidate provider its API and the
// credentials the person may use there.
type Plan = { provider: IssueProvider; endpoint: Endpoint; credentials: IssueReadCredential[] }[];
async function planFor(user: Identity, ref: IssueLinkRef): Promise<Plan> {
  const plan: Plan = [];
  for (const provider of ref.providers) {
    let endpoint: Endpoint;
    try {
      // The issue sync's host rules (allowed hosts, internal addresses).
      endpoint = issueEndpoint(provider, ref.web);
    } catch {
      continue;
    }
    const credentials = (await issueReadCredentials(user, provider, endpoint.web, ref.repo))
      // The token only to the API of the server it belongs to.
      .filter((c) => new URL(c.endpoint.api).origin === new URL(endpoint.api).origin)
      .slice(0, 2);
    plan.push({ provider, endpoint, credentials });
  }
  return plan;
}

// A connection's token first (private repositories), then without one.
async function lookup(plan: Plan, ref: IssueLinkRef): Promise<IssuePreviewResult> {
  if (!plan.length) return { url: ref.url, error: "unsupported" };
  let limited = false,
    failed = false,
    withToken = false;
  for (const { provider, endpoint, credentials } of plan) {
    const tries = [...credentials.map((c) => ({ endpoint: c.endpoint, headers: c.headers, token: true })), { endpoint, headers: publicHeaders(provider), token: false }];
    for (const one of tries) {
      const result = await attempt(one.endpoint, apiPath(provider, ref), one.headers);
      if (result.kind === "ok") {
        const mapped = provider === "github" ? githubPreview(result.data) : provider === "gitlab" ? gitlabPreview(result.data, ref.kind) : forgejoPreview(result.data);
        // An answer about another number is no answer for this link.
        if (mapped.number !== ref.number) return { url: ref.url, error: "not_found" };
        return { ...mapped, url: ref.url, provider, host: ref.host, repo: ref.repo };
      }
      if (one.token) withToken = true;
      if (result.kind === "limited") limited = true;
      if (result.kind === "failed") failed = true;
    }
  }
  if (limited) return { url: ref.url, error: "rate_limited" };
  if (failed) return { url: ref.url, error: "unavailable" };
  return { url: ref.url, error: withToken ? "not_found" : "private" };
}

/* ---------- Cache ---------- */

type Kept = { at: number; ttl: number; result: IssuePreviewResult };
const runtime = globalThis as typeof globalThis & { flowplanIssuePreviews?: Map<string, Kept>; flowplanIssuePreviewsRunning?: Map<string, Promise<IssuePreviewResult>> };
const cache = () => (runtime.flowplanIssuePreviews ??= new Map());
const running = () => (runtime.flowplanIssuePreviewsRunning ??= new Map());
// Tests start over.
export function clearIssuePreviewCache() {
  cache().clear();
  running().clear();
}
function keep(key: string, result: IssuePreviewResult) {
  const kept = cache();
  kept.delete(key);
  kept.set(key, { at: Date.now(), ttl: "error" in result && result.error === "rate_limited" ? RATE_LIMITED_TTL : TTL, result });
  while (kept.size > MAX_CACHE) kept.delete(kept.keys().next().value!);
}

// The previews of up to MAX_PREVIEW_URLS addresses, keyed by the address
// as asked. Signed-in people only (the route checks).
export async function issuePreviews(user: Identity, urls: readonly string[]): Promise<Record<string, IssuePreviewResult>> {
  const allowedHosts = issueSyncHosts();
  const servers = allowedHosts.length ? await issueServersOf(user) : [];
  const out: Record<string, IssuePreviewResult> = {};
  await Promise.all(
    [...new Set(urls)].slice(0, MAX_PREVIEW_URLS).map(async (raw) => {
      const ref = parseIssueUrl(raw, { allowedHosts, servers });
      if (!ref) {
        out[raw] = { url: raw, error: "unsupported" };
        return;
      }
      // Who may see the answer: an answer without a token is everyone's,
      // but the person's tokens could read more – so the key names the
      // connections they may use for this server.
      const plan = await planFor(user, ref);
      const scope = plan
        .flatMap((p) => p.credentials.map((c) => c.connectionId))
        .sort()
        .join(",");
      const key = `${scope}|${ref.url}`;
      const kept = cache().get(key);
      if (kept && Date.now() - kept.at < kept.ttl) {
        out[raw] = { ...kept.result, url: raw };
        return;
      }
      let job = running().get(key);
      if (!job) {
        if (!allow(`issue-preview:${user.id}`, PER_MINUTE, 60_000)) {
          out[raw] = { url: raw, error: "rate_limited" };
          return;
        }
        job = lookup(plan, ref).then((result) => {
          keep(key, result);
          return result;
        });
        running().set(key, job);
        job.finally(() => running().delete(key)).catch(() => {});
      }
      out[raw] = { ...(await job), url: raw };
    }),
  );
  return out;
}
