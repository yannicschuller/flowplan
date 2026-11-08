import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity, View } from "../lib/types";
import { cleanOptions, hasOwnSettings, mergesOf, optionRenames } from "../lib/option-renames";
import { groupKey, pathCollapseKey } from "../lib/database-groups";

test("the options text: renames and merges in place; additions, removals and moves stay what they are", () => {
  const list = ["Offen", "In Arbeit", "Erledigt"];
  assert.deepEqual(optionRenames(list, ["Offen", "In Bearbeitung", "Erledigt"]), [{ from: "In Arbeit", to: "In Bearbeitung" }]);
  // Case only.
  assert.deepEqual(optionRenames(list, ["offen", "In Arbeit", "Erledigt"]), [{ from: "Offen", to: "offen" }]);
  // One removed here and one added there: not guessed to be a rename.
  assert.deepEqual(optionRenames(list, ["Offen", "Erledigt", "Wartet"]), []);
  assert.deepEqual(optionRenames(list, ["Wartet", "Offen", "Erledigt"]), []);
  // Renamed in place plus one added at the end.
  assert.deepEqual(optionRenames(list, ["Offen", "Wartet", "Erledigt", "Archiv"]), [{ from: "In Arbeit", to: "Wartet" }]);
  // Merged: an existing name written in place of an option.
  assert.deepEqual(optionRenames(list, ["Offen", "Offen", "Erledigt"]), [{ from: "In Arbeit", to: "Offen" }]);
  // Two options renamed to the same new name: the second merges into it.
  assert.deepEqual(optionRenames(list, ["Neu", "Neu", "Erledigt"]), [
    { from: "Offen", to: "Neu" },
    { from: "In Arbeit", to: "Neu" },
  ]);
  // Removed, added, reordered, swapped: no renames.
  assert.deepEqual(optionRenames(list, ["Offen", "Erledigt"]), []);
  assert.deepEqual(optionRenames(list, [...list, "Archiv"]), []);
  assert.deepEqual(optionRenames(list, ["Erledigt", "In Arbeit", "Offen"]), []);
  assert.deepEqual(optionRenames(list, ["Erledigt", "Offen"]), []);
  // Typing leftovers.
  assert.deepEqual(optionRenames(list, ["Offen", "In Arbeit", "Erledigt", ""]), []);
  assert.deepEqual(cleanOptions(["Offen", " Offen", "", "Erledigt "]), ["Offen", "Erledigt"]);
  // What the confirmation calls a merge, and when it says the merged
  // option's own "Workflow and done" settings go.
  const renames = [
    { field: "status", from: "Offen", to: "Neu" },
    { field: "status", from: "In Arbeit", to: "Neu" },
    { field: "status", from: "Wartet", to: "Erledigt" },
  ];
  assert.deepEqual(mergesOf(renames, () => list), renames.slice(1));
  const settings = { done: { field: "status", values: ["Erledigt"] }, workflow: { field: "status", transitions: { Offen: ["Erledigt"] }, required: {}, ownersOnly: ["Wartet"] } };
  assert.equal(hasOwnSettings(settings, "status", "Offen"), true);
  assert.equal(hasOwnSettings(settings, "status", "Wartet"), true);
  assert.equal(hasOwnSettings(settings, "status", "Erledigt"), true);
  assert.equal(hasOwnSettings(settings, "status", "In Arbeit"), false);
  assert.equal(hasOwnSettings(settings, "labels", "Offen"), false);
  assert.equal(hasOwnSettings(undefined, "status", "Offen"), false);
});

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-option-renames-"));
const { id, run, one, all } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { databaseSettings } = await import("../lib/database-settings");
async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  editor = await user("editor"),
  wid = await createWorkspace(owner.id, "Option renames"),
  boot = await bootstrap(owner, wid);
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const act = (body: Record<string, unknown>, by = owner): Promise<any> => command(by, body);
const fields: Field[] = [
  { id: "title", name: "Name", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
  { id: "labels", name: "Labels", type: "multiselect", options: ["Rot", "Blau", "Grün"] },
  { id: "phase", name: "Phase", type: "select", options: ["In Arbeit", "Fertig"] },
];
const board: View = {
  id: "board",
  name: "Board",
  type: "board",
  groupBy: "status",
  filters: [],
  filterGroup: {
    kind: "group",
    join: "or",
    rules: [
      { kind: "condition", field: "labels", op: "all_of", value: "", values: ["Rot"] },
      { kind: "group", join: "and", rules: [{ kind: "condition", field: "status", op: "eq", value: "In Arbeit" }] },
    ],
  },
  sorts: [],
  groupSettings: { hideEmpty: false, sort: "manual", collapsed: [groupKey("Offen")], order: [groupKey("Offen"), groupKey("In Arbeit"), groupKey("Erledigt"), "empty"] },
  wip: { [groupKey("In Arbeit")]: { max: 3 }, [groupKey("Offen")]: { max: 9 } },
};
const table: View = {
  id: "table",
  name: "Tabelle",
  type: "table",
  filters: [{ field: "status", op: "any_of", value: "", values: ["In Arbeit", "Erledigt"] }],
  sorts: [],
};
async function setup() {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Aufnahmen", kind: "database" })).id as string;
  await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields, views: [board, table] });
  const row = async (cells: Record<string, unknown>) => (await act({ action: "row.create", pageId, cells })).id as string;
  return {
    pageId,
    working: await row({ title: "Erstgespräch", status: "In Arbeit", labels: ["Rot", "Blau"], phase: "In Arbeit" }),
    open: await row({ title: "Rückruf", status: "Offen", labels: ["Blau"] }),
  };
}
const cells = async (rowId: string) => JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId))!.cells);
const withOptions = (fid: string, options: string[]) => fields.map((f) => (f.id === fid ? { ...f, options } : f));
async function rename(pageId: string, nextFields: Field[], optionRenames: unknown, views?: View[], by = owner) {
  views ??= (await database(pageId)).views;
  return act({ action: "database.update", pageId, version: (await database(pageId)).version, fields: nextFields, views, optionRenames }, by);
}

test("a renamed option carries records, templates, the trash, views, settings and form conditions", async () => {
  const { pageId, working, open } = await setup();
  const trashed = (await act({ action: "row.create", pageId, cells: { title: "Alt", status: "In Arbeit" } })).id as string;
  await act({ action: "row.template.save", pageId, rowId: working, name: "Aufnahme" });
  await act({ action: "row.delete", pageId, rowId: trashed });
  await act({
    action: "database.settings",
    pageId,
    settings: {
      done: { field: "status", values: ["Erledigt"] },
      workflow: { field: "status", transitions: { Offen: ["In Arbeit"], "In Arbeit": ["Erledigt", "Offen"] }, required: { "In Arbeit": ["labels"] }, ownersOnly: ["In Arbeit"] },
      automations: [
        {
          id: "a1",
          trigger: { type: "changed", field: "status", to: "In Arbeit" },
          conditions: [{ field: "labels", op: "all_of", value: "", values: ["Rot"] }],
          actions: [{ type: "set", field: "labels", value: ["Rot", "Grün"] }],
        },
      ],
    },
  });
  await act({ action: "form.update", pageId, config: { logic: { labels: { field: "status", op: "is", value: "In Arbeit" } } } });
  const before = await cells(working),
    version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", working))!.version,
    snapshots = (await one<{ n: number }>("SELECT count(*) AS n FROM snapshots WHERE page_id=?", pageId))!.n;

  await rename(pageId, withOptions("status", ["Offen", "In Bearbeitung", "Erledigt"]), [{ field: "status", from: "In Arbeit", to: "In Bearbeitung" }]);

  // Records: only the renamed property; the same name in another property stays.
  assert.deepEqual(await cells(working), { ...before, status: "In Bearbeitung" });
  assert.equal((await cells(working)).phase, "In Arbeit");
  assert.equal((await cells(open)).status, "Offen");
  assert.equal((await one<{ version: number }>("SELECT version FROM rows WHERE id=?", working))!.version, version + 1);
  assert.equal((await one<{ n: number }>("SELECT count(*) AS n FROM snapshots WHERE page_id=?", pageId))!.n, snapshots + 1);
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM row_templates WHERE page_id=?", pageId))!.cells).status, "In Bearbeitung");
  assert.match((await one<{ payload: string }>("SELECT payload FROM row_trash WHERE page_id=?", pageId))!.payload, /In Bearbeitung/);
  assert.doesNotMatch((await one<{ payload: string }>("SELECT payload FROM row_trash WHERE page_id=?", pageId))!.payload, /In Arbeit/);

  const view = (await database(pageId)).views[0];
  assert.deepEqual((await database(pageId)).views[1].filters[0].values, ["In Bearbeitung", "Erledigt"]);
  assert.deepEqual(view.filterGroup!.rules[1], { kind: "group", join: "and", rules: [{ kind: "condition", field: "status", op: "eq", value: "In Bearbeitung" }] });
  assert.deepEqual(view.groupSettings!.order, [groupKey("Offen"), groupKey("In Bearbeitung"), groupKey("Erledigt"), "empty"]);
  assert.deepEqual(view.wip, { [groupKey("In Bearbeitung")]: { max: 3 }, [groupKey("Offen")]: { max: 9 } });

  const settings = await databaseSettings(pageId);
  assert.deepEqual(settings.workflow!.transitions, { Offen: ["In Bearbeitung"], "In Bearbeitung": ["Erledigt", "Offen"] });
  assert.deepEqual(settings.workflow!.required, { "In Bearbeitung": ["labels"] });
  assert.deepEqual(settings.workflow!.ownersOnly, ["In Bearbeitung"]);
  assert.equal((settings.automations![0].trigger as { to?: string }).to, "In Bearbeitung");
  const form = JSON.parse((await one<{ config: string }>("SELECT config FROM forms WHERE page_id=?", pageId))!.config);
  assert.equal(form.logic.labels.value, "In Bearbeitung");

  // The workflow still lets the record move on under its new name.
  await act({ action: "row.update", pageId, rowId: working, version: version + 1, cells: { status: "Erledigt" } });
  assert.equal((await cells(working)).status, "Erledigt");
  // "Offen" may only go to the renamed status, now under its new name.
  const openVersion = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", open))!.version;
  await assert.rejects(() => act({ action: "row.update", pageId, rowId: open, version: openVersion, cells: { status: "Erledigt" } }));
  await act({ action: "row.update", pageId, rowId: open, version: openVersion, cells: { status: "In Bearbeitung" } });
  assert.equal((await cells(open)).status, "In Bearbeitung");

  // Multi-select and done rule: "Rot" → "Dringend", "Erledigt" → "Fertig".
  await rename(pageId, withOptions("labels", ["Dringend", "Blau", "Grün"]).map((f) => (f.id === "status" ? { ...f, options: ["Offen", "In Bearbeitung", "Fertig"] } : f)), [
    { field: "labels", from: "Rot", to: "Dringend" },
    { field: "status", from: "Erledigt", to: "Fertig" },
  ]);
  assert.deepEqual((await cells(working)).labels, ["Dringend", "Blau"]);
  assert.equal((await cells(working)).status, "Fertig");
  const after = await databaseSettings(pageId);
  assert.deepEqual(after.done, { field: "status", values: ["Fertig"] });
  assert.deepEqual(after.automations![0].conditions[0].values, ["Dringend"]);
  assert.deepEqual((after.automations![0].actions[0] as { value: unknown }).value, ["Dringend", "Grün"]);
  assert.deepEqual((await database(pageId)).views[0].filterGroup!.rules[0], { kind: "condition", field: "labels", op: "all_of", value: "", values: ["Dringend"] });
});

test("an existing name merges: values, groups and limits join the target", async () => {
  const { pageId, working, open } = await setup();
  const both = (await act({ action: "row.create", pageId, cells: { title: "Beides", labels: ["Rot", "Blau"] } })).id as string;
  await rename(pageId, withOptions("status", ["Offen", "Erledigt"]), [{ field: "status", from: "In Arbeit", to: "Offen" }]);
  assert.equal((await cells(working)).status, "Offen");
  assert.equal((await cells(open)).status, "Offen");
  const view = (await database(pageId)).views[0];
  assert.deepEqual(view.groupSettings!.order, [groupKey("Offen"), groupKey("Erledigt"), "empty"]);
  // Where both had a limit, the target keeps its own.
  assert.deepEqual(view.wip, { [groupKey("Offen")]: { max: 9 } });
  // A multi-select holding both keeps the name once.
  await rename(pageId, withOptions("labels", ["Blau", "Grün"]).map((f) => (f.id === "status" ? { ...f, options: ["Offen", "Erledigt"] } : f)), [
    { field: "labels", from: "Rot", to: "Blau" },
  ]);
  assert.deepEqual((await cells(both)).labels, ["Blau"]);
});

test("renames that do not fit the options are refused; without renames nothing moves", async () => {
  const { pageId, working } = await setup();
  const refused = /passt nicht zu den Optionen/;
  // The old name is still an option, the new one is not, unknown names, a tag property.
  await assert.rejects(() => rename(pageId, withOptions("status", [...fields[1].options!, "Neu"]), [{ field: "status", from: "In Arbeit", to: "Neu" }]), refused);
  await assert.rejects(() => rename(pageId, withOptions("status", ["Offen", "Erledigt"]), [{ field: "status", from: "In Arbeit", to: "Neu" }]), refused);
  await assert.rejects(() => rename(pageId, withOptions("status", ["Offen", "Neu", "Erledigt"]), [{ field: "status", from: "Gibt es nicht", to: "Neu" }]), refused);
  await assert.rejects(() => rename(pageId, fields, [{ field: "title", from: "a", to: "b" }]), refused);
  assert.equal((await cells(working)).status, "In Arbeit");
  // Options changed without renames: the records keep their values (as before).
  await rename(pageId, withOptions("status", ["Offen", "Neu", "Erledigt"]), undefined);
  assert.equal((await cells(working)).status, "In Arbeit");
  assert.equal((await all("SELECT 1 FROM rows WHERE page_id=?", pageId)).length, 2);
});

test("a merge gives the merged option's rules up to the target's; editors stay within their rights", async () => {
  const { pageId, working } = await setup();
  await act({
    action: "database.settings",
    pageId,
    settings: {
      done: { field: "status", values: ["In Arbeit"] },
      workflow: { field: "status", transitions: { Offen: ["In Arbeit"], "In Arbeit": ["Offen"] }, required: { "In Arbeit": ["labels"] }, ownersOnly: ["Erledigt"] },
    },
  });
  // Merging into an owners-only status is for owners.
  await assert.rejects(
    () => rename(pageId, withOptions("status", ["Offen", "Erledigt"]), [{ field: "status", from: "In Arbeit", to: "Erledigt" }], undefined, editor),
    /nur Verantwortliche/,
  );
  // "In Arbeit" into "Offen": "Offen" keeps its own rules, links to "In Arbeit" lead to "Offen".
  await rename(pageId, withOptions("status", ["Offen", "Erledigt"]), [{ field: "status", from: "In Arbeit", to: "Offen" }], undefined, editor);
  assert.equal((await cells(working)).status, "Offen");
  const settings = await databaseSettings(pageId);
  assert.deepEqual(settings.done!.values, []);
  assert.deepEqual(settings.workflow!.transitions, { Offen: ["Offen"] });
  assert.deepEqual(settings.workflow!.required, {});
  assert.deepEqual(settings.workflow!.ownersOnly, ["Erledigt"]);
  // Two options renamed to one new name: the first one's rules carry over,
  // the second one merges and gives its own up – an owners-only first one
  // keeps the new name for owners.
  await act({
    action: "database.settings",
    pageId,
    settings: { workflow: { field: "status", transitions: { Offen: ["Erledigt"], Erledigt: ["Offen"] }, required: {}, ownersOnly: ["Offen"] } },
  });
  await assert.rejects(
    () => rename(pageId, withOptions("status", ["Neu"]), [{ field: "status", from: "Offen", to: "Neu" }, { field: "status", from: "Erledigt", to: "Neu" }], undefined, editor),
    /nur Verantwortliche/,
  );
  await rename(pageId, withOptions("status", ["Neu"]), [{ field: "status", from: "Offen", to: "Neu" }, { field: "status", from: "Erledigt", to: "Neu" }]);
  assert.equal((await cells(working)).status, "Neu");
  assert.deepEqual((await databaseSettings(pageId)).workflow!.transitions, { Neu: ["Neu"] });
  assert.deepEqual((await databaseSettings(pageId)).workflow!.ownersOnly, ["Neu"]);
  // A property only owners may write: its options are not renamed by others.
  const locked = (await database(pageId)).fields.map((f) => (f.id === "labels" ? { ...f, access: { write: "owners" as const } } : f));
  await act({ action: "database.update", pageId, version: (await database(pageId)).version, fields: locked, views: (await database(pageId)).views });
  await assert.rejects(
    () => rename(pageId, locked.map((f) => (f.id === "labels" ? { ...f, options: ["Dringend", "Blau", "Grün"] } : f)), [{ field: "labels", from: "Rot", to: "Dringend" }], undefined, editor),
    /nur für bestimmte Personen/,
  );
  assert.deepEqual((await cells(working)).labels, ["Rot", "Blau"]);
});

const rowVersion = async (rowId: string) => (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version;
const latestVersion = async (pageId: string) =>
  (await one<{ id: string; html: string }>("SELECT id,html FROM snapshots WHERE page_id=? ORDER BY created_at DESC,seq DESC LIMIT 1", pageId))!;

test("restoring the version from before a rename brings the settings back with the options", async () => {
  const { pageId, working } = await setup();
  await act({ action: "row.update", pageId, rowId: working, version: await rowVersion(working), cells: { status: "Erledigt" } });
  await act({
    action: "database.settings",
    pageId,
    settings: {
      done: { field: "status", values: ["Erledigt"] },
      workflow: { field: "status", transitions: { "In Arbeit": ["Erledigt"] }, required: { Erledigt: ["labels"] }, ownersOnly: [] },
      automations: [{ id: "a1", trigger: { type: "changed", field: "status", to: "Erledigt" }, conditions: [], actions: [{ type: "set", field: "labels", value: ["Grün"] }] }],
    },
  });
  // An issue sync mapping the status (the connection does not matter here).
  const connection = id();
  await run(
    "INSERT INTO issue_connections(id,workspace_id,provider,token,hook_token,hook_secret,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
    connection,
    wid,
    "github",
    "x",
    id(),
    "x",
    owner.id,
    Date.now(),
  );
  const mapping = [
    { value: "Offen", state: "open", label: "" },
    { value: "Erledigt", state: "closed", label: "" },
  ];
  await run(
    "INSERT INTO issue_sync_maps(page_id,connection_id,repo,config,created_at) VALUES(?,?,?,?,?)",
    pageId,
    connection,
    "acme/app",
    JSON.stringify({ title: "title", status: { field: "status", map: mapping } }),
    Date.now(),
  );
  const syncStatus = async () => JSON.parse((await one<{ config: string }>("SELECT config FROM issue_sync_maps WHERE page_id=?", pageId))!.config).status;
  const before = await databaseSettings(pageId);

  await rename(pageId, withOptions("status", ["Offen", "In Arbeit", "Fertig"]), [{ field: "status", from: "Erledigt", to: "Fertig" }]);
  assert.deepEqual((await databaseSettings(pageId)).done!.values, ["Fertig"]);
  assert.equal((await syncStatus()).map[1].value, "Fertig");
  // Meanwhile a sprint is planned: not part of the version.
  await act({ action: "database.settings", pageId, settings: { sprints: [{ id: "s1", name: "Sprint 1", start: "2026-11-02", end: "2026-11-13" }] } });

  await act({ action: "snapshot.restore", pageId, snapshotId: (await latestVersion(pageId)).id }, editor);
  assert.deepEqual((await database(pageId)).fields.find((f) => f.id === "status")!.options, ["Offen", "In Arbeit", "Erledigt"]);
  assert.equal((await cells(working)).status, "Erledigt");
  const restored = await databaseSettings(pageId);
  assert.deepEqual(restored.done, before.done);
  assert.deepEqual(restored.workflow, before.workflow);
  assert.equal((restored.automations![0].trigger as { to?: string }).to, "Erledigt");
  // The rule comes back changed: it acts for the person who restored it.
  assert.equal(restored.automations![0].createdBy, editor.id);
  assert.deepEqual(restored.sprints!.map((s) => s.id), ["s1"]);
  assert.deepEqual(await syncStatus(), { field: "status", map: mapping });

  // A merge is undone as well: the merged option's own rules return.
  await rename(pageId, withOptions("status", ["Offen", "In Arbeit"]), [{ field: "status", from: "Erledigt", to: "In Arbeit" }]);
  assert.deepEqual((await databaseSettings(pageId)).done!.values, []);
  await act({ action: "snapshot.restore", pageId, snapshotId: (await latestVersion(pageId)).id });
  assert.deepEqual((await databaseSettings(pageId)).done, before.done);
  assert.deepEqual((await databaseSettings(pageId)).workflow, before.workflow);
  assert.deepEqual(await syncStatus(), { field: "status", map: mapping });

  // A version from before settings were kept leaves them as they are.
  await rename(pageId, withOptions("status", ["Offen", "In Arbeit", "Fertig"]), [{ field: "status", from: "Erledigt", to: "Fertig" }]);
  const old = await latestVersion(pageId);
  const { settings: _settings, issueSyncStatus: _status, ...withoutSettings } = JSON.parse(old.html);
  void _settings;
  void _status;
  await run("UPDATE snapshots SET html=? WHERE id=?", JSON.stringify(withoutSettings), old.id);
  await act({ action: "snapshot.restore", pageId, snapshotId: old.id });
  assert.equal((await cells(working)).status, "Erledigt");
  assert.deepEqual((await databaseSettings(pageId)).done!.values, ["Fertig"]);
});

test("linked views on other pages and in records follow, also where the renaming person cannot edit", async () => {
  const { escaped, htmlState } = await import("../lib/document-server");
  const { replaceRowDocument } = await import("../lib/row-documents");
  const { linkedDatabaseData } = await import("../lib/linked-databases");
  const { pageId, working } = await setup();
  const linked: View = {
    id: "linked",
    name: "Verknüpft",
    type: "board",
    groupBy: "phase",
    subGroupBy: "status",
    filters: [{ field: "status", op: "eq", value: "In Arbeit" }],
    sorts: [],
    groupSettings: { hideEmpty: false, sort: "manual", collapsed: [pathCollapseKey(["lane", groupKey("In Arbeit")])] },
  };
  const blockHtml = (blockId: string, source = pageId) =>
    `<div data-linked-database="${blockId}" data-linked-source="${source}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify([linked]))}"></div>`;
  // Another database with the same option name.
  const other = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Andere", kind: "database" })).id as string;
  await act({ action: "database.update", pageId: other, version: (await database(other)).version, fields, views: [table] });
  const host = (await act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Übersicht", kind: "document" })).id as string;
  const pageBlock = id(),
    otherBlock = id(),
    rowBlock = id();
  const html = `<p>Stand</p>${blockHtml(pageBlock)}${blockHtml(otherBlock, other)}`;
  await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), host);
  await replaceRowDocument(working, `<p>Notiz</p>${blockHtml(rowBlock)}`, owner.id);
  // The editor may not change the host page.
  await run("UPDATE pages SET locked=1 WHERE id=?", host);

  await rename(pageId, withOptions("status", ["Offen", "In Bearbeitung", "Erledigt"]), [{ field: "status", from: "In Arbeit", to: "In Bearbeitung" }], undefined, editor);
  for (const data of [(await linkedDatabaseData(owner, host, pageBlock)).database, (await linkedDatabaseData(owner, pageId, rowBlock, working)).database]) {
    assert.deepEqual(data.views[0].filters, [{ field: "status", op: "eq", value: "In Bearbeitung" }]);
    assert.deepEqual(data.views[0].groupSettings!.collapsed, [pathCollapseKey(["lane", groupKey("In Bearbeitung")])]);
    // A linked view open elsewhere reloads before saving its views.
    assert.equal(data.version, 2);
  }
  // The same name in another database's block stays, and so does the text.
  const untouched = (await linkedDatabaseData(owner, host, otherBlock)).database;
  assert.deepEqual(untouched.views[0].filters, [{ field: "status", op: "eq", value: "In Arbeit" }]);
  assert.equal(untouched.version, 1);
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", host))!.html, /<p>Stand<\/p>/);
});

test("collapsed groups below the first level follow with the property of their level", async () => {
  const { renameInViews, renameMaps } = await import("../lib/option-renames");
  const view: View = {
    id: "v",
    name: "V",
    type: "table",
    groupBy: "phase",
    subGroupBy: "status",
    groupLevels: ["labels"],
    filters: [],
    sorts: [],
    groupSettings: {
      hideEmpty: false,
      sort: "manual",
      collapsed: [
        groupKey("In Arbeit"),
        pathCollapseKey([groupKey("In Arbeit"), groupKey("In Arbeit")]),
        pathCollapseKey([groupKey("Fertig"), groupKey("Offen"), groupKey("Rot")]),
        pathCollapseKey(["lane", groupKey("In Arbeit")]),
      ],
      order: [groupKey("In Arbeit")],
    },
  };
  renameInViews(
    [view],
    renameMaps([
      { field: "status", from: "In Arbeit", to: "Aktiv" },
      { field: "labels", from: "Rot", to: "Dringend" },
    ]),
  );
  assert.deepEqual(view.groupSettings!.collapsed, [
    // The first level groups by "phase", whose "In Arbeit" stays.
    groupKey("In Arbeit"),
    pathCollapseKey([groupKey("In Arbeit"), groupKey("Aktiv")]),
    pathCollapseKey([groupKey("Fertig"), groupKey("Offen"), groupKey("Dringend")]),
    pathCollapseKey(["lane", groupKey("Aktiv")]),
  ]);
  assert.deepEqual(view.groupSettings!.order, [groupKey("In Arbeit")]);
});
