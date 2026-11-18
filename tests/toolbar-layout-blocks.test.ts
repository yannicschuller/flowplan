// Follow-ups to "Formatierungsleiste anpassen" (#292): the blocks of the
// "/" menu as toolbar buttons (lib/toolbar-layout.ts) and the instance's
// default toolbar (instance setting toolbarLayoutDefault,
// lib/user-toolbar-layout.ts): own layout → instance default → built-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-toolbar-blocks-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const L = await import("../lib/toolbar-layout");
type Layout = import("../lib/toolbar-layout").ToolbarLayout;

test("blocks of the / menu: not in the default, added at the end, taken out again, groupable", () => {
  assert.ok(L.defaultToolbarLayout().order.every((e) => !L.isToolbarBlock(e)), "the default toolbar is unchanged");
  assert.equal(L.blocksOutside(L.defaultToolbarLayout()).length, L.TOOLBAR_BLOCKS.length);
  assert.deepEqual(L.defaultToolbarLayout().hidden, ["bulletList", "orderedList", "indent", "outdent", "cloze"]);
  // A layout stored before the blocks stays as it was.
  const read = L.toolbarLayoutOf({ order: L.DEFAULT_TOOLBAR_ORDER.filter((e) => e !== "bold"), hidden: ["italic"] });
  assert.ok(read.order.every((e) => !L.isToolbarBlock(e)), "blocks are never put back on their own");
  // Shown: at the end; hidden again: out of the order.
  let layout = L.setToolbarItemShown(L.defaultToolbarLayout(), "block:table", true);
  assert.equal(layout.order[layout.order.length - 1], "block:table");
  assert.ok(!L.blocksOutside(layout).includes("block:table"));
  assert.ok(L.toolbarEntries(layout).includes("block:table"));
  assert.ok(L.toolbarLayoutSchema.safeParse(layout).success, "the server accepts block ids");
  layout = L.addToolbarDivider(layout, layout.order.length - 2);
  assert.equal(layout.order[layout.order.length - 2], "|");
  const out = L.setToolbarItemShown(layout, "block:table", false);
  assert.ok(L.isDefaultToolbarLayout(L.toolbarLayoutOf(out)), "taken out, with the divider before it gone");
  // A hidden block of its own leaves the order when read.
  assert.ok(!L.toolbarLayoutOf({ order: [...L.DEFAULT_TOOLBAR_ORDER, "block:code"], hidden: ["block:code"] }).order.includes("block:code"));
  // In a group: hidden keeps its place; groups mix buttons and blocks.
  layout = L.setToolbarItemShown(L.setToolbarItemShown(L.defaultToolbarLayout(), "block:code", true), "block:math", true);
  layout = L.groupWithNext(layout, layout.order.length - 2);
  assert.deepEqual(layout.order[layout.order.length - 1], ["block:code", "block:math"]);
  layout = L.toolbarLayoutOf(L.setToolbarItemShown(layout, "block:math", false));
  assert.deepEqual(layout.order[layout.order.length - 1], ["block:code", "block:math"]);
  assert.deepEqual(layout.hidden, ["cloze", "bulletList", "orderedList", "indent", "outdent", "block:math"]);
  assert.deepEqual(L.toolbarEntries(layout).at(-1), "block:code");
  assert.deepEqual(L.groupWithNext({ order: ["addBlock", "block:callout"], hidden: [] }, 0).order, [["addBlock", "block:callout"]]);
  // Unknown block ids are dropped when read, refused when saved.
  assert.ok(!JSON.stringify(L.toolbarLayoutOf({ order: ["block:rocket", "bold"], hidden: [] }).order).includes("rocket"));
  assert.ok(!L.toolbarLayoutSchema.safeParse({ order: ["block:rocket"], hidden: [] }).success);
  // "Trennlinie einfügen": after every entry but the last, not next to one.
  assert.deepEqual(L.dividerPlaces({ order: ["bold", "|", "italic", "underline"], hidden: [] }), [2]);
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const storedOf = async (userId: string) => (await one<{ toolbar_layout: string | null }>("SELECT toolbar_layout FROM users WHERE id=?", userId))?.toolbar_layout ?? null;

test("the instance's default toolbar: for everyone without their own, reset goes back to it", async () => {
  const carl = await account("layout-carl"),
    dora = await account("layout-dora");
  const wid = await createWorkspace(carl.id, "Leiste Instanz");
  await run("INSERT INTO members VALUES(?,?,?)", wid, dora.id, "editor");
  await command(dora, { action: "profile.toolbarLayout", toolbarLayout: { order: ["bold", "|", "italic"], hidden: [] } });
  const boot = await bootstrap(carl, wid);
  assert.ok(L.isDefaultToolbarLayout(boot.toolbarLayoutDefault!));
  assert.equal(boot.toolbarLayoutCustom, false);

  const standard = L.setToolbarItemShown(L.applyGroupPreset(L.defaultToolbarLayout(), "lists"), "block:table", true);
  await saveInstanceSettings({ toolbarLayoutDefault: standard });
  const stored = (await instanceSettings()).toolbarLayoutDefault!;
  assert.ok(L.sameToolbarLayout(stored, L.toolbarLayoutOf(standard)));
  const carlBoot = await bootstrap(carl, wid);
  assert.ok(L.sameToolbarLayout(carlBoot.toolbarLayout!, stored), "without their own: the instance's default");
  assert.ok(L.sameToolbarLayout(carlBoot.toolbarLayoutDefault!, stored));
  assert.equal(carlBoot.toolbarLayoutCustom, false);
  const doraBoot = await bootstrap(dora, wid);
  assert.equal(doraBoot.toolbarLayoutCustom, true, "their own layout wins");
  const doraOrder = doraBoot.toolbarLayout!.order;
  assert.deepEqual(doraOrder.slice(doraOrder.indexOf("bold"), doraOrder.indexOf("bold") + 3), ["bold", "|", "italic"]);
  // Reset (null) goes back to the instance's default, not the built-in one.
  const reset = (await command(dora, { action: "profile.toolbarLayout", toolbarLayout: null })) as { toolbarLayout: Layout; custom: boolean };
  assert.ok(L.sameToolbarLayout(reset.toolbarLayout, stored));
  assert.equal(reset.custom, false);
  // The built-in layout chosen on purpose is a layout of one's own then.
  const own = (await command(dora, { action: "profile.toolbarLayout", toolbarLayout: L.defaultToolbarLayout() })) as { custom: boolean };
  assert.equal(own.custom, true);
  assert.equal((await bootstrap(dora, wid)).toolbarLayoutCustom, true);
  // The instance's default saved is no layout of one's own.
  await command(dora, { action: "profile.toolbarLayout", toolbarLayout: stored });
  assert.equal(await storedOf(dora.id), null);
  // A broken own value reads as none: the instance's default.
  await run("UPDATE users SET toolbar_layout=? WHERE id=?", "not json", dora.id);
  assert.ok(L.sameToolbarLayout((await bootstrap(dora, wid)).toolbarLayout!, stored));

  // Validated strictly when saved; a broken stored value voids only itself.
  await assert.rejects(() => saveInstanceSettings({ toolbarLayoutDefault: { order: ["rocket"], hidden: [] } }));
  await assert.rejects(() => saveInstanceSettings({ toolbarLayoutDefault: "bold" }));
  await run("UPDATE instance_settings SET value=? WHERE key='toolbarLayoutDefault'", JSON.stringify({ order: ["block:rocket", "bold"], hidden: 3 }));
  const lenient = await instanceSettings();
  assert.equal(lenient.trashDays, 30, "the other settings stay");
  assert.ok(lenient.toolbarLayoutDefault && !JSON.stringify(lenient.toolbarLayoutDefault).includes("rocket"), "read leniently");
  assert.deepEqual(lenient.toolbarLayoutDefault.hidden, ["cloze", "bulletList", "orderedList", "indent", "outdent"]);
  await run("UPDATE instance_settings SET value=? WHERE key='toolbarLayoutDefault'", '"broken"');
  assert.equal((await instanceSettings()).toolbarLayoutDefault, null);
  // Back to the built-in one; the built-in layout itself is stored as null.
  await saveInstanceSettings({ toolbarLayoutDefault: standard });
  await saveInstanceSettings({ toolbarLayoutDefault: L.defaultToolbarLayout() });
  assert.equal((await instanceSettings()).toolbarLayoutDefault, null);
  await saveInstanceSettings({ toolbarLayoutDefault: standard });
  await saveInstanceSettings({ toolbarLayoutDefault: null });
  assert.equal((await instanceSettings()).toolbarLayoutDefault, null);
  assert.ok(L.isDefaultToolbarLayout((await bootstrap(carl, wid)).toolbarLayout!));
  // Other settings saved keep it.
  await saveInstanceSettings({ toolbarLayoutDefault: standard });
  await saveInstanceSettings({ trashDays: 31 });
  assert.ok(L.sameToolbarLayout((await instanceSettings()).toolbarLayoutDefault!, stored));
});
