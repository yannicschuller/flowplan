// Back-link comments of the Git connection (#184): with an access token
// stored for the connection, a pull/merge request that names ticket numbers
// of the database gets one comment linking to those records ("Linked in
// Flowplan: [WEB-12 Login](…)"). Later events of the same request (an edited
// title, merged, closed) update that comment instead of writing another;
// git_backlinks remembers its id per database and request (schema 98).
//
// What the comment shows: the ticket number and the title of a record; for
// a private record (row access) or a database behind a journal PIN only the
// ticket number. Nothing for databases in the trash or in encrypted spaces.
//
// The token is sealed (lib/sealed-values.ts) and bound to the provider and
// address it was entered for: a webhook from another provider or server
// does not get it. Addresses pass the issue sync's rules (github.com,
// gitlab.com, codeberg.org; other servers only from ISSUE_SYNC_ALLOWED_HOSTS,
// internal addresses only with ISSUE_SYNC_ALLOW_PRIVATE) and its transport
// (lib/safe-fetch.ts). The comment is written in the background once the
// webhook's transaction has ended, one request after the other per
// connection and at most PER_MINUTE writes a minute; a failure is logged
// (without the token) and shown in the connection's settings.
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, one, run } from "./db";
import { afterTransaction } from "./db-driver/context";
import { appUrl, HttpError } from "./auth";
import { databaseSettings, storeSettings } from "./database-settings";
import { journalLocked } from "./journal-extras";
import { cellText } from "./cell-text";
import { ticketId } from "./ticket-ids";
import { ISSUE_PROVIDERS, IssueRateLimit, ProviderError, issueEndpoint, providerCall, type IssueProvider } from "./issue-sync";
import { openGitAccess, sealGitAccess } from "./sealed-values";
import type { Field, Identity, Page } from "./types";

const MINUTE = 60_000;
const MAX_RECORDS = 20;
const MAX_PENDING = 100;
const MARKER = "<!-- flowplan-backlink -->";

/* ---------- The request a webhook is about ---------- */

export type BackLinkTarget = {
  provider: IssueProvider;
  // The server's web address (https://github.com, https://git.example.org/gitlab).
  web: string;
  // owner/name (GitHub, Forgejo/Gitea) or group/project (GitLab).
  repo: string;
  number: number;
  url: string;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const REPO = /^[\w.-]+(\/[\w.-]+)+$/;
// The server address: the repository's web address without its path.
function serverOf(repoUrl: string, repo: string) {
  const suffix = `/${repo}`.toLowerCase();
  const url = repoUrl.replace(/\/+$/, "");
  return url.toLowerCase().endsWith(suffix) ? url.slice(0, -suffix.length) : "";
}
/* eslint-disable @typescript-eslint/no-explicit-any */
export function backLinkTarget(provider: "github" | "gitlab" | "gitea", event: string, p: any): BackLinkTarget | null {
  let target: BackLinkTarget;
  if (provider === "gitlab" && event === "Merge Request Hook") {
    const repo = str(p?.project?.path_with_namespace);
    target = { provider, repo, web: serverOf(str(p?.project?.web_url), repo), number: Number(p?.object_attributes?.iid), url: str(p?.object_attributes?.url) };
  } else if (provider !== "gitlab" && event === "pull_request") {
    const repo = str(p?.repository?.full_name);
    target = {
      provider: provider === "gitea" ? "forgejo" : "github",
      repo,
      web: serverOf(str(p?.repository?.html_url), repo),
      number: Number(p?.pull_request?.number ?? p?.number),
      url: str(p?.pull_request?.html_url),
    };
  } else return null;
  if (!REPO.test(target.repo) || target.repo.length > 300 || (target.provider !== "gitlab" && target.repo.split("/").length !== 2)) return null;
  if (!Number.isInteger(target.number) || target.number < 1 || target.number > 1e9) return null;
  if (!/^https:\/\//.test(target.web) || !/^https?:\/\//.test(target.url)) return null;
  return target;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ---------- Access token (settings) ---------- */

const accessInput = z.object({
  provider: z.enum(ISSUE_PROVIDERS),
  baseUrl: z.string().max(500).default(""),
  token: z.string().trim().min(1).max(1000),
});
// git.token: stores the access token for the provider and address, or
// removes it ({ remove: true }). Never returned.
export async function gitAccessCommand(user: Identity, page: Page, b: Record<string, unknown>) {
  const settings = await databaseSettings(page.id);
  if (!settings.git) throw new HttpError(400, "Bitte zuerst die Git-Anbindung einrichten.");
  if (b.remove === true) {
    const { access: _removed, ...git } = settings.git;
    await storeSettings(page.id, { ...settings, git });
    await audit(user.id, "git.token", page.id, "removed");
    return { ok: true, access: null };
  }
  const input = accessInput.parse(b);
  const endpoint = issueEndpoint(input.provider, input.baseUrl);
  const access = { provider: input.provider, web: endpoint.web, sealed: sealGitAccess(page.id, input.token), setAt: new Date().toISOString() };
  await storeSettings(page.id, { ...settings, git: { ...settings.git, access } });
  await audit(user.id, "git.token", page.id, `${input.provider} ${new URL(endpoint.web).host}`);
  return { ok: true, access: publicAccess(access) };
}
export const publicAccess = (access: { provider: IssueProvider; web: string; setAt: string } | undefined) =>
  access ? { provider: access.provider, web: access.web, setAt: access.setAt } : null;

// The last attempt of the connection: when, and the error if it failed.
export async function gitBackLinkStatus(pageId: string) {
  const last = await one<{ url: string; status: number | null; error: string | null; at: number }>(
    "SELECT url,status,error,at FROM git_backlinks WHERE page_id=? ORDER BY at DESC LIMIT 1",
    pageId,
  );
  return last ? { url: last.url, at: Number(last.at), status: last.status === null ? null : Number(last.status), error: last.error } : null;
}

/* ---------- Queue ---------- */

type Job = { pageId: string; target: BackLinkTarget; rowIds: string[] };
type Queue = { pending: Map<string, Job>; running: boolean; sent: number[]; backoffUntil: number; timer?: ReturnType<typeof setTimeout> };
const runtime = globalThis as typeof globalThis & { flowplanGitBackLinks?: Map<string, Queue>; flowplanGitBackLinkLimit?: number };
const queues = () => (runtime.flowplanGitBackLinks ??= new Map());
const perMinute = () => runtime.flowplanGitBackLinkLimit ?? 30;
// Tests lower the writes per minute and connection; undefined restores 30.
export function setGitBackLinkLimit(limit?: number) {
  runtime.flowplanGitBackLinkLimit = limit;
  for (const [pageId, q] of queues()) {
    clearTimeout(q.timer);
    q.timer = undefined;
    wake(pageId);
  }
}
function queueOf(pageId: string) {
  let q = queues().get(pageId);
  if (!q) queues().set(pageId, (q = { pending: new Map(), running: false, sent: [], backoffUntil: 0 }));
  return q;
}

// Called by the webhook inside its transaction: the comment follows once it
// has ended. A newer event of the same request replaces a waiting one.
export function queueBackLink(job: Job) {
  afterTransaction(() => {
    const q = queueOf(job.pageId);
    q.pending.delete(job.target.url);
    q.pending.set(job.target.url, job);
    if (q.pending.size > MAX_PENDING) q.pending.delete(q.pending.keys().next().value!);
    wake(job.pageId);
  });
}
function waitFor(q: Queue, now = Date.now()) {
  q.sent = q.sent.filter((at) => at > now - MINUTE);
  if (q.backoffUntil > now) return q.backoffUntil - now;
  return q.sent.length >= perMinute() ? q.sent[0] + MINUTE - now : 0;
}
function wake(pageId: string) {
  const q = queueOf(pageId);
  if (q.running || q.timer || !q.pending.size) return;
  q.timer = setTimeout(() => {
    q.timer = undefined;
    void pump(pageId);
  }, waitFor(q));
  // A later write must not keep a stopping server (or a test) alive.
  if (waitFor(q) > 0) q.timer.unref?.();
}
async function pump(pageId: string) {
  const q = queueOf(pageId);
  if (q.running) return;
  q.running = true;
  try {
    while (q.pending.size && !waitFor(q)) {
      const [url, job] = q.pending.entries().next().value!;
      q.pending.delete(url);
      try {
        await deliver(job, q);
      } catch (error) {
        console.error("Git back-link failed", error instanceof Error ? error.message : error);
      }
    }
  } finally {
    q.running = false;
  }
  wake(pageId);
}
// Tests: resolves once no comment waits or is being written (or after `ms`).
export async function gitBackLinksSettled(ms = 5000) {
  const until = Date.now() + ms;
  const busy = () => [...queues().values()].some((q) => q.running || (q.pending.size && !waitFor(q)));
  while (busy() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
}
export const gitBackLinksWaiting = (pageId: string) => queues().get(pageId)?.pending.size ?? 0;

/* ---------- The comment ---------- */

const NOBODY = { id: "" } as unknown as Identity;
// A title as plain link text: no Markdown, no mentions or references.
function plain(text: string) {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[\\`*_{}[\]()<>~]/g, "\\$&")
    .replace(/@/g, "@⁠");
}
async function commentBody(page: Page, rowIds: string[]) {
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))?.fields || "[]") as Field[];
  const idField = fields.find((f) => f.type === "id" && f.prefix);
  if (!idField) return [];
  const titleField = fields.find((f) => f.type !== "id");
  // Nobody has entered a PIN: a database below a locked journal shows numbers only.
  const locked = await journalLocked(NOBODY, page);
  const rows: { id: string; cells: string; number: number; access: string | null }[] = [];
  for (const rowId of [...new Set(rowIds)].slice(0, MAX_RECORDS)) {
    const row = await one<{ id: string; cells: string; number: number | null; access: string | null }>(
      "SELECT id,cells,number,access FROM rows WHERE id=? AND page_id=?",
      rowId,
      page.id,
    );
    if (row && row.number !== null) rows.push({ ...row, number: Number(row.number) });
  }
  const base = appUrl().replace(/\/$/, "");
  return rows
    .sort((a, b) => a.number - b.number)
    .map((row) => {
      const key = ticketId(idField, row.number);
      const restricted = locked || row.access === "private";
      let title = "";
      if (!restricted)
        try {
          title = plain(cellText((JSON.parse(row.cells) as Record<string, unknown>)[titleField?.id || "title"]));
        } catch {
          title = "";
        }
      return `[${title ? `${key} ${title}` : key}](${base}/#page=${page.id}&row=${row.id})`;
    });
}
export function renderComment(lines: string[]) {
  if (!lines.length) return `${MARKER}\nNo longer linked in Flowplan.`;
  if (lines.length === 1) return `${MARKER}\nLinked in Flowplan: ${lines[0]}`;
  return `${MARKER}\nLinked in Flowplan:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function paths(target: BackLinkTarget, commentId?: string) {
  if (target.provider === "gitlab") {
    const base = `/projects/${encodeURIComponent(target.repo)}/merge_requests/${target.number}/notes`;
    return commentId ? { method: "PUT", path: `${base}/${encodeURIComponent(commentId)}` } : { method: "POST", path: base };
  }
  const [owner, name] = target.repo.split("/").map(encodeURIComponent);
  return commentId
    ? { method: "PATCH", path: `/repos/${owner}/${name}/issues/comments/${encodeURIComponent(commentId)}` }
    : { method: "POST", path: `/repos/${owner}/${name}/issues/${target.number}/comments` };
}
const sameServer = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

async function record(pageId: string, url: string, values: { commentId: string | null; hash: string; status: number | null; error: string | null }) {
  await run(
    "INSERT INTO git_backlinks(page_id,url,comment_id,body_hash,status,error,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(page_id,url) DO UPDATE SET comment_id=excluded.comment_id,body_hash=excluded.body_hash,status=excluded.status,error=excluded.error,at=excluded.at",
    pageId,
    url.slice(0, 1000),
    values.commentId,
    values.hash,
    values.status,
    values.error,
    Date.now(),
  );
}

async function deliver(job: Job, q: Queue) {
  const { pageId, target } = job;
  const settings = await databaseSettings(pageId);
  const access = settings.git?.access;
  if (!access) return;
  const page = await one<Page & { space_deleted: string | null; encrypted: number | null }>(
    "SELECT p.*,s.deleted_at AS space_deleted,s.encrypted FROM pages p LEFT JOIN spaces s ON s.id=p.space_id WHERE p.id=?",
    pageId,
  );
  if (!page || page.deleted_at || page.space_deleted || Number(page.encrypted) === 1) return;
  const before = await one<{ comment_id: string | null; body_hash: string }>("SELECT comment_id,body_hash FROM git_backlinks WHERE page_id=? AND url=?", pageId, target.url);
  try {
    if (target.provider !== access.provider) throw new HttpError(400, "Der Webhook kommt von einem anderen Git-Anbieter als dem des Zugangstokens.");
    // The allow-list and address rules as they are now.
    const endpoint = issueEndpoint(access.provider, access.web);
    if (!sameServer(target.web, endpoint.web)) throw new HttpError(400, "Das Repository liegt auf einem anderen Server als dem des Zugangstokens.");
    const token = openGitAccess(pageId, access.sealed);
    if (!token) throw new HttpError(400, "Das Zugangstoken lässt sich auf dieser Instanz nicht öffnen.");
    const lines = await commentBody(page, job.rowIds);
    // Nothing linked and nothing written yet: nothing to say.
    if (!lines.length && !before?.comment_id) return;
    const body = renderComment(lines);
    const hash = createHash("sha256").update(body).digest("hex");
    if (before?.comment_id && before.body_hash === hash) return;
    q.sent.push(Date.now());
    let commentId = before?.comment_id || null;
    if (commentId) {
      const { method, path } = paths(target, commentId);
      try {
        await providerCall(access.provider, endpoint, token, method, path, { body });
      } catch (error) {
        // Deleted on the provider: a new one.
        if (!(error instanceof ProviderError && error.upstream === 404)) throw error;
        commentId = null;
      }
    }
    if (!commentId) {
      const { method, path } = paths(target);
      const made = (await providerCall(access.provider, endpoint, token, method, path, { body })) as { id?: unknown } | null;
      commentId = made && (typeof made.id === "number" || typeof made.id === "string") ? String(made.id).slice(0, 64) : "";
      if (!/^\d+$/.test(commentId)) throw new HttpError(502, "Der Git-Anbieter hat keinen Kommentar angelegt.");
    }
    await record(pageId, target.url, { commentId, hash, status: null, error: null });
  } catch (error) {
    if (error instanceof IssueRateLimit) {
      q.backoffUntil = error.until;
      // Again once the provider allows it, unless a newer event is waiting.
      if (!q.pending.has(target.url)) q.pending.set(target.url, job);
    }
    const status = error instanceof ProviderError ? error.upstream : error instanceof IssueRateLimit ? 429 : null;
    const message = error instanceof HttpError ? error.message : "Der Git-Anbieter ist nicht erreichbar.";
    console.warn(`Git back-link for ${target.url} failed: ${status ?? ""} ${message}`.replace(/\s+/g, " "));
    await record(pageId, target.url, { commentId: before?.comment_id ?? null, hash: before?.body_hash ?? "", status, error: message.slice(0, 500) });
  }
}
