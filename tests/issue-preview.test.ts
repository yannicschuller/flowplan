// Issue link previews (#654): the strict address parser, the host
// allow-list, the mapping of the providers' answers, which token is used
// (and where it goes), the cache and limits, and the route. The providers
// are a local fake behind the issue sync's transport (as in
// tests/issue-sync.test.ts) – never the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import type { IssueHttpRequest, IssueHttpResponse } from "../lib/issue-sync";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-issue-preview-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
delete process.env.ISSUE_SYNC_ALLOW_PRIVATE;
const { id, run } = await import("../lib/db");
const { command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { createApiToken } = await import("../lib/api-tokens");
const { setIssueSyncTransport } = await import("../lib/issue-sync");
const { parseIssueUrl, issueLinkShape } = await import("../lib/issue-link-url");
const { issuePreviews, clearIssuePreviewCache, githubPreview, gitlabPreview, forgejoPreview, plainExcerpt } = await import("../lib/issue-preview");
const route = await import("../app/api/issue-sync/preview/handler");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function account(name: string) {
  const uid = id(),
    cookie = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", sha(cookie), uid, "[]", Date.now() + 3600_000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  return { user, cookie: `flowplan_session=${cookie}` };
}

/* ---------- The address parser ---------- */

test("the parser reads issues, pull requests and merge requests of the public hosts", () => {
  assert.deepEqual(parseIssueUrl("https://github.com/outline/outline/issues/6821"), {
    providers: ["github"],
    host: "github.com",
    web: "https://github.com",
    repo: "outline/outline",
    number: 6821,
    kind: "issue",
    url: "https://github.com/outline/outline/issues/6821",
  });
  const pull = parseIssueUrl("https://GitHub.com/acme/web.app/pull/12/files?diff=split#r1");
  assert.equal(pull?.kind, "pull");
  assert.equal(pull?.repo, "acme/web.app");
  assert.equal(pull?.url, "https://github.com/acme/web.app/pull/12");
  const issue = parseIssueUrl("https://gitlab.com/group/sub/project/-/issues/7");
  assert.deepEqual([issue?.providers, issue?.repo, issue?.kind, issue?.number], [["gitlab"], "group/sub/project", "issue", 7]);
  const mr = parseIssueUrl("https://gitlab.com/group/project/-/merge_requests/3/diffs");
  assert.deepEqual([mr?.providers, mr?.kind, mr?.url], [["gitlab"], "pull", "https://gitlab.com/group/project/-/merge_requests/3"]);
  const forgejo = parseIssueUrl("https://codeberg.org/forgejo/forgejo/pulls/99");
  assert.deepEqual([forgejo?.providers, forgejo?.kind, forgejo?.web], [["forgejo"], "pull", "https://codeberg.org"]);
  assert.equal(parseIssueUrl("https://codeberg.org/team/app/issues/4/")?.number, 4);
});

test("the parser refuses everything else", () => {
  for (const url of [
    "http://github.com/a/b/issues/1",
    "https://user:pw@github.com/a/b/issues/1",
    "https://github.com:8443/a/b/issues/1",
    "https://github.com/a/b/issues/0",
    "https://github.com/a/b/issues/01",
    "https://github.com/a/b/issues/12345678901",
    "https://github.com/a/b/issues/1/comments",
    "https://github.com/a/b/pulls/1",
    "https://github.com/a/b/issues",
    "https://github.com/a/issues/1",
    "https://github.com/a/b/c/issues/1",
    "https://github.com/a/%2e%2e/issues/1",
    "https://github.com/a/../b/issues/1",
    "https://github.com/a//b/issues/1",
    "https://github.com/a/b/discussions/1",
    "https://gitlab.com/group/project/issues/1",
    "https://gitlab.com/project/-/issues/1",
    "https://gitlab.com/group/project/-/merge_requests/1/notes",
    "https://codeberg.org/a/b/pull/1",
    "https://evil.example/a/b/issues/1",
    "https://github.com.evil.example/a/b/issues/1",
    "javascript:alert(1)",
    "not a url",
    `https://github.com/${"a".repeat(2000)}/b/issues/1`,
  ])
    assert.equal(parseIssueUrl(url), null, url);
});

test("other hosts only from ISSUE_SYNC_ALLOWED_HOSTS; their provider from a connection or the path", () => {
  assert.equal(parseIssueUrl("https://git.example.test/a/b/issues/1"), null);
  const allowedHosts = ["git.example.test", "forge.example.test:3000"];
  assert.deepEqual(parseIssueUrl("https://git.example.test/a/b/issues/1", { allowedHosts })?.providers, ["github", "forgejo"]);
  assert.deepEqual(parseIssueUrl("https://git.example.test/a/b/pull/1", { allowedHosts })?.providers, ["github"]);
  assert.deepEqual(parseIssueUrl("https://git.example.test/a/b/pulls/1", { allowedHosts })?.providers, ["forgejo"]);
  assert.deepEqual(parseIssueUrl("https://git.example.test/g/p/-/merge_requests/1", { allowedHosts })?.providers, ["gitlab"]);
  assert.equal(parseIssueUrl("https://forge.example.test:3000/a/b/issues/1", { allowedHosts })?.host, "forge.example.test:3000");
  assert.equal(parseIssueUrl("https://forge.example.test/a/b/issues/1", { allowedHosts }), null, "the port is part of the listing");
  // A connected server decides – also under a path.
  const servers = [{ provider: "gitlab" as const, web: "https://git.example.test/code" }];
  const ref = parseIssueUrl("https://git.example.test/code/team/app/-/issues/5", { allowedHosts, servers });
  assert.deepEqual([ref?.providers, ref?.web, ref?.repo], [["gitlab"], "https://git.example.test/code", "team/app"]);
  assert.deepEqual(parseIssueUrl("https://git.example.test/a/b/issues/1", { allowedHosts, servers: [{ provider: "forgejo", web: "https://git.example.test" }] })?.providers, ["forgejo"]);
});

test("the browser's first look matches issue paths only", () => {
  assert.ok(issueLinkShape("https://github.com/a/b/issues/1"));
  assert.ok(issueLinkShape("https://gitlab.com/g/p/-/merge_requests/2#note_1"));
  assert.ok(issueLinkShape("https://codeberg.org/a/b/pulls/3/files"));
  assert.ok(!issueLinkShape("https://github.com/a/b"));
  assert.ok(!issueLinkShape("http://github.com/a/b/issues/1"));
  assert.ok(!issueLinkShape("/#page=abc"));
  assert.ok(!issueLinkShape(null));
});

/* ---------- Mapping ---------- */

test("Markdown and HTML become a short plain excerpt", () => {
  assert.equal(
    plainExcerpt("## Steps\n\n1. Open **Firefox**\n2. Run `clear cache` <img src=x onerror=alert(1)>\n\n> [docs](https://x.test) ![shot](https://x.test/a.png)\n\n```js\nsecret()\n```\n<!-- hidden -->Done &amp; dusted"),
    "Steps Open Firefox Run clear cache docs Done & dusted",
  );
  const long = plainExcerpt("word ".repeat(100));
  assert.ok(long.length <= 201 && long.endsWith("…"));
  assert.ok(!/[<>]/.test(plainExcerpt("<script>alert(1)</script> text")));
});

test("the providers' answers map to one shape", () => {
  const issue = githubPreview({
    number: 6821,
    title: "Command to clear IndexedDB cache does not work in Firefox",
    body: "The **command** does nothing.",
    state: "open",
    user: { login: "tommoor" },
    created_at: "2026-11-27T10:00:00Z",
    labels: [{ name: "bug", color: "D73A4A" }, { name: "evil", color: "red;background:url(x)" }],
  });
  assert.deepEqual(issue, {
    number: 6821,
    kind: "issue",
    state: "open",
    title: "Command to clear IndexedDB cache does not work in Firefox",
    author: "tommoor",
    createdAt: "2026-11-27T10:00:00.000Z",
    excerpt: "The command does nothing.",
    labels: [
      { name: "bug", color: "#d73a4a" },
      { name: "evil", color: "" },
    ],
  });
  assert.equal(githubPreview({ number: 1, state: "closed" }).state, "closed");
  assert.deepEqual(
    [githubPreview({ number: 2, state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } })].map((p) => [p.kind, p.state]),
    [["pull", "merged"]],
  );
  assert.equal(githubPreview({ number: 3, state: "open", draft: true, pull_request: { merged_at: null } }).state, "draft");
  assert.equal(githubPreview({ number: 4, state: "closed", pull_request: { merged_at: null } }).state, "closed");

  const gl = gitlabPreview({ iid: 7, title: "Crash", description: "_Stack_ trace", state: "opened", author: { username: "ana" }, created_at: "2026-01-02T00:00:00Z", labels: ["bug", { name: "ui", color: "#428BCA" }] }, "issue");
  assert.deepEqual([gl.number, gl.state, gl.author, gl.excerpt, gl.labels], [7, "open", "ana", "Stack trace", [{ name: "bug", color: "" }, { name: "ui", color: "#428bca" }]]);
  assert.equal(gitlabPreview({ iid: 3, state: "merged" }, "pull").state, "merged");
  assert.equal(gitlabPreview({ iid: 3, state: "opened", draft: true }, "pull").state, "draft");
  assert.equal(gitlabPreview({ iid: 3, state: "locked" }, "issue").state, "closed");

  const fj = forgejoPreview({ number: 5, title: "Docs", body: "", state: "open", user: { login: "bo" }, labels: [{ name: "docs", color: "0075ca" }] });
  assert.deepEqual([fj.kind, fj.state, fj.labels], ["issue", "open", [{ name: "docs", color: "#0075ca" }]]);
  assert.deepEqual(
    [forgejoPreview({ number: 6, state: "closed", pull_request: { merged: true } })].map((p) => [p.kind, p.state]),
    [["pull", "merged"]],
  );
  assert.equal(forgejoPreview({ number: 7, state: "open", title: "WIP: new parser", pull_request: { merged: false } }).state, "draft");
  assert.equal(forgejoPreview({ number: 8, state: "open", pull_request: { merged: false, draft: true } }).state, "draft");
});

/* ---------- Lookups, tokens and the cache ---------- */

class Fake {
  requests: IssueHttpRequest[] = [];
  // Path → answer; tokens that may read private repositories.
  answers = new Map<string, { status: number; body?: unknown; private?: boolean; headers?: Record<string, string> }>();
  tokens = new Set<string>();
  http = async (request: IssueHttpRequest): Promise<IssueHttpResponse> => {
    this.requests.push(request);
    const answer = this.answers.get(request.url);
    const auth = request.headers.authorization || request.headers["private-token"] || "";
    const token = auth.replace(/^(Bearer|token) /, "");
    if (!answer || (answer.private && !this.tokens.has(token))) return { status: 404, headers: {}, body: '{"message":"Not Found"}' };
    return { status: answer.status, headers: answer.headers || {}, body: JSON.stringify(answer.body ?? {}) };
  };
}
const fake = new Fake();
setIssueSyncTransport(fake.http);

const owner = await account("preview-owner"),
  member = await account("preview-member"),
  guest = await account("preview-guest"),
  stranger = await account("preview-stranger");
const wid = await createWorkspace(owner.user.id, "Previews");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.user.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.user.id, "viewer");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.user.id);
const token = `ghp_${randomBytes(12).toString("hex")}`;
fake.tokens.add(token);
await command(owner.user, { action: "issueSync.connect", workspaceId: wid, provider: "github", repo: "acme/secret", token });
const otherToken = `fj_${randomBytes(12).toString("hex")}`;
await command(owner.user, { action: "issueSync.connect", workspaceId: wid, provider: "forgejo", baseUrl: "https://codeberg.org", repo: "acme/forge", token: otherToken });

fake.answers.set("https://api.github.com/repos/outline/outline/issues/6821", {
  status: 200,
  body: { number: 6821, title: "Public issue", body: "text", state: "open", user: { login: "tommoor" }, created_at: "2026-11-27T10:00:00Z", labels: [{ name: "bug", color: "d73a4a" }] },
});
fake.answers.set("https://api.github.com/repos/acme/secret/issues/5", {
  status: 200,
  private: true,
  body: { number: 5, title: "Private issue", body: "", state: "closed", user: { login: "dev" }, created_at: "2026-11-01T10:00:00Z", labels: [] },
});
fake.answers.set("https://gitlab.com/api/v4/projects/group%2Fapp/merge_requests/3", {
  status: 200,
  body: { iid: 3, title: "MR", description: "", state: "merged", author: { username: "ana" }, created_at: "2026-11-01T10:00:00Z", labels: [] },
});
fake.answers.set("https://codeberg.org/api/v1/repos/team/app/issues/4", {
  status: 200,
  body: { number: 4, title: "Forgejo", body: "", state: "open", user: { login: "bo" }, created_at: "2026-11-01T10:00:00Z", labels: [], pull_request: { merged: false, draft: true } },
});

test("a public issue is read without a token for someone without connections, and kept", async () => {
  clearIssuePreviewCache();
  fake.requests = [];
  const url = "https://github.com/outline/outline/issues/6821";
  const result = (await issuePreviews(stranger.user, [url]))[url];
  assert.ok("state" in result);
  assert.deepEqual([result.state, result.title, result.repo, result.number, result.provider, result.labels], ["open", "Public issue", "outline/outline", 6821, "github", [{ name: "bug", color: "#d73a4a" }]]);
  assert.equal(fake.requests.length, 1);
  const sent = fake.requests[0];
  assert.equal(sent.url, "https://api.github.com/repos/outline/outline/issues/6821");
  assert.equal(sent.method, "GET");
  assert.equal(sent.headers.authorization, undefined, "no token");
  assert.equal(sent.headers["user-agent"], "Flowplan-IssuePreview");
  assert.ok(!JSON.stringify(sent).includes(stranger.user.email) && !JSON.stringify(sent).includes(stranger.user.name), "nothing of the person");
  assert.ok((sent.timeout ?? 99_999) <= 5000, "a short timeout");
  // Again: from the cache.
  await issuePreviews(stranger.user, [url, url]);
  assert.equal(fake.requests.length, 1);
});

test("a private repository: the workspace's connection token for members, never for guests or strangers", async () => {
  clearIssuePreviewCache();
  fake.requests = [];
  const url = "https://github.com/acme/secret/issues/5";
  const forMember = (await issuePreviews(member.user, [url]))[url];
  assert.ok("state" in forMember && forMember.title === "Private issue" && forMember.state === "closed");
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(new URL(fake.requests[0].url).host, "api.github.com", "the token only goes to its server");
  assert.ok(!JSON.stringify(forMember).includes(token), "the token is not in the answer");
  // The Forgejo connection's token never goes to GitHub.
  assert.ok(fake.requests.every((r) => !JSON.stringify(r.headers).includes(otherToken)));

  fake.requests = [];
  assert.deepEqual((await issuePreviews(stranger.user, [url]))[url], { url, error: "private" }, "the member's cached answer is not the stranger's");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].headers.authorization, undefined);
  fake.requests = [];
  assert.deepEqual((await issuePreviews(guest.user, [url]))[url], { url, error: "private" });
  assert.ok(fake.requests.every((r) => !r.headers.authorization), "guests get no token");
});

test("GitLab merge requests and Forgejo drafts; refusals and limits answer gracefully", async () => {
  clearIssuePreviewCache();
  const mr = "https://gitlab.com/group/app/-/merge_requests/3";
  const fj = "https://codeberg.org/team/app/pulls/4";
  const missing = "https://github.com/acme/secret/issues/404";
  const other = "https://example.test/a/b/issues/1";
  const results = await issuePreviews(member.user, [mr, fj, missing, other]);
  assert.ok("state" in results[mr] && results[mr].state === "merged" && results[mr].kind === "pull");
  assert.ok("state" in results[fj] && results[fj].state === "draft" && results[fj].kind === "pull");
  assert.deepEqual(results[missing], { url: missing, error: "not_found" }, "the token was tried");
  assert.deepEqual(results[other], { url: other, error: "unsupported" });
  // The Forgejo token went to codeberg.org only.
  assert.ok(fake.requests.filter((r) => r.headers.authorization === `token ${otherToken}`).every((r) => new URL(r.url).host === "codeberg.org"));

  fake.answers.set("https://api.github.com/repos/busy/repo/issues/1", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
  fake.answers.set("https://api.github.com/repos/down/repo/issues/1", { status: 502 });
  const busy = "https://github.com/busy/repo/issues/1",
    down = "https://github.com/down/repo/issues/1";
  const more = await issuePreviews(stranger.user, [busy, down]);
  assert.deepEqual(more[busy], { url: busy, error: "rate_limited" });
  assert.deepEqual(more[down], { url: down, error: "unavailable" });
  // The transport failing (timeout, refused address) is "unavailable" too.
  setIssueSyncTransport(async () => {
    throw new Error("Zeitüberschreitung.");
  });
  const slow = "https://github.com/slow/repo/issues/1";
  assert.deepEqual((await issuePreviews(stranger.user, [slow]))[slow], { url: slow, error: "unavailable" });
  setIssueSyncTransport(fake.http);
});

test("allowed hosts follow ISSUE_SYNC_ALLOWED_HOSTS and ISSUE_SYNC_ALLOW_PRIVATE", async () => {
  clearIssuePreviewCache();
  const url = "https://10.0.0.5/a/b/pull/1";
  process.env.ISSUE_SYNC_ALLOWED_HOSTS = "10.0.0.5,git.example.test";
  try {
    assert.deepEqual((await issuePreviews(stranger.user, [url]))[url], { url, error: "unsupported" }, "an internal address needs ISSUE_SYNC_ALLOW_PRIVATE");
    fake.answers.set("https://git.example.test/api/v1/repos/a/b/issues/2", { status: 200, body: { number: 2, title: "Self-hosted", state: "open" } });
    const ambiguous = "https://git.example.test/a/b/issues/2";
    fake.requests = [];
    const result = (await issuePreviews(stranger.user, [ambiguous]))[ambiguous];
    assert.ok("state" in result && result.provider === "forgejo" && result.title === "Self-hosted");
    assert.deepEqual(
      fake.requests.map((r) => r.url),
      ["https://git.example.test/api/v3/repos/a/b/issues/2", "https://git.example.test/api/v1/repos/a/b/issues/2"],
      "GitHub Enterprise first, then Forgejo",
    );
    process.env.ISSUE_SYNC_ALLOW_PRIVATE = "true";
    clearIssuePreviewCache();
    fake.requests = [];
    await issuePreviews(stranger.user, [url]);
    assert.equal(fake.requests[0]?.url, "https://10.0.0.5/api/v3/repos/a/b/issues/1");
    assert.equal(fake.requests[0]?.allowPrivate, true);
  } finally {
    delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
    delete process.env.ISSUE_SYNC_ALLOW_PRIVATE;
  }
});

test("each person may cause at most 60 lookups a minute", async () => {
  clearIssuePreviewCache();
  const busy = await account("preview-busy");
  const urls = Array.from({ length: 70 }, (_, i) => `https://github.com/many/repo/issues/${i + 1}`);
  let refused = 0;
  for (let i = 0; i < urls.length; i += 20) {
    const batch = await issuePreviews(busy.user, urls.slice(i, i + 20));
    refused += Object.values(batch).filter((r) => "error" in r && r.error === "rate_limited").length;
  }
  assert.equal(refused, 10);
});

/* ---------- The route ---------- */

const post = (headers: Record<string, string>, body: unknown) =>
  new Request("https://flowplan.example.test/api/issue-sync/preview", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://flowplan.example.test", ...headers },
    body: JSON.stringify(body),
  });

test("the route: signed-in browser sessions only, at most 20 addresses", async () => {
  clearIssuePreviewCache();
  const url = "https://github.com/outline/outline/issues/6821";
  const ok = await route.POST(post({ cookie: member.cookie }, { urls: [url] }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = (await ok.json()) as { previews: Record<string, { title?: string }> };
  assert.equal(body.previews[url].title, "Public issue");
  assert.equal((await route.POST(post({}, { urls: [url] }))).status, 401);
  const apiToken = (await createApiToken(member.user, { name: "Skript", scope: "read" })).token;
  assert.equal((await route.POST(post({ authorization: `Bearer ${apiToken}` }, { urls: [url] }))).status, 403);
  assert.equal((await route.POST(post({ cookie: member.cookie }, { urls: Array.from({ length: 21 }, (_, i) => `${url}?${i}`) }))).status, 400);
  assert.equal((await route.POST(post({ cookie: member.cookie }, { urls: [] }))).status, 400);
  assert.equal((await route.POST(post({ cookie: member.cookie, origin: "https://evil.example" }, { urls: [url] }))).status, 403);
});
