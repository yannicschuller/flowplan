// Colours of select and multi-select options (#242): what is stored, how
// new options get theirs, renames, imports and the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";
import { AUTO_COLORS, autoColors, carryColors, choiceChipClass, colorOptions, nextColor } from "../lib/option-colors";
import { notionOptionColors } from "../lib/importers/notion-html";
import { addImportedOptions } from "../lib/database-operations";

const status = (extra: Partial<Field> = {}): Field => ({ id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"], ...extra });

test("existing options keep their look, new ones get the next colour in turn", () => {
  // An existing database without colours: nothing changes.
  const [same] = colorOptions([status()], [status()]);
  assert.equal(same.optionColors, undefined);
  // Two options added: colours in turn, by their place in the list.
  const [grown] = colorOptions([status({ options: ["Offen", "In Arbeit", "Erledigt", "Wartet", "Archiv"] })], [status()]);
  assert.deepEqual(grown.optionColors, { Wartet: AUTO_COLORS[3], Archiv: AUTO_COLORS[4] });
  // After a coloured option the next one follows its colour.
  const [after] = colorOptions(
    [status({ options: ["Offen", "Neu"], optionColors: { Offen: "purple" } })],
    [status({ options: ["Offen"], optionColors: { Offen: "purple" } })],
  );
  assert.deepEqual(after.optionColors, { Offen: "purple", Neu: nextColor("purple", 1) });
  assert.equal(nextColor("purple", 1), "pink");
  // A new property: every option coloured, neighbours differ.
  const [created] = colorOptions([status()]);
  assert.deepEqual(created.optionColors, { Offen: "blue", "In Arbeit": "green", Erledigt: "red" });
  assert.deepEqual(autoColors(["a", "b"]), { a: "blue", b: "green" });
  assert.equal(AUTO_COLORS.includes("gray"), false);
});

test("stored colours: kept when left out, cleared with {}, pruned, renamed along", () => {
  const stored = status({ optionColors: { Offen: "red", Erledigt: "green" } });
  // An API client that does not know colours keeps them.
  assert.deepEqual(colorOptions([status()], [stored])[0].optionColors, { Offen: "red", Erledigt: "green" });
  // {} clears them (the key goes).
  assert.equal("optionColors" in colorOptions([status({ optionColors: {} })], [stored])[0], false);
  // A removed option's colour goes.
  assert.deepEqual(colorOptions([status({ options: ["Offen", "In Arbeit"] })], [stored])[0].optionColors, { Offen: "red" });
  // optionRenames: the colour goes along; an uncoloured renamed option stays uncoloured.
  const renamed = colorOptions(
    [status({ options: ["Neu", "Läuft", "Erledigt"] })],
    [stored],
    [
      { field: "status", from: "Offen", to: "Neu" },
      { field: "status", from: "In Arbeit", to: "Läuft" },
    ],
  )[0];
  assert.deepEqual(renamed.optionColors, { Neu: "red", Erledigt: "green" });
  // Typing in the options text carries the colour too.
  assert.deepEqual(carryColors({ Offen: "red" }, [{ from: "Offen", to: "Offe" }]), { Offen: "red", Offe: "red" });
  // Tag-backed properties and other types carry none.
  const tags = colorOptions([{ id: "t", name: "Tags", type: "multiselect", tagOptions: true, options: ["a"], optionColors: { a: "red" } }])[0];
  assert.equal(tags.optionColors, undefined);
  const text = colorOptions([{ id: "t", name: "T", type: "text", optionColors: { a: "red" } }], [stored])[0];
  assert.equal(text.optionColors, undefined);
});

test("chip classes: own colour, tag colour, otherwise the earlier look", () => {
  assert.equal(choiceChipClass(status({ optionColors: { Offen: "teal" } }), "Offen"), "tag tag-choice tag-colored opt-teal");
  assert.equal(choiceChipClass(status(), "Erledigt"), "tag tag-choice tag-green");
  assert.equal(choiceChipClass(status(), "Offen"), "tag tag-choice tag-gray");
  assert.equal(choiceChipClass({ type: "multiselect", tagOptions: true }, "x", () => "pink"), "tag tag-choice tag-colored opt-pink");
});

test("imported values that become options get colours", () => {
  const rows = [{ status: "Wartet" }, { status: "offen" }];
  const { fields } = addImportedOptions([status({ optionColors: { Offen: "red" } }), { id: "title", name: "Name", type: "text" }], rows);
  assert.deepEqual(fields[0].optionColors, { Offen: "red", Wartet: AUTO_COLORS[3] });
  assert.equal(rows[1].status, "Offen");
});

test("Notion's HTML: colours of the values in the table and on record pages", () => {
  const table =
    '<table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg></svg></span>Name</th><th>Status</th><th>Tags</th></tr></thead>' +
    '<tbody><tr><td class="cell-title">A</td><td><span class="status-value select-value-color-green"><div class="status-dot"></div>Done</span></td>' +
    '<td><span class="selected-value select-value-color-brown">Kunde</span><span class="selected-value select-value-color-default">Intern</span></td></tr></tbody></table>';
  const record = '<table class="properties"><tbody><tr class="property-row property-row-select"><th>Phase</th><td><span class="selected-value select-value-color-purple">Plan</span></td></tr></tbody></table>';
  const colors = notionOptionColors(`<html><body>${table}</body></html>`);
  notionOptionColors(`<html><body>${record}</body></html>`, colors);
  assert.deepEqual(Object.fromEntries([...colors].map(([k, v]) => [k, Object.fromEntries(v)])), {
    Status: { Done: "green" },
    Tags: { Kunde: "orange", Intern: "gray" },
    Phase: { Plan: "purple" },
  });
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-option-colors-"));
const { id, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { writeZip } = await import("../lib/archive");
const { importZip } = await import("../lib/zip-import");
const { openApiDocument } = await import("../lib/openapi");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Option colours"),
  boot = await bootstrap(owner, wid);
const act = (body: Record<string, unknown>): Promise<any> => command(owner, body);

test("database.update stores, colours, renames and checks the colours", async () => {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Farben", kind: "database" })).id as string;
  const update = async (fields: Field[], extra: Record<string, unknown> = {}) => {
    const d = await database(pageId);
    return act({ action: "database.update", pageId, version: d.version, fields, views: d.views, ...extra });
  };
  const title: Field = { id: "title", name: "Name", type: "text" };
  // Not the default "status" (its options exist): a property of its own.
  const status = (extra: Partial<Field> = {}): Field => ({ id: "phase", name: "Phase", type: "select", options: ["Offen", "In Arbeit", "Erledigt"], ...extra });
  // A new property through the API: every option coloured in turn.
  await update([title, status()]);
  assert.deepEqual((await database(pageId)).fields[1].optionColors, { Offen: "blue", "In Arbeit": "green", Erledigt: "red" });
  // Colours set; an option added without one gets the next.
  await update([title, status({ options: ["Offen", "In Arbeit", "Erledigt", "Wartet"], optionColors: { Offen: "teal", "In Arbeit": "green", Erledigt: "red" } })]);
  assert.deepEqual((await database(pageId)).fields[1].optionColors, { Offen: "teal", "In Arbeit": "green", Erledigt: "red", Wartet: "yellow" });
  // Left out: kept. A rename takes the colour along.
  await update([title, status({ options: ["Neu", "In Arbeit", "Erledigt", "Wartet"] })], { optionRenames: [{ field: "phase", from: "Offen", to: "Neu" }] });
  assert.deepEqual((await database(pageId)).fields[1].optionColors, { Neu: "teal", "In Arbeit": "green", Erledigt: "red", Wartet: "yellow" });
  // {} clears them: the options look as before colours existed.
  await update([title, status({ options: ["Neu", "In Arbeit", "Erledigt", "Wartet"], optionColors: {} })]);
  assert.equal((await database(pageId)).fields[1].optionColors, undefined);
  // Unknown colours are refused.
  await assert.rejects(update([title, status({ optionColors: { Offen: "brown" as never } })]));
  // The API documents them.
  assert.match(JSON.stringify(openApiDocument()), /optionColors/);
});

test("ZIP import: Notion's colours where the export has them, the rest in turn", async () => {
  const csv = "Name,Status,Phase\nA,Done,Eins\nB,Done,Zwei\nC,Open,Eins\nD,Open,Zwei\n";
  const html =
    '<html><body><article class="page sans"><header><h1 class="page-title">Liste</h1></header><table class="collection-content"><thead><tr><th>Name</th><th>Status</th><th>Phase</th></tr></thead>' +
    '<tbody><tr><td>A</td><td><span class="selected-value select-value-color-purple">Done</span></td><td>Eins</td></tr>' +
    '<tr><td>C</td><td><span class="selected-value select-value-color-red">Open</span></td><td>Eins</td></tr></tbody></table></article></body></html>';
  const bytes = await writeZip(new Map([["Liste 1a2b3c4d5e6f70811a2b3c4d5e6f7081.csv", Buffer.from(csv)], ["Liste 1a2b3c4d5e6f70811a2b3c4d5e6f7081.html", Buffer.from(html)]]));
  await importZip(owner, wid, boot.spaces[0].id, bytes);
  const page = (await (await import("../lib/db")).one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title=? AND kind='database'", wid, "Liste"))!;
  const fields = (await database(page.id)).fields;
  assert.deepEqual(fields.find((f) => f.name === "Status")!.optionColors, { Done: "purple", Open: "red" });
  assert.deepEqual(fields.find((f) => f.name === "Phase")!.optionColors, { Eins: "blue", Zwei: "green" });
});
