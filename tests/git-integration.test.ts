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

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  viewer = await user("viewer");
const wid = await createWorkspace(owner.id, "Dev"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title: "Web" })).id as string;
await act({
  action: "database.update",
  pageId,
  version: (await database(pageId)).version,
  fields: [
    { id: "title", name: "Title", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
    { id: "key", name: "ID", type: "id", prefix: "WEB" },
  ],
  views: (await database(pageId)).views,
});
const a = (await act({ action: "row.create", pageId, cells: { title: "Login", status: "Open" } })).id;
const b = (await act({ action: "row.create", pageId, cells: { title: "Logout", status: "Open" } })).id;
const { token, secret } = await act({ action: "git.setup", pageId });
const status = async (rid: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid))!.cells).status;
const send = async (headers: Record<string, string>, payload: unknown) => {
  const body = JSON.stringify(payload);
  return await transaction(async () => await receiveGitWebhook(token, new Headers(headers), body));
};
const sign = (body: unknown) => createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");

test("the secret stays with editors", async () => {
  assert.equal((await database(pageId)).settings!.git!.secret, "");
  await assert.rejects(async () => await gitConfig(viewer, pageId));
  assert.equal((await gitConfig(owner, pageId))!.secret, secret);
});

test("GitHub: commits link records; closing on the default branch", async () => {
  const push = {
    ref: "refs/heads/main",
    repository: { default_branch: "main" },
    commits: [{ id: "abc1234def", message: "Fix login, closes WEB-1\n\nAlso touches WEB-2", url: "https://github.com/x/y/commit/abc", author: { name: "Ada" } }],
  };
  await assert.rejects(async () => await send({ "x-github-event": "push", "x-hub-signature-256": "sha256=bad" }, push), /Signatur/);
  const result = await send({ "x-github-event": "push", "x-hub-signature-256": `sha256=${sign(push)}` }, push);
  assert.deepEqual([result.linked, result.closed], [2, 1]);
  assert.equal(await status(a), "Done");
  assert.equal(await status(b), "Open");
  assert.equal((await gitLinks(owner, pageId, b))[0].author, "Ada");
});

test("GitLab and Gitea pull requests close when merged", async () => {
  const mr = { object_attributes: { iid: 7, title: "Resolves WEB-2", description: "", url: "https://gitlab.com/x/-/merge_requests/7", state: "opened" }, user: { name: "Bo" } };
  await send({ "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret }, mr);
  assert.equal(await status(b), "Open");
  const merged = { ...mr, object_attributes: { ...mr.object_attributes, state: "merged", action: "merge" } };
  await send({ "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret }, merged);
  assert.equal(await status(b), "Done");
  assert.equal((await gitLinks(owner, pageId, b)).filter((l) => l.kind === "pr").length, 1);
  const pr = { pull_request: { number: 3, title: "WEB-1 follow-up", body: "", html_url: "https://gitea.example/x/pulls/3", merged: false, state: "open", user: { login: "cy" } } };
  assert.equal((await send({ "x-gitea-event": "pull_request", "x-gitea-signature": sign(pr) }, pr)).linked, 1);
  await assert.rejects(async () => await send({ "x-gitlab-event": "Push Hook", "x-gitlab-token": "wrong" }, {}), /Signatur/);
});
