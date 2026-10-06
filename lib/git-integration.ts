// Git connection: GitHub, GitLab and Gitea/Forgejo send webhooks to
// /api/git/<token> of a database. Commits and pull/merge requests that
// mention a ticket number (WEB-123) appear on that record; "closes WEB-123"
// marks it done once the commit is on the default branch or the request is
// merged. Every request is checked against the database's secret.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { databaseSettings, storeSettings } from "./database-settings";
import { doneRule, isDone } from "./database-settings-schema";
import { resolveTicket } from "./ticket-refs";
import { rowChanged } from "./automations";
import { TICKET_REF } from "./ticket-ids";
import type { Field, Identity, Page } from "./types";

type Item = { kind: "commit" | "pr"; ref: string; title: string; text: string; url: string; author: string; state: string; closes: boolean };

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|schließt|behebt)\s*:?\s+#?([A-Z][A-Z0-9]{0,9}-\d{1,7})\b/gi;

export function gitSetup(page: Page, action: "git.setup" | "git.disable") {
  const settings = databaseSettings(page.id);
  if (action === "git.disable") {
    const { git: _git, ...rest } = settings;
    storeSettings(page.id, rest);
    return { ok: true };
  }
  const git = { token: randomBytes(24).toString("base64url"), secret: randomBytes(24).toString("base64url"), createdAt: new Date().toISOString() };
  storeSettings(page.id, { ...settings, git });
  return git;
}

function same(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

// Which provider sent it, and is it really from there?
function verify(headers: Headers, body: string, secret: string) {
  const gitea = headers.get("x-gitea-event") || headers.get("x-forgejo-event");
  if (gitea) {
    const signature = headers.get("x-gitea-signature") || headers.get("x-forgejo-signature") || "";
    return same(signature, hmac(secret, body)) ? { provider: "gitea" as const, event: gitea } : null;
  }
  const gitlab = headers.get("x-gitlab-event");
  if (gitlab) return same(headers.get("x-gitlab-token") || "", secret) ? { provider: "gitlab" as const, event: gitlab } : null;
  const github = headers.get("x-github-event");
  if (github) return same(headers.get("x-hub-signature-256") || "", `sha256=${hmac(secret, body)}`) ? { provider: "github" as const, event: github } : null;
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function items(provider: "github" | "gitlab" | "gitea", event: string, p: any): Item[] {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (event === "push" || event === "Push Hook") {
    const branch = str(p.ref).replace(/^refs\/heads\//, "");
    const main = str(p.repository?.default_branch || p.project?.default_branch) || "main";
    return (Array.isArray(p.commits) ? p.commits : []).slice(0, 100).map((c: any) => ({
      kind: "commit" as const,
      ref: str(c.id).slice(0, 40),
      title: str(c.message).split("\n")[0].slice(0, 300),
      text: str(c.message),
      url: str(c.url),
      author: str(c.author?.name || c.author?.username),
      state: branch,
      closes: branch === main,
    }));
  }
  if (provider === "gitlab" && event === "Merge Request Hook") {
    const mr = p.object_attributes || {};
    const merged = mr.state === "merged" || mr.action === "merge";
    return [
      {
        kind: "pr",
        ref: String(mr.iid ?? mr.id ?? ""),
        title: str(mr.title).slice(0, 300),
        text: `${str(mr.title)}\n${str(mr.description)}`,
        url: str(mr.url),
        author: str(p.user?.name || p.user?.username),
        state: merged ? "merged" : str(mr.state) || "opened",
        closes: merged,
      },
    ];
  }
  if (event === "pull_request") {
    const pr = p.pull_request || {};
    const merged = !!pr.merged;
    return [
      {
        kind: "pr",
        ref: String(pr.number ?? ""),
        title: str(pr.title).slice(0, 300),
        text: `${str(pr.title)}\n${str(pr.body)}\n${str(pr.head?.ref)}`,
        url: str(pr.html_url),
        author: str(pr.user?.login),
        state: merged ? "merged" : str(pr.state) || "open",
        closes: merged,
      },
    ];
  }
  return [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// Marks a record done (the database's done rule) as the Git connection.
function closeRecord(pageId: string, rowId: string) {
  const page = one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)!.fields) as Field[];
  const rule = doneRule(fields, databaseSettings(pageId));
  const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId);
  if (!rule || !row) return false;
  const before = JSON.parse(row.cells);
  if (isDone(rule, before)) return false;
  const after = { ...before, [rule.field.id]: rule.field.type === "checkbox" ? true : rule.values[0] };
  run("UPDATE rows SET cells=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", JSON.stringify(after), rowId);
  // Workflow and automations as for any change; a refused step stays open.
  try {
    rowChanged("system", page, rowId, before, after, fields);
  } catch {
    run("UPDATE rows SET cells=?,version=version+1 WHERE id=?", JSON.stringify(before), rowId);
    return false;
  }
  return true;
}

export function receiveGitWebhook(token: string, headers: Headers, body: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, "Nicht gefunden.");
  const db = all<{ page_id: string; workspace_id: string; settings: string }>(
    "SELECT d.page_id,p.workspace_id,d.settings FROM databases d JOIN pages p ON p.id=d.page_id WHERE p.deleted_at IS NULL AND d.settings LIKE ?",
    `%"token":"${token}"%`,
  ).find((d) => databaseSettings(d.page_id).git?.token === token);
  if (!db) throw new HttpError(404, "Nicht gefunden.");
  const git = databaseSettings(db.page_id).git!;
  const source = verify(headers, body, git.secret);
  if (!source) throw new HttpError(401, "Signatur ungültig.");
  if (source.event === "ping") return { ok: true, linked: 0, closed: 0 };
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new HttpError(400, "Nur JSON-Webhooks werden unterstützt.");
  }
  let linked = 0,
    closed = 0;
  for (const item of items(source.provider, source.event, payload)) {
    if (!item.url || !/^https?:\/\//.test(item.url)) continue;
    const keys = new Set([...item.text.matchAll(TICKET_REF)].map((m) => m[0]));
    const closing = new Set([...item.text.matchAll(CLOSING)].map((m) => m[1].toUpperCase()));
    for (const key of keys) {
      const ticket = resolveTicket(null, db.workspace_id, key);
      if (!ticket) continue;
      run(
        "INSERT INTO git_links(id,page_id,row_id,kind,ref,title,url,author,state,at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(row_id,url) DO UPDATE SET title=excluded.title,state=excluded.state,at=excluded.at",
        id(),
        ticket.pageId,
        ticket.rowId,
        item.kind,
        item.ref,
        item.title,
        item.url.slice(0, 1000),
        item.author.slice(0, 120),
        item.state.slice(0, 60),
        Date.now(),
      );
      linked++;
      if (item.closes && closing.has(key) && closeRecord(ticket.pageId, ticket.rowId)) closed++;
    }
  }
  return { ok: true, linked, closed };
}

// Address and secret for setting up the webhook: only for people who may
// change the database (a reader with the secret could close records).
export function gitConfig(user: Identity, pageId: string) {
  requirePage(user, pageId, true);
  const git = databaseSettings(pageId).git;
  return git ? { token: git.token, secret: git.secret, createdAt: git.createdAt } : null;
}

export function gitLinks(user: Identity, pageId: string, rowId: string) {
  requirePage(user, pageId);
  requireRow(user, pageId, rowId);
  return all<{ id: string; kind: string; ref: string; title: string; url: string; author: string; state: string; at: number }>(
    "SELECT id,kind,ref,title,url,author,state,at FROM git_links WHERE row_id=? ORDER BY at DESC LIMIT 100",
    rowId,
  );
}
