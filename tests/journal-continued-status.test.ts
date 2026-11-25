// A journal task copied on to a later day keeps its state on its own day
// (#536): open or in progress shows there with a ➔ badge, while it stays
// closed (cancelled) for every count, My tasks and older clients, keeps the
// badge whatever is done with it there, and is never carried again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-journal-continued-"));
const { run: sql, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { rollJournal, openTasks, withContinuedTasks } = await import("../lib/journal");
const { indexPageTasks, myTasks, extractTasks } = await import("../lib/doc-tasks");
const ts = await import("../lib/task-status");
const { documentSchema } = await import("../lib/document-schema");
const { setTaskStatus, cycleTaskStatus, tidyTaskStatus } = await import("../lib/task-status-commands");
const { checkSubtasks } = await import("../lib/task-subtasks");
const { bulkTasks } = await import("../lib/task-bulk");
const { documentXhtml } = await import("../lib/export-xhtml");
const { documentJira } = await import("../lib/export-jira");
const { documentConfluence } = await import("../lib/export-confluence");
const { htmlToMarkdown } = await import("../lib/markdown");
const { jsonHtml, htmlJson } = await import("../lib/document-server");
const { Node: PMNode } = await import("@tiptap/pm/model");
const { yDocToProsemirrorJSON } = await import("y-prosemirror");

const schema = documentSchema();
const docOf = (body: string) => {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, htmlState(body));
  return PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
};
const li = (text: string, attrs = "") => `<li data-type="taskItem" data-checked="false"${attrs}><p>${text}</p></li>`;
const list = (...items: string[]) => `<ul data-type="taskList">${items.join("")}</ul>`;
const byText = (d: Node) => {
  const out: Record<string, Node> = {};
  d.descendants((n) => {
    if (n.type.name === "taskItem") out[n.firstChild!.textContent] = n;
    return true;
  });
  return out;
};

test("copying keeps each task's state: stored cancelled, shown open or in progress", () => {
  const d = withContinuedTasks(docOf(list(li("Bericht"), li("Angebot", ' data-status="progress"'), li("Später", ' data-status="deferred"'))), "2026-11-26");
  const t = byText(d);
  for (const [text, was] of [["Bericht", "open"], ["Angebot", "progress"], ["Später", "deferred"]] as const) {
    assert.equal(ts.taskStatusOf(t[text].attrs), "cancelled", `${text} is closed for logic`);
    assert.equal(t[text].attrs.checked, true, `${text}: older clients see it ticked`);
    assert.equal(ts.isContinuedTask(t[text].attrs), true);
    assert.equal(ts.shownStatusOf(t[text].attrs), was);
    assert.equal(ts.continuedOn(t[text].attrs), "2026-11-26");
  }
  assert.equal(openTasks(d).length, 0, "never carried again");
  // In the task index they are left out as before.
  assert.ok(extractTasks(d.toJSON()).every((task) => task.continued));
  // Stored HTML: still cancelled, with the shown state beside the marker.
  const html = jsonHtml(d.toJSON());
  assert.match(html, /data-journal-was="progress"/);
  assert.equal(html.split('data-status="cancelled"').length - 1, 3);
  // And back from HTML.
  const again = byText(docOf(html));
  assert.equal(ts.shownStatusOf(again.Angebot.attrs), "progress");
  assert.equal(ts.shownStatusOf(again.Bericht.attrs), "open");
});

test("a shown state needs the marker; tasks continued before #536 stay as they were", () => {
  // Without the marker the attribute is dropped.
  const plain = byText(docOf(`<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-status="cancelled" data-journal-was="open"><p>X</p></li></ul>`));
  assert.equal(plain.X.attrs.journalWas, null);
  assert.equal(ts.shownStatusOf(plain.X.attrs), "cancelled");
  // Old data: cancelled with the marker, no shown state – carried-over look.
  const old = byText(docOf(`<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-status="cancelled" data-journal-continued="2026-10-06"><p>Alt</p></li></ul>`)).Alt;
  assert.equal(ts.isLegacyContinued(old.attrs), true);
  assert.equal(ts.isContinuedTask(old.attrs), true);
  assert.equal(ts.shownStatusOf(old.attrs), "cancelled");
  assert.doesNotMatch(jsonHtml(docOf(`<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-status="cancelled" data-journal-continued="2026-10-06"><p>Alt</p></li></ul>`).toJSON()), /data-journal-was/);
  // Removing the marker: an old one becomes open.
  assert.deepEqual(ts.uncontinuedAttrs(old.attrs), { checked: false, status: null, symbol: null, journalContinued: null, journalWas: null });
});

// The editor: menu, Ctrl/Cmd+L, a click and bulk actions on a continued task.
function apply(state: EditorState, command: (s: EditorState, d: (tr: Transaction) => void) => boolean) {
  let next = state;
  command(state, (tr) => {
    let after = state.apply(tr);
    const extra = checkSubtasks([tr], state, after);
    if (extra) after = after.apply(extra);
    const tidy = tidyTaskStatus([tr], state, after);
    next = tidy ? after.apply(tidy) : after;
  });
  return next;
}
const continued = () => {
  const d = withContinuedTasks(docOf(list(li("Angebot", ' data-status="progress"'))), "2026-11-26");
  return EditorState.create({ schema, doc: d, selection: TextSelection.create(d, 4) });
};
const first = (s: EditorState) => s.doc.firstChild!.firstChild!;

test("changing the state on its day keeps the badge and keeps it closed, done stays done", () => {
  // Done there: stored done, still marked.
  let state = apply(continued(), (s, d) => setTaskStatus(s, d, "done", [1]));
  assert.equal(ts.taskStatusOf(first(state).attrs), "done");
  assert.equal(ts.shownStatusOf(first(state).attrs), "done");
  assert.equal(ts.continuedOn(first(state).attrs), "2026-11-26");
  assert.equal(first(state).attrs.journalWas, null);
  // Back to open from the menu: shown open, still closed and not carried.
  state = apply(state, (s, d) => setTaskStatus(s, d, "open", [1]));
  assert.equal(ts.taskStatusOf(first(state).attrs), "cancelled");
  assert.equal(ts.shownStatusOf(first(state).attrs), "open");
  assert.equal(openTasks(state.doc).length, 0);
  // Ctrl/Cmd+L goes by the state it shows: open → in progress.
  state = apply(state, cycleTaskStatus);
  assert.equal(ts.shownStatusOf(first(state).attrs), "progress");
  assert.equal(ts.taskStatusOf(first(state).attrs), "cancelled");
  // Cancelled there: shown cancelled, still marked.
  state = apply(state, (s, d) => setTaskStatus(s, d, "cancelled", [1]));
  assert.equal(ts.shownStatusOf(first(state).attrs), "cancelled");
  assert.equal(ts.continuedOn(first(state).attrs), "2026-11-26");
  // Unticked by a plain toggle (only `checked`): shown open, still closed.
  state = apply(state, (s, d) => (d(s.tr.setNodeMarkup(1, undefined, { ...first(s).attrs, checked: false })), true));
  assert.equal(first(state).attrs.checked, true);
  assert.equal(ts.shownStatusOf(first(state).attrs), "open");
  assert.equal(ts.isContinuedTask(first(state).attrs), true);
  // Editing the text keeps it all.
  state = apply(state, (s, d) => (d(s.tr.insertText(" neu", 3)), true));
  assert.equal(ts.shownStatusOf(first(state).attrs), "open");
  assert.equal(ts.continuedOn(first(state).attrs), "2026-11-26");
  // Bulk "done" ticks it off, bulk "open" shows it open again.
  const done = bulkTasks(state, [1], "done");
  assert.ok(done);
  state = state.apply(done!);
  assert.equal(ts.taskStatusOf(first(state).attrs), "done");
  state = state.apply(bulkTasks(state, [1], "open")!);
  assert.equal(ts.shownStatusOf(first(state).attrs), "open");
  assert.equal(ts.taskStatusOf(first(state).attrs), "cancelled");
  // Removing the marker on purpose: an ordinary open task again.
  state = state.apply(state.tr.setNodeMarkup(1, undefined, { ...first(state).attrs, ...ts.uncontinuedAttrs(first(state).attrs) }));
  assert.equal(ts.taskStatusOf(first(state).attrs), "open");
  assert.equal(ts.continuedOn(first(state).attrs), null);
  assert.equal(openTasks(state.doc).length, 1);
});

test("exports show the state it kept with the day it continues on; Markdown keeps it closed", () => {
  const html = jsonHtml(withContinuedTasks(docOf(list(li("Bericht"), li("Angebot", ' data-status="progress"'))), "2026-11-26").toJSON());
  const xhtml = documentXhtml(html, { url: (u) => u, image: () => null });
  assert.match(xhtml, /☐<\/span> Bericht <span class="continued">\(→ 2026-11-26\)<\/span>/);
  assert.match(xhtml, /◐<\/span> Angebot/);
  const jira = documentJira(html, { url: (u) => u, image: () => null });
  assert.match(jira, /\* \\\[ \\\] Bericht \(→ 2026-11-26\)/);
  const confluence = documentConfluence(html, { url: (u) => u, image: () => null });
  assert.match(confluence, /<ac:task-status>incomplete<\/ac:task-status><ac:task-body>Bericht \(→ 2026-11-26\)/);
  assert.doesNotMatch(confluence, /<s>Bericht/);
  // Markdown: "[-]", so reading it in again does not reopen it.
  assert.match(htmlToMarkdown(html, { url: (url: string) => url, linked: () => null }), /- \[-\] Bericht/);
  // Round trip of the stored HTML keeps the shown state.
  assert.match(jsonHtml(htmlJson(html)), /data-journal-was="progress"/);
});

test("a copied journal day keeps open and in-progress originals, not counted, not carried", async () => {
  const uid = id();
  await sql("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Mia", "mia@example.test");
  const owner = { id: uid, name: "Mia", email: "mia@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
  const wid = await createWorkspace(owner.id, "Stand-up");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const act = async (b: Record<string, unknown>) => (await command(owner, { workspaceId: wid, ...b })) as Record<string, unknown>;
  const page = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
  const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))?.html || "");
  const journalId = String((await act({ action: "page.create", spaceId: space, title: "Kopieren", kind: "journal" })).id);
  await act({ action: "journal.settings", pageId: journalId, options: { carry: "copy" } });
  const monday = (await rollJournal(owner, await page(journalId), "2026-11-23", "2026-11-23")).dayId;
  const body = `<p>Stand-up</p>${list(li("Bericht"), li("Angebot", ' data-status="progress"'))}`;
  await sql("UPDATE documents SET state=?,html=? WHERE page_id=?", htmlState(body), body, monday);
  await indexPageTasks(monday, false);
  const tuesday = (await rollJournal(owner, await page(journalId), "2026-11-24", "2026-11-24")).dayId;
  const before = await html(monday);
  assert.match(before, /data-journal-continued="2026-11-24" data-journal-was="open"/);
  assert.match(before, /data-journal-was="progress"/);
  // The copies on Tuesday are open with their own state and no marker.
  const after = byText(docOf(await html(tuesday)));
  assert.equal(ts.taskStatusOf(after.Angebot.attrs), "progress");
  assert.equal(after.Angebot.attrs.journalWas, null);
  assert.equal(after.Bericht.attrs.journalContinued, null);
  // My tasks: each once, on Tuesday.
  const mine = (await myTasks(owner, wid)).filter((t) => ["Bericht", "Angebot"].includes(t.text));
  assert.deepEqual(mine.map((t) => t.pageId), [tuesday, tuesday]);
  // A third day carries only Tuesday's copies again.
  const wednesday = (await rollJournal(owner, await page(journalId), "2026-11-25", "2026-11-25")).dayId;
  assert.equal((await html(wednesday)).split(">Angebot<").length - 1, 1);
  assert.match(await html(monday), /data-journal-continued="2026-11-24"/);
});
