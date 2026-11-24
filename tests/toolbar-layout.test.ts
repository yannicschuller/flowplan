// "Formatierungsleiste anpassen" (#292, lib/toolbar-layout.ts,
// lib/user-toolbar-layout.ts): the stored layout of the formatting toolbar
// is read leniently (unknown buttons dropped, new buttons at their default
// place, dividers tidied), saved strictly per person and delivered with the
// bootstrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-toolbar-layout-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const L = await import("../lib/toolbar-layout");
const { textMenuMarks } = await import("../lib/text-menu-placement");

const items = (order: readonly (string | string[])[]) => order.flatMap((e) => (Array.isArray(e) ? e : e === "|" ? [] : [e]));

test("the default lists every button once, in groups", () => {
  const layout = L.defaultToolbarLayout();
  assert.deepEqual([...items(layout.order)].sort(), [...L.TOOLBAR_BUTTONS].sort());
  assert.deepEqual(items(layout.order), [...L.TOOLBAR_BUTTONS], "the default order is the item order");
  assert.equal(layout.order.filter((e) => e === "|").length, 2);
  assert.deepEqual(layout.hidden, ["bulletList", "orderedList", "indent", "outdent", "cloze"], "the lists new in #292, indent / outdent (#302) and the cloze (flashcards) start hidden: the toolbar stays as it was");
  assert.ok(L.isDefaultToolbarLayout(L.toolbarLayoutOf(null)));
  for (const bad of [undefined, "", "{", "[]", 3, true, {}, { order: "bold" }, { hidden: ["bold"] }])
    assert.ok(L.isDefaultToolbarLayout(L.toolbarLayoutOf(bad)), JSON.stringify(bad));
});

test("a stored layout is read leniently: unknown and duplicate buttons dropped, dividers tidied", () => {
  const layout = L.toolbarLayoutOf(
    JSON.stringify({
      order: ["|", "bold", "bold", "rocket", "|", "|", "italic", "undo", "|"],
      hidden: ["italic", "rocket", "italic"],
    }),
  );
  assert.deepEqual(layout.order.slice(0, 3), ["bold", "|", "italic"]);
  assert.equal(layout.order[layout.order.indexOf("undo") + 1], "redo", "a missing button follows its default predecessor");
  assert.equal(layout.order[layout.order.indexOf("italic") + 1], "underline");
  assert.notEqual(layout.order[layout.order.length - 1], "|");
  assert.ok(!layout.order.some((e, i) => e === "|" && layout.order[i + 1] === "|"), "never two dividers in a row");
  assert.deepEqual([...items(layout.order)].sort(), [...L.TOOLBAR_BUTTONS].sort(), "every known button is in the order");
  assert.deepEqual(layout.hidden, ["italic", "cloze", "bulletList", "orderedList", "indent", "outdent"], "missing buttons the default hides start hidden");
});

test("buttons missing from a stored layout (added in a later version) appear at their default place, shown", () => {
  // A layout saved before "spoiler" and "suggest" existed, with bold moved
  // to the end.
  const old = L.DEFAULT_TOOLBAR_ORDER.filter((e) => e !== "spoiler" && e !== "suggest" && e !== "bold");
  const layout = L.toolbarLayoutOf({ order: [...old, "bold"], hidden: ["underline"] });
  const at = (e: string) => layout.order.indexOf(e as never);
  assert.equal(at("spoiler"), at("subscript") + 1, "after the button it follows by default");
  assert.equal(at("cloze"), at("spoiler") + 1);
  assert.equal(at("suggest"), at("cloze") + 1);
  assert.equal(layout.order[layout.order.length - 1], "bold", "the person's own order stays");
  assert.ok(!layout.hidden.includes("spoiler") && !layout.hidden.includes("suggest"), "new buttons are not hidden");
  assert.deepEqual(layout.hidden, ["underline"]);
  // A new first button goes to the start.
  const noUndo = L.toolbarLayoutOf({ order: L.DEFAULT_TOOLBAR_ORDER.filter((e) => e !== "undo"), hidden: [] });
  assert.equal(noUndo.order[0], "undo");
  // The default's predecessor moved: the new button follows it there.
  const moved = L.toolbarLayoutOf({ order: ["addBlock", "subscript", "|", "undo"], hidden: [] });
  assert.equal(moved.order[moved.order.indexOf("subscript") + 1], "spoiler");
});

test("inline code (#465): right after strikethrough, shown, also in a layout stored before it", () => {
  const layout = L.defaultToolbarLayout();
  assert.equal(layout.order[layout.order.indexOf("strike") + 1], "code", "after strikethrough by default");
  assert.ok(!layout.hidden.includes("code"), "shown by default");
  assert.ok(L.isGroupableItem("code"), "it can share a group");
  assert.ok(L.isToolbarItem("block:code") && !L.isToolbarBlock("code"), "not the code block of the \"/\" menu");
  // A layout saved before it: the button comes in after strikethrough,
  // shown; the person's order and hidden buttons stay.
  const before = { order: [...L.DEFAULT_TOOLBAR_ORDER.filter((e) => e !== "code" && e !== "bold"), "bold"], hidden: ["underline"] };
  assert.ok(L.toolbarLayoutSchema.safeParse(before).success, "still a valid layout to save");
  const read = L.toolbarLayoutOf(before);
  assert.equal(read.order[read.order.indexOf("strike") + 1], "code");
  assert.equal(read.order[read.order.length - 1], "bold");
  assert.deepEqual(read.hidden, ["underline"]);
  assert.ok(L.toolbarEntries(read).includes("code"));
  // Strikethrough in a group: after the group. Strikethrough hidden: still
  // after it, shown.
  const grouped = L.toolbarLayoutOf({ order: ["bold", ["strike", "superscript", "subscript"], "spoiler", "cloze", "suggest", "authors", "link"], hidden: ["strike"] });
  assert.equal(grouped.order[L.entryIndexOf(grouped.order, "strike") + 1], "code");
  assert.ok(!grouped.hidden.includes("code"));
  // The instance's default (stored the same way) gets it too.
  const instance = L.toolbarLayoutOf(null, L.toolbarLayoutOf({ order: ["undo", "strike", "link"], hidden: [] }));
  assert.equal(instance.order[instance.order.indexOf("strike") + 1], "code");
  // Hidden on request; grouped with strikethrough.
  assert.deepEqual(L.setToolbarItemShown(layout, "code", false).hidden.includes("code"), true);
  assert.ok(L.toolbarLayoutSchema.safeParse({ order: [["strike", "code"], "bold"], hidden: [] }).success);
});

test("indent and outdent (#302): a layout stored before them stays valid and renders as before", () => {
  const before = { order: L.DEFAULT_TOOLBAR_ORDER.filter((e) => e !== "indent" && e !== "outdent"), hidden: ["italic"] };
  assert.ok(L.toolbarLayoutSchema.safeParse(before).success, "still a valid layout to save");
  const layout = L.toolbarLayoutOf(before);
  const at = (e: string) => layout.order.indexOf(e as never);
  assert.equal(at("indent"), at("blockDown") + 1, "at their default place");
  assert.equal(at("outdent"), at("indent") + 1);
  assert.deepEqual(layout.hidden, ["italic", "indent", "outdent"], "hidden: nothing new shows without a choice");
  assert.deepEqual(L.toolbarEntries(layout), L.toolbarEntries(before as never), "the toolbar looks as before");
  // Shown on request, and they can share a group.
  const shown = L.setToolbarItemShown(L.setToolbarItemShown(layout, "indent", true), "outdent", true);
  assert.ok(L.toolbarEntries(shown).includes("indent") && L.toolbarEntries(shown).includes("outdent"));
  assert.ok(L.canGroupWithNext(shown, at("indent")));
  assert.ok(L.toolbarLayoutSchema.safeParse({ order: [["indent", "outdent"], "bold"], hidden: [] }).success);
});

test("what the toolbar renders: hidden and inapplicable buttons left out, dividers only between buttons", () => {
  const layout: import("../lib/toolbar-layout").ToolbarLayout = {
    order: ["undo", "|", "imageTools", "|", "bold", "italic", "|", "link"],
    hidden: ["link"],
  };
  const noImage = (item: string) => item !== "imageTools";
  assert.deepEqual(L.toolbarEntries(layout, noImage), ["undo", "|", "bold", "italic"]);
  assert.deepEqual(L.toolbarEntries(layout), ["undo", "|", "imageTools", "|", "bold", "italic"]);
  assert.deepEqual(L.toolbarEntries({ order: ["|", "bold", "|"], hidden: ["bold"] }), []);
});

test("edits in the settings: move, show and hide, add and remove dividers", () => {
  let layout: import("../lib/toolbar-layout").ToolbarLayout = { order: ["undo", "redo", "bold"], hidden: [] };
  layout = L.moveToolbarEntry(layout, 0, 1);
  assert.deepEqual(layout.order.slice(0, 3), ["redo", "undo", "bold"]);
  assert.equal(L.moveToolbarEntry(layout, 0, -1), layout, "out of range changes nothing");
  layout = L.addToolbarDivider(layout, 0);
  assert.deepEqual(layout.order.slice(0, 4), ["redo", "|", "undo", "bold"]);
  assert.equal(L.addToolbarDivider(layout, 0), layout, "no second divider next to one");
  assert.equal(L.addToolbarDivider(layout, layout.order.length - 1), layout, "none at the end");
  layout = L.setToolbarItemShown(layout, "bold", false);
  assert.deepEqual(layout.hidden, ["bold"]);
  layout = L.setToolbarItemShown(layout, "bold", true);
  assert.deepEqual(layout.hidden, []);
  assert.equal(L.removeToolbarEntry(layout, 0), layout, "only dividers are removed");
  layout = L.removeToolbarEntry(layout, 1);
  assert.deepEqual(layout.order.slice(0, 3), ["redo", "undo", "bold"]);
});

test("groups: read leniently, rendered as one entry, a button once across groups", () => {
  const layout = L.toolbarLayoutOf({
    order: [["bulletList", "orderedList", "taskList"], "|", ["strike", "rocket", "color", "superscript"], ["bold", "bulletList"], ["italic"], []],
    hidden: [],
  });
  const placed = new Set(["bulletList", "orderedList", "taskList", "|", "strike", "superscript", "bold", "italic"]);
  assert.deepEqual(
    layout.order.filter((e) => (Array.isArray(e) ? e.every((i) => placed.has(i)) : placed.has(e))),
    [["bulletList", "orderedList", "taskList"], "|", ["strike", "superscript"], "bold", "italic"],
    "unknown, ungroupable and repeated buttons leave a group; one left is a button",
  );
  assert.deepEqual([...items(layout.order)].sort(), [...L.TOOLBAR_BUTTONS].sort());
  assert.equal(layout.order.indexOf("color" as never) >= 0, true, "an ungroupable button is put back on its own");
  // A missing button follows the group holding its default predecessor.
  const at = L.entryIndexOf(layout.order, "subscript");
  assert.equal(at, L.entryIndexOf(layout.order, "superscript") + 1);
  assert.deepEqual(layout.hidden, ["cloze", "indent", "outdent"], "lists the person placed are shown (the cloze, indent and outdent, left out, keep their default)");
  // Rendering: hidden members leave the group; one left is a button.
  const shown = (hidden: import("../lib/toolbar-layout").ToolbarItem[]) =>
    L.toolbarEntries({ order: [["bulletList", "orderedList", "taskList"], "|", "bold"], hidden });
  assert.deepEqual(shown([]), [["bulletList", "orderedList", "taskList"], "|", "bold"]);
  assert.deepEqual(shown(["orderedList"]), [["bulletList", "taskList"], "|", "bold"]);
  assert.deepEqual(shown(["orderedList", "bulletList"]), ["taskList", "|", "bold"]);
  assert.deepEqual(shown(["orderedList", "bulletList", "taskList"]), ["bold"]);
});

test("group edits: with the next, out of the group, within it, ungroup, presets", () => {
  let layout: import("../lib/toolbar-layout").ToolbarLayout = { order: ["bold", "italic", "color", "underline", "strike"], hidden: [] };
  assert.equal(L.canGroupWithNext(layout, 1), false, "colour is a menu of its own");
  layout = L.groupWithNext(layout, 0);
  assert.deepEqual(layout.order, [["bold", "italic"], "color", "underline", "strike"]);
  layout = L.groupWithNext(layout, 2);
  layout = L.groupWithNext(layout, 0);
  assert.deepEqual(layout.order, [["bold", "italic"], "color", ["underline", "strike"]], "colour cannot join");
  layout = L.moveToolbarEntry(layout, 1, 2);
  layout = L.groupWithNext(layout, 0);
  assert.deepEqual(layout.order, [["bold", "italic", "underline", "strike"], "color"], "two groups merge");
  layout = L.moveInGroup(layout, 0, 3, 0);
  assert.deepEqual(layout.order[0], ["strike", "bold", "italic", "underline"]);
  layout = L.takeOutOfGroup(layout, 0, 0);
  assert.deepEqual(layout.order, [["bold", "italic", "underline"], "strike", "color"]);
  layout = L.ungroupToolbarEntry(layout, 0);
  assert.deepEqual(layout.order, ["bold", "italic", "underline", "strike", "color"]);
  layout = L.takeOutOfGroup({ order: [["bold", "italic"]], hidden: [] }, 0, 0);
  assert.deepEqual(layout.order, ["italic", "bold"], "a group of two becomes two buttons");

  // Presets: from the default, the lists together where the first was, shown.
  let preset = L.applyGroupPreset(L.defaultToolbarLayout(), "lists");
  assert.ok(L.hasGroupPreset(preset, "lists"));
  assert.ok(!preset.hidden.includes("bulletList") && !preset.hidden.includes("orderedList"));
  assert.equal(preset.order[preset.order.indexOf("heading") + 1].toString(), "bulletList,orderedList,taskList");
  preset = L.applyGroupPreset(preset, "scripts");
  assert.ok(L.hasGroupPreset(preset, "scripts"));
  assert.equal(preset.order[preset.order.indexOf("underline") + 1].toString(), "strike,superscript,subscript", "where strikethrough was");
  assert.deepEqual([...items(preset.order)].sort(), [...L.TOOLBAR_BUTTONS].sort(), "nothing lost");
  // A preset over an existing group takes its buttons out of it.
  const mixed = L.applyGroupPreset({ order: [["taskList", "bold"], "italic"], hidden: [] }, "lists");
  assert.deepEqual(mixed.order, [["bulletList", "orderedList", "taskList"], "bold", "italic"]);
  assert.ok(L.toolbarLayoutSchema.safeParse(preset).success, "what the settings save passes the server");
});

test("the server accepts only known buttons, each once, bounded", () => {
  const ok = (v: unknown) => L.toolbarLayoutSchema.safeParse(v).success;
  assert.ok(ok(null));
  assert.ok(ok({ order: ["bold", "|", "italic"], hidden: ["bold"] }));
  assert.ok(ok(L.defaultToolbarLayout()));
  assert.ok(!ok(undefined));
  assert.ok(!ok({ order: ["bold", "rocket"], hidden: [] }), "unknown button");
  assert.ok(!ok({ order: ["bold", "bold"], hidden: [] }), "twice");
  assert.ok(!ok({ order: ["bold"], hidden: ["italic", "italic"] }));
  assert.ok(!ok({ order: ["bold"], hidden: ["|"] }));
  assert.ok(!ok({ order: Array(L.TOOLBAR_ORDER_MAX + 1).fill("|"), hidden: [] }), "too long");
  assert.ok(!ok({ order: [], hidden: [], extra: 1 }), "no other fields");
  assert.ok(!ok({ order: "bold", hidden: [] }));
  assert.ok(ok({ order: [["bold", "italic"], "|", "color"], hidden: [] }));
  assert.ok(!ok({ order: [["bold"]], hidden: [] }), "a group has two buttons at least");
  assert.ok(!ok({ order: [["bold", "color"]], hidden: [] }), "only groupable buttons");
  assert.ok(!ok({ order: [["bold", "italic"], "bold"], hidden: [] }), "once across groups");
  assert.ok(!ok({ order: [["bold", ["italic", "underline"]]], hidden: [] }), "no nesting");
});

test("marks taken out of the toolbar are offered in the text menu", () => {
  assert.deepEqual(textMenuMarks(true), ["bold", "italic", "code"]);
  assert.deepEqual(textMenuMarks(true, ["underline", "highlight", "link"]), ["bold", "italic", "underline", "highlight", "code"]);
  assert.deepEqual(textMenuMarks(false, ["underline"]), ["bold", "italic", "underline", "strike", "highlight", "code"]);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const rejects = async (fn: () => Promise<unknown>) =>
  await assert.rejects(fn, (e: unknown) => (e as { status?: number }).status === 400 || (e as Error).name === "ZodError");

test("each person saves a layout; it comes with the bootstrap, is validated, and null resets", async () => {
  const anna = await account("layout-anna"),
    ben = await account("layout-ben");
  const wid = await createWorkspace(anna.id, "Leiste");
  await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
  assert.ok(L.isDefaultToolbarLayout((await bootstrap(anna, wid)).toolbarLayout!), "never chosen: the default");
  const mine = { order: ["bold", "|", "italic", "undo"], hidden: ["undo"] };
  const saved = (await command(anna, { action: "profile.toolbarLayout", toolbarLayout: mine })) as { toolbarLayout: { order: string[]; hidden: string[] } };
  assert.deepEqual(saved.toolbarLayout.order.slice(0, 3), ["bold", "|", "italic"]);
  assert.deepEqual(saved.toolbarLayout.hidden, ["undo", "cloze", "bulletList", "orderedList", "indent", "outdent"], "left out, the lists keep their default: hidden");
  assert.equal(items(saved.toolbarLayout.order).length, L.TOOLBAR_BUTTONS.length, "the rest at their default places");
  assert.deepEqual((await bootstrap(anna, wid)).toolbarLayout, saved.toolbarLayout);
  assert.ok(L.isDefaultToolbarLayout((await bootstrap(ben, wid)).toolbarLayout!), "only for that person");
  for (const bad of [undefined, "bold", { order: ["rocket"], hidden: [] }, { order: ["bold", "bold"], hidden: [] }, { order: [], hidden: ["x"] }, { order: Array(200).fill("|"), hidden: [] }])
    await rejects(() => command(anna, { action: "profile.toolbarLayout", toolbarLayout: bad }));
  assert.deepEqual((await bootstrap(anna, wid)).toolbarLayout, saved.toolbarLayout, "a rejected value changes nothing");
  // The default is stored as NULL, so later defaults reach it.
  await command(anna, { action: "profile.toolbarLayout", toolbarLayout: L.defaultToolbarLayout() });
  assert.equal((await one<{ toolbar_layout: string | null }>("SELECT toolbar_layout FROM users WHERE id=?", anna.id))?.toolbar_layout, null);
  await command(anna, { action: "profile.toolbarLayout", toolbarLayout: mine });
  await command(anna, { action: "profile.toolbarLayout", toolbarLayout: null });
  assert.equal((await one<{ toolbar_layout: string | null }>("SELECT toolbar_layout FROM users WHERE id=?", anna.id))?.toolbar_layout, null);
  assert.ok(L.isDefaultToolbarLayout((await bootstrap(anna, wid)).toolbarLayout!));
  await run("UPDATE users SET toolbar_layout=? WHERE id=?", "not json", ben.id);
  assert.ok(L.isDefaultToolbarLayout((await bootstrap(ben, wid)).toolbarLayout!), "a broken value reads as the default");
});
