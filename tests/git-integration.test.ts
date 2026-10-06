import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-git-"));
const { id, run, one, transaction } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { receiveGitWebhook, gitLinks, gitConfig } = await import("../lib/git-integration");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  viewer = user("viewer");
const wid = createWorkspace(owner.id, "Dev"),
  boot = bootstrap(owner, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = (body: Record<string, unknown>): any => command(owner, body);
const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Web" }).id as string;
act({
  action: "database.update",
  pageId,
  version: database(pageId).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
    { id: "key", name: "ID", type: "id", prefix: "WEB" },
  ],
  views: database(pageId).views,
});
const a = act({ action: "row.create", pageId, cells: { title: "Login", status: "Open" } }).id;
const b = act({ action: "row.create", pageId, cells: { title: "Logout", status: "Open" } }).id;
const { token, secret } = act({ action: "git.setup", pageId });
const status = (rid: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid)!.cells).status;
const send = (headers: Record<string, string>, payload: unknown) => {
  const body = JSON.stringify(payload);
  return transaction(() => receiveGitWebhook(token, new Headers(headers), body));
};
const sign = (body: unknown) => createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");

test("the secret stays with editors", () => {
  assert.equal(database(pageId).settings!.git!.secret, "");
  assert.throws(() => gitConfig(viewer, pageId));
  assert.equal(gitConfig(owner, pageId)!.secret, secret);
});

test("GitHub: commits link records; closing on the default branch", () => {
  const push = {
    ref: "refs/heads/main",
    repository: { default_branch: "main" },
    commits: [{ id: "abc1234def", message: "Fix login, closes WEB-1\n\nAlso touches WEB-2", url: "https://github.com/x/y/commit/abc", author: { name: "Ada" } }],
  };
  assert.throws(() => send({ "x-github-event": "push", "x-hub-signature-256": "sha256=bad" }, push), /Signatur/);
  const result = send({ "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(push)}` }, push);
  assert.deepEqual([result.linked, result.closed], [2, 1]);
  assert.equal(status(a), "Done");
  assert.equal(status(b), "Open");
  assert.equal(gitLinks(owner, pageId, b)[0].author, "Ada");
});

test("GitLab and Gitea pull requests close when merged", () => {
  const mr = { object_attributes: { iid: 7, title: "Resolves WEB-2", description: "", url: "https://gitlab.com/x/-/merge_requests/7", state: "opened" }, user: { name: "Bo" } };
  send({ "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret }, mr);
  assert.equal(status(b), "Open");
  const merged = { ...mr, object_attributes: { ...mr.object_attributes, state: "merged", action: "merge" } };
  send({ "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret }, merged);
  assert.equal(status(b), "Done");
  assert.equal(gitLinks(owner, pageId, b).filter((l) => l.kind === "pr").length, 1);
  const pr = { pull_request: { number: 3, title: "WEB-1 follow-up", body: "", html_url: "https://gitea.example/x/pulls/3", merged: false, state: "open", user: { login: "cy" } } };
  assert.equal(send({ "x-gitea-event": "pull_request", "x-gitea-signature": sign(pr) }, pr).linked, 1);
  assert.throws(() => send({ "x-gitlab-event": "Push Hook", "x-gitlab-token": "wrong" }, {}), /Signatur/);
});
