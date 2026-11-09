// Back-link comments of the Git connection (#184, lib/git-backlinks.ts):
// a stub API per provider (GitHub, GitLab, Gitea/Forgejo) behind the issue
// sync's transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import type { IssueHttpRequest, IssueHttpResponse } from "../lib/issue-sync";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-backlinks-"));
process.env.APP_URL = "https://flowplan.example";
delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
delete process.env.ISSUE_SYNC_ALLOW_PRIVATE;

// Everything written to the console, to check that no token shows up.
const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    original(...args);
  };
}

const { id, run, one, transaction } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { receiveGitWebhook, gitConfig } = await import("../lib/git-integration");
const { setIssueSyncTransport } = await import("../lib/issue-sync");
const { gitBackLinksSettled, gitBackLinksWaiting, setGitBackLinkLimit, renderComment } = await import("../lib/git-backlinks");

/* ---------- A comment API in memory ---------- */

class StubApi {
  requests: IssueHttpRequest[] = [];
  comments = new Map<string, { path: string; body: string }>();
  next = 9000;
  delay = 0;
  fail: number | null = null;
  handle = async (request: IssueHttpRequest): Promise<IssueHttpResponse> => {
    this.requests.push(request);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    const json = (data: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(data) });
    if (this.fail) return json({ message: "nope" }, this.fail);
    const url = new URL(request.url);
    const body = JSON.parse(request.body || "{}") as { body: string };
    if (request.method === "POST") {
      const commentId = String(++this.next);
      this.comments.set(commentId, { path: url.pathname, body: body.body });
      return json({ id: Number(commentId), body: body.body }, 201);
    }
    const commentId = url.pathname.split("/").pop()!;
    const comment = this.comments.get(commentId);
    if (!comment) return json({ message: "Not Found" }, 404);
    comment.body = body.body;
    return json({ id: Number(commentId), body: body.body });
  };
  calls = () => this.requests.map((r) => `${r.method} ${r.url}`);
  reset() {
    this.requests = [];
  }
}
const stub = new StubApi();
setIssueSyncTransport(stub.handle);

/* ---------- Workspace, database, Git connection ---------- */

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner");
const wid = await createWorkspace(owner.id, "Dev"),
  boot = await bootstrap(owner, wid);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
async function ticketDatabase(title: string, prefix: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  await act({
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "key", name: "ID", type: "id", prefix },
    ],
    views: (await database(pageId)).views,
  });
  const { token, secret } = await act({ action: "git.setup", pageId });
  return { pageId, token: token as string, secret: secret as string };
}
const web = await ticketDatabase("Web", "WEB");
const pageId = web.pageId;
const login = (await act({ action: "row.create", pageId, cells: { title: "Login *fast* @team" } })).id as string;
const logout = (await act({ action: "row.create", pageId, cells: { title: "Logout" } })).id as string;
const secretRow = (await act({ action: "row.create", pageId, cells: { title: "Secret plan" } })).id as string;
await run("UPDATE rows SET access='private' WHERE id=?", secretRow);

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");
async function send(provider: "github" | "gitlab" | "gitea", payload: unknown, connection = web) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> =
    provider === "github"
      ? { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${sign(connection.secret, body)}` }
      : provider === "gitlab"
        ? { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": connection.secret }
        : { "x-gitea-event": "pull_request", "x-gitea-signature": sign(connection.secret, body) };
  const started = Date.now();
  const result = await transaction(async () => await receiveGitWebhook(connection.token, new Headers(headers), body));
  return { ...result, ms: Date.now() - started };
}
const githubPr = (number: number, title: string, opts: { merged?: boolean; host?: string; repo?: string } = {}) => {
  const host = opts.host || "https://github.com",
    repo = opts.repo || "acme/web";
  return {
    action: opts.merged ? "closed" : "opened",
    number,
    pull_request: { number, title, body: "", html_url: `${host}/${repo}/pull/${number}`, merged: !!opts.merged, state: opts.merged ? "closed" : "open", user: { login: "ada" }, head: { ref: "feature" } },
    repository: { full_name: repo, html_url: `${host}/${repo}` },
  };
};
const gitlabMr = (iid: number, title: string, state = "opened") => ({
  object_kind: "merge_request",
  user: { name: "Bo" },
  project: { id: 42, path_with_namespace: "team/app", web_url: "https://gitlab.com/team/app" },
  object_attributes: { iid, title, description: "", url: `https://gitlab.com/team/app/-/merge_requests/${iid}`, state, action: state === "merged" ? "merge" : "open" },
});
const giteaPr = (number: number, title: string, host = "https://git.example.org") => ({
  action: "opened",
  number,
  pull_request: { number, title, body: "", html_url: `${host}/acme/web/pulls/${number}`, merged: false, state: "open", user: { login: "cy" } },
  repository: { full_name: "acme/web", html_url: `${host}/acme/web` },
});
const link = (rowId: string) => `https://flowplan.example/#page=${pageId}&row=${rowId}`;
const config = async () => (await gitConfig(owner, pageId))!;
const TOKENS = ["ghp_SECRET_github_token_1", "glpat-SECRET-gitlab-2", "gitea_SECRET_token_3"];

/* ---------- Tests ---------- */

test("without an access token nothing is sent", async () => {
  const result = await send("github", githubPr(1, "WEB-1 login form"));
  assert.equal(result.linked, 1);
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), []);
  assert.equal((await config()).access, null);
});

test("the token is sealed, bound to its server and never returned", async () => {
  await assert.rejects(act({ action: "git.token", pageId, provider: "gitlab", baseUrl: "https://git.evil.example", token: "x" }), /nicht freigegeben/);
  const saved = await act({ action: "git.token", pageId, provider: "github", baseUrl: "", token: TOKENS[0] });
  assert.deepEqual(saved.access.provider, "github");
  assert.equal(saved.access.web, "https://github.com");
  const raw = (await one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", pageId))!.settings;
  assert.ok(!raw.includes(TOKENS[0]), "stored sealed");
  assert.match(raw, /"sealed":"fps1:/);
  assert.ok(!JSON.stringify(saved).includes(TOKENS[0]));
  assert.ok(!JSON.stringify(await config()).includes(TOKENS[0]));
  assert.ok(!JSON.stringify(await database(pageId)).includes(TOKENS[0]));
  // A new address and secret keep the token.
  const renewed = await act({ action: "git.setup", pageId });
  web.token = renewed.token;
  web.secret = renewed.secret;
  assert.equal((await config()).access?.web, "https://github.com");
});

test("GitHub: opened, edited, merged → one comment, then updated", async () => {
  stub.reset();
  const opened = await send("github", githubPr(5, "WEB-1 login form"));
  assert.ok(opened.ms < 1000);
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), ["POST https://api.github.com/repos/acme/web/issues/5/comments"]);
  const first = stub.requests[0];
  assert.equal(first.headers.authorization, `Bearer ${TOKENS[0]}`);
  assert.equal(first.allowPrivate, false);
  const body = JSON.parse(first.body!).body as string;
  // Markdown and mentions of the title are neutralised.
  assert.equal(body, renderComment([`[WEB-1 Login \\*fast\\* @⁠team](${link(login)})`]));
  assert.match(body, /^<!-- flowplan-backlink -->\nLinked in Flowplan: \[WEB-1 /);

  await send("github", githubPr(5, "WEB-1 login form, also WEB-2"));
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls().slice(1), ["PATCH https://api.github.com/repos/acme/web/issues/comments/9001"]);
  const updated = stub.comments.get("9001")!.body;
  assert.match(updated, /Linked in Flowplan:\n- \[WEB-1 [^\n]+\n- \[WEB-2 Logout\]/);
  assert.ok(updated.includes(link(logout)));

  // Merged with the same text: nothing new to say, no second comment.
  await send("github", githubPr(5, "WEB-1 login form, also WEB-2", { merged: true }));
  await gitBackLinksSettled();
  assert.equal(stub.requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(stub.comments.size, 1);
  // The references removed: the same comment says so.
  await send("github", githubPr(5, "Unrelated title"));
  await gitBackLinksSettled();
  assert.equal(stub.comments.get("9001")!.body, renderComment([]));
  assert.equal(stub.comments.size, 1);
  const status = (await config()).backLink!;
  assert.equal(status.error, null);
  assert.equal(status.url, "https://github.com/acme/web/pull/5");
});

test("a pull request without ticket numbers gets no comment", async () => {
  stub.reset();
  await send("github", githubPr(6, "Just a refactoring"));
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), []);
});

test("a private record shows only its ticket number", async () => {
  stub.reset();
  await send("github", githubPr(7, "WEB-3 and WEB-2"));
  await gitBackLinksSettled();
  const body = JSON.parse(stub.requests[0].body!).body as string;
  assert.ok(body.includes(`[WEB-3](${link(secretRow)})`));
  assert.ok(!body.includes("Secret plan"));
  assert.ok(body.includes("[WEB-2 Logout]"));
});

test("a comment deleted on the provider is written again", async () => {
  stub.reset();
  stub.comments.clear();
  await send("github", githubPr(7, "WEB-3 only"));
  await gitBackLinksSettled();
  assert.deepEqual(
    stub.calls().map((c) => c.split(" ")[0]),
    ["PATCH", "POST"],
  );
  assert.equal(stub.comments.size, 1);
});

test("GitLab: a note on the merge request, then updated", async () => {
  await act({ action: "git.token", pageId, provider: "gitlab", baseUrl: "", token: TOKENS[1] });
  stub.reset();
  await send("gitlab", gitlabMr(7, "Resolves WEB-2"));
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), ["POST https://gitlab.com/api/v4/projects/team%2Fapp/merge_requests/7/notes"]);
  assert.equal(stub.requests[0].headers["private-token"], TOKENS[1]);
  const noteId = [...stub.comments.keys()].pop()!;
  await send("gitlab", gitlabMr(7, "Resolves WEB-2 and WEB-1"));
  await send("gitlab", gitlabMr(7, "Resolves WEB-2 and WEB-1", "merged"));
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls().slice(1), [`PUT https://gitlab.com/api/v4/projects/team%2Fapp/merge_requests/7/notes/${noteId}`]);
  assert.match(stub.comments.get(noteId)!.body, /WEB-1 [\s\S]*WEB-2 Logout/);
});

test("Gitea/Forgejo: own server from the allow-list; wrong server or provider refused", async () => {
  await assert.rejects(act({ action: "git.token", pageId, provider: "forgejo", baseUrl: "https://git.example.org", token: TOKENS[2] }), /nicht freigegeben/);
  process.env.ISSUE_SYNC_ALLOWED_HOSTS = "git.example.org,10.0.0.5,localhost";
  try {
    await act({ action: "git.token", pageId, provider: "forgejo", baseUrl: "https://git.example.org/", token: TOKENS[2] });
    stub.reset();
    await send("gitea", giteaPr(3, "WEB-1 follow-up"));
    await gitBackLinksSettled();
    assert.deepEqual(stub.calls(), ["POST https://git.example.org/api/v1/repos/acme/web/issues/3/comments"]);
    assert.equal(stub.requests[0].headers.authorization, `token ${TOKENS[2]}`);
    const commentId = [...stub.comments.keys()].pop()!;
    await send("gitea", giteaPr(3, "WEB-1 follow-up for WEB-2"));
    await gitBackLinksSettled();
    assert.deepEqual(stub.calls().slice(1), [`PATCH https://git.example.org/api/v1/repos/acme/web/issues/comments/${commentId}`]);

    // A repository on another server does not get the token.
    stub.reset();
    await send("gitea", giteaPr(4, "WEB-1 elsewhere", "https://evil.example"));
    await gitBackLinksSettled();
    assert.deepEqual(stub.calls(), []);
    assert.match((await config()).backLink!.error!, /anderen Server/);
    // Nor a webhook of another provider.
    await send("github", githubPr(8, "WEB-1 via GitHub"));
    await gitBackLinksSettled();
    assert.deepEqual(stub.calls(), []);
    assert.match((await config()).backLink!.error!, /anderen Git-Anbieter/);

    // Internal addresses: refused when saving an IP address, and by the
    // transport for a name that resolves to one.
    await assert.rejects(act({ action: "git.token", pageId, provider: "forgejo", baseUrl: "https://10.0.0.5", token: "t" }), /Interne Adressen/);
    await act({ action: "git.token", pageId, provider: "forgejo", baseUrl: "https://localhost:9", token: TOKENS[2] });
    setIssueSyncTransport(undefined);
    try {
      await send("gitea", giteaPr(4, "WEB-1 local", "https://localhost:9"));
      await gitBackLinksSettled();
    } finally {
      setIssueSyncTransport(stub.handle);
    }
    assert.match((await config()).backLink!.error!, /Interne Adressen/);
  } finally {
    delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
  }
  // Removed from the allow-list later: no request any more.
  await send("gitea", giteaPr(3, "WEB-2 only"));
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), []);
  assert.match((await config()).backLink!.error!, /nicht freigegeben/);
});

test("a slow or failing provider neither slows nor fails the webhook", async () => {
  await act({ action: "git.token", pageId, provider: "github", baseUrl: "", token: TOKENS[0] });
  stub.reset();
  stub.delay = 1500;
  try {
    const result = await send("github", githubPr(20, "WEB-2 slow"));
    assert.equal(result.linked, 1);
    assert.ok(result.ms < 1000, `webhook took ${result.ms} ms`);
    await gitBackLinksSettled();
    assert.equal(stub.requests.length, 1);
  } finally {
    stub.delay = 0;
  }
  stub.fail = 403;
  try {
    const result = await send("github", githubPr(21, "WEB-2 refused"));
    assert.equal(result.ok, true);
    await gitBackLinksSettled();
  } finally {
    stub.fail = null;
  }
  const status = (await config()).backLink!;
  assert.equal(status.status, 403);
  assert.match(status.error!, /Berechtigung/);
  assert.equal(status.url, "https://github.com/acme/web/pull/21");
  // Without the token, nothing is sent and the comment ids stay.
  await act({ action: "git.token", pageId, remove: true });
  stub.reset();
  await send("github", githubPr(5, "WEB-1 again"));
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), []);
  assert.equal((await config()).access, null);
});

test("writes per connection are limited per minute", async () => {
  const other = await ticketDatabase("Ops", "OPS");
  await command(owner, { action: "row.create", pageId: other.pageId, cells: { title: "Disk" } });
  await act({ action: "git.token", pageId: other.pageId, provider: "github", baseUrl: "", token: TOKENS[0] });
  setGitBackLinkLimit(2);
  try {
    stub.reset();
    for (const n of [31, 32, 33]) await send("github", githubPr(n, `OPS-1 part ${n}`), other);
    await gitBackLinksSettled(1000);
    assert.equal(stub.requests.length, 2);
    assert.equal(gitBackLinksWaiting(other.pageId), 1);
  } finally {
    setGitBackLinkLimit(undefined);
  }
});

test("nothing is posted for a database in an encrypted space", async () => {
  await act({ action: "git.token", pageId, provider: "github", baseUrl: "", token: TOKENS[0] });
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", boot.spaces[0].id);
  try {
    stub.reset();
    await send("github", githubPr(40, "WEB-1 encrypted"));
    await gitBackLinksSettled();
    assert.deepEqual(stub.calls(), []);
  } finally {
    await run("UPDATE spaces SET encrypted=0 WHERE id=?", boot.spaces[0].id);
  }
  // In the trash: the webhook itself no longer finds the database.
  await run("UPDATE pages SET deleted_at=? WHERE id=?", new Date().toISOString(), pageId);
  await assert.rejects(send("github", githubPr(41, "WEB-1 trashed")), /Nicht gefunden/);
  await gitBackLinksSettled();
  assert.deepEqual(stub.calls(), []);
});

test("no token in any log line", () => {
  assert.ok(logged.length > 0, "the failures were logged");
  for (const line of logged) for (const token of TOKENS) assert.ok(!line.includes(token), line);
});
