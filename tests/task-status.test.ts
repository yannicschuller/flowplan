// The five states of a task and Ctrl/Cmd+L (#201, lib/task-status.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-task-status-"));
const { documentSchema } = await import("../lib/document-schema");
const { cycleTaskStatus, setTaskStatus, tidyTaskStatus } = await import("../lib/task-status-commands");
const { checkSubtasks } = await import("../lib/task-subtasks");
const { attrsOfSymbol, markdownSymbol, nextStatus, taskStatusOf, statusAttrs } = await import("../lib/task-status");
const { htmlJson, jsonHtml, cleanHtml } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToHtml } = await import("../lib/markdown-import");
const { extractTasks } = await import("../lib/doc-tasks");
const { openTasks, withoutOpenTasks } = await import("../lib/journal");

const schema = documentSchema();
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
const task = (text: string, attrs: Record<string, unknown> = {}, ...sub: Node[]) =>
  schema.nodes.taskItem.create({ checked: false, ...attrs }, [p(text), ...(sub.length ? [schema.nodes.taskList.create(null, sub)] : [])]);
const tasks = (...items: Node[]) => schema.nodes.taskList.create(null, items);
const doc = (...blocks: Node[]) => schema.nodes.doc.create(null, blocks);
const states = (d: Node) => {
  const out: [string, string][] = [];
  d.descendants((n) => {
    if (n.type.name === "taskItem") out.push([n.firstChild!.textContent, taskStatusOf(n.attrs)]);
    return true;
  });
  return out;
};
// Runs the command and what the editor's plugins append (subtasks, tidy).
function run(state: EditorState, command: (s: EditorState, d: (tr: Transaction) => void) => boolean) {
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
const caretIn = (d: Node, text: string) => {
  let at = -1;
  d.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text?.includes(text)) at = pos + 1;
    return at < 0;
  });
  return EditorState.create({ schema, doc: d, selection: TextSelection.create(d, at) });
};

test("the states and their attributes", () => {
  assert.deepEqual(statusAttrs("progress"), { checked: false, status: "progress", symbol: null });
  assert.deepEqual(statusAttrs("cancelled"), { checked: true, status: "cancelled", symbol: null });
  assert.deepEqual(statusAttrs("deferred"), { checked: false, status: "deferred", symbol: null });
  assert.equal(taskStatusOf({ checked: true, status: null }), "done");
  // An older client unticked a cancelled task, ticked one in progress: the box decides.
  assert.equal(taskStatusOf({ checked: false, status: "cancelled" }), "open");
  assert.equal(taskStatusOf({ checked: true, status: "progress" }), "done");
  assert.deepEqual(["open", "progress", "done", "cancelled", "deferred"].map((s) => nextStatus(s as never)), ["progress", "done", "open", "open", "open"]);
  assert.equal(markdownSymbol({ checked: false, symbol: "?" }), "?");
  assert.equal(markdownSymbol({ checked: true, symbol: "?" }), "x");
  assert.equal(attrsOfSymbol("1"), null);
  assert.deepEqual(attrsOfSymbol("X"), statusAttrs("done"));
});

test("status and symbol survive HTML and Yjs, older HTML stays as it was", () => {
  const html =
    '<ul data-type="taskList">' +
    '<li data-type="taskItem" data-checked="false"><p>Offen</p></li>' +
    '<li data-type="taskItem" data-checked="false" data-status="progress"><p>Läuft</p></li>' +
    '<li data-type="taskItem" data-checked="true"><p>Fertig</p></li>' +
    '<li data-type="taskItem" data-checked="true" data-status="cancelled"><p>Abgesagt</p></li>' +
    '<li data-type="taskItem" data-checked="false" data-status="deferred"><p>Später</p></li>' +
    '<li data-type="taskItem" data-checked="false" data-symbol="?"><p>Frage</p></li>' +
    '<li data-type="taskItem" data-checked="false" data-status="bogus" data-symbol="1"><p>Kaputt</p></li>' +
    "</ul>";
  const json = htmlJson(cleanHtml(html));
  const node = schema.nodeFromJSON(json);
  assert.deepEqual(states(node), [
    ["Offen", "open"],
    ["Läuft", "progress"],
    ["Fertig", "done"],
    ["Abgesagt", "cancelled"],
    ["Später", "deferred"],
    ["Frage", "open"],
    ["Kaputt", "open"],
  ]);
  const out = jsonHtml(json);
  assert.match(out, /data-checked="false" data-status="progress"/);
  assert.match(out, /data-checked="true" data-status="cancelled"/);
  assert.match(out, /data-status="deferred"/);
  assert.match(out, /data-symbol="\?"/);
  assert.doesNotMatch(out, /bogus|data-symbol="1"/);
  // Yjs (collaboration, offline) carries the attributes like `checked`.
  const ydoc = prosemirrorJSONToYDoc(schema, json, "default");
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
  assert.deepEqual(states(schema.nodeFromJSON(yDocToProsemirrorJSON(copy, "default"))), states(node));
  // A task without the attributes is what it was.
  assert.doesNotMatch(jsonHtml(htmlJson('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>x</p></li></ul>')), /data-status|data-symbol/);
});

test("Markdown round trip of every symbol, unknown ones kept", () => {
  const ctx = { url: (url: string) => url, linked: () => null };
  const symbols = [" ", "/", "x", "-", ">", "?", "!", "*", '"', "l", "b", "i", "S", "I", "p", "c", "f", "k", "w", "u", "d", "<"];
  const markdown = symbols.map((s, i) => `- [${s}] Aufgabe ${i}`).join("\n") + "\n- [X] Groß\n- [/]\n  - [-] Unteraufgabe";
  const html = markdownToHtml(markdown);
  const node = schema.nodeFromJSON(htmlJson(cleanHtml(html)));
  const found = states(node);
  assert.equal(found.length, symbols.length + 3);
  assert.deepEqual(found.slice(0, 5).map(([, s]) => s), ["open", "progress", "done", "cancelled", "deferred"]);
  // The unknown ones are open.
  assert.ok(found.slice(5, symbols.length).every(([, s]) => s === "open"));
  // The text has no symbol left in it.
  assert.equal(found[6][0], "Aufgabe 6");
  assert.equal(found[8][0], "Aufgabe 8");
  const back = htmlToMarkdown(html, ctx);
  assert.equal(
    back,
    symbols.map((s, i) => `- [${s === "X" ? "x" : s}] Aufgabe ${i}`).join("\n") + "\n- [x] Groß\n- [/] \n  - [-] Unteraufgabe\n",
  );
  // Not tasks: digits, longer brackets, ordered lists.
  assert.doesNotMatch(markdownToHtml("- [1] Quelle\n- [ab] zwei"), /taskItem/);
});

test("Ctrl/Cmd+L cycles a task: open → in progress → done → open", () => {
  let state = caretIn(doc(tasks(task("Angebot"))), "Angebot");
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    state = run(state, cycleTaskStatus);
    seen.push(states(state.doc)[0][1]);
  }
  assert.deepEqual(seen, ["progress", "done", "open", "progress"]);
  // Cancelled and deferred start again as open.
  for (const status of ["cancelled", "deferred"] as const) {
    const s = run(caretIn(doc(tasks(task("A", statusAttrs(status)))), "A"), cycleTaskStatus);
    assert.equal(states(s.doc)[0][1], "open");
  }
  // An unknown symbol goes once the task moves on.
  const sym = run(caretIn(doc(tasks(task("Frage", { symbol: "?" }))), "Frage"), cycleTaskStatus);
  assert.equal(sym.doc.firstChild!.firstChild!.attrs.symbol, null);
});

test("Ctrl/Cmd+L with several lines: all follow the first one", () => {
  const d = doc(tasks(task("Eins"), task("Zwei", statusAttrs("done")), task("Drei", statusAttrs("cancelled"))));
  let from = -1,
    to = -1;
  d.descendants((n, pos) => {
    if (n.isText && n.text === "Eins") from = pos + 1;
    if (n.isText && n.text === "Drei") to = pos + 3;
    return true;
  });
  const state = run(EditorState.create({ schema, doc: d, selection: TextSelection.create(d, from, to) }), cycleTaskStatus);
  assert.deepEqual(states(state.doc).map(([, s]) => s), ["progress", "progress", "progress"]);
});

test("Ctrl/Cmd+L on a plain line or a list item makes it a task", () => {
  const paragraph = run(caretIn(doc(p("Einkaufen")), "Einkaufen"), cycleTaskStatus);
  assert.deepEqual(states(paragraph.doc), [["Einkaufen", "open"]]);
  // Again: in progress.
  assert.deepEqual(states(run(paragraph, cycleTaskStatus).doc), [["Einkaufen", "progress"]]);
  // In a bulleted list only that item; the list is split around it.
  const li = (text: string) => schema.nodes.listItem.create(null, p(text));
  const list = doc(schema.nodes.bulletList.create(null, [li("A"), li("B"), li("C")]));
  const state = run(caretIn(list, "B"), cycleTaskStatus);
  assert.deepEqual(
    state.doc.content.content.map((n) => n.type.name),
    ["bulletList", "taskList", "bulletList"],
  );
  assert.deepEqual(states(state.doc), [["B", "open"]]);
  // The caret stays in the line.
  assert.equal(state.selection.$from.parent.textContent, "B");
  // A numbered list goes on with its number.
  const numbered = run(caretIn(doc(schema.nodes.orderedList.create({ start: 1 }, [li("A"), li("B"), li("C")])), "A"), cycleTaskStatus);
  assert.deepEqual(numbered.doc.content.content.map((n) => [n.type.name, n.attrs.start ?? null]), [["taskList", null], ["orderedList", 2]]);
});

test("the menu sets a state; the box clicked afterwards gives open or done", () => {
  let state = caretIn(doc(tasks(task("Umzug", {}, task("Kartons"), task("Wagen", statusAttrs("progress"))))), "Umzug");
  state = run(state, (s, d) => setTaskStatus(s, d, "cancelled", [1]));
  // Cancelling cancels the open subtasks.
  assert.deepEqual(states(state.doc), [["Umzug", "cancelled"], ["Kartons", "cancelled"], ["Wagen", "cancelled"]]);
  // A click on the box (only `checked` changes, as TipTap's node view does it).
  state = run(state, (s, d) => (d(s.tr.setNodeMarkup(1, undefined, { ...s.doc.nodeAt(1)!.attrs, checked: false })), true));
  assert.equal(state.doc.nodeAt(1)!.attrs.status, null);
  assert.equal(states(state.doc)[0][1], "open");
  // In progress clicked: done.
  let progress = caretIn(doc(tasks(task("X", statusAttrs("progress")))), "X");
  progress = run(progress, (s, d) => (d(s.tr.setNodeMarkup(1, undefined, { ...s.doc.nodeAt(1)!.attrs, checked: true })), true));
  assert.deepEqual(progress.doc.nodeAt(1)!.attrs.status, null);
  assert.equal(states(progress.doc)[0][1], "done");
});

test("My tasks, reminders and the journal: in progress, deferred and unknown symbols are open, cancelled is closed", () => {
  const d = doc(
    tasks(
      task("Offen"),
      task("Läuft", statusAttrs("progress")),
      task("Fertig", statusAttrs("done")),
      task("Abgesagt", statusAttrs("cancelled")),
      task("Später", statusAttrs("deferred")),
      task("Frage", { symbol: "?" }),
      task(""),
    ),
  );
  const extracted = extractTasks(d.toJSON());
  assert.deepEqual(
    extracted.map((t) => [t.text, t.checked, t.status]),
    [
      ["Offen", false, "open"],
      ["Läuft", false, "progress"],
      ["Fertig", true, "done"],
      ["Abgesagt", true, "cancelled"],
      ["Später", false, "deferred"],
      ["Frage", false, "open"],
      ["", false, "open"],
    ],
  );
  // Carried to the next day: everything open, not done, cancelled or empty.
  assert.deepEqual(openTasks(d).map((t) => t.firstChild!.textContent), ["Offen", "Läuft", "Später", "Frage"]);
  // What is carried leaves the day before; the empty task stays there.
  assert.deepEqual(states(withoutOpenTasks(d)).map(([text]) => text), ["Fertig", "Abgesagt", ""]);
});
