// #431: "ändern zu aufgaben zum abhaken" on a bulleted list answered with the
// same list. The prompts (server and device) now name the Markdown the
// editor imports and tell a free instruction it may change the block type;
// checkboxes as models write them become tasks; the selection goes along
// with its structure; and "Umwandeln in" turns lists locally, without AI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR ||= mkdtempSync(join(tmpdir(), "flowplan-ai-block-types-"));

const { documentExtensions, documentSchema } = await import("../lib/document-schema");
const { generateJSON } = await import("@tiptap/html/server");
const { EditorState } = await import("@tiptap/pm/state");
const { aiMarkdownToHtml, aiInsertTransaction, selectionText, taskMarkers } = await import("../lib/ai/insert");
const { writePrompt } = await import("../lib/ai/prompts");
const { deviceWritePrompt } = await import("../lib/ai/device-prompts");
const { listTurnTransaction } = await import("../lib/ai/list-turn");
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

const schema = documentSchema();
const blocksOf = (markdown: string) => schema.nodeFromJSON(generateJSON(aiMarkdownToHtml(markdown) || "<p></p>", documentExtensions)).content;
const stateOf = (html: string) => EditorState.create({ doc: schema.nodeFromJSON(generateJSON(html, documentExtensions)) });
const shape = (node: ProseMirrorNode): unknown =>
  node.isTextblock
    ? node.type.name === "paragraph"
      ? node.textContent
      : `${node.type.name}:${node.textContent}`
    : { [node.type.name + (node.type.name === "taskItem" ? (node.attrs.checked ? "[x]" : "[ ]") : "")]: node.content.content.map(shape) };
const shapes = (fragment: { forEach: (f: (n: ProseMirrorNode) => void) => void }) => {
  const list: unknown[] = [];
  fragment.forEach((node) => list.push(shape(node)));
  return list;
};
function textPos(doc: ProseMirrorNode, needle: string) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(needle)) found = pos + node.text!.indexOf(needle);
    return found < 0;
  });
  assert.ok(found >= 0, needle);
  return found;
}

test("prompts: the Markdown subset with tasks, and a free instruction may change the block type", () => {
  const custom = writePrompt({ action: "custom", instruction: "ändern zu aufgaben zum abhaken", text: "- Milch\n- Brot", locale: "de" });
  assert.match(custom.system!, /"- \[ \] " tasks to tick off/);
  assert.match(custom.system!, /"1\. " numbered lists/);
  assert.match(custom.system!, /"> " quotes/);
  assert.match(custom.system!, /change the block type itself/);
  assert.match(custom.system!, /every task as "- \[ \] task"/);
  assert.match(custom.system!, /Never answer with the original structure unchanged/);
  assert.match(custom.messages[0].content, /<text>\n- Milch\n- Brot\n<\/text>/);
  // Fixed actions keep their formatting rule, but know the subset too.
  const improve = writePrompt({ action: "improve", text: "- Milch\n- Brot", locale: "de" });
  assert.match(improve.system!, /"- \[ \] " tasks/);
  assert.doesNotMatch(improve.system!, /change the block type/);
  // The free prompt at the caret: tasks as Markdown tasks.
  assert.match(writePrompt({ action: "prompt", instruction: "Einkaufsliste", locale: "de" }).system!, /tasks to tick off as "- \[ \] task"/);

  // On the device, in each language of its instructions.
  const de = deviceWritePrompt({ action: "custom", instruction: "ändern zu aufgaben zum abhaken", text: "- Milch\n- Brot", locale: "de" });
  assert.match(de.instructions, /Aufgaben zum Abhaken „- \[ \] Aufgabe“/);
  assert.match(de.instructions, /„1\. Punkt“/);
  assert.match(de.instructions, /andere Form .*ändere die Form/);
  assert.match(de.instructions, /nie die alte Form unverändert/);
  assert.match(de.prompt, /Text:\n- Milch\n- Brot$/);
  const en = deviceWritePrompt({ action: "custom", instruction: "make this a checklist", text: "- milk\n- bread", locale: "en" });
  assert.match(en.instructions, /tasks to tick off “- \[ \] task”/);
  assert.match(en.instructions, /change the form/);
  const fr = deviceWritePrompt({ action: "custom", instruction: "en tâches", text: "- lait", locale: "fr" });
  assert.match(fr.instructions, /tâches à cocher « - \[ \] tâche »/);
  assert.match(fr.instructions, /change la forme/);
  assert.doesNotMatch(deviceWritePrompt({ action: "improve", text: "- Milch", locale: "de" }).instructions, /ändere die Form/);
  // A quick capture keeps its note short: no Markdown list there.
  assert.doesNotMatch(deviceWritePrompt({ action: "improve", text: "Milch #einkauf", locale: "de", capture: true }).instructions, /Aufgaben zum Abhaken/);
});

test("answers: checkboxes as models write them become tasks; numbered lists, headings, quotes become their blocks", () => {
  assert.equal(taskMarkers("- [] Milch\n- [ ]Brot\n[ ] Eier\n[x] Butter\n☐ Käse\n- ☑ Salz\n1. [ ] Mehl\n* [X] Zucker"), "- [ ] Milch\n- [ ] Brot\n- [ ] Eier\n- [x] Butter\n- [ ] Käse\n- [x] Salz\n- [ ] Mehl\n- [x] Zucker");
  // Untouched: proper tasks, links, code, plain bullets.
  const kept = "- [ ] ok\n- [x] done\n[Link](https://example.org)\n- Punkt\n```\n[ ] im Code\n```";
  assert.equal(taskMarkers(kept), kept);
  assert.deepEqual(shapes(blocksOf("- [] Milch\n- [] Brot")), [{ taskList: [{ "taskItem[ ]": ["Milch"] }, { "taskItem[ ]": ["Brot"] }] }]);
  assert.deepEqual(shapes(blocksOf("☐ Milch\n☒ Brot")), [{ taskList: [{ "taskItem[ ]": ["Milch"] }, { "taskItem[x]": ["Brot"] }] }]);
  assert.deepEqual(shapes(blocksOf("- [ ] Milch\n  - [ ] fettarm\n- [x] Brot")), [
    { taskList: [{ "taskItem[ ]": ["Milch", { taskList: [{ "taskItem[ ]": ["fettarm"] }] }] }, { "taskItem[x]": ["Brot"] }] },
  ]);
  assert.deepEqual(shapes(blocksOf("1. Milch\n2. Brot")), [{ orderedList: [{ listItem: ["Milch"] }, { listItem: ["Brot"] }] }]);
  assert.deepEqual(shapes(blocksOf("## Einkauf\n\n> Nicht vergessen")), ["heading:Einkauf", { blockquote: ["Nicht vergessen"] }]);
  assert.deepEqual(shapes(blocksOf("| A | B |\n|---|---|\n| 1 | 2 |")).map((s) => Object.keys(s as object)[0]), ["table"]);
});

test("Ersetzen with a task answer: the selected bulleted list becomes a task list", () => {
  const state = stateOf("<p>Vorher</p><ul><li><p>Milch</p></li><li><p>Brot</p></li></ul><p>Nachher</p>");
  const range = { from: textPos(state.doc, "Milch"), to: textPos(state.doc, "Brot") + 4 };
  assert.equal(selectionText(state.doc, range.from, range.to), "- Milch\n- Brot");
  const next = state.apply(aiInsertTransaction(state, blocksOf("- [ ] Milch\n- [ ] Brot"), range, "replace")!);
  assert.deepEqual(shapes(next.doc), ["Vorher", { taskList: [{ "taskItem[ ]": ["Milch"] }, { "taskItem[ ]": ["Brot"] }] }, "Nachher"]);
  // As a numbered list, a heading.
  const numbered = state.apply(aiInsertTransaction(state, blocksOf("1. Milch\n2. Brot"), range, "replace")!);
  assert.deepEqual(shapes(numbered.doc), ["Vorher", { orderedList: [{ listItem: ["Milch"] }, { listItem: ["Brot"] }] }, "Nachher"]);
  const heading = state.apply(aiInsertTransaction(state, blocksOf("## Milch und Brot"), range, "replace")!);
  assert.deepEqual(shapes(heading.doc), ["Vorher", "heading:Milch und Brot", "Nachher"]);
});

test("the selection goes to the model with numbers, boxes, nesting and quotes", () => {
  const state = stateOf(
    '<ol start="3"><li><p>drei</p></li><li><p>vier</p><ul><li><p>unter</p></li></ul></li></ol><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>fertig</p></li><li data-type="taskItem" data-checked="false"><p>offen</p></li></ul><blockquote><p>Zitat</p></blockquote><h3>Titel</h3>',
  );
  assert.equal(selectionText(state.doc, 0, state.doc.content.size), "3. drei\n4. vier\n   - unter\n- [x] fertig\n- [ ] offen\n> Zitat\n### Titel");
});

test("Umwandeln in: lists and paragraphs turn locally, items keep their text, marks and sub-items", () => {
  const html = '<p>Vorher</p><ul><li data-block-id="a"><p>Milch <strong>fett</strong></p><ul><li><p>Sorte</p></li></ul></li><li><p>Brot</p></li></ul><p>Nachher</p>';
  let state = stateOf(html);
  const whole = { from: textPos(state.doc, "Milch"), to: textPos(state.doc, "Brot") + 4 };
  const tasks = state.apply(listTurnTransaction(state, whole, "taskList")!);
  assert.deepEqual(shapes(tasks.doc), ["Vorher", { taskList: [{ "taskItem[ ]": ["Milch fett", { taskList: [{ "taskItem[ ]": ["Sorte"] }] }] }, { "taskItem[ ]": ["Brot"] }] }, "Nachher"]);
  let bold = false;
  tasks.doc.descendants((node) => {
    if (node.isText && node.text === "fett") bold = node.marks.some((m) => m.type.name === "bold");
  });
  assert.ok(bold, "marks stay");
  // Already tasks: nothing to do.
  assert.equal(listTurnTransaction(tasks, { from: textPos(tasks.doc, "Milch"), to: textPos(tasks.doc, "Brot") + 4 }, "taskList"), null);
  // A done task back to tasks keeps its state; to numbers and back.
  state = stateOf('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>eins</p></li><li data-type="taskItem" data-checked="false"><p>zwei</p></li></ul>');
  const all = () => ({ from: 1, to: state.doc.content.size - 1 });
  state = state.apply(listTurnTransaction(state, all(), "orderedList")!);
  assert.deepEqual(shapes(state.doc), [{ orderedList: [{ listItem: ["eins"] }, { listItem: ["zwei"] }] }]);
  state = state.apply(listTurnTransaction(state, all(), "bulletList")!);
  assert.deepEqual(shapes(state.doc), [{ bulletList: [{ listItem: ["eins"] }, { listItem: ["zwei"] }] }]);
  // Only some items: the list is split around them.
  state = stateOf("<ol><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ol>");
  state = state.apply(listTurnTransaction(state, { from: textPos(state.doc, "b"), to: textPos(state.doc, "b") + 1 }, "taskList")!);
  assert.deepEqual(shapes(state.doc), [{ orderedList: [{ listItem: ["a"] }] }, { taskList: [{ "taskItem[ ]": ["b"] }] }, { orderedList: [{ listItem: ["c"] }] }]);
  assert.equal(state.doc.child(2).attrs.start, 3, "numbering goes on");
  // Paragraphs and a heading become tasks; a table in between stays.
  state = stateOf("<h2>Einkauf</h2><p>Milch</p><p></p><p>Brot</p><table><tbody><tr><td><p>x</p></td></tr></tbody></table><p>Eier</p>");
  state = state.apply(listTurnTransaction(state, { from: 1, to: state.doc.content.size - 1 }, "taskList")!);
  const names = shapes(state.doc).map((s) => (typeof s === "string" ? s : Object.keys(s as object)[0]));
  assert.deepEqual(names, ["taskList", "table", "taskList"]);
  assert.deepEqual(shapes(state.doc)[0], { taskList: [{ "taskItem[ ]": ["Einkauf"] }, { "taskItem[ ]": ["Milch"] }, { "taskItem[ ]": ["Brot"] }] });
});
