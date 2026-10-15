import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-mcp-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { handleMcpMessage, mcpToolNames } = await import("../lib/mcp");
import type { Identity } from "../lib/types";

function person(name: string, demoUntil: number | null = null) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email,demo_until) VALUES(?,?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`, demoUntil);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
function tokenFor(user: Identity, scope: "read" | "write") {
  const { token } = command(user, { action: "token.create", name: `MCP ${scope}`, scope }) as { token: string };
  return identityFromApiToken(`Bearer ${token}`)!;
}
let seq = 0;
async function rpc(user: Identity, method: string, params: Record<string, unknown> = {}) {
  return (await handleMcpMessage(user, { jsonrpc: "2.0", id: ++seq, method, params })) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}
async function call(user: Identity, name: string, args: Record<string, unknown>) {
  const answer = await rpc(user, "tools/call", { name, arguments: args });
  const result = answer.result as { content: { text: string }[]; isError?: boolean };
  return { error: !!result.isError, text: result.content[0].text };
}

const ana = person("Ana"),
  ben = person("Ben");
const wid = createWorkspace(ana.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const teamSpace = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
// Ana's private space: Ben is a member of the workspace but must not see it.
const privateSpace = id();
run(
  "INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)",
  privateSpace,
  wid,
  "Privat",
  "",
  "private",
  ana.id,
);
const secret = createPage(wid, privateSpace, ana.id, "Geheime Notizen");
const notes = createPage(wid, teamSpace, ana.id, "Team-Notizen");
const tasksDb = createPage(wid, teamSpace, ana.id, "Aufgaben", "database");
const anaWrite = tokenFor(ana, "write"),
  benWrite = tokenFor(ben, "write"),
  benRead = tokenFor(ben, "read");

test("initialize answers with the protocol version and the server", async () => {
  const answer = await rpc(benRead, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(answer.result!.protocolVersion, "2025-06-18");
  assert.equal((answer.result!.serverInfo as { name: string }).name, "flowplan");
  assert.equal(await handleMcpMessage(benRead, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await rpc(benRead, "unknown/method")).error!.code, -32601);
});

test("only personal API tokens reach MCP; demo accounts get none", async () => {
  // A browser session (cookie) has no token scope and is refused.
  await assert.rejects(() => handleMcpMessage(ben, { jsonrpc: "2.0", id: 1, method: "tools/list" }), /API token/);
  const demo = person("Demo", Date.now() + 3600_000);
  assert.equal(demo.demo, true);
  assert.throws(() => command(demo, { action: "token.create", name: "x", scope: "write" }), /Demo/);
  // Even a token row written behind the app's back does not sign a demo in.
  const raw = `fp_${randomBytes(30).toString("base64url")}`;
  run(
    "INSERT INTO api_tokens(id,user_id,name,scope,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?,?)",
    id(),
    demo.id,
    "x",
    "write",
    createHash("sha256").update(raw).digest("hex"),
    raw.slice(0, 10),
    Date.now(),
  );
  assert.equal(identityFromApiToken(`Bearer ${raw}`), null);
  await assert.rejects(() => handleMcpMessage({ ...demo, apiScope: "write" }, { jsonrpc: "2.0", id: 1, method: "tools/list" }), /API token/);
});

test("another person's private page stays invisible", async () => {
  const listed = await call(benWrite, "list_pages", { workspaceId: wid });
  assert.equal(listed.text.includes(secret), false);
  assert.ok(listed.text.includes(notes));
  const spaces = await call(benWrite, "list_workspaces", {});
  assert.equal(spaces.text.includes(privateSpace), false);
  const read = await call(benWrite, "read_page", { pageId: secret });
  assert.equal(read.error, true);
  assert.match(read.text, /Keine Berechtigung|permission/i);
  const append = await call(benWrite, "append_to_page", { pageId: secret, markdown: "Ben war hier" });
  assert.equal(append.error, true);
  const created = await call(benWrite, "create_page", { workspaceId: wid, spaceId: privateSpace, title: "Eindringling" });
  assert.equal(created.error, true);
  assert.equal(one("SELECT 1 FROM pages WHERE title='Eindringling'"), undefined);
  const resource = await rpc(benWrite, "resources/read", { uri: `flowplan://page/${secret}` });
  assert.ok(resource.error);
  // Ana herself reads it.
  assert.equal((await call(anaWrite, "read_page", { pageId: secret })).text.includes("Geheime Notizen"), true);
});

test("a workspace the person is not in is refused", async () => {
  const other = createWorkspace(ana.id, "Nur Ana");
  const answer = await call(benWrite, "search", { workspaceId: other, query: "Notizen" });
  assert.equal(answer.error, true);
  const listed = await call(benWrite, "list_pages", { workspaceId: other });
  assert.equal(listed.error, true);
});

test("read tokens only see and use read tools", async () => {
  const names = mcpToolNames(benRead);
  assert.ok(names.includes("read_page"));
  for (const name of ["create_page", "append_to_page", "create_record", "update_record"]) assert.equal(names.includes(name), false);
  const listed = (await rpc(benRead, "tools/list")).result!.tools as { name: string }[];
  assert.equal(listed.some((t) => t.name === "append_to_page"), false);
  const before = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", notes)!.html;
  const write = await call(benRead, "append_to_page", { pageId: notes, markdown: "Darf nicht" });
  assert.equal(write.error, true);
  assert.match(write.text, /only read/);
  assert.equal(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", notes)!.html, before);
  assert.equal((await call(benRead, "create_record", { databaseId: tasksDb, properties: { Name: "x" } })).error, true);
  assert.equal(Number(one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", tasksDb)!.n), 0);
});

test("write tools go through the same commands as the interface", async () => {
  const appended = await call(benWrite, "append_to_page", { pageId: notes, markdown: "## Protokoll\n\n- [ ] Angebot schicken\n- Punkt **zwei**" });
  assert.equal(appended.error, false, appended.text);
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", notes)!.html;
  assert.match(html, /<h2[^>]*>Protokoll<\/h2>/);
  assert.match(html, /data-type="taskItem"/);
  // Counted as Ben's edit, as in the editor (activity, followers).
  assert.ok(one("SELECT 1 FROM page_edits WHERE page_id=? AND user_id=?", notes, ben.id));
  const read = await call(benWrite, "read_page", { pageId: notes });
  assert.match(read.text, /## Protokoll/);
  // Raw HTML in Markdown stays text.
  await call(benWrite, "append_to_page", { pageId: notes, markdown: '<img src=x onerror="alert(1)">' });
  assert.equal(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", notes)!.html.match(/<img[^>]*onerror/), null);

  const page = JSON.parse((await call(benWrite, "create_page", { workspaceId: wid, spaceId: teamSpace, title: "Von Claude", markdown: "Hallo **Welt**" })).text);
  assert.equal(one<{ created_by: string }>("SELECT created_by FROM pages WHERE id=?", page.id)!.created_by, ben.id);
  assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id)!.html, /<strong>Welt<\/strong>/);

  const schema = JSON.parse((await call(benWrite, "query_database", { databaseId: tasksDb })).text);
  const titleField = schema.fields[0].name as string;
  const record = JSON.parse((await call(benWrite, "create_record", { databaseId: tasksDb, properties: { [titleField]: "Per MCP" } })).text);
  assert.equal(one<{ created_by: string }>("SELECT created_by FROM rows WHERE id=?", record.id)!.created_by, ben.id);
  const updated = await call(benWrite, "update_record", { databaseId: tasksDb, recordId: record.id, properties: { [titleField]: "Geändert" } });
  assert.equal(updated.error, false, updated.text);
  const got = JSON.parse((await call(benWrite, "get_record", { databaseId: tasksDb, recordId: record.id })).text);
  assert.equal(got.title, "Geändert");
  const unknown = await call(benWrite, "create_record", { databaseId: tasksDb, properties: { Gibtsnicht: 1 } });
  assert.equal(unknown.error, true);
  const stale = await call(benWrite, "update_record", { databaseId: tasksDb, recordId: record.id, version: 0, properties: { [titleField]: "Alt" } });
  assert.equal(stale.error, true);
});

test("private records of others stay hidden in database queries", async () => {
  const { id: rid } = command(ana, { action: "row.create", pageId: tasksDb, cells: { title: "Anas Privatsache" } }) as { id: string };
  run("UPDATE rows SET access='private' WHERE id=?", rid);
  const listed = await call(benWrite, "query_database", { databaseId: tasksDb });
  assert.equal(listed.text.includes("Anas Privatsache"), false);
  assert.equal((await call(benWrite, "get_record", { databaseId: tasksDb, recordId: rid })).error, true);
  assert.equal((await call(benWrite, "update_record", { databaseId: tasksDb, recordId: rid, properties: { title: "x" } })).error, true);
  assert.ok((await call(anaWrite, "query_database", { databaseId: tasksDb })).text.includes("Anas Privatsache"));
});

test("invalid arguments are tool errors, not crashes", async () => {
  const answer = await call(benWrite, "read_page", { pageId: "not-a-uuid" });
  assert.equal(answer.error, true);
  assert.match(answer.text, /Invalid arguments/);
  assert.equal((await rpc(benWrite, "tools/call", { name: "drop_everything", arguments: {} })).error!.code, -32602);
});
