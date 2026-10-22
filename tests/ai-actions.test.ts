import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-actions-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { proposeActions, runActions, previewAction, tasksHtml, ACTIONS_SYSTEM } = await import("../lib/ai/actions");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben"),
  vic = person("Vic");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const privateSpace = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", admin.id);
const doc = createPage(wid, space, admin.id, "Protokoll");
run("UPDATE documents SET html=? WHERE page_id=?", "<p>Besprechung vom Montag.</p>", doc);
const db = createPage(wid, space, admin.id, "Aufgaben", "database");
// A property only owners may change.
const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db)!.fields);
fields.push({ id: "budget", name: "Budget", type: "number", access: { write: "owners" } });
run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), db);
const existing = command(admin, { action: "row.create", pageId: db, cells: { title: "Angebot schreiben" } }) as { id: string };
const blockedDb = createPage(wid, space, admin.id, "Gehälter", "database");
command(admin, { action: "ai.block", targetId: blockedDb, kind: "page", blocked: true });

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });

const proposal = () =>
  JSON.stringify({
    actions: [
      { tool: "create_page", spaceId: space, parentId: null, title: "Entscheidungen", markdown: "# Entscheidungen\n\n- Wir starten im Mai." },
      { tool: "create_tasks", pageId: doc, tasks: [{ text: "Angebot verschicken", assignee: "Ben", due: "2026-11-02" }, { text: "Raum buchen", assignee: "Niemand", due: "morgen" }] },
      { tool: "create_record", databaseId: db, cells: { Aufgabe: "Kunden anrufen", Status: "in arbeit", Verantwortlich: "ben", Tags: "Design" } },
      { tool: "create_record", databaseId: db, cells: { Aufgabe: "Teuer", Budget: 5000 } },
      { tool: "update_record", databaseId: db, recordId: existing.id, cells: { Status: "Erledigt" } },
      { tool: "create_record", databaseId: blockedDb, cells: { Aufgabe: "Gehalt" } },
      { tool: "delete_everything", pageId: doc },
    ],
  });

test("AI actions are off by default and need the actions feature", async () => {
  await assert.rejects(proposeActions(ben, { workspaceId: wid, instruction: "Lege Aufgaben an" }), /ausgeschaltet/);
  assert.throws(() => runActions(ben, { workspaceId: wid, actions: [{ tool: "create_page", spaceId: space, title: "X" }] }), /ausgeschaltet/);
  setAi({ enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" }, features: { actions: false } });
  await assert.rejects(proposeActions(ben, { workspaceId: wid, instruction: "Lege Aufgaben an" }), /ausgeschaltet/);
  setAi({ features: { actions: true } });
  command(ben, { action: "ai.settings", features: { actions: false } });
  await assert.rejects(proposeActions(ben, { workspaceId: wid, instruction: "Lege Aufgaben an" }), /ausgeschaltet/);
  command(ben, { action: "ai.settings", features: { actions: true } });
});

test("the proposal is a checked preview; nothing is written before running", async () => {
  mock.answer = () => proposal();
  const pagesBefore = Number(one<{ n: number }>("SELECT count(*) n FROM pages")!.n);
  const rowsBefore = Number(one<{ n: number }>("SELECT count(*) n FROM rows")!.n);
  const before = mock.chats.length;
  const { actions } = await proposeActions(ben, { workspaceId: wid, instruction: "Lege an, was besprochen wurde", context: "Ben schickt das Angebot.", pageId: doc });
  const sent = mock.chats[before];
  assert.equal(sent.system, ACTIONS_SYSTEM);
  assert.match(sent.prompt, /Ben schickt das Angebot/);
  assert.ok(sent.prompt.includes(space) && sent.prompt.includes(db), "the catalogue names writable places");
  assert.ok(!sent.prompt.includes(blockedDb), "databases closed to the AI are not offered");
  assert.ok(!sent.prompt.includes(privateSpace), "spaces without edit rights are not offered");
  assert.ok(!sent.prompt.includes('"budget"'), "properties the person may not write are not offered");
  assert.equal(Number(one<{ n: number }>("SELECT count(*) n FROM pages")!.n), pagesBefore);
  assert.equal(Number(one<{ n: number }>("SELECT count(*) n FROM rows")!.n), rowsBefore);

  const [page, tasks, record, budget, update, blocked, invalid] = actions;
  assert.equal(page.ok, true);
  assert.equal(page.view.title, "Entscheidungen");
  assert.equal(tasks.ok, true);
  assert.deepEqual(tasks.view.tasks, [{ text: "Angebot verschicken", assignee: "Ben", due: "2026-11-02" }, { text: "Raum buchen" }]);
  assert.equal(record.ok, true);
  const cells = (record.action as { cells: Record<string, unknown> }).cells;
  assert.deepEqual(cells, { title: "Kunden anrufen", status: "In Arbeit", assignee: ben.id, tags: ["Design"] });
  assert.equal(budget.ok, false, "field permissions apply");
  assert.match(budget.problem!, /nur für bestimmte Personen/);
  assert.equal(update.ok, true);
  assert.equal(blocked.ok, false);
  assert.match(blocked.problem!, /für die KI gesperrt/);
  assert.equal(invalid.ok, false);
});

test("confirmed actions run as the person, with audit entries and undo", async () => {
  mock.answer = () => proposal();
  const { actions } = await proposeActions(ben, { workspaceId: wid, instruction: "Lege an", pageId: doc });
  const chosen = actions.filter((a) => a.ok).map((a) => a.action);
  const { results } = runActions(ben, { workspaceId: wid, actions: chosen });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  const created = results.find((r) => r.tool === "create_page")!;
  const page = one<{ title: string; created_by: string; space_id: string }>("SELECT title,created_by,space_id FROM pages WHERE id=?", created.pageId!)!;
  assert.deepEqual(page, { title: "Entscheidungen", created_by: ben.id, space_id: space });
  assert.match(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", created.pageId!)!.html, /Wir starten im Mai/);
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", doc)!.html;
  assert.match(html, /Besprechung vom Montag/);
  assert.match(html, /data-due="2026-11-02"/);
  assert.match(html, new RegExp(`data-mention="${ben.id}"`));
  // The task is assigned like one written in the editor.
  assert.ok(one("SELECT 1 FROM doc_tasks WHERE page_id=? AND assignee=? AND due='2026-11-02'", doc, ben.id));
  const record = results.find((r) => r.tool === "create_record")!;
  assert.match(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", record.rowId!)!.cells, /Kunden anrufen/);
  assert.equal(JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", existing.id)!.cells).status, "Erledigt");
  const audits = all<{ detail: string }>("SELECT detail FROM audit WHERE actor_id=? AND action='ai.action'", ben.id).map((a) => a.detail);
  assert.deepEqual(audits.sort(), ["create_page", "create_record", "create_tasks:2", "update_record"]);
  // Undo: created things go to the trash.
  assert.deepEqual(created.undo, { action: "page.delete", pageId: created.pageId });
  command(ben, created.undo!);
  assert.ok(one<{ deleted_at: string | null }>("SELECT deleted_at FROM pages WHERE id=?", created.pageId!)!.deleted_at);
  assert.deepEqual(record.undo, { action: "row.delete", pageId: db, rowId: record.rowId });
});

test("running checks everything again: tampered or forbidden actions fail", () => {
  const { results } = runActions(ben, {
    workspaceId: wid,
    actions: [
      { tool: "create_page", spaceId: privateSpace, title: "Eingeschleust", markdown: "" },
      { tool: "create_record", databaseId: db, cells: { budget: 1 } },
      { tool: "create_record", databaseId: blockedDb, cells: { title: "x" } },
      { tool: "create_tasks", pageId: doc, tasks: [{ text: "ok" }] },
    ],
  });
  assert.deepEqual(
    results.map((r) => r.ok),
    [false, false, false, true],
  );
  assert.ok(!one("SELECT 1 FROM pages WHERE title='Eingeschleust'"));
  // Readers cannot write through the AI either.
  const forVic = runActions(vic, { workspaceId: wid, actions: [{ tool: "create_tasks", pageId: doc, tasks: [{ text: "x" }] }] });
  assert.equal(forVic.results[0].ok, false);
  assert.equal(previewAction(vic, wid, { tool: "create_page", spaceId: space, title: "x" }, 0).ok, false);
});

test("task HTML escapes text and carries assignee and due date", () => {
  const html = tasksHtml([{ text: "<b>A</b> & B", assignee: ben.id, due: "2026-01-02" }], () => "Ben");
  assert.equal(html, `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-01-02"><p>&lt;b&gt;A&lt;/b&gt; &amp; B <span data-mention="${ben.id}">@Ben</span></p></li></ul>`);
});
