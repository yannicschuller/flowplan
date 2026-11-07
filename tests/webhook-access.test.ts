// A workspace webhook speaks for the owner who set it up: it never carries
// another member's private space (records, pages, comments, the digest of
// due records), a webhook for one page needs a page its owner may read, and
// its signing secret and address are sealed at rest (older plain values
// are read and sealed once by schema 92).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-webhook-access-"));
process.env.APP_URL = "https://flowplan.example.test";
// Only so a 127.0.0.1 dummy target is accepted; nothing listens there.
process.env.FLOWPLAN_WEBHOOK_ALLOW_PRIVATE = "true";
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command, database: databaseOf } = await import("../lib/api");
const { createWebhook, updateWebhook, listWebhooks, processDigests } = await import("../lib/webhooks");
const { SEALED_SECRETS_MIGRATION } = await import("../lib/sealed-values");
const { runDataSteps } = await import("../lib/data-steps");
const { receiveGitWebhook, gitConfig } = await import("../lib/git-integration");

async function person(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const owner = await person("Owner"),
  ben = await person("Ben");
const wid = await createWorkspace(owner.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const team = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND visibility='team'", wid))!.id;
const benSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)", benSpace, wid, "Ben privat", "", "private", ben.id);

async function dueDatabase(space: string, title: string) {
  const pageId = await createPage(wid, space, ben.id, title, "database");
  await command(ben, {
    action: "database.update",
    pageId,
    version: (await databaseOf(pageId)).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
    ],
    views: (await databaseOf(pageId)).views,
  });
  return pageId;
}
const secretDb = await dueDatabase(benSpace, "Bens Gehaltsverhandlung");
const teamDb = await dueDatabase(team, "Team-Aufgaben");
const events = ["row.created", "row.updated", "page.created", "comment.created"];
const bodies = async (hookId: string) => (await all<{ body: string }>("SELECT body FROM webhook_deliveries WHERE webhook_id=?", hookId)).map((d) => d.body);

test("an owner's webhook gets nothing from another member's private space, but the team space", async () => {
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/hook", events });
  const row = ((await command(ben, { action: "row.create", pageId: secretDb, cells: { title: "SECRET-ROW salary 123456" } })) as { id: string }).id;
  const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", row))!.version;
  await command(ben, { action: "row.update", pageId: secretDb, rowId: row, version, cells: { title: "SECRET-ROW changed" } });
  await command(ben, { action: "page.create", workspaceId: wid, spaceId: benSpace, title: "SECRET-PAGE" });
  await command(ben, { action: "comment.create", pageId: secretDb, body: "SECRET-COMMENT" });
  assert.deepEqual(await bodies(hook.id), [], "nothing from Ben's private space");

  await command(ben, { action: "row.create", pageId: teamDb, cells: { title: "Team row" } });
  await command(ben, { action: "page.create", workspaceId: wid, spaceId: team, title: "Team page" });
  const sent = (await bodies(hook.id)).map((b) => JSON.parse(b) as { event: string });
  assert.deepEqual(sent.map((b) => b.event).sort(), ["page.created", "row.created"]);
  assert.ok(!(await bodies(hook.id)).some((b) => b.includes("SECRET")));
});

test("a webhook for one page needs a page its owner may read", async () => {
  await assert.rejects(
    createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/one", events, pageId: secretDb }),
    (e: { status?: number }) => e.status === 403,
  );
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/one", events, pageId: teamDb });
  await assert.rejects(
    updateWebhook(owner, { workspaceId: wid, id: hook.id, events, pageId: secretDb }),
    (e: { status?: number }) => e.status === 403,
  );
  // A page of another workspace is no page of this one.
  const other = await createWorkspace(owner.id, "Anderer");
  const otherSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", other))!.id;
  const foreign = await createPage(other, otherSpace, owner.id, "Fremd", "document");
  await assert.rejects(
    createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/one", events, pageId: foreign }),
    (e: { status?: number }) => e.status === 404,
  );
});

test("the digest of due records leaves out databases the owner cannot read", async () => {
  const today = new Date().toISOString().slice(0, 10);
  await command(ben, { action: "row.create", pageId: secretDb, cells: { title: "SECRET-DUE", due: today } });
  await command(ben, { action: "row.create", pageId: teamDb, cells: { title: "Team due", due: today } });
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/digest", events: ["digest.due"], config: { digestTime: "00:00", timeZone: "UTC" } });
  assert.ok((await processDigests()) >= 1);
  const [body] = await bodies(hook.id);
  const titles = (JSON.parse(body) as { data: { items: { title: string }[] } }).data.items.map((i) => i.title);
  assert.ok(titles.includes("Team due"));
  assert.ok(!titles.includes("SECRET-DUE"));
});

test("signing secret and address are sealed at rest and still sign deliveries", async () => {
  const url = "https://hooks.slack.example/services/T000/B000/XXXXSECRET";
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/sealed", events: ["row.created"] });
  await run("UPDATE webhooks SET format='slack' WHERE id=?", hook.id);
  await updateWebhook(owner, { workspaceId: wid, id: hook.id, url: url.replace("https://hooks.slack.example", "http://127.0.0.1:9"), events: ["row.created"], format: "slack" });
  const stored = (await one<{ url: string; secret: string }>("SELECT url,secret FROM webhooks WHERE id=?", hook.id))!;
  assert.ok(stored.url.startsWith("fps1:") && stored.secret.startsWith("fps1:"));
  assert.ok(!stored.url.includes("XXXXSECRET") && !stored.secret.includes(hook.secret));
  assert.equal((await listWebhooks(owner, wid)).find((h) => h.id === hook.id)!.url, "http://127.0.0.1:9/services/T000/B000/XXXXSECRET");
});

test("schema 92 seals plain secrets from before once; until then they are read as they are", async () => {
  // A webhook and a Git connection as an older version stored them.
  const hookId = id();
  await run(
    "INSERT INTO webhooks(id,workspace_id,url,events,page_id,secret,created_by,created_at,format,templates,config) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    hookId, wid, "http://127.0.0.1:9/legacy", JSON.stringify(["row.created"]), null, "legacy-secret-0123456789", owner.id, Date.now(), "json", "{}", "{}",
  );
  const gitToken = "legacyTokenLegacyToken0123456789",
    gitSecret = "legacySecretLegacySecret0123";
  const settings = JSON.parse((await one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", teamDb))!.settings || "{}");
  await run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify({ ...settings, git: { token: gitToken, secret: gitSecret, createdAt: "2026-01-01T00:00:00.000Z" } }), teamDb);
  assert.equal((await listWebhooks(owner, wid)).find((h) => h.id === hookId)!.url, "http://127.0.0.1:9/legacy");
  assert.equal((await gitConfig(owner, teamDb))!.secret, gitSecret);

  await run("DELETE FROM data_migrations WHERE name=?", SEALED_SECRETS_MIGRATION);
  await runDataSteps([SEALED_SECRETS_MIGRATION]);
  assert.ok(await one("SELECT 1 x FROM data_migrations WHERE name=?", SEALED_SECRETS_MIGRATION));
  const hook = (await one<{ url: string; secret: string }>("SELECT url,secret FROM webhooks WHERE id=?", hookId))!;
  assert.ok(hook.url.startsWith("fps1:") && hook.secret.startsWith("fps1:"));
  assert.equal((await listWebhooks(owner, wid)).find((h) => h.id === hookId)!.url, "http://127.0.0.1:9/legacy");
  const raw = (await one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", teamDb))!.settings;
  assert.ok(!raw.includes(gitToken) && !raw.includes(gitSecret), "no plain Git token or secret left");
  assert.equal((await gitConfig(owner, teamDb))!.token, gitToken);
  // The address with the old token still works, checked with the old secret.
  const body = JSON.stringify({ zen: "ok" });
  const signature = `sha256=${createHmac("sha256", gitSecret).update(body).digest("hex")}`;
  assert.deepEqual(await receiveGitWebhook(gitToken, new Headers({ "x-github-event": "ping", "x-hub-signature-256": signature }), body), { ok: true, linked: 0, closed: 0 });
  await assert.rejects(async () => await receiveGitWebhook("x".repeat(32), new Headers({ "x-github-event": "ping", "x-hub-signature-256": signature }), body), /Nicht gefunden/);
  // A new connection is sealed right away.
  const fresh = (await command(owner, { action: "git.setup", pageId: teamDb })) as { token: string; secret: string };
  const after = (await one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", teamDb))!.settings;
  assert.ok(!after.includes(fresh.token) && !after.includes(fresh.secret));
  await assert.rejects(async () => await receiveGitWebhook(gitToken, new Headers({ "x-github-event": "ping", "x-hub-signature-256": signature }), body), /Nicht gefunden/, "the old address ends");
});
