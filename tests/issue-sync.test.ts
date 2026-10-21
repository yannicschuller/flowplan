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

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
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

const owner = user("ada"),
  editor = user("bo"),
  other = user("cy");
const wid = createWorkspace(owner.id, "Dev"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, other.id, "editor");
const act = (body: Record<string, unknown>, who: Identity = owner): any => command(who, body);
function makeDatabase(title: string) {
  const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title }).id as string;
  act({
    action: "database.update",
    pageId,
    version: database(pageId).version,
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
    views: database(pageId).views,
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
const cells = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells);
const rowsOf = (pageId: string) => all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=? ORDER BY position", pageId);
const rowByTitle = (pageId: string, title: string) => rowsOf(pageId).find((r) => JSON.parse(r.cells).title === title)!.id;
const version = (rid: string) => one<{ version: number }>("SELECT version FROM rows WHERE id=?", rid)!.version;
const update = (pageId: string, rid: string, patch: Record<string, unknown>, who = owner) => act({ action: "row.update", pageId, rowId: rid, version: version(rid), cells: patch }, who);

const github = new FakeProvider("github", "acme/web");
setIssueSyncTransport(github.handle);
const pageId = makeDatabase("Web");
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
  assert.throws(() => act({ action: "issueSync.connect", workspaceId: wid, provider: "github", repo: "acme/web", token: "ghp_x" }, editor), /Eigentümer/);
  connectionId = act({
    action: "issueSync.connect",
    workspaceId: wid,
    provider: "github",
    repo: "acme/web",
    token: "ghp_secret",
    people: [{ login: "Ada-gh", email: owner.email }],
  }).id;
  const stored = one<{ token: string }>("SELECT token FROM issue_connections WHERE id=?", connectionId)!;
  assert.ok(!stored.token.includes("ghp_secret"));
  assert.equal(issueSyncOverview(editor, wid).available, false);
  const overview = issueSyncOverview(owner, wid);
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
  assert.throws(() => act({ action: "issueSync.map", pageId, connectionId, config: { ...config(), labels: "status" } }), /passt nicht|nur einmal/);
  act({ action: "issueSync.map", pageId, connectionId, config: config() });
  const result = await syncIssues(pageId);
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 3);
  const login = cells(rowByTitle(pageId, "Login broken"));
  assert.equal(login.status, "Todo");
  assert.deepEqual(login.tags, ["bug"]);
  assert.equal(login.owner, owner.id);
  assert.equal(login.notes, "Steps **here**");
  assert.equal(login.num, 1);
  assert.equal(login.link, "https://github.com/acme/web/issues/1");
  const dark = cells(rowByTitle(pageId, "Dark mode"));
  assert.equal(dark.status, "Doing");
  assert.deepEqual(dark.tags, ["feature"]);
  assert.equal(dark.due, "2026-12-01");
  const old = rowByTitle(pageId, "Old thing");
  assert.equal(cells(old).status, "Done");
  const comments = all<{ body: string; author_id: string }>("SELECT body,author_id FROM comments WHERE row_id=?", old);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Fixed in 1\.2[\s\S]*zoe \(GitHub\) https:\/\/github\.com/);
  assert.equal(comments[0].author_id, owner.id);
  assert.equal(issueLinkOf(owner, pageId, old)!.label, "GitHub #3");
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
  const row = cells(rowByTitle(pageId, "Login broken on Safari"));
  assert.equal(row.status, "Done");
  assert.equal(issueSyncDatabase(owner, pageId).map!.state.pulled, 1);
});

test("push: record changes update the issue, new records create issues", async () => {
  const rid = rowByTitle(pageId, "Dark mode");
  update(pageId, rid, { status: "Done", tags: ["feature", "bug"], owner: "" });
  assert.ok(one("SELECT 1 FROM issue_sync_queue WHERE row_id=?", rid));
  github.requests = [];
  const result = await syncIssues(pageId, { pushOnly: true });
  assert.equal(result.pushed, 1);
  const patch = github.requests.find((r) => r.method === "PATCH")!;
  const body = JSON.parse(patch.body!);
  assert.equal(body.state, "closed");
  assert.deepEqual(body.labels, ["bug", "feature"]);
  assert.deepEqual(body.assignees, []);
  assert.equal(github.issues[1].state, "closed");
  assert.ok(!one("SELECT 1 FROM issue_sync_queue WHERE row_id=?", rid));

  const fresh = act({ action: "row.create", pageId, cells: { title: "From Flowplan", status: "Doing", owner: owner.id, due: "2026-12-01", notes: "Body" } }).id;
  await syncIssues(pageId, { pushOnly: true });
  const created = github.issues.find((i) => i.title === "From Flowplan")!;
  assert.deepEqual(created.labels, ["in progress"]);
  assert.deepEqual(created.assignees, ["Ada-gh"]);
  assert.equal(created.milestone, 4);
  assert.equal(created.body, "Body");
  assert.equal(cells(fresh).num, created.number);
  assert.equal(cells(fresh).link, `https://github.com/acme/web/issues/${created.number}`);
  // The pull after the push sees its own change and leaves the record alone.
  const before = version(fresh);
  await syncIssues(pageId);
  assert.equal(version(fresh), before);
});

test("comments both ways", async () => {
  const rid = rowByTitle(pageId, "From Flowplan");
  act({ action: "comment.create", pageId, rowId: rid, body: "Looks good" }, editor);
  github.requests = [];
  await syncIssues(pageId, { pushOnly: true });
  const posted = github.requests.find((r) => r.method === "POST" && r.url.endsWith("/comments"))!;
  assert.match(JSON.parse(posted.body!).body, /\*\*bo\*\* \(Flowplan\):\n\nLooks good/);
  // The pushed comment does not come back as a second comment.
  const issue = github.issues.find((i) => i.title === "From Flowplan")!;
  issue.comments.push({ id: 9, author: "dev", body: "Thanks" });
  issue.updated = github.tick();
  await syncIssues(pageId);
  const bodies = all<{ body: string }>("SELECT body FROM comments WHERE row_id=? ORDER BY created_at", rid).map((c) => c.body);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /^Thanks/);
});

test("conflicts: the later change wins, with an audit line", async () => {
  const rid = rowByTitle(pageId, "Login broken on Safari");
  const issue = github.issues[0];
  // Local change now, remote change later (in the future): remote wins.
  update(pageId, rid, { title: "Local title" });
  issue.title = "Remote title";
  issue.updated = Date.now() + 3_600_000;
  await syncIssues(pageId);
  assert.equal(cells(rid).title, "Remote title");
  const audits = all<{ detail: string }>("SELECT detail FROM audit WHERE action='issueSync.conflict' AND resource_id=?", rid);
  assert.match(audits.at(-1)!.detail, /#1: remote/);
  // Remote change long ago (but after the last sync), local change now: local wins.
  const lines = audits.length;
  update(pageId, rid, { title: "Local wins" });
  issue.title = "Stale remote";
  issue.updated = issue.updated + 1000;
  const link = one<{ remote_updated: number }>("SELECT remote_updated FROM issue_links WHERE row_id=?", rid)!;
  run("UPDATE issue_links SET remote_updated=? WHERE row_id=?", link.remote_updated - 10_000_000_000, rid);
  run("UPDATE rows SET updated_at='2099-01-01 00:00:00' WHERE id=?", rid);
  await syncIssues(pageId);
  assert.equal(cells(rid).title, "Local wins");
  assert.equal(issue.title, "Local wins");
  const after = all<{ detail: string }>("SELECT detail FROM audit WHERE action='issueSync.conflict' AND resource_id=?", rid);
  assert.equal(after.length, lines + 1);
  assert.match(after.at(-1)!.detail, /local/);
});

test("records the connecting person may not read are skipped", async () => {
  const rid = act({ action: "row.create", pageId, cells: { title: "Private plan" } }, other).id;
  run("UPDATE rows SET access='private' WHERE id=?", rid);
  // The owner sees everything; with an editor grant on the page, not this.
  run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,NULL,'editor')", pageId, owner.id);
  try {
    const result = await syncIssues(pageId, { scan: true });
    assert.ok((result.skipped || 0) >= 1);
    assert.ok(!github.issues.some((i) => i.title === "Private plan"));
  } finally {
    run("DELETE FROM grants WHERE resource_id=? AND user_id=?", pageId, owner.id);
    run("DELETE FROM rows WHERE id=?", rid);
  }
});

test("webhooks: signature checked, the matching database is named", () => {
  const row = one<{ hook_token: string }>("SELECT hook_token FROM issue_connections WHERE id=?", connectionId)!;
  const secret = issueSyncOverview(owner, wid).available ? (issueSyncOverview(owner, wid) as any).connections[0].hookSecret : "";
  const payload = JSON.stringify({ action: "edited", repository: { full_name: "acme/web" }, issue: { number: 1 } });
  const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  assert.throws(() => receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issues", "x-hub-signature-256": "sha256=00" }), payload), /Signatur/);
  assert.throws(() => receiveIssueWebhook("unknown-token-unknown-token", new Headers(), payload), /Nicht gefunden/);
  const result = receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issues", "x-hub-signature-256": signature }), payload);
  assert.deepEqual(result.pages, [pageId]);
  const comment = JSON.stringify({ repository: { full_name: "acme/other" } });
  const other = receiveIssueWebhook(row.hook_token, new Headers({ "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(comment).digest("hex")}` }), comment);
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
  const state = JSON.parse(one<{ state: string }>("SELECT state FROM issue_connections WHERE id=?", connectionId)!.state);
  assert.ok(state.backoffUntil > Date.now() + 100_000);
  github.requests = [];
  const paused = await syncIssues(pageId);
  assert.ok(paused.backoffUntil);
  assert.equal(github.requests.length, 0);
  run("UPDATE issue_connections SET state='{}' WHERE id=?", connectionId);
});

test("GitLab: closed state, usernames, labels and state events", async () => {
  const gitlab = new FakeProvider("gitlab", "team/app");
  setIssueSyncTransport(gitlab.handle);
  const gid = act({ action: "issueSync.connect", workspaceId: wid, provider: "gitlab", repo: "team/app", token: "glpat", people: [{ login: "bo", email: editor.email }] }).id;
  const lab = makeDatabase("App");
  gitlab.add({ title: "Crash", state: "closed", assignees: ["bo"], labels: ["bug"] });
  act({ action: "issueSync.map", pageId: lab, connectionId: gid, config: config({ comments: { pull: false, push: false } }) });
  await syncIssues(lab);
  const rid = rowByTitle(lab, "Crash");
  assert.equal(cells(rid).status, "Done");
  assert.equal(cells(rid).owner, editor.id);
  assert.equal(cells(rid).link, "https://gitlab.com/team/app/-/issues/1");
  assert.equal(gitlab.requests[0].headers["private-token"], "glpat");
  update(lab, rid, { status: "Doing" });
  gitlab.requests = [];
  await syncIssues(lab, { pushOnly: true });
  const put = gitlab.requests.find((r) => r.method === "PUT")!;
  const body = JSON.parse(put.body!);
  assert.equal(body.state_event, "reopen");
  assert.equal(body.labels, "bug,in progress");
  assert.deepEqual(body.assignee_ids, [77]);
  assert.equal(gitlab.issues[0].state, "open");
  // The same repository cannot feed a second database.
  const third = makeDatabase("Again");
  assert.throws(() => act({ action: "issueSync.map", pageId: third, connectionId: gid, config: config() }), /schon mit einer anderen Datenbank/);
  act({ action: "issueSync.unmap", pageId: lab });
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM issue_links WHERE page_id=?", lab)!.n, 0);
  setIssueSyncTransport(github.handle);
});

test("the record's document as Markdown body", async () => {
  const docs = new FakeProvider("github", "acme/docs");
  setIssueSyncTransport(docs.handle);
  const did = act({ action: "issueSync.connect", workspaceId: wid, provider: "github", repo: "acme/docs", token: "ghp_docs" }).id;
  const dbId = makeDatabase("Docs");
  docs.add({ title: "Spec", body: "## Goal\n\nShip **it**" });
  act({ action: "issueSync.map", pageId: dbId, connectionId: did, config: config({ body: "@document", status: null, labels: "", assignee: "", milestone: "" }) });
  await syncIssues(dbId);
  const rid = rowByTitle(dbId, "Spec");
  const html = one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rid)!.html;
  assert.match(html, /<h2[^>]*>Goal<\/h2>/);
  assert.match(html, /<strong>it<\/strong>/);
  const { replaceRowDocument } = await import("../lib/row-documents");
  replaceRowDocument(rid, "<h2>Goal</h2><p>Ship <em>soon</em></p>", owner.id);
  run("UPDATE rows SET updated_at='2099-01-01 00:00:00' WHERE id=?", rid);
  docs.requests = [];
  await syncIssues(dbId, { scan: true });
  const patch = docs.requests.find((r) => r.method === "PATCH")!;
  assert.match(JSON.parse(patch.body!).body, /## Goal\s+Ship (\*soon\*|_soon_)/);
  setIssueSyncTransport(github.handle);
});
