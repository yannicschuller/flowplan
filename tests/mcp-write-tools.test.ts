// The MCP tools that change existing content: update_page, move_page,
// trash_page, trash_record and set_task (lib/mcp.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-mcp-write-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { handleMcpMessage, mcpToolNames, appendToPage } = await import("../lib/mcp");
const { documentKey, watchDocument } = await import("../lib/document-live");
import type { Identity } from "../lib/types";

async function person(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
async function tokenFor(user: Identity, scope: "read" | "write") {
  const { token } = (await command(user, { action: "token.create", name: `MCP ${scope}`, scope })) as { token: string };
  return (await identityFromApiToken(`Bearer ${token}`))!;
}
let seq = 0;
async function call(user: Identity, name: string, args: Record<string, unknown>) {
  const answer = (await handleMcpMessage(user, { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } })) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return { error: !!answer.result.isError, text: answer.result.content[0].text, parts: answer.result.content.map((c) => c.text) };
}
const ok = async (user: Identity, name: string, args: Record<string, unknown>) => {
  const answer = await call(user, name, args);
  assert.equal(answer.error, false, answer.text);
  return JSON.parse(answer.text);
};
// read_page: the Markdown and its facts (revision, headings, tasks).
async function read(user: Identity, pageId: string) {
  const answer = await call(user, "read_page", { pageId });
  assert.equal(answer.error, false, answer.text);
  return { markdown: answer.parts[0], ...(JSON.parse(answer.parts[1]) as { revision: string; headings: { level: number; text: string }[]; tasks: { index: number; key: string; text: string; done: boolean; due?: string; assignees?: string[] }[] }) };
}
const html = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;
const snapshots = async (pageId: string) => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM snapshots WHERE page_id=?", pageId))!.n);

const ana = await person("Ana"),
  ben = await person("Ben"),
  cleo = await person("Cleo");
const wid = await createWorkspace(ana.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, cleo.id, "viewer");
const teamSpace = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const anaWrite = await tokenFor(ana, "write"),
  benWrite = await tokenFor(ben, "write"),
  benRead = await tokenFor(ben, "read"),
  cleoWrite = await tokenFor(cleo, "write");

test("the new write tools are listed for write tokens only, destructive ones marked", async () => {
  const fresh = ["update_page", "move_page", "trash_page", "trash_record", "set_task"];
  for (const name of fresh) {
    assert.ok(mcpToolNames(benWrite).includes(name), name);
    assert.equal(mcpToolNames(benRead).includes(name), false, name);
  }
  const listed = (
    (await handleMcpMessage(benWrite, { jsonrpc: "2.0", id: ++seq, method: "tools/list" })) as {
      result: { tools: { name: string; annotations: { destructiveHint: boolean; readOnlyHint: boolean } }[] };
    }
  ).result.tools;
  const hint = (name: string) => listed.find((t) => t.name === name)!.annotations;
  assert.equal(hint("update_page").destructiveHint, true);
  assert.equal(hint("trash_page").destructiveHint, true);
  assert.equal(hint("trash_record").destructiveHint, true);
  assert.equal(hint("set_task").destructiveHint, false);
  assert.equal(hint("read_page").readOnlyHint, true);
  const page = await createPage(wid, teamSpace, ana.id, "Nur lesen");
  const refused = await call(benRead, "update_page", { pageId: page, title: "Nein" });
  assert.equal(refused.error, true);
  assert.match(refused.text, /only read/);
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", page))!.title, "Nur lesen");
});

test("update_page replaces the text, keeps a version and reaches open editors", async () => {
  const page = await createPage(wid, teamSpace, ana.id, "Plan");
  await appendToPage(ana, { pageId: page, markdown: "## Ziele\n\nAlt" });
  const { revision, markdown } = await read(benWrite, page);
  assert.match(markdown, /Alt/);
  assert.match(revision, /^[\w-]{16}$/);
  // An editor that has the page open.
  const generation = (await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", page))!.generation;
  const events: string[] = [];
  const stop = watchDocument(documentKey(page, null, generation), "browser-tab", (e) => events.push(e));
  const before = await snapshots(page);
  const answer = await ok(benWrite, "update_page", { pageId: page, markdown: "# Neu\n\nGanz **neu**", revision, title: "Plan 2", icon: "🚀" });
  stop();
  assert.equal(answer.content, "replace");
  assert.equal(answer.versionKept, true);
  assert.notEqual(answer.revision, revision);
  assert.equal(events.some((e) => e.includes('"type":"update"')), true);
  assert.equal((await html(page)).includes("Alt"), false);
  assert.match(await html(page), /<strong>neu<\/strong>/);
  // The text before is a version (also right after the last one).
  assert.equal(await snapshots(page), before + 1);
  const version = await one<{ html: string }>("SELECT html FROM snapshots WHERE page_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", page);
  assert.match(version!.html, /Alt/);
  const stored = (await one<{ title: string; icon: string }>("SELECT title,icon FROM pages WHERE id=?", page))!;
  assert.deepEqual([stored.title, stored.icon], ["Plan 2", "🚀"]);
  // Counted as Ben's edit, as in the editor.
  assert.ok(await one("SELECT 1 FROM page_edits WHERE page_id=? AND user_id=?", page, ben.id));
  assert.equal((await read(benWrite, page)).revision, answer.revision);
  // Append keeps the text.
  await ok(benWrite, "update_page", { pageId: page, markdown: "Nachtrag", mode: "append" });
  assert.match((await read(benWrite, page)).markdown, /Ganz \*\*neu\*\*[\s\S]*Nachtrag/);
  assert.equal((await call(benWrite, "update_page", { pageId: page })).error, true);
});

test("update_page refuses an outdated revision, also after a collaborator's edit", async () => {
  const page = await createPage(wid, teamSpace, ana.id, "Gemeinsam");
  await appendToPage(ana, { pageId: page, markdown: "Erster Stand" });
  const { revision } = await read(benWrite, page);
  // Ana types in the editor meanwhile (document.sync from her browser).
  await appendToPage(ana, { pageId: page, markdown: "Anas Absatz" });
  const stale = await call(benWrite, "update_page", { pageId: page, markdown: "Bens Fassung", revision });
  assert.equal(stale.error, true);
  assert.match(stale.text, /changed since you read it/);
  assert.match(await html(page), /Anas Absatz/);
  assert.equal((await html(page)).includes("Bens Fassung"), false);
  // A title change alone checks the revision too.
  assert.equal((await call(benWrite, "update_page", { pageId: page, title: "Neu", revision })).error, true);
  // With the current revision it works, and Ana's text is part of the version.
  const fresh = await read(benWrite, page);
  await ok(benWrite, "update_page", { pageId: page, markdown: "Bens Fassung", revision: fresh.revision });
  assert.match((await one<{ html: string }>("SELECT html FROM snapshots WHERE page_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", page))!.html, /Anas Absatz/);
  // A renamed page has a new revision.
  const renamed = await read(benWrite, page);
  await command(ana, { action: "page.update", pageId: page, patch: { title: "Umbenannt" } });
  assert.equal((await call(benWrite, "update_page", { pageId: page, markdown: "x", revision: renamed.revision })).error, true);
});

test("update_page replaces one section by its heading", async () => {
  const page = await createPage(wid, teamSpace, ana.id, "Protokoll");
  await appendToPage(ana, {
    pageId: page,
    markdown: "# Protokoll\n\nEinleitung\n\n## Entscheidungen\n\nAlt A\n\n### Details\n\nAlt B\n\n## Offene Punkte\n\nBleibt\n\n## Notizen\n\nEins\n\n## Notizen\n\nZwei",
  });
  const { headings } = await read(benWrite, page);
  assert.deepEqual(headings.map((h) => h.text), ["Protokoll", "Entscheidungen", "Details", "Offene Punkte", "Notizen", "Notizen"]);
  // Without a heading in the Markdown the heading stays; its subsections go too.
  await ok(benWrite, "update_page", { pageId: page, section: "entscheidungen", markdown: "- Neu beschlossen" });
  let text = (await read(benWrite, page)).markdown;
  assert.match(text, /## Entscheidungen\s+- Neu beschlossen\s+## Offene Punkte\s+Bleibt/);
  assert.equal(/Alt A|Alt B|Details/.test(text), false);
  assert.match(text, /Einleitung/);
  // With a heading it replaces the heading as well.
  await ok(benWrite, "update_page", { pageId: page, section: "Offene Punkte", markdown: "## Erledigt\n\nAlles" });
  text = (await read(benWrite, page)).markdown;
  assert.match(text, /## Erledigt\s+Alles\s+## Notizen/);
  assert.equal(text.includes("Offene Punkte"), false);
  // Unknown and ambiguous headings are refused with the list of headings.
  const missing = await call(benWrite, "update_page", { pageId: page, section: "Gibt es nicht", markdown: "x" });
  assert.equal(missing.error, true);
  assert.match(missing.text, /No heading[\s\S]*## Entscheidungen/);
  const twice = await call(benWrite, "update_page", { pageId: page, section: "Notizen", markdown: "x" });
  assert.equal(twice.error, true);
  assert.match(twice.text, /2 times[\s\S]*occurrence/);
  await ok(benWrite, "update_page", { pageId: page, section: "Notizen", occurrence: 2, markdown: "Zwei neu" });
  text = (await read(benWrite, page)).markdown;
  assert.match(text, /Eins[\s\S]*## Notizen\s+Zwei neu/);
  assert.equal((await call(benWrite, "update_page", { pageId: page, section: "Notizen", mode: "append", markdown: "x" })).error, true);
});

test("update_page respects rights, locks, encryption and the page kind", async () => {
  const page = await createPage(wid, teamSpace, ana.id, "Geschützt");
  await appendToPage(ana, { pageId: page, markdown: "Bleibt so" });
  // Cleo only reads in this workspace.
  assert.equal((await call(cleoWrite, "update_page", { pageId: page, markdown: "Cleo" })).error, true);
  // A private page of Ana.
  const privateSpace = id();
  await run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)", privateSpace, wid, "Privat", "", "private", ana.id);
  const secret = await createPage(wid, privateSpace, ana.id, "Geheim");
  assert.equal((await call(benWrite, "update_page", { pageId: secret, title: "Ben" })).error, true);
  // Locked: neither the text nor the title.
  await run("UPDATE pages SET locked=1 WHERE id=?", page);
  const locked = await call(benWrite, "update_page", { pageId: page, title: "Anders" });
  assert.equal(locked.error, true);
  assert.equal((await call(benWrite, "update_page", { pageId: page, markdown: "Anders" })).error, true);
  await run("UPDATE pages SET locked=0 WHERE id=?", page);
  // Databases and whiteboards are not documents.
  const db = await createPage(wid, teamSpace, ana.id, "Tabelle", "database");
  assert.match((await call(benWrite, "update_page", { pageId: db, title: "x" })).text, /documents only/);
  // End-to-end encrypted spaces are refused (no plaintext on the server).
  const vault = id();
  await run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id,encrypted) VALUES(?,?,?,?,?,?,1)", vault, wid, "Tresor", "", "workspace", ana.id);
  const sealed = await createPage(wid, vault, ana.id, "Verschlüsselt");
  const refused = await call(anaWrite, "update_page", { pageId: sealed, markdown: "Klartext" });
  assert.equal(refused.error, true);
  assert.match(refused.text, /verschlüsselt|encrypted/i);
  assert.equal((await html(sealed)).includes("Klartext"), false);
  assert.equal((await call(anaWrite, "trash_page", { pageId: sealed })).error, true);
  assert.equal((await call(anaWrite, "move_page", { pageId: sealed, spaceId: teamSpace })).error, true);
  assert.equal((await html(page)).includes("Cleo"), false);
});

test("move_page moves like the interface and refuses cycles", async () => {
  const parent = await createPage(wid, teamSpace, ana.id, "Projekte");
  const child = await createPage(wid, teamSpace, ana.id, "Projekt A", "document", parent);
  const grandchild = await createPage(wid, teamSpace, ana.id, "Unterseite", "document", child);
  const other = await createPage(wid, teamSpace, ana.id, "Archiv");
  // Below itself or its own sub-page: refused.
  for (const target of [parent, child, grandchild]) {
    const cycle = await call(benWrite, "move_page", { pageId: parent, parentId: target });
    assert.equal(cycle.error, true);
    assert.match(cycle.text, /below one of its own sub-pages/);
  }
  assert.match((await call(benWrite, "move_page", { pageId: parent, afterId: grandchild })).text, /below one of its own/);
  assert.equal((await one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", parent))!.parent_id, null);
  // Below another page, with what is below it.
  const moved = await ok(benWrite, "move_page", { pageId: child, parentId: other });
  assert.equal(moved.parentId, other);
  assert.equal((await one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", grandchild))!.parent_id, child);
  // Next to a page: in its parent, right before it.
  const second = await createPage(wid, teamSpace, ana.id, "Projekt B", "document", other);
  await ok(benWrite, "move_page", { pageId: second, beforeId: child });
  const order = (await import("../lib/db")).all<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND deleted_at IS NULL ORDER BY position", other);
  assert.deepEqual((await order).map((p) => p.id), [second, child]);
  // To the top level of the space.
  assert.equal((await ok(benWrite, "move_page", { pageId: child, spaceId: teamSpace })).parentId, null);
  // Into Ana's private space or by a reader: refused.
  const privateSpace = id();
  await run("INSERT INTO spaces(id,workspace_id,name,icon,visibility,owner_id) VALUES(?,?,?,?,?,?)", privateSpace, wid, "Nur Ana", "", "private", ana.id);
  assert.equal((await call(benWrite, "move_page", { pageId: child, spaceId: privateSpace })).error, true);
  assert.equal((await call(cleoWrite, "move_page", { pageId: child, parentId: parent })).error, true);
  // A locked destination refuses it.
  await run("UPDATE pages SET locked=1 WHERE id=?", parent);
  assert.equal((await call(benWrite, "move_page", { pageId: child, parentId: parent })).error, true);
  await run("UPDATE pages SET locked=0 WHERE id=?", parent);
  assert.equal((await one<{ space_id: string; parent_id: string | null }>("SELECT space_id,parent_id FROM pages WHERE id=?", child))!.parent_id, null);
  assert.equal((await call(benWrite, "move_page", { pageId: child })).error, true);
});

test("trash_page and trash_record move to the trash, restorable", async () => {
  const page = await createPage(wid, teamSpace, ana.id, "Weg damit");
  const below = await createPage(wid, teamSpace, ana.id, "Darunter", "document", page);
  await appendToPage(ana, { pageId: page, markdown: "Inhalt bleibt" });
  const answer = await ok(benWrite, "trash_page", { pageId: page });
  assert.equal(answer.inTrash, true);
  assert.equal(answer.subPages, 1);
  assert.match(answer.restore, /Trash[\s\S]*Restore[\s\S]*30 days/);
  assert.match(answer.restore, /Nothing was deleted permanently/);
  // In the trash, not deleted: rows and content are there.
  for (const pid of [page, below]) assert.ok((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE id=?", pid))!.deleted_at);
  assert.match(await html(page), /Inhalt bleibt/);
  assert.equal((await call(benWrite, "read_page", { pageId: page })).error, true);
  // Restored as in the trash view, with the page below it.
  await command(ben, { action: "page.restore", pageId: page });
  for (const pid of [page, below]) assert.equal((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE id=?", pid))!.deleted_at, null);
  assert.match((await read(benWrite, page)).markdown, /Inhalt bleibt/);
  // A reader may not, a locked page stays.
  assert.equal((await call(cleoWrite, "trash_page", { pageId: page })).error, true);
  await run("UPDATE pages SET locked=1 WHERE id=?", page);
  assert.equal((await call(benWrite, "trash_page", { pageId: page })).error, true);
  await run("UPDATE pages SET locked=0 WHERE id=?", page);
  assert.equal((await one<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE id=?", page))!.deleted_at, null);

  // Records.
  const db = await createPage(wid, teamSpace, ana.id, "Aufgaben", "database");
  const { id: rid } = (await command(ana, { action: "row.create", pageId: db, cells: { title: "Weg" } })) as { id: string };
  const record = await ok(benWrite, "trash_record", { databaseId: db, recordId: rid });
  assert.equal(record.inTrash, true);
  assert.match(record.restore, /Restore/);
  assert.equal(await one("SELECT 1 FROM rows WHERE id=?", rid), undefined);
  assert.ok(await one("SELECT 1 FROM row_trash WHERE id=?", rid));
  await command(ben, { action: "row.trash.restore", trashId: rid });
  assert.ok(await one("SELECT 1 FROM rows WHERE id=?", rid));
  // Another person's private record stays.
  const { id: privateId } = (await command(ana, { action: "row.create", pageId: db, cells: { title: "Privat" } })) as { id: string };
  await run("UPDATE rows SET access='private' WHERE id=?", privateId);
  assert.equal((await call(benWrite, "trash_record", { databaseId: db, recordId: privateId })).error, true);
  assert.ok(await one("SELECT 1 FROM rows WHERE id=?", privateId));
});

test("set_task ticks, dates and assigns one task without replacing the text", async () => {
  const page = await createPage(wid, teamSpace, ana.id, "Aufgabenliste");
  await appendToPage(ana, { pageId: page, markdown: "Vorher **fett**\n\n- [ ] Angebot schicken\n- [ ] Rechnung prüfen\n- [ ] Rechnung prüfen" });
  const { tasks } = await read(benWrite, page);
  assert.deepEqual(tasks.map((t) => [t.index, t.text, t.done]), [[0, "Angebot schicken", false], [1, "Rechnung prüfen", false], [2, "Rechnung prüfen", false]]);
  const generation = (await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", page))!.generation;
  const events: string[] = [];
  const stop = watchDocument(documentKey(page, null, generation), "tab", (e) => events.push(e));
  // By its text.
  const ticked = await ok(benWrite, "set_task", { pageId: page, text: "angebot schicken", done: true, due: "2026-12-01", assignee: "ana@example.test" });
  stop();
  assert.equal(ticked.task.done, true);
  assert.equal(ticked.task.due, "2026-12-01");
  assert.deepEqual(ticked.task.assignees, ["Ana"]);
  assert.equal(events.some((e) => e.includes('"type":"update"')), true);
  const after = await read(benWrite, page);
  assert.equal(after.tasks[0].done, true);
  assert.equal(after.tasks[0].text, "Angebot schicken @Ana");
  assert.match(after.markdown, /Vorher \*\*fett\*\*/);
  // my_tasks of Ana names it with the same reference.
  const mine = JSON.parse((await call(anaWrite, "my_tasks", { workspaceId: wid, includeDone: true })).text).tasks as { pageId: string; index: number; key: string; done: boolean }[];
  const listed = mine.find((t) => t.pageId === page)!;
  assert.deepEqual([listed.index, listed.key, listed.done], [0, after.tasks[0].key, true]);
  // By index and key; unticked, date and assignee cleared.
  await ok(anaWrite, "set_task", { pageId: page, index: listed.index, key: listed.key, done: false, due: null, assignee: null });
  const cleared = (await read(benWrite, page)).tasks[0];
  assert.deepEqual([cleared.text, cleared.done, cleared.due, cleared.assignees], ["Angebot schicken", false, undefined, undefined]);
  // Two tasks with the same text: by text refused, by index fine.
  const twice = await call(benWrite, "set_task", { pageId: page, text: "Rechnung prüfen", done: true });
  assert.equal(twice.error, true);
  assert.match(twice.text, /2 tasks match/);
  await ok(benWrite, "set_task", { pageId: page, index: 2, text: "Rechnung prüfen", status: "progress" });
  assert.deepEqual((await read(benWrite, page)).tasks.map((t) => t.done), [false, false, false]);
  // A key that no longer fits the position (the task changed): refused.
  const stale = await call(benWrite, "set_task", { pageId: page, index: 0, key: listed.key, done: true });
  assert.equal(stale.error, true);
  assert.match(stale.text, /no longer the one/);
  // Unknown people, readers and locked pages are refused.
  assert.match((await call(benWrite, "set_task", { pageId: page, index: 1, text: "Rechnung prüfen", assignee: "niemand@example.test" })).text, /no member/);
  assert.equal((await call(cleoWrite, "set_task", { pageId: page, index: 1, text: "Rechnung prüfen", done: true })).error, true);
  await run("UPDATE pages SET locked=1 WHERE id=?", page);
  assert.equal((await call(benWrite, "set_task", { pageId: page, index: 1, text: "Rechnung prüfen", done: true })).error, true);
  await run("UPDATE pages SET locked=0 WHERE id=?", page);
  assert.equal((await read(benWrite, page)).tasks[1].done, false);

  // A task in a record's document.
  const db = await createPage(wid, teamSpace, ana.id, "Projekte", "database");
  const titleField = JSON.parse((await call(benWrite, "query_database", { databaseId: db })).text).fields[0].name as string;
  const record = await ok(benWrite, "create_record", { databaseId: db, properties: { [titleField]: "Mit Aufgabe" }, document: "- [ ] Im Datensatz" });
  const got = await ok(benWrite, "get_record", { databaseId: db, recordId: record.id });
  assert.equal(got.tasks[0].text, "Im Datensatz");
  const done = await ok(benWrite, "set_task", { pageId: db, recordId: record.id, index: 0, key: got.tasks[0].key, done: true });
  assert.equal(done.task.done, true);
  assert.equal((await ok(benWrite, "get_record", { databaseId: db, recordId: record.id })).tasks[0].done, true);
});
