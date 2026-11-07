import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
import type { IssueHttpRequest, IssueHttpResponse } from "../lib/issue-sync";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-issues-"));
delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
delete process.env.ISSUE_SYNC_ALLOW_PRIVATE;
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const sync = await import("../lib/issue-sync");
const { setIssueSyncTransport, syncIssues, issueEndpoint, testIssueConnection, receiveIssueWebhook, issueSyncOverview, issueLinkOf, retryAfter, issueSyncDatabase } = sync;

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}

/* ---------- A small GitHub and GitLab in memory ---------- */

type Issue = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  milestone: number | null;
  updated: number;
  comments: { id: number; author: string; body: string }[];
};
class FakeProvider {
  issues: Issue[] = [];
  requests: IssueHttpRequest[] = [];
  milestones = [{ number: 4, due: "2026-12-01" }];
  next: IssueHttpResponse | null = null;
  clock = Date.parse("2026-01-01T00:00:00Z");
  constructor(
    public kind: "github" | "gitlab",
    public repo: string,
  ) {}
  add(partial: Partial<Issue>) {
    const number = this.issues.length + 1;
    const issue: Issue = { id: 1000 + number, number, title: "", body: "", state: "open", labels: [], assignees: [], milestone: null, updated: this.tick(), comments: [], ...partial };
    this.issues.push(issue);
    return issue;
  }
  tick() {
    this.clock += 1000;
    return this.clock;
  }
  json(issue: Issue) {
    const m = this.milestones.find((x) => x.number === issue.milestone);
    if (this.kind === "github")
      return {
        id: issue.id,
        number: issue.number,
        html_url: `https://github.com/${this.repo}/issues/${issue.number}`,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((name) => ({ name })),
        assignees: issue.assignees.map((login) => ({ login })),
        milestone: m ? { number: m.number, due_on: `${m.due}T07:00:00Z` } : null,
        updated_at: new Date(issue.updated).toISOString(),
        comments: issue.comments.length,
      };
    return {
      id: issue.id,
      iid: issue.number,
      web_url: `https://gitlab.com/${this.repo}/-/issues/${issue.number}`,
      title: issue.title,
      description: issue.body,
      state: issue.state === "closed" ? "closed" : "opened",
      labels: issue.labels,
      assignees: issue.assignees.map((username) => ({ username })),
      milestone: m ? { id: m.number, due_date: m.due } : null,
      updated_at: new Date(issue.updated).toISOString(),
      user_notes_count: issue.comments.length,
    };
  }
  handle = async (request: IssueHttpRequest): Promise<IssueHttpResponse> => {
    this.requests.push(request);
    if (this.next) {
      const answer = this.next;
      this.next = null;
      return answer;
    }
    const ok = (data: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(data) });
    const url = new URL(request.url);
    const gh = this.kind === "github";
    const base = gh ? `/repos/${this.repo}` : `/api/v4/projects/${encodeURIComponent(this.repo)}`;
    const path = url.pathname.replace(/%2F/gi, "%2F");
    const body = request.body ? JSON.parse(request.body) : {};
    if (path === base) return ok(gh ? { full_name: this.repo } : { path_with_namespace: this.repo });
    if (!gh && url.pathname === "/api/v4/users") return ok([{ id: 77, username: url.searchParams.get("username") }]);
    if (path === `${base}/milestones`) return ok(this.milestones.map((m) => (gh ? { number: m.number, due_on: `${m.due}T07:00:00Z` } : { id: m.number, due_date: m.due })));
    if (path === `${base}/issues` && request.method === "GET") {
      const since = Date.parse(url.searchParams.get(gh ? "since" : "updated_after") || "") || 0;
      const page = Number(url.searchParams.get("page") || 1),
        per = Number(url.searchParams.get("per_page") || 50);
      const list = this.issues.filter((i) => i.updated >= since).sort((a, b) => a.updated - b.updated);
      return ok(list.slice((page - 1) * per, page * per).map((i) => this.json(i)));
    }
    if (path === `${base}/issues` && request.method === "POST") {
      const issue = this.add({
        title: body.title,
        body: (gh ? body.body : body.description) || "",
        labels: gh ? body.labels || [] : String(body.labels || "").split(",").filter(Boolean),
        assignees: body.assignees || [],
        milestone: body.milestone ?? body.milestone_id ?? null,
      });
      return ok(this.json(issue), 201);
    }
    const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/(\\d+)(/(comments|notes))?$`).exec(path);
    if (match) {
      const issue = this.issues.find((i) => i.number === Number(match[1]));
      if (!issue) return ok({ message: "Not Found" }, 404);
      if (match[3]) {
        if (request.method === "POST") {
          const comment = { id: 5000 + issue.comments.length, author: "flowplan-bot", body: body.body };
          issue.comments.push(comment);
          issue.updated = this.tick();
          return ok(gh ? { id: comment.id, html_url: `https://github.com/${this.repo}/issues/${issue.number}#c${comment.id}` } : { id: comment.id }, 201);
        }
        return ok(
          issue.comments.map((c) =>
            gh ? { id: c.id, user: { login: c.author }, body: c.body, html_url: `https://github.com/${this.repo}/issues/${issue.number}#c${c.id}` } : { id: c.id, author: { name: c.author }, body: c.body, system: false },
          ),
        );
      }
      if (request.method === "PATCH" || request.method === "PUT") {
        if (body.title !== undefined) issue.title = body.title;
        if (gh && body.body !== undefined) issue.body = body.body;
        if (!gh && body.description !== undefined) issue.body = body.description;
        if (gh && body.state) issue.state = body.state;
        if (!gh && body.state_event) issue.state = body.state_event === "close" ? "closed" : "open";
        if (gh && body.labels) issue.labels = body.labels;
        if (!gh && body.labels !== undefined) issue.labels = String(body.labels).split(",").filter(Boolean);
        if (body.assignees) issue.assignees = body.assignees;
        if (body.assignee_ids) issue.assignees = body.assignee_ids.includes(77) ? ["bo"] : [];
        if ("milestone" in body) issue.milestone = body.milestone;
        if ("milestone_id" in body) issue.milestone = body.milestone_id || null;
        issue.updated = this.tick();
      }
      return ok(this.json(issue));
    }
    return ok({ message: "unexpected " + request.method + " " + path }, 400);
  };
}

/* ---------- Workspace, database, connection ---------- */

const owner = await user("ada"),
  editor = await user("bo"),
  other = await user("cy");
const wid = await createWorkspace(owner.id, "Dev"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, other.id, "editor");
const act = async (body: Record<string, unknown>, who: Identity = owner): Promise<any> => await command(who, body);
async function makeDatabase(title: string) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title })).id as string;
  await act({
    action: "database.update",
    pageId,
    version: (await database(pageId)).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Todo", "Doing", "Done"] },
      { id: "tags", name: "Tags", type: "multiselect", options: ["bug", "feature"] },
      { id: "owner", name: "Owner", type: "person" },
      { id: "due", name: "Due", type: "date" },
      { id: "num", name: "Issue", type: "number" },
      { id: "link", name: "Link", type: "url" },
      { id: "notes", name: "Notes", type: "text" },
    ],
    views: (await database(pageId)).views,
  });
  return pageId;
}
const config = (extra: Record<string, unknown> = {}) => ({
  direction: "both",
  title: "title",
  body: "notes",
  status: {
    field: "status",
    map: [
      { value: "Todo", state: "open", label: "" },
      { value: "Doing", state: "open", label: "in progress" },
      { value: "Done", state: "closed", label: "" },
    ],
  },
  labels: "tags",
  assignee: "owner",
  milestone: "due",
  number: "num",
  url: "link",
  comments: { pull: true, push: true },
  importExisting: true,
  ...extra,
});
const cells = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells);
const rowsOf = async (pageId: string) => await all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=? ORDER BY position", pageId);
const rowByTitle = async (pageId: string, title: string) => (await rowsOf(pageId)).find((r) => JSON.parse(r.cells).title === title)!.id;
const version = async (rid: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid))!.version;
const update = async (pageId: string, rid: string, patch: Record<string, unknown>, who = owner) => await act({ action: "row.update", pageId, rowId: rid, version: await version(rid), cells: patch }, who);

const github = new FakeProvider("github", "acme/web");
setIssueSyncTransport(github.handle);
const pageId = await makeDatabase("Web");
let connectionId = "";

test("only github.com, gitlab.com and listed servers are reached", () => {
  assert.equal(issueEndpoint("github", "").api, "https://api.github.com");
  assert.equal(issueEndpoint("gitlab", "https://gitlab.com/").api, "https://gitlab.com/api/v4");
  assert.throws(() => issueEndpoint("gitlab", "https://git.example.org"), /nicht freigegeben/);
  assert.throws(() => issueEndpoint("github", "http://github.com"), /https/);
  process.env.ISSUE_SYNC_ALLOWED_HOSTS = "git.example.org, 10.0.0.5";
  try {
    assert.equal(issueEndpoint("gitlab", "https://git.example.org/gitlab/").api, "https://git.example.org/gitlab/api/v4");
    assert.equal(issueEndpoint("github", "https://git.example.org").api, "https://git.example.org/api/v3");
    // Listed, but an internal address needs the extra opt-in.
    assert.throws(() => issueEndpoint("gitlab", "https://10.0.0.5"), /Interne Adressen/);
    process.env.ISSUE_SYNC_ALLOW_PRIVATE = "true";
    assert.equal(issueEndpoint("gitlab", "https://10.0.0.5").allowPrivate, true);
  } finally {
    delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
    delete process.env.ISSUE_SYNC_ALLOW_PRIVATE;
  }
});

test("connections: owners only, token sealed, checked with one call", async () => {
  await assert.rejects(async () => await act({ action: "issueSync.connect", workspaceId: wid, provider: "github", repo: "acme/web", token: "ghp_x" }, editor), /Eigentümer/);
  connectionId = (await act({
    action: "issueSync.connect",
    workspaceId: wid,
    provider: "github",
    repo: "acme/web",
    token: "ghp_secret",
    people: [{ login: "Ada-gh", email: owner.email }],
  })).id;
  const stored = (await one<{ token: string }>("SELECT token FROM issue_connections WHERE id=?", connectionId))!;
  assert.ok(!stored.token.includes("ghp_secret"));
  assert.equal((await issueSyncOverview(editor, wid)).available, false);
  const overview = await issueSyncOverview(owner, wid);
  assert.ok(overview.available && overview.connections[0].hookUrl.includes("/api/issue-sync/hook/"));
  github.requests = [];
  const result = await testIssueConnection(owner, { workspaceId: wid, id: connectionId, provider: "github", repo: "acme/web" });
  assert.equal(result.repo, "acme/web");
  assert.equal(github.requests.length, 1);
  assert.equal(github.requests[0].url, "https://api.github.com/repos/acme/web");
  assert.equal(github.requests[0].headers.authorization, "Bearer ghp_secret");
  await assert.rejects(testIssueConnection(owner, { workspaceId: wid, provider: "gitlab", baseUrl: "https://evil.example", repo: "a/b", token: "t" }), /nicht freigegeben/);
});

test("pull creates records with status, labels, assignee, milestone, number and URL", async () => {
  github.add({ title: "Login broken", body: "Steps **here**", labels: ["bug"], assignees: ["ada-gh"] });
  github.add({ title: "Dark mode", labels: ["feature", "in progress"], milestone: 4 });
  const done = github.add({ title: "Old thing", state: "closed" });
  done.comments.push({ id: 1, author: "zoe", body: "Fixed in 1.2" });
  await assert.rejects(async () => await act({ action: "issueSync.map", pageId, connectionId, config: { ...config(), labels: "status" } }), /passt nicht|nur einmal/);
  await act({ action: "issueSync.map", pageId, connectionId, config: config() });
  const result = await syncIssues(pageId);
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 3);
  const login = await cells(await rowByTitle(pageId, "Login broken"));
  assert.equal(login.status, "Todo");
  assert.deepEqual(login.tags, ["bug"]);
  assert.equal(login.owner, owner.id);
  assert.equal(login.notes, "Steps **here**");
  assert.equal(login.num, 1);
  assert.equal(login.link, "https://github.com/acme/web/issues/1");
  const dark = await cells(await rowByTitle(pageId, "Dark mode"));
  assert.equal(dark.status, "Doing");
  assert.deepEqual(dark.tags, ["feature"]);
  assert.equal(dark.due, "2026-12-01");
  const old = await rowByTitle(pageId, "Old thing");
  assert.equal((await cells(old)).status, "Done");
  const comments = await all<{ body: string; author_id: string }>("SELECT body,author_id FROM comments WHERE row_id=?", old);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Fixed in 1\.2[\s\S]*zoe \(GitHub\) https:\/\/github\.com/);
  assert.equal(comments[0].author_id, owner.id);
  assert.equal((await issueLinkOf(owner, pageId, old))!.label, "GitHub #3");
  // A second run changes nothing and pushes nothing back.
  github.requests = [];
  const again = await syncIssues(pageId, { scan: true });
  assert.equal(again.pulled, 0);
  assert.equal(again.pushed, 0);
  assert.ok(github.requests.every((r) => r.method === "GET"));
});

test("pull updates a record when its issue changes", async () => {
  const issue = github.issues[0];
  issue.title = "Login broken on Safari";
  issue.state = "closed";
  issue.updated = github.tick();
  await syncIssues(pageId);
  const row = await cells(await rowByTitle(pageId, "Login broken on Safari"));
  assert.equal(row.status, "Done");
  assert.equal((await issueSyncDatabase(owner, pageId)).map!.state.pulled, 1);
});

test("push: record changes update the issue, new records create issues", async () => {
  const rid = await rowByTitle(pageId, "Dark mode");
  await update(pageId, rid, { status: "Done", tags: ["feature", "bug"], owner: "" });
  assert.ok(await one("SELECT 1 FROM issue_sync_queue WHERE row_id=?", rid));
  github.requests = [];
  const result = await syncIssues(pageId, { pushOnly: true });
  assert.equal(result.pushed, 1);
  const patch = github.requests.find((r) => r.method === "PATCH")!;
  const body = JSON.parse(patch.body!);
  assert.equal(body.state, "closed");
  assert.deepEqual(body.labels, ["bug", "feature"]);
  assert.deepEqual(body.assignees, []);
  assert.equal(github.issues[1].state, "closed");
  assert.ok(!(await one("SELECT 1 FROM issue_sync_queue WHERE row_id=?", rid)));

  const fresh = (await act({ action: "row.create", pageId, cells: { title: "From Flowplan", status: "Doing", owner: owner.id, due: "2026-12-01", notes: "Body" } })).id;
  await syncIssues(pageId, { pushOnly: true });
  const created = github.issues.find((i) => i.title === "From Flowplan")!;
  assert.deepEqual(created.labels, ["in progress"]);
  assert.deepEqual(created.assignees, ["Ada-gh"]);
  assert.equal(created.milestone, 4);
  assert.equal(created.body, "Body");
  assert.equal((await cells(fresh)).num, created.number);
  assert.equal((await cells(fresh)).link, `https://github.com/acme/web/issues/${created.number}`);
  // The pull after the push sees its own change and leaves the record alone.
  const before = await version(fresh);
  await syncIssues(pageId);
  assert.equal(await version(fresh), before);
});

test("comments both ways", async () => {
  const rid = await rowByTitle(pageId, "From Flowplan");
  await act({ action: "comment.create", pageId, rowId: rid, body: "Looks good" }, editor);
  github.requests = [];
  await syncIssues(pageId, { pushOnly: true });
  const posted = github.requests.find((r) => r.method === "POST" && r.url.endsWith("/comments"))!;
  assert.match(JSON.parse(posted.body!).body, /\*\*bo\*\* \(Flowplan\):\n\nLooks good/);
  // The pushed comment does not come back as a second comment.
  const issue = github.issues.find((i) => i.title === "From Flowplan")!;
  issue.comments.push({ id: 9, author: "dev", body: "Thanks" });
  issue.updated = github.tick();
  await syncIssues(pageId);
  const bodies = (await all<{ body: string }>("SELECT body FROM comments WHERE row_id=? ORDER BY created_at", rid)).map((c) => c.body);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /^Thanks/);
});

test("conflicts: the later change wins, with an audit line", async () => {
  const rid = await rowByTitle(pageId, "Login broken on Safari");
  const issue = github.issues[0];
  // Local change now, remote change later (in the future): remote wins.
  await update(pageId, rid, { title: "Local title" });
  issue.title = "Remote title";
  issue.updated = Date.now() + 3_600_000;
  await syncIssues(pageId);
  assert.equal((await cells(rid)).title, "Remote title");
  const audits = await all<{ detail: string }>("SELECT detail FROM audit WHERE action='issueSync.conflict' AND resource_id=?", rid);
  assert.match(audits.at(-1)!.detail, /#1: remote/);
  // Remote change long ago (but after the last sync), local change now: local wins.
  const lines = audits.length;
  await update(pageId, rid, { title: "Local wins" });
  issue.title = "Stale remote";
  issue.updated = issue.updated + 1000;
  const link = (await one<{ remote_updated: number }>("SELECT remote_updated FROM issue_links WHERE row_id=?", rid))!;
  await run("UPDATE issue_links SET remote_updated=? WHERE row_id=?", link.remote_updated - 10_000_000_000, rid);
  await run("UPDATE rows SET updated_at='2099-01-01 00:00:00' WHERE id=?", rid);
  await syncIssues(pageId);
  assert.equal((await cells(rid)).title, "Local wins");
  assert.equal(issue.title, "Local wins");
  const after = await all<{ detail: string }>("SELECT detail FROM audit WHERE action='issueSync.conflict' AND resource_id=?", rid);
  assert.equal(after.length, lines + 1);
  assert.match(after.at(-1)!.detail, /local/);
});

test("records the connecting person may not read are skipped", async () => {
  const rid = (await act({ action: "row.create", pageId, cells: { title: "Private plan" } }, other)).id;
  await run("UPDATE rows SET access='private' WHERE id=?", rid);
  // The owner sees everything; with an editor grant on the page, not this.
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,NULL,'editor')", pageId, owner.id);
  try {
    const result = await syncIssues(pageId, { scan: true });
    assert.ok((result.skipped || 0) >= 1);
    assert.ok(!github.issues.some((i) => i.title === "Private plan"));
  } finally {
    await run("DELETE FROM grants WHERE resource_id=? AND user_id=?", pageId, owner.id);
    await run("DELETE FROM rows WHERE id=?", rid);
  }
});

test("webhooks: signature checked, the matching database is named", async () => {
  const row = (await one<{ hook_token: string }>("SELECT hook_token FROM issue_connections WHERE id=?", connectionId))!;
  const secret = (await issueSyncOverview(owner, wid)).available ? ((await issueSyncOverview(owner, wid)) as any).connections[0].hookSecret : "";
  const payload = JSON.stringify({ action: "edited", repository: { full_name: "acme/web" }, issue: { number: 1 } });
  const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  await assert.rejects(async () => await receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issues", "x-hub-signature-256": "sha256=00" }), payload), /Signatur/);
  await assert.rejects(async () => await receiveIssueWebhook("unknown-token-unknown-token", new Headers(), payload), /Nicht gefunden/);
  const result = await receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issues", "x-hub-signature-256": signature }), payload);
  assert.deepEqual(result.pages, [pageId]);
  const comment = JSON.stringify({ repository: { full_name: "acme/other" } });
  const other = await receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(comment).digest("hex")}` }), comment);
  assert.deepEqual(other.pages, []);
});

test("rate limits pause the connection until Retry-After", async () => {
  const now = Date.parse("2026-05-01T00:00:00Z");
  assert.equal(retryAfter({ "Retry-After": "120" }, now), now + 120_000);
  assert.equal(retryAfter({ "x-ratelimit-reset": String(now / 1000 + 300) }, now), now + 300_000);
  assert.equal(retryAfter({}, now), now + 60_000);
  assert.equal(retryAfter({ "retry-after": "999999" }, now), now + 3_600_000);
  github.next = { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "120" }, body: "{}" };
  const result = await syncIssues(pageId);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /begrenzt/);
  const state = JSON.parse((await one<{ state: string }>("SELECT state FROM issue_connections WHERE id=?", connectionId))!.state);
  assert.ok(state.backoffUntil > Date.now() + 100_000);
  github.requests = [];
  const paused = await syncIssues(pageId);
  assert.ok(paused.backoffUntil);
  assert.equal(github.requests.length, 0);
  await run("UPDATE issue_connections SET state='{}' WHERE id=?", connectionId);
});

test("GitLab: closed state, usernames, labels and state events", async () => {
  const gitlab = new FakeProvider("gitlab", "team/app");
  setIssueSyncTransport(gitlab.handle);
  const gid = (await act({ action: "issueSync.connect", workspaceId: wid, provider: "gitlab", repo: "team/app", token: "glpat", people: [{ login: "bo", email: editor.email }] })).id;
  const lab = await makeDatabase("App");
  gitlab.add({ title: "Crash", state: "closed", assignees: ["bo"], labels: ["bug"] });
  await act({ action: "issueSync.map", pageId: lab, connectionId: gid, config: config({ comments: { pull: false, push: false } }) });
  await syncIssues(lab);
  const rid = await rowByTitle(lab, "Crash");
  assert.equal((await cells(rid)).status, "Done");
  assert.equal((await cells(rid)).owner, editor.id);
  assert.equal((await cells(rid)).link, "https://gitlab.com/team/app/-/issues/1");
  assert.equal(gitlab.requests[0].headers["private-token"], "glpat");
  await update(lab, rid, { status: "Doing" });
  gitlab.requests = [];
  await syncIssues(lab, { pushOnly: true });
  const put = gitlab.requests.find((r) => r.method === "PUT")!;
  const body = JSON.parse(put.body!);
  assert.equal(body.state_event, "reopen");
  assert.equal(body.labels, "bug,in progress");
  assert.deepEqual(body.assignee_ids, [77]);
  assert.equal(gitlab.issues[0].state, "open");
  // The same repository cannot feed a second database.
  const third = await makeDatabase("Again");
  await assert.rejects(async () => await act({ action: "issueSync.map", pageId: third, connectionId: gid, config: config() }), /schon mit einer anderen Datenbank/);
  await act({ action: "issueSync.unmap", pageId: lab });
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM issue_links WHERE page_id=?", lab))!.n, 0);
  setIssueSyncTransport(github.handle);
});

test("the record's document as Markdown body", async () => {
  const docs = new FakeProvider("github", "acme/docs");
  setIssueSyncTransport(docs.handle);
  const did = (await act({ action: "issueSync.connect", workspaceId: wid, provider: "github", repo: "acme/docs", token: "ghp_docs" })).id;
  const dbId = await makeDatabase("Docs");
  docs.add({ title: "Spec", body: "## Goal\n\nShip **it**" });
  await act({ action: "issueSync.map", pageId: dbId, connectionId: did, config: config({ body: "@document", status: null, labels: "", assignee: "", milestone: "" }) });
  await syncIssues(dbId);
  const rid = await rowByTitle(dbId, "Spec");
  const html = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rid))!.html;
  assert.match(html, /<h2[^>]*>Goal<\/h2>/);
  assert.match(html, /<strong>it<\/strong>/);
  const { replaceRowDocument } = await import("../lib/row-documents");
  await replaceRowDocument(rid, "<h2>Goal</h2><p>Ship <em>soon</em></p>", owner.id);
  await run("UPDATE rows SET updated_at='2099-01-01 00:00:00' WHERE id=?", rid);
  docs.requests = [];
  await syncIssues(dbId, { scan: true });
  const patch = docs.requests.find((r) => r.method === "PATCH")!;
  assert.match(JSON.parse(patch.body!).body, /## Goal\s+Ship (\*soon\*|_soon_)/);
  setIssueSyncTransport(github.handle);
});

/* ---------- A small Forgejo/Gitea in memory ---------- */

// The Gitea REST API v1 as Forgejo and Gitea serve it: issues and pull
// requests in one list (newest first, not by change), `limit`/`page` with
// X-Total-Count and Link, labels by ID, milestones by ID, `since`/`before`
// to the second, token auth.
type ForgeIssue = Issue & { pull: boolean };
class FakeForgejo {
  issues: ForgeIssue[] = [];
  requests: IssueHttpRequest[] = [];
  labels = [
    { id: 11, name: "bug" },
    { id: 12, name: "in progress" },
  ];
  orgLabels: { id: number; name: string }[] | null = null;
  milestones = [{ id: 31, due: "2026-12-01" }];
  next: IssueHttpResponse | null = null;
  clock = Date.parse("2026-02-01T00:00:00Z");
  // A server's MAX_RESPONSE_ITEMS: fewer per page than asked for.
  maxLimit = 50;
  totalHeader = true;
  // Older servers ignore type=issues: pull requests come along.
  honorType = true;
  constructor(
    public repo: string,
    public host = "https://forge.example.org",
  ) {}
  add(partial: Partial<ForgeIssue>) {
    const number = this.issues.length + 1;
    const issue: ForgeIssue = { id: 7000 + number, number, title: "", body: "", state: "open", labels: [], assignees: [], milestone: null, updated: this.tick(), comments: [], pull: false, ...partial };
    this.issues.push(issue);
    return issue;
  }
  tick() {
    this.clock += 1000;
    return this.clock;
  }
  label(name: string) {
    return [...this.labels, ...(this.orgLabels || [])].find((l) => l.name === name)!;
  }
  json(issue: ForgeIssue) {
    const m = this.milestones.find((x) => x.id === issue.milestone);
    return {
      id: issue.id,
      number: issue.number,
      html_url: `${this.host}/${this.repo}/issues/${issue.number}`,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ id: this.label(name)?.id, name })),
      assignee: issue.assignees[0] ? { login: issue.assignees[0] } : null,
      assignees: issue.assignees.length ? issue.assignees.map((login) => ({ login })) : null,
      milestone: m ? { id: m.id, title: "v1", due_on: `${m.due}T23:59:59Z` } : null,
      updated_at: new Date(issue.updated).toISOString().replace(/\.\d{3}Z$/, "Z"),
      comments: issue.comments.length,
      pull_request: issue.pull ? { merged: false } : null,
    };
  }
  handle = async (request: IssueHttpRequest): Promise<IssueHttpResponse> => {
    this.requests.push(request);
    if (this.next) {
      const answer = this.next;
      this.next = null;
      return answer;
    }
    if (request.headers.authorization !== "token fj_secret") return { status: 401, headers: {}, body: JSON.stringify({ message: "token is required" }) };
    const ok = (data: unknown, status = 200, headers: Record<string, string> = {}) => ({ status, headers, body: JSON.stringify(data) });
    const url = new URL(request.url);
    const base = `/api/v1/repos/${this.repo}`;
    const path = url.pathname;
    const body = request.body ? JSON.parse(request.body) : {};
    const paged = <T>(all: T[]) => {
      const limit = Math.min(this.maxLimit, Number(url.searchParams.get("limit") || 30));
      const page = Number(url.searchParams.get("page") || 1);
      const last = Math.max(1, Math.ceil(all.length / limit));
      const link = page < last ? `<${url.origin}${url.pathname}?page=${page + 1}&limit=${limit}>; rel="next",<${url.origin}${url.pathname}?page=${last}&limit=${limit}>; rel="last"` : "";
      return ok(all.slice((page - 1) * limit, page * limit), 200, {
        ...(this.totalHeader ? { "X-Total-Count": String(all.length) } : {}),
        ...(link ? { Link: link } : {}),
      });
    };
    if (url.origin !== this.host) return ok({ message: "wrong host" }, 400);
    if (path === base) return ok({ full_name: this.repo });
    if (path.startsWith("/api/v1/orgs/")) return this.orgLabels ? paged(this.orgLabels) : ok({ message: "GetOrgByName" }, 404);
    if (path === `${base}/labels` && request.method === "GET") return paged(this.labels);
    if (path === `${base}/labels` && request.method === "POST") {
      const label = { id: 100 + this.labels.length, name: String(body.name) };
      assert.match(String(body.color), /^#[0-9a-f]{6}$/);
      this.labels.push(label);
      return ok(label, 201);
    }
    if (path === `${base}/milestones`) return paged(this.milestones.map((m) => ({ id: m.id, title: "v1", due_on: `${m.due}T23:59:59Z` })));
    if (path === `${base}/issues` && request.method === "GET") {
      const second = (name: string) => (url.searchParams.get(name) ? Math.floor(Date.parse(url.searchParams.get(name)!) / 1000) : null);
      const since = second("since"),
        before = second("before");
      const onlyIssues = this.honorType && url.searchParams.get("type") === "issues";
      const list = this.issues
        .filter((i) => (since === null || Math.floor(i.updated / 1000) >= since) && (before === null || Math.floor(i.updated / 1000) <= before) && (!onlyIssues || !i.pull))
        .sort((a, b) => b.number - a.number);
      return paged(list.map((i) => this.json(i)));
    }
    if (path === `${base}/issues` && request.method === "POST") {
      const issue = this.add({
        title: body.title,
        body: body.body || "",
        labels: (body.labels || []).map((lid: number) => [...this.labels, ...(this.orgLabels || [])].find((l) => l.id === lid)!.name),
        assignees: body.assignees || [],
        milestone: body.milestone || null,
      });
      return ok(this.json(issue), 201);
    }
    const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/(\\d+)(/(comments|labels))?$`).exec(path);
    if (match) {
      const issue = this.issues.find((i) => i.number === Number(match[1]));
      if (!issue) return ok({ message: "not found" }, 404);
      if (match[3] === "labels") {
        assert.equal(request.method, "PUT");
        issue.labels = (body.labels as number[]).map((lid) => [...this.labels, ...(this.orgLabels || [])].find((l) => l.id === lid)!.name);
        issue.updated = this.tick();
        return ok(issue.labels.map((name) => this.label(name)));
      }
      if (match[3] === "comments") {
        if (request.method === "POST") {
          const comment = { id: 9000 + issue.comments.length, author: "flowplan-bot", body: body.body };
          issue.comments.push(comment);
          issue.updated = this.tick();
          return ok({ id: comment.id, html_url: `${this.host}/${this.repo}/issues/${issue.number}#issuecomment-${comment.id}`, user: { login: comment.author }, body: comment.body }, 201);
        }
        return paged(issue.comments.map((c) => ({ id: c.id, user: { login: c.author }, body: c.body, html_url: `${this.host}/${this.repo}/issues/${issue.number}#issuecomment-${c.id}` })));
      }
      if (request.method === "PATCH") {
        assert.ok(!("labels" in body), "labels go through their own call");
        if (body.title !== undefined) issue.title = body.title;
        if (body.body !== undefined) issue.body = body.body;
        if (body.state) issue.state = body.state;
        if (body.assignees) issue.assignees = body.assignees;
        if ("milestone" in body) issue.milestone = body.milestone || null;
        issue.updated = this.tick();
        return ok(this.json(issue), 201);
      }
      return ok(this.json(issue));
    }
    return ok({ message: "unexpected " + request.method + " " + path }, 400);
  };
}
const FORGE_HOST = "forge.example.org";
// Every Forgejo/Gitea server needs the administrators' approval.
async function withForgeHost<T>(fn: () => Promise<T>) {
  process.env.ISSUE_SYNC_ALLOWED_HOSTS = FORGE_HOST;
  try {
    return await fn();
  } finally {
    delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
  }
}
const forge = new FakeForgejo("team/forge");
let forgeConnection = "";
let forgePage = "";

test("Forgejo/Gitea: the server address is required and must be allowed", () => {
  assert.throws(() => issueEndpoint("forgejo", ""), /Adresse des Servers/);
  assert.throws(() => issueEndpoint("forgejo", `https://${FORGE_HOST}`), /nicht freigegeben/);
  // codeberg.org, the public Forgejo, needs no listing (its address is stored).
  assert.deepEqual(issueEndpoint("forgejo", "https://Codeberg.org/"), { web: "https://codeberg.org", api: "https://codeberg.org/api/v1", allowPrivate: false, selfHosted: true });
  assert.throws(() => issueEndpoint("forgejo", "https://codeberg.org:8443"), /nicht freigegeben/);
  assert.throws(() => issueEndpoint("gitlab", "https://codeberg.org"), /nicht freigegeben/);
  assert.throws(() => issueEndpoint("forgejo", `http://${FORGE_HOST}`), /https/);
  assert.throws(() => issueEndpoint("forgejo", `https://token:x@${FORGE_HOST}`), /Zugangsdaten/);
  process.env.ISSUE_SYNC_ALLOWED_HOSTS = `${FORGE_HOST},192.168.1.20`;
  try {
    assert.deepEqual(issueEndpoint("forgejo", `https://${FORGE_HOST}/`), { web: `https://${FORGE_HOST}`, api: `https://${FORGE_HOST}/api/v1`, allowPrivate: false, selfHosted: true });
    assert.equal(issueEndpoint("forgejo", `https://${FORGE_HOST}/git/`).api, `https://${FORGE_HOST}/git/api/v1`);
    assert.throws(() => issueEndpoint("forgejo", "https://192.168.1.20"), /Interne Adressen/);
    process.env.ISSUE_SYNC_ALLOW_PRIVATE = "true";
    assert.equal(issueEndpoint("forgejo", "https://192.168.1.20").allowPrivate, true);
  } finally {
    delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
    delete process.env.ISSUE_SYNC_ALLOW_PRIVATE;
  }
  assert.throws(() => sync.checkedRepo("forgejo", "group/sub/project"), /besitzer\/name/);
  assert.equal(sync.checkedRepo("forgejo", "/team/forge.git"), "team/forge");
});

test("Forgejo/Gitea: codeberg.org connects without ISSUE_SYNC_ALLOWED_HOSTS", async () => {
  const codeberg = new FakeForgejo("team/cb", "https://codeberg.org");
  setIssueSyncTransport(codeberg.handle);
  try {
    assert.equal(process.env.ISSUE_SYNC_ALLOWED_HOSTS, undefined);
    const cid = (await act({ action: "issueSync.connect", workspaceId: wid, provider: "forgejo", baseUrl: "https://codeberg.org", repo: "team/cb", token: "fj_secret" })).id;
    assert.equal((await one<{ base_url: string }>("SELECT base_url FROM issue_connections WHERE id=?", cid))!.base_url, "https://codeberg.org");
    assert.equal((await testIssueConnection(owner, { workspaceId: wid, id: cid, provider: "forgejo", baseUrl: "https://codeberg.org", repo: "team/cb" })).repo, "team/cb");
    assert.equal(codeberg.requests[0].url, "https://codeberg.org/api/v1/repos/team/cb");
    assert.equal(codeberg.requests[0].allowPrivate, false);
    codeberg.add({ title: "From Codeberg" });
    const dbId = await makeDatabase("Codeberg");
    await act({ action: "issueSync.map", pageId: dbId, connectionId: cid, config: config({ comments: { pull: false, push: false } }) });
    const result = await syncIssues(dbId);
    assert.equal(result.pulled, 1, String(result.error));
    await act({ action: "issueSync.disconnect", workspaceId: wid, id: cid });
  } finally {
    setIssueSyncTransport(github.handle);
  }
});

test("Forgejo/Gitea: connect, test with the token, import issues without pull requests", async () =>
  await withForgeHost(async () => {
    setIssueSyncTransport(forge.handle);
    await assert.rejects(async () => await act({ action: "issueSync.connect", workspaceId: wid, provider: "forgejo", repo: "team/forge", token: "fj_secret" }), /Adresse des Servers/);
    forgeConnection = (await act({
      action: "issueSync.connect",
      workspaceId: wid,
      provider: "forgejo",
      baseUrl: `https://${FORGE_HOST}/`,
      repo: "team/forge",
      token: "fj_secret",
      people: [{ login: "bo", email: editor.email }],
    })).id;
    const stored = (await one<{ base_url: string; provider: string; token: string }>("SELECT base_url,provider,token FROM issue_connections WHERE id=?", forgeConnection))!;
    assert.deepEqual([stored.provider, stored.base_url], ["forgejo", `https://${FORGE_HOST}`]);
    assert.ok(!stored.token.includes("fj_secret"));
    forge.requests = [];
    assert.equal((await testIssueConnection(owner, { workspaceId: wid, id: forgeConnection, provider: "forgejo", baseUrl: `https://${FORGE_HOST}`, repo: "team/forge" })).repo, "team/forge");
    assert.equal(forge.requests[0].url, `https://${FORGE_HOST}/api/v1/repos/team/forge`);
    assert.equal(forge.requests[0].headers.authorization, "token fj_secret");
    assert.equal(forge.requests[0].allowPrivate, false);
    await assert.rejects(testIssueConnection(owner, { workspaceId: wid, provider: "forgejo", baseUrl: `https://${FORGE_HOST}`, repo: "team/forge", token: "wrong" }), /lehnt das Token ab/);

    forge.add({ title: "Upload fails", body: "Steps **here**", labels: ["bug"], assignees: ["bo"] });
    forge.add({ title: "Fix upload", pull: true });
    forge.add({ title: "Dark theme", labels: ["in progress"], milestone: 31 });
    const old = forge.add({ title: "Old crash", state: "closed" });
    old.comments.push({ id: 1, author: "zoe", body: "Fixed in 2.0" });
    forge.add({ title: "Release 2.0", pull: true, state: "closed" });
    forgePage = await makeDatabase("Forge");
    await act({ action: "issueSync.map", pageId: forgePage, connectionId: forgeConnection, config: config() });
    forge.requests = [];
    const result = await syncIssues(forgePage);
    assert.equal(result.ok, true, String(result.error));
    assert.equal(result.pulled, 3);
    const list = forge.requests.find((r) => r.method === "GET" && r.url.includes("/issues?"))!;
    assert.match(list.url, /state=all&type=issues/);
    const titles = (await rowsOf(forgePage)).map((r) => JSON.parse(r.cells).title).sort();
    assert.deepEqual(titles, ["Dark theme", "Old crash", "Upload fails"]);
    const upload = await cells(await rowByTitle(forgePage, "Upload fails"));
    assert.equal(upload.status, "Todo");
    assert.deepEqual(upload.tags, ["bug"]);
    assert.equal(upload.owner, editor.id);
    assert.equal(upload.notes, "Steps **here**");
    assert.equal(upload.num, 1);
    assert.equal(upload.link, `https://${FORGE_HOST}/team/forge/issues/1`);
    const dark = await cells(await rowByTitle(forgePage, "Dark theme"));
    assert.equal(dark.status, "Doing");
    assert.equal(dark.due, "2026-12-01");
    const crash = await rowByTitle(forgePage, "Old crash");
    assert.equal((await cells(crash)).status, "Done");
    const comments = await all<{ body: string }>("SELECT body FROM comments WHERE row_id=?", crash);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Fixed in 2\.0[\s\S]*zoe \(Forgejo\/Gitea\) https:\/\/forge\.example\.org\/team\/forge\/issues\/4#issuecomment-1/);
    assert.equal((await issueLinkOf(owner, forgePage, crash))!.label, "Forgejo/Gitea #4");
    // Nothing changed: nothing comes back, nothing goes out.
    forge.requests = [];
    const again = await syncIssues(forgePage, { scan: true });
    assert.equal(again.pulled, 0);
    assert.equal(again.pushed, 0);
    assert.ok(forge.requests.every((r) => r.method === "GET"));
  }));

test("Forgejo/Gitea: record changes go back – labels by ID (missing ones created), state, assignee, milestone", async () =>
  await withForgeHost(async () => {
    const rid = await rowByTitle(forgePage, "Dark theme");
    await update(forgePage, rid, { status: "Done", tags: ["feature", "bug"], owner: editor.id, due: "" });
    forge.requests = [];
    const result = await syncIssues(forgePage, { pushOnly: true });
    assert.equal(result.pushed, 1, String(result.error));
    const created = forge.requests.find((r) => r.method === "POST" && r.url.endsWith("/labels"))!;
    assert.equal(JSON.parse(created.body!).name, "feature");
    const put = forge.requests.find((r) => r.method === "PUT")!;
    assert.match(put.url, /\/api\/v1\/repos\/team\/forge\/issues\/3\/labels$/);
    assert.deepEqual(JSON.parse(put.body!).labels.sort(), [11, forge.label("feature").id].sort());
    const patch = JSON.parse(forge.requests.find((r) => r.method === "PATCH")!.body!);
    assert.equal(patch.state, "closed");
    assert.deepEqual(patch.assignees, ["bo"]);
    assert.equal(patch.milestone, 0);
    const issue = forge.issues[2];
    assert.deepEqual([issue.state, issue.labels.sort(), issue.assignees, issue.milestone], ["closed", ["bug", "feature"], ["bo"], null]);
    // An organisation's labels count as well (no copy in the repository).
    forge.orgLabels = [{ id: 51, name: "security" }];
    await act({ action: "database.update", pageId: forgePage, version: (await database(forgePage)).version, fields: (await database(forgePage)).fields.map((f: any) => (f.id === "tags" ? { ...f, options: [...f.options, "security"] } : f)), views: (await database(forgePage)).views });
    await update(forgePage, rid, { tags: ["security"] });
    forge.requests = [];
    await syncIssues(forgePage, { pushOnly: true });
    assert.deepEqual(issue.labels, ["security"]);
    assert.ok(!forge.requests.some((r) => r.method === "POST" && r.url.endsWith("/labels")));

    const fresh = (await act({ action: "row.create", pageId: forgePage, cells: { title: "From Flowplan", status: "Done", owner: editor.id, due: "2026-12-01", tags: ["bug"], notes: "Body" } })).id;
    forge.requests = [];
    await syncIssues(forgePage, { pushOnly: true });
    const post = JSON.parse(forge.requests.find((r) => r.method === "POST" && r.url.endsWith("/issues"))!.body!);
    assert.deepEqual(post.labels, [11]);
    assert.equal(post.milestone, 31);
    assert.ok(!("state" in post));
    const made = forge.issues.find((i) => i.title === "From Flowplan")!;
    // Created open, then closed in a second step.
    assert.equal(made.state, "closed");
    assert.deepEqual(made.assignees, ["bo"]);
    assert.equal(made.body, "Body");
    assert.equal((await cells(fresh)).num, made.number);
    assert.equal((await cells(fresh)).link, `https://${FORGE_HOST}/team/forge/issues/${made.number}`);
    // The pull after the push sees its own change.
    const before = await version(fresh);
    await syncIssues(forgePage);
    assert.equal(await version(fresh), before);
  }));

test("Forgejo/Gitea: comments both ways, remote changes win when later", async () =>
  await withForgeHost(async () => {
    const rid = await rowByTitle(forgePage, "From Flowplan");
    await act({ action: "comment.create", pageId: forgePage, rowId: rid, body: "Looks good" }, editor);
    forge.requests = [];
    await syncIssues(forgePage, { pushOnly: true });
    const posted = forge.requests.find((r) => r.method === "POST" && r.url.endsWith("/comments"))!;
    assert.match(JSON.parse(posted.body!).body, /\*\*bo\*\* \(Flowplan\):\n\nLooks good/);
    const issue = forge.issues.find((i) => i.title === "From Flowplan")!;
    issue.comments.push({ id: 77, author: "dev", body: "Thanks" });
    issue.updated = forge.tick();
    await syncIssues(forgePage);
    const bodies = (await all<{ body: string }>("SELECT body FROM comments WHERE row_id=? ORDER BY created_at", rid)).map((c) => c.body);
    assert.equal(bodies.length, 2);
    assert.match(bodies[1], /^Thanks/);
    // Changed on both sides: the issue's later change wins.
    await update(forgePage, rid, { title: "Local title" });
    issue.title = "Remote title";
    issue.updated = Date.now() + 3_600_000;
    await syncIssues(forgePage);
    assert.equal((await cells(rid)).title, "Remote title");
    const audits = await all<{ detail: string }>("SELECT detail FROM audit WHERE action='issueSync.conflict' AND resource_id=?", rid);
    assert.match(audits.at(-1)!.detail, /Forgejo\/Gitea #\d+: remote/);
  }));

test("Forgejo/Gitea webhooks: X-Forgejo-Signature or X-Gitea-Signature, HMAC of the body", async () => {
  const row = (await one<{ hook_token: string }>("SELECT hook_token FROM issue_connections WHERE id=?", forgeConnection))!;
  const overview = (await issueSyncOverview(owner, wid)) as any;
  const secret = overview.connections.find((c: any) => c.id === forgeConnection).hookSecret;
  const sign = (text: string) => createHmac("sha256", secret).update(text).digest("hex");
  const payload = JSON.stringify({ action: "edited", repository: { full_name: "team/forge" }, issue: { number: 1 } });
  const forgejo = await receiveIssueWebhook(row.hook_token, new Headers({ "x-forgejo-event": "issues", "x-forgejo-signature": sign(payload) }), payload);
  assert.deepEqual(forgejo.pages, [forgePage]);
  const gitea = await receiveIssueWebhook(row.hook_token, new Headers({ "x-gitea-event": "issue_comment", "x-gitea-signature": sign(payload) }), payload);
  assert.deepEqual(gitea.pages, [forgePage]);
  const label = await receiveIssueWebhook(row.hook_token, new Headers({ "x-gitea-event": "issue_label", "x-gitea-signature": sign(payload) }), payload);
  assert.deepEqual(label.pages, [forgePage]);
  // Pushes and pull requests start nothing.
  const pushed = await receiveIssueWebhook(row.hook_token, new Headers({ "x-forgejo-event": "push", "x-forgejo-signature": sign(payload) }), payload);
  assert.deepEqual(pushed.pages, []);
  await assert.rejects(async () => await receiveIssueWebhook(row.hook_token, new Headers({ "x-forgejo-event": "issues", "x-forgejo-signature": sign(payload + " ") }), payload), /Signatur/);
  await assert.rejects(async () => await receiveIssueWebhook(row.hook_token, new Headers({ "x-forgejo-event": "issues" }), payload), /Signatur/);
  // GitHub's header (Forgejo sends it too) is not what a Forgejo connection checks.
  await assert.rejects(
    async () => await receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issues", "x-hub-signature-256": `sha256=${sign(payload)}` }), payload),
    /Signatur/,
  );
  const other = JSON.stringify({ repository: { full_name: "team/other" } });
  assert.deepEqual((await receiveIssueWebhook(row.hook_token, new Headers({ "x-forgejo-event": "issues", "x-forgejo-signature": sign(other) }), other)).pages, []);
});

test("Forgejo/Gitea: errors and rate limits", async () =>
  await withForgeHost(async () => {
    forge.next = { status: 429, headers: { "Retry-After": "90" }, body: "{}" };
    const limited = await syncIssues(forgePage);
    assert.equal(limited.ok, false);
    assert.match(String(limited.error), /begrenzt/);
    const state = JSON.parse((await one<{ state: string }>("SELECT state FROM issue_connections WHERE id=?", forgeConnection))!.state);
    assert.ok(state.backoffUntil > Date.now() + 60_000);
    forge.requests = [];
    assert.ok((await syncIssues(forgePage)).backoffUntil);
    assert.equal(forge.requests.length, 0);
    await run("UPDATE issue_connections SET state='{}' WHERE id=?", forgeConnection);
    for (const [status, message] of [
      [401, /lehnt das Token ab/],
      [403, /fehlt die Berechtigung/],
      [404, /nicht gefunden/],
      [500, /HTTP 500/],
    ] as const) {
      forge.next = { status, headers: {}, body: "{}" };
      const result = await syncIssues(forgePage);
      assert.equal(result.ok, false);
      assert.match(String(result.error), message);
      assert.match(String((await issueSyncDatabase(owner, forgePage)).map!.state.error), message);
    }
    // Not a listed server any more: the sync stops with a message.
    delete process.env.ISSUE_SYNC_ALLOWED_HOSTS;
    const refused = await syncIssues(forgePage);
    assert.match(String(refused.error), /nicht freigegeben/);
    process.env.ISSUE_SYNC_ALLOWED_HOSTS = FORGE_HOST;
    assert.equal((await syncIssues(forgePage)).ok, true);
  }));

test("Forgejo/Gitea: many changed issues – window by `before`, all pages, oldest change first", async () =>
  await withForgeHost(async () => {
    const big = new FakeForgejo("team/big");
    big.maxLimit = 20; // fewer per page than asked for: X-Total-Count decides
    setIssueSyncTransport(big.handle);
    for (let i = 1; i <= 230; i++) big.add({ title: `Issue ${i}`, pull: i % 25 === 0 });
    // Changed in another order than created.
    for (const i of [3, 1, 2]) big.issues[i - 1].updated = big.tick();
    const cid = (await act({ action: "issueSync.connect", workspaceId: wid, provider: "forgejo", baseUrl: `https://${FORGE_HOST}`, repo: "team/big", token: "fj_secret" })).id;
    const dbId = await makeDatabase("Big");
    await act({ action: "issueSync.map", pageId: dbId, connectionId: cid, config: config({ comments: { pull: false, push: false } }) });
    big.requests = [];
    const first = await syncIssues(dbId);
    assert.equal(first.ok, true, String(first.error));
    // 221 issues (9 pull requests); one run takes 200, the oldest changes.
    assert.equal(first.pulled, 200);
    assert.ok(big.requests.some((r) => /[?&]before=/.test(r.url)));
    const listed = big.requests.filter((r) => r.url.includes("/issues?") && !r.url.includes("limit=1&"));
    assert.ok(listed.length >= 10, `pages: ${listed.length}`);
    const titles = new Set((await rowsOf(dbId)).map((r) => JSON.parse(r.cells).title));
    assert.ok(titles.has("Issue 4") && !titles.has("Issue 1") && !titles.has("Issue 25"));
    const second = await syncIssues(dbId);
    assert.equal(second.pulled, 21);
    const all230 = (await rowsOf(dbId)).map((r) => JSON.parse(r.cells).title);
    assert.equal(all230.length, 221);
    assert.equal(new Set(all230).size, 221);
    assert.ok(!all230.some((t) => /^Issue (25|50|75|100|125|150|175|200|225)$/.test(t)));
    assert.equal((await syncIssues(dbId)).pulled, 0);

    // An older server: no X-Total-Count (the Link header leads), type=issues
    // ignored (pull_request marks them).
    const old = new FakeForgejo("team/old");
    old.totalHeader = false;
    old.honorType = false;
    old.maxLimit = 2;
    setIssueSyncTransport(old.handle);
    for (let i = 1; i <= 5; i++) old.add({ title: `Old ${i}`, pull: i === 2 });
    const oid = (await act({ action: "issueSync.connect", workspaceId: wid, provider: "forgejo", baseUrl: `https://${FORGE_HOST}`, repo: "team/old", token: "fj_secret" })).id;
    const oldDb = await makeDatabase("Old");
    await act({ action: "issueSync.map", pageId: oldDb, connectionId: oid, config: config({ comments: { pull: false, push: false } }) });
    const result = await syncIssues(oldDb);
    assert.equal(result.pulled, 4, String(result.error));
    assert.deepEqual((await rowsOf(oldDb)).map((r) => JSON.parse(r.cells).title).sort(), ["Old 1", "Old 3", "Old 4", "Old 5"]);
    setIssueSyncTransport(github.handle);
  }));
