// A saved page template as a journal's daily template (#316,
// journal.settings with `templateFromSaved`): the content is copied through
// the document schema; private templates of others, templates of another
// space and database templates are refused; later edits of the template do
// not reach the journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-saved-template-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Hanna"),
  editor = await account("Erik");
const wid = await createWorkspace(owner.id, "Büro");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
type Result = { id: string } & Record<string, unknown>;
const act = async (b: Record<string, unknown>, as = owner) => (await command(as, { workspaceId: wid, ...b })) as Result;
const home = (await bootstrap(owner, wid)).spaces[0].id;
const other = (await act({ action: "space.create", name: "Boulot" })).id;
const write = async (pageId: string, body: string) => await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const doc = async (title: string, body: string, spaceId = home, as = owner) => {
  const pageId = (await act({ action: "page.create", spaceId, title }, as)).id;
  await write(pageId, body);
  return pageId;
};
const save = async (pageId: string, name: string, extra: Record<string, unknown> = {}, as = owner) =>
  (await act({ action: "template.save", pageId, name, ...extra }, as)).id;
const template = async (journal: string) => String((await one<{ template: string }>("SELECT template FROM journal_settings WHERE page_id=?", journal))?.template ?? "");
const choose = async (journal: string, templateId: string, as = owner) => await act({ action: "journal.settings", pageId: journal, templateFromSaved: templateId }, as);

const journal = (await act({ action: "page.create", spaceId: home, title: "Journal", kind: "journal" })).id;

test("a document template of the journal's space or the whole workspace is copied, tasks unchecked", async () => {
  const source = await doc("Tagesplan", '<h3>Plan</h3><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Wasser trinken</p></li></ul><script>alert(1)</script>');
  const scoped = await save(source, "Tagesplan");
  assert.equal((await one<{ space_id: string }>("SELECT space_id FROM templates WHERE id=?", scoped))?.space_id, home);
  const result = await choose(journal, scoped);
  assert.match(String(result.template), /Plan/);
  const stored = await template(journal);
  assert.match(stored, /Wasser trinken/);
  assert.match(stored, /data-checked="false"/, "tasks start unchecked");
  assert.doesNotMatch(stored, /script/, "through the document schema");

  const wide = await save(await doc("Wochenstart", "<h3>Woche</h3><p>Ziele</p>"), "Wochenstart", { spaceId: null });
  await choose(journal, wide);
  assert.match(await template(journal), /Ziele/);
});

test("later edits of the saved template do not change the journal until it is chosen again", async () => {
  const source = await doc("Abend", "<h3>Abend</h3><p>Erster Stand</p>");
  const saved = await save(source, "Abend");
  await choose(journal, saved);
  await run("UPDATE templates SET payload=? WHERE id=?", JSON.stringify({ html: "<h3>Abend</h3><p>Zweiter Stand</p>" }), saved);
  assert.match(await template(journal), /Erster Stand/);
  await choose(journal, saved);
  assert.match(await template(journal), /Zweiter Stand/);
});

test("someone else's private template is refused; one's own private one works", async () => {
  const mine = await save(await doc("Privat", "<p>Nur für Erik</p>", home, editor), "Privat", { private: true }, editor);
  await assert.rejects(async () => await choose(journal, mine), /Private Vorlage/);
  assert.doesNotMatch(await template(journal), /Nur für Erik/);
  await choose(journal, mine, editor);
  assert.match(await template(journal), /Nur für Erik/);
});

test("a template of another space is refused", async () => {
  const foreign = await save(await doc("Boulot-Plan", "<p>Boulot</p>", other), "Boulot-Plan");
  assert.equal((await one<{ space_id: string }>("SELECT space_id FROM templates WHERE id=?", foreign))?.space_id, other);
  await assert.rejects(async () => await choose(journal, foreign), /anderen Bereichs/);
  assert.doesNotMatch(await template(journal), /Boulot/);
});

test("database templates and unknown ids are refused", async () => {
  const table = (await act({ action: "page.create", spaceId: home, title: "Aufgaben", kind: "database" })).id;
  const tableTemplate = await save(table, "Aufgaben");
  await assert.rejects(async () => await choose(journal, tableTemplate), /Dokumentvorlagen/);
  await assert.rejects(async () => await choose(journal, id()), /Vorlage fehlt/);
  await assert.rejects(async () => await choose(journal, "kein-uuid"));
});

test("only on journals, and only for who may write in them", async () => {
  const saved = await save(await doc("Notiz", "<p>Notiz</p>"), "Notiz");
  const page = await doc("Keine Journalseite", "<p>x</p>");
  await assert.rejects(async () => await choose(page, saved), /kein Journal/);
  const reader = await account("Rita");
  await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
  await assert.rejects(async () => await choose(journal, saved, reader));
});
