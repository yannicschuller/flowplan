// "Formatierungsleiste" (#235, lib/toolbar-pref.ts, lib/user-formatting-toolbar.ts):
// whether pages and records show the fixed formatting toolbar, saved per
// person on the server, validated and delivered with the bootstrap; and
// what "Umwandeln in" at the start of the full text menu shows
// (lib/text-menu-turn.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-toolbar-pref-"));
const win = new Window({ url: "https://flowplan.test/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "Element", "getComputedStyle", "MutationObserver", "DOMParser"]) {
  if (!(key in g)) g[key] = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
}
after(async () => {
  await win.happyDOM.close();
});
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const pref = { ...(await import("../lib/toolbar-pref")), ...(await import("../lib/toolbar-pref-client")) };
const { currentTextBlock, sameKind, CLEARED_MARKS } = await import("../lib/text-menu-turn");
const { documentSchema } = await import("../lib/document-schema");
const { textMenuMarks } = await import("../lib/text-menu-placement");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("the toolbar shows by default; hidden only by the setting, and never on a touch phone's keyboard", () => {
  assert.equal(pref.DEFAULT_FORMATTING_TOOLBAR, "show");
  assert.equal(pref.showsFormattingToolbar("show", false), true);
  assert.equal(pref.showsFormattingToolbar("hide", false), false);
  assert.equal(pref.showsFormattingToolbar("hide", true), true, "the row docked on the keyboard stays");
  for (const value of [null, undefined, "", "off", 0, false, "HIDE"]) assert.equal(pref.formattingToolbarOf(value), "show", String(value));
  assert.equal(pref.formattingToolbarOf("hide"), "hide");
});

test("without the toolbar the text menu offers every mark (#210 trims them only next to it)", () => {
  assert.deepEqual(textMenuMarks(true), ["bold", "italic", "code"]);
  assert.deepEqual(textMenuMarks(false), ["bold", "italic", "underline", "strike", "highlight", "code"]);
});

test("the browser's copy changes with the bootstrap and tells its listeners", () => {
  assert.equal(pref.formattingToolbar(), "show");
  pref.setFormattingToolbarLocal("hide");
  assert.equal(pref.formattingToolbar(), "hide");
  pref.setFormattingToolbarLocal(undefined);
  assert.equal(pref.formattingToolbar(), "show", "a bootstrap without the field means the default");
});

test("each person saves the choice; it comes with the bootstrap and is validated", async () => {
  const anna = await account("toolbar-anna"),
    ben = await account("toolbar-ben");
  const wid = await createWorkspace(anna.id, "Leiste");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.equal((await bootstrap(anna, wid)).formattingToolbar, "show", "never chosen: the default");
  assert.equal((await one<{ formatting_toolbar: string | null }>("SELECT formatting_toolbar FROM users WHERE id=?", anna.id))?.formatting_toolbar, null);
  assert.deepEqual(await command(anna, { action: "profile.formattingToolbar", formattingToolbar: "hide" }), { formattingToolbar: "hide" });
  assert.equal((await bootstrap(anna, wid)).formattingToolbar, "hide");
  assert.equal((await bootstrap(ben, wid)).formattingToolbar, "show", "only for that person");
  for (const bad of ["hidden", "", null, true, 0, undefined, { value: "hide" }])
    await rejects(() => command(anna, { action: "profile.formattingToolbar", formattingToolbar: bad }));
  assert.equal((await bootstrap(anna, wid)).formattingToolbar, "hide", "a rejected value changes nothing");
  await command(anna, { action: "profile.formattingToolbar", formattingToolbar: "show" });
  assert.equal((await bootstrap(anna, wid)).formattingToolbar, "show");
  await run("UPDATE users SET formatting_toolbar=? WHERE id=?", "bogus", ben.id);
  assert.equal((await bootstrap(ben, wid)).formattingToolbar, "show", "a value written elsewhere reads as the default");
});

test("“Turn into” names the block the selection starts in", () => {
  const schema = documentSchema();
  const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
  const doc = schema.nodes.doc.create(null, [
    p("Absatz"),
    schema.nodes.heading.create({ level: 2 }, schema.text("Titel")),
    schema.nodes.bulletList.create(null, schema.nodes.listItem.create(null, p("Punkt"))),
    schema.nodes.taskList.create(null, schema.nodes.taskItem.create({ checked: false }, p("Aufgabe"))),
    schema.nodes.blockquote.create(null, p("Zitat")),
    schema.nodes.codeBlock.create(null, schema.text("x = 1")),
  ]);
  const at = (text: string) => {
    let found = -1;
    doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text === text) found = pos + 1;
    });
    return currentTextBlock(EditorState.create({ schema, doc, selection: TextSelection.create(doc, found) }));
  };
  assert.deepEqual(at("Absatz")?.kind, { type: "paragraph" });
  assert.deepEqual(at("Titel")?.kind, { type: "heading", level: 2 });
  assert.deepEqual(at("Punkt")?.kind, { type: "bulletList" });
  assert.equal(doc.nodeAt(at("Punkt")!.pos)?.type.name, "listItem", "a list item is turned as a whole");
  assert.deepEqual(at("Aufgabe")?.kind, { type: "taskList" });
  assert.deepEqual(at("Zitat")?.kind, { type: "blockquote" });
  assert.deepEqual(at("x = 1")?.kind, { type: "codeBlock" });
  assert.equal(sameKind({ type: "heading", level: 2 }, { type: "heading", level: 3 }), false);
  assert.equal(sameKind({ type: "heading", level: 2 }, { type: "heading", level: 2 }), true);
  // Clearing keeps links and comments.
  assert.ok(!CLEARED_MARKS.includes("link"));
  for (const name of CLEARED_MARKS) assert.ok(schema.marks[name], `${name} exists in the schema`);
});
