// A workspace webhook speaks for the owner who set it up: it never carries
// another member's private space (records, pages, comments, the digest of
// due records), a webhook for one page needs a page its owner may read, and
// its signing secret and address are sealed at rest (older plain values
// are read and sealed once by schema 92).
import { sqliteOnly } from "./helpers/backend";
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
const { run, one, all, id, db: database } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command, database: databaseOf } = await import("../lib/api");
const { createWebhook, updateWebhook, listWebhooks, processDigests } = await import("../lib/webhooks");
const { migrateSealedSecrets, SEALED_SECRETS_MIGRATION } = await import("../lib/sealed-values");
const { receiveGitWebhook, gitConfig } = await import("../lib/git-integration");

async function person(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const owner = await person("Owner"),
  ben = await person("Ben");
const wid = createWorkspace(owner.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const team = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? AND visibility='team'", wid)!.id;
const benSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)", benSpace, wid, "Ben privat", "", "private", ben.id);

function dueDatabase(space: string, title: string) {
  const pageId = createPage(wid, space, ben.id, title, "database");
  command(ben, {
    action: "database.update",
    pageId,
    version: databaseOf(pageId).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
    ],
    views: databaseOf(pageId).views,
  });
  return pageId;
}
const secretDb = dueDatabase(benSpace, "Bens Gehaltsverhandlung");
const teamDb = dueDatabase(team, "Team-Aufgaben");
const events = ["row.created", "row.updated", "page.created", "comment.created"];
const bodies = (hookId: string) => all<{ body: string }>("SELECT body FROM webhook_deliveries WHERE webhook_id=?", hookId).map((d) => d.body);

test("an owner's webhook gets nothing from another member's private space, but the team space", async () => {
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/hook", events });
  const row = (command(ben, { action: "row.create", pageId: secretDb, cells: { title: "SECRET-ROW salary 123456" } }) as { id: string }).id;
  const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", row)!.version;
  command(ben, { action: "row.update", pageId: secretDb, rowId: row, version, cells: { title: "SECRET-ROW changed" } });
  command(ben, { action: "page.create", workspaceId: wid, spaceId: benSpace, title: "SECRET-PAGE" });
  command(ben, { action: "comment.create", pageId: secretDb, body: "SECRET-COMMENT" });
  assert.deepEqual(bodies(hook.id), [], "nothing from Ben's private space");

  command(ben, { action: "row.create", pageId: teamDb, cells: { title: "Team row" } });
  command(ben, { action: "page.create", workspaceId: wid, spaceId: team, title: "Team page" });
  const sent = bodies(hook.id).map((b) => JSON.parse(b) as { event: string });
  assert.deepEqual(sent.map((b) => b.event).sort(), ["page.created", "row.created"]);
  assert.ok(!bodies(hook.id).some((b) => b.includes("SECRET")));
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
  const other = createWorkspace(owner.id, "Anderer");
  const otherSpace = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", other)!.id;
  const foreign = createPage(other, otherSpace, owner.id, "Fremd", "document");
  await assert.rejects(
    createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/one", events, pageId: foreign }),
    (e: { status?: number }) => e.status === 404,
  );
});

test("the digest of due records leaves out databases the owner cannot read", async () => {
  const today = new Date().toISOString().slice(0, 10);
  command(ben, { action: "row.create", pageId: secretDb, cells: { title: "SECRET-DUE", due: today } });
  command(ben, { action: "row.create", pageId: teamDb, cells: { title: "Team due", due: today } });
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/digest", events: ["digest.due"], config: { digestTime: "00:00", timeZone: "UTC" } });
  assert.ok(processDigests() >= 1);
  const [body] = bodies(hook.id);
  const titles = (JSON.parse(body) as { data: { items: { title: string }[] } }).data.items.map((i) => i.title);
  assert.ok(titles.includes("Team due"));
  assert.ok(!titles.includes("SECRET-DUE"));
});

test("signing secret and address are sealed at rest and still sign deliveries", async () => {
  const url = "https://hooks.slack.example/services/T000/B000/XXXXSECRET";
  const hook = await createWebhook(owner, { workspaceId: wid, url: "http://127.0.0.1:9/sealed", events: ["row.created"] });
  run("UPDATE webhooks SET format='slack' WHERE id=?", hook.id);
  await updateWebhook(owner, { workspaceId: wid, id: hook.id, url: url.replace("https://hooks.slack.example", "http://127.0.0.1:9"), events: ["row.created"], format: "slack" });
  const stored = one<{ url: string; secret: string }>("SELECT url,secret FROM webhooks WHERE id=?", hook.id)!;
  assert.ok(stored.url.startsWith("fps1:") && stored.secret.startsWith("fps1:"));
  assert.ok(!stored.url.includes("XXXXSECRET") && !stored.secret.includes(hook.secret));
  assert.equal(listWebhooks(owner, wid).find((h) => h.id === hook.id)!.url, "http://127.0.0.1:9/services/T000/B000/XXXXSECRET");
});

test("schema 92 seals plain secrets from before once; until then they are read as they are", { skip: sqliteOnly }, async () => {
  // A webhook and a Git connection as an older version stored them.
  const hookId = id();
  run(
    "INSERT INTO webhooks(id,workspace_id,url,events,page_id,secret,created_by,created_at,format,templates,config) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    hookId, wid, "http://127.0.0.1:9/legacy", JSON.stringify(["row.created"]), null, "legacy-secret-0123456789", owner.id, Date.now(), "json", "{}", "{}",
  );
  const gitToken = "legacyTokenLegacyToken0123456789",
    gitSecret = "legacySecretLegacySecret0123";
  const settings = JSON.parse(one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", teamDb)!.settings || "{}");
  run("UPDATE databases SET settings=? WHERE page_id=?", JSON.stringify({ ...settings, git: { token: gitToken, secret: gitSecret, createdAt: "2026-01-01T00:00:00.000Z" } }), teamDb);
  assert.equal(listWebhooks(owner, wid).find((h) => h.id === hookId)!.url, "http://127.0.0.1:9/legacy");
  assert.equal(gitConfig(owner, teamDb)!.secret, gitSecret);

  run("DELETE FROM data_migrations WHERE name=?", SEALED_SECRETS_MIGRATION);
  migrateSealedSecrets(database());
  assert.ok(one("SELECT 1 x FROM data_migrations WHERE name=?", SEALED_SECRETS_MIGRATION));
  const hook = one<{ url: string; secret: string }>("SELECT url,secret FROM webhooks WHERE id=?", hookId)!;
  assert.ok(hook.url.startsWith("fps1:") && hook.secret.startsWith("fps1:"));
  assert.equal(listWebhooks(owner, wid).find((h) => h.id === hookId)!.url, "http://127.0.0.1:9/legacy");
  const raw = one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", teamDb)!.settings;
  assert.ok(!raw.includes(gitToken) && !raw.includes(gitSecret), "no plain Git token or secret left");
  assert.equal(gitConfig(owner, teamDb)!.token, gitToken);
  // The address with the old token still works, checked with the old secret.
  const body = JSON.stringify({ zen: "ok" });
  const signature = `sha256=${createHmac("sha256", gitSecret).update(body).digest("hex")}`;
  assert.deepEqual(receiveGitWebhook(gitToken, new Headers({ "x-github-event": "ping", "x-hub-signature-256": signature }), body), { ok: true, linked: 0, closed: 0 });
  assert.throws(() => receiveGitWebhook("x".repeat(32), new Headers({ "x-github-event": "ping", "x-hub-signature-256": signature }), body), /Nicht gefunden/);
  // A new connection is sealed right away.
  const fresh = command(owner, { action: "git.setup", pageId: teamDb }) as { token: string; secret: string };
  const after = one<{ settings: string }>("SELECT settings FROM databases WHERE page_id=?", teamDb)!.settings;
  assert.ok(!after.includes(fresh.token) && !after.includes(fresh.secret));
  assert.throws(() => receiveGitWebhook(gitToken, new Headers({ "x-github-event": "ping", "x-hub-signature-256": signature }), body), /Nicht gefunden/, "the old address ends");
});
