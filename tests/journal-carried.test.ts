// Where carried-over tasks go in a new journal day (#247): at the top (the
// default), after the template, or below a heading of the template – in
// days created by rollJournal and in the drafts of "beim ersten Schreiben".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-carried-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState, stateHtml } = await import("../lib/document-server");
const { rollJournal, dayDocument } = await import("../lib/journal");
const { journalDraftPage } = await import("../lib/journal-days");
const { templateNodesOf, journalSettings } = await import("../lib/journal-extras");
const { placeBlocks, placeIndex, headingsOf } = await import("../lib/journal-place");
const { documentSchema } = await import("../lib/document-schema");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Lena", "lena@example.test");
const owner = { id: uid, name: "Lena", email: "lena@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = await createWorkspace(owner.id, "Tagebuch");
const space = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (b: Record<string, unknown>) => (await command(owner, { workspaceId: wid, ...b })) as Record<string, unknown>;
const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "");
const write = async (pageId: string, body: string) => await run("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, pageId);
const roll = async (journalId: string, date: string) => await rollJournal(owner, await page(journalId), date, date);
const task = (text: string) => `<li data-type="taskItem" data-checked="false"><p>${text}</p></li>`;
const TEMPLATE = "<h3>🎯 Fokus</h3><p>Ziel</p><h3>📥 Inbox</h3><p>Eingang</p><h3>🌙 Abschluss</h3><p></p>";

// The order of the day's blocks as short marks: headings by text, the task list as "TASKS".
const outline = (body: string) =>
  [...body.matchAll(/<h3[^>]*>(.*?)<\/h3>|<ul data-type="taskList"|<p[^>]*>(.*?)<\/p>/g)]
    .filter((m) => !m[0].startsWith("<p") || m[2])
    .map((m) => (m[1] !== undefined ? m[1] : m[0].startsWith("<ul") ? "TASKS" : m[2]))
    .filter((mark, i, all) => !(mark === "Offen" && all[i - 1] === "TASKS"));

test("dayDocument: each place, a missing heading, no template, no tasks", () => {
  const schema = documentSchema();
  const template = templateNodesOf(TEMPLATE, schema);
  const tasks = [schema.node("taskItem", { checked: false }, [schema.node("paragraph", null, [schema.text("Offen")])])];
  const order = (doc: ReturnType<typeof dayDocument>) => {
    const out: string[] = [];
    doc.forEach((n) => out.push(n.type.name === "taskList" ? "TASKS" : n.type.name === "heading" ? n.textContent : n.textContent || "·"));
    return out;
  };
  assert.deepEqual(order(dayDocument(tasks, template)), ["TASKS", "🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "·"]);
  assert.deepEqual(order(dayDocument(tasks, template, { at: "top" })), ["TASKS", "🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "·"]);
  assert.deepEqual(order(dayDocument(tasks, template, { at: "end" })), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "·", "TASKS"]);
  // Directly below the heading, before what the template puts there; the heading's text is trimmed.
  assert.deepEqual(order(dayDocument(tasks, template, { at: "heading", heading: "  📥 Inbox " })), ["🎯 Fokus", "Ziel", "📥 Inbox", "TASKS", "Eingang", "🌙 Abschluss", "·"]);
  // The heading is not in the template (any more): after the template.
  assert.deepEqual(order(dayDocument(tasks, template, { at: "heading", heading: "Gibt es nicht" })), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "·", "TASKS"]);
  assert.deepEqual(order(dayDocument(tasks, template, { at: "heading", heading: "" })), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "·", "TASKS"]);
  // No template: the tasks, then an empty line to write in – whatever the place.
  for (const at of ["top", "end", "heading"] as const) assert.deepEqual(order(dayDocument(tasks, [], { at, heading: "📥 Inbox" })), ["TASKS", "·"]);
  // No tasks: the template as it is.
  for (const at of ["top", "end", "heading"] as const)
    assert.deepEqual(order(dayDocument([], template, { at, heading: "📥 Inbox" })), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "·"]);
  assert.deepEqual(order(dayDocument([], [])), ["·"]);
});

test("placeIndex: the end of a heading's section stops at the next heading of the same level and before trailing empty lines", () => {
  const schema = documentSchema();
  const body = templateNodesOf("<h2>A</h2><p>a</p><h3>A.1</h3><p>a1</p><p></p><h2>B</h2><p>b</p>", schema);
  assert.deepEqual(headingsOf(body), [{ text: "A", level: 2 }, { text: "A.1", level: 3 }, { text: "B", level: 2 }]);
  assert.equal(placeIndex(body, { at: "heading", heading: "A" }, "end"), 4, "after A.1's text, before the empty line");
  assert.equal(placeIndex(body, { at: "heading", heading: "A.1" }, "end"), 4);
  assert.equal(placeIndex(body, { at: "heading", heading: "B" }, "end"), body.length);
  assert.equal(placeIndex(body, { at: "heading", heading: "B" }), 6);
  assert.equal(placeIndex(body, { at: "top" }, "end"), 0);
  assert.equal(placeBlocks(body, [], { at: "end" }), body);
});

test("rollJournal and the drafts follow the journal's setting", async () => {
  const journal = String((await act({ action: "page.create", spaceId: space, title: "Journal", kind: "journal" })).id);
  await act({ action: "journal.settings", pageId: journal, template: TEMPLATE });
  // Default: at the top, as before.
  assert.deepEqual((await journalSettings(journal)).options.carried, "top");
  const first = (await roll(journal, "2026-10-01")).dayId;
  await write(first, `<ul data-type="taskList">${task("Offen")}</ul><p>Eintrag</p>`);
  const second = (await roll(journal, "2026-10-02")).dayId;
  assert.deepEqual(outline(await html(second)).slice(0, 2), ["TASKS", "🎯 Fokus"]);
  // Below a heading.
  await act({ action: "journal.settings", pageId: journal, options: { carried: "heading", carriedHeading: "📥 Inbox" } });
  await write(second, `<ul data-type="taskList">${task("Offen")}</ul><p>Eintrag</p>`);
  const third = (await roll(journal, "2026-10-03")).dayId;
  assert.deepEqual(outline(await html(third)), ["🎯 Fokus", "Ziel", "📥 Inbox", "TASKS", "Eingang", "🌙 Abschluss"]);
  // After the template.
  await act({ action: "journal.settings", pageId: journal, options: { carried: "end" } });
  assert.equal((await journalSettings(journal)).options.carriedHeading, "📥 Inbox", "the heading stays chosen");
  await write(third, `<p>Eintrag</p><ul data-type="taskList">${task("Offen")}</ul>`);
  const fourth = (await roll(journal, "2026-10-04")).dayId;
  assert.deepEqual(outline(await html(fourth)), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "TASKS"]);
  // A draft ("beim ersten Schreiben") shows the same.
  await act({ action: "journal.settings", pageId: journal, options: { create: "write", carried: "heading", carriedHeading: "🌙 Abschluss" } });
  await write(fourth, `<p>Eintrag</p><ul data-type="taskList">${task("Offen")}</ul>`);
  const draft = await roll(journal, "2026-10-05");
  assert.equal(draft.draft, true);
  const shown = await journalDraftPage(owner, draft.dayId, "2026-10-05");
  assert.ok(shown && "data" in shown);
  const local = new Y.Doc();
  Y.applyUpdate(local, Buffer.from((shown.data as { state: string }).state, "base64"));
  assert.deepEqual(outline(stateHtml(local)), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "TASKS"]);
  // The day created from the draft by the first write is exactly the draft.
  const created = await rollJournal(owner, await page(journal), "2026-10-05", "2026-10-05", false, { write: true });
  assert.equal(created.dayId, draft.dayId);
  assert.deepEqual(outline(await html(created.dayId)), ["🎯 Fokus", "Ziel", "📥 Inbox", "Eingang", "🌙 Abschluss", "TASKS"]);
});

test("the setting is validated", async () => {
  const journal = String((await act({ action: "page.create", spaceId: space, title: "Journal 2", kind: "journal" })).id);
  await assert.rejects(act({ action: "journal.settings", pageId: journal, options: { carried: "middle" } }));
  await assert.rejects(act({ action: "journal.settings", pageId: journal, options: { carried: "heading", carriedHeading: "x".repeat(201) } }));
  assert.equal((await journalSettings(journal)).options.carried, "top");
});
