// Scopes of tags, page properties and templates (#136): the migration,
// names per scope, visibility and rights per space, promoting and demoting
// with their references, moving pages with map/copy/remove (nothing lost
// silently), templates of one space used in another, and the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Field, Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-meta-scope-"));
const { one, all, run, id, migrateMetaScopes } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData, database } = await import("../lib/api");
const { searchWorkspace } = await import("../lib/search-index");
const { listPageTemplates } = await import("../lib/page-templates");
const { contextOf, inScope, parseSearchTokens } = await import("../lib/page-properties");
const { choiceFor, defaultChoice, metaKey, planFrom } = await import("../lib/meta-scope");
const { commandActionNames } = await import("../lib/openapi");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Olga"),
  editor = account("Emil"),
  manager = account("Mia"),
  outsider = account("Otto");
const wid = createWorkspace(owner.id, "Agentur");
for (const u of [editor, manager, outsider]) run("INSERT INTO members VALUES(?,?,?)", wid, u.id, "editor");
type Result = { id: string } & Record<string, unknown>;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Result;
// Space A (team, managed by Mia), space B (team), space P (private, Olga's).
const spaceA = act({ action: "space.create", workspaceId: wid, name: "Vertrieb" }, manager).id;
const spaceB = act({ action: "space.create", workspaceId: wid, name: "Entwicklung" }).id;
const spaceP = act({ action: "space.create", workspaceId: wid, name: "Geheim", private: true }).id;
const page = (title: string, spaceId: string, kind = "document", as = owner) => act({ action: "page.create", workspaceId: wid, spaceId, title, kind }, as).id;
const meta = (pageId: string) => (pageData(owner, pageId) as { properties?: { tags: string[]; values: Record<string, unknown> } }).properties!;
const tagRow = (tagId: string) => one<{ name: string; space_id: string | null }>("SELECT name,space_id FROM page_tags WHERE id=?", tagId);
const tagsNamed = (name: string) => all<{ id: string; space_id: string | null }>("SELECT id,space_id FROM page_tags WHERE workspace_id=? AND name=? COLLATE NOCASE", wid, name);
const tag = (name: string, spaceId: string | null, as = owner) => act({ action: "tag.save", workspaceId: wid, name, spaceId }, as).id;
const property = (name: string, type: string, spaceId: string | null, options: string[] = [], as = owner) =>
  act({ action: "property.save", workspaceId: wid, name, type, options, spaceId }, as).id;

test("schema 91: existing tags, definitions and templates stay workspace-wide; per-scope unique indexes", () => {
  // A database as it was before #136 (schema 82): no space_id, unique names per workspace.
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY);
    CREATE TABLE page_tags(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT 'gray',position REAL NOT NULL DEFAULT 0,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX page_tags_name ON page_tags(workspace_id,name COLLATE NOCASE);
    CREATE TABLE page_property_defs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,options TEXT NOT NULL DEFAULT '[]',position REAL NOT NULL DEFAULT 0,created_by TEXT,created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX page_property_defs_name ON page_property_defs(workspace_id,name COLLATE NOCASE);
    CREATE TABLE templates(id TEXT PRIMARY KEY,workspace_id TEXT,name TEXT,kind TEXT,payload TEXT,created_by TEXT);
    INSERT INTO page_tags(id,workspace_id,name,created_at) VALUES('t1','w','Kunde',1);
    INSERT INTO page_property_defs(id,workspace_id,name,type,created_at) VALUES('p1','w','Status','text',1);
    INSERT INTO templates(id,workspace_id,name,kind,payload) VALUES('v1','w','Angebot','document','{}');`);
  migrateMetaScopes(old);
  migrateMetaScopes(old); // idempotent
  for (const table of ["page_tags", "page_property_defs", "templates"])
    assert.equal((old.prepare(`SELECT space_id FROM ${table}`).get() as { space_id: string | null }).space_id, null, table);
  const indexes = (old.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((i) => i.name);
  assert.ok(!indexes.includes("page_tags_name") && indexes.includes("page_tags_scope_name"));
  // Same name in two spaces: fine; twice in one scope: refused.
  old.exec("INSERT INTO spaces VALUES('a'),('b')");
  old.exec("INSERT INTO page_tags(id,workspace_id,space_id,name,created_at) VALUES('t2','w','a','Urgent',1),('t3','w','b','Urgent',1)");
  assert.throws(() => old.exec("INSERT INTO page_tags(id,workspace_id,space_id,name,created_at) VALUES('t4','w','a','urgent',1)"), /UNIQUE/);
  assert.throws(() => old.exec("INSERT INTO page_tags(id,workspace_id,name,created_at) VALUES('t5','w','KUNDE',1)"), /UNIQUE/);
  // The live database is on 91.
  assert.ok((all<{ name: string }>("PRAGMA table_info(page_tags)")).some((c) => c.name === "space_id"));
});

test("scoping rules: context of a space, plans and their defaults", () => {
  const items = [
    { id: "w", spaceId: null },
    { id: "a", spaceId: "A" },
    { id: "b", spaceId: "B" },
  ];
  assert.deepEqual(contextOf(items, "A").map((i) => i.id), ["w", "a"]);
  assert.deepEqual(contextOf(items, null).map((i) => i.id), ["w"]);
  assert.equal(inScope({ spaceId: undefined }, "X"), true);
  const item = { kind: "tag" as const, id: "t", sameName: "u" };
  assert.deepEqual(defaultChoice(item), { action: "map", to: "u" });
  assert.deepEqual(defaultChoice({ ...item, sameName: null }), { action: "copy" });
  assert.equal(choiceFor(item, undefined), undefined);
  assert.deepEqual(choiceFor(item, { default: "remove" }), { action: "remove" });
  assert.deepEqual(choiceFor(item, { tags: { t: { action: "copy" } }, default: "remove" }), { action: "copy" });
  assert.equal(metaKey("tag", "  Two  Words "), "tag:two words");
  const full = { ...item, name: "x", spaceId: null, pages: 1, records: 0, candidates: [] };
  assert.deepEqual(planFrom([full], {}), { tags: { t: { action: "map", to: "u" } }, properties: {} });
  // A #name in the search names every tag of that name (one per space).
  const parsed = parseSearchTokens("#urgent status:offen", {
    tags: [
      { id: "1", name: "Urgent" },
      { id: "2", name: "urgent" },
    ],
    properties: [
      { id: "p", name: "Status", type: "select" },
      { id: "q", name: "status", type: "text" },
    ],
  });
  assert.deepEqual(parsed.tags, [{ tagId: "1", tagIds: ["1", "2"], exclude: false }]);
  assert.equal(parsed.properties[0].propertyId, "p");
  assert.equal(parsed.properties[0].also?.[0].propertyId, "q");
});

test("duplicates: allowed across spaces, refused within a context (case ignored)", () => {
  const a = tag("Urgent", spaceA);
  const b = tag("urgent", spaceB);
  assert.notEqual(a, b);
  assert.throws(() => tag("URGENT", spaceA), /gibt es schon im Bereich „Vertrieb“/);
  // A workspace tag would share every context with them.
  assert.throws(() => tag("Urgent", null), /gibt es schon/);
  tag("Kunde", null);
  assert.throws(() => tag("kunde", spaceA), /gibt es schon\./);
  // Properties alike; renaming follows the same rule.
  const status = property("Phase", "select", spaceA, ["Offen"]);
  property("Phase", "text", spaceB);
  assert.throws(() => property("phase", "text", spaceA), /gibt es schon/);
  assert.throws(() => property("Phase", "text", null), /gibt es schon/);
  property("Budget", "number", null);
  assert.throws(() => act({ action: "property.save", workspaceId: wid, propertyId: status, name: "budget", type: "select" }), /gibt es schon/);
  // Pages use their context: a name means the tag of their space.
  const offer = page("Angebot", spaceA);
  const spec = page("Spezifikation", spaceB);
  act({ action: "page.properties", pageId: offer, addTags: ["urgent"], values: { phase: "Offen" } });
  act({ action: "page.properties", pageId: spec, addTags: ["Urgent"], values: { Phase: "frei" } });
  assert.deepEqual(meta(offer).tags, [a]);
  assert.deepEqual(meta(spec).tags, [b]);
  // Another space's tag is refused by id, never swapped.
  assert.throws(() => act({ action: "page.properties", pageId: offer, addTags: [b] }), /anderen Bereich/);
  // New tags while tagging belong to the page's space.
  act({ action: "page.properties", pageId: offer, addTags: ["Lead"] }, editor);
  assert.equal(tagRow(tagsNamed("Lead")[0].id)?.space_id, spaceA);
  // The search: #urgent finds both pages (one name, one tag per space).
  assert.deepEqual(searchWorkspace(owner, wid, "#urgent").map((h) => h.id).sort(), [offer, spec].sort());
  assert.deepEqual(searchWorkspace(owner, wid, "phase:offen").map((h) => h.id), [offer]);
});

test("visibility and rights per space", () => {
  const secret = tag("Intern", spaceP);
  // Olga (owner) sees every scope; Emil cannot open the private space.
  assert.ok(bootstrap(owner, wid).taxonomy!.tags.some((t) => t.id === secret));
  const seen = bootstrap(editor, wid).taxonomy!;
  assert.ok(!seen.tags.some((t) => t.id === secret));
  assert.ok(seen.tags.some((t) => t.name === "Urgent" && t.spaceId === spaceA));
  // Editors: tags of spaces they write in, not of the workspace or a closed space.
  assert.ok(tag("Rückruf", spaceB, editor));
  assert.throws(() => tag("Global", null, editor), /Eigentümer/);
  assert.throws(() => tag("Hinein", spaceP, editor), /Schreibrechte/);
  // Space managers (Mia owns "Vertrieb") manage its own tags and definitions …
  const urgentA = tagsNamed("urgent").find((t) => t.space_id === spaceA)!.id;
  act({ action: "tag.save", workspaceId: wid, tagId: urgentA, name: "Dringend", color: "red" }, manager);
  assert.equal(tagRow(urgentA)?.name, "Dringend");
  assert.ok(property("Region", "text", spaceA, [], manager));
  assert.deepEqual(bootstrap(manager, wid).taxonomy!.manageSpaces, [spaceA]);
  // … not those of the workspace or another space, and editors none.
  const kunde = tagsNamed("Kunde")[0].id;
  assert.throws(() => act({ action: "tag.save", workspaceId: wid, tagId: kunde, name: "Kunden" }, manager), /Eigentümer/);
  assert.throws(() => property("Team", "text", spaceB, [], manager), /Eigentümer/);
  assert.throws(() => act({ action: "tag.delete", workspaceId: wid, tagId: urgentA }, editor), /Eigentümer|Berechtigung/);
  // Merging only into a tag every page may carry.
  const urgentB = tagsNamed("urgent").find((t) => t.space_id === spaceB)!.id;
  assert.throws(() => act({ action: "tag.merge", workspaceId: wid, tagId: urgentA, into: urgentB }), /desselben Bereichs/);
  // Scope changes: owners only.
  assert.throws(() => act({ action: "tag.scope", workspaceId: wid, tagId: urgentA, spaceId: null }, manager), /Eigentümer/);
  act({ action: "tag.save", workspaceId: wid, tagId: urgentA, name: "Urgent" }, manager);
});

test("promoting and demoting with references: block, copy, remove, merge", () => {
  // A workspace tag used in A and B.
  const kunde = tagsNamed("Kunde")[0].id;
  const inA = page("Kunde A", spaceA),
    inB = page("Kunde B", spaceB);
  act({ action: "page.properties", pageId: inA, addTags: [kunde] });
  act({ action: "page.properties", pageId: inB, addTags: [kunde] });
  const usage = act({ action: "meta.usage", workspaceId: wid, kind: "tag", id: kunde, spaceId: spaceA }) as unknown as { usage: { spaceId: string; pages: number }[] };
  assert.deepEqual(usage.usage.map((u) => [u.spaceId, u.pages]), [[spaceB, 1]]);
  // Demote to A: blocked while B uses it …
  assert.throws(() => act({ action: "tag.scope", workspaceId: wid, tagId: kunde, spaceId: spaceA }), /außerhalb des Zielbereichs/);
  assert.equal(tagRow(kunde)?.space_id, null);
  // … with "copy" B keeps a tag of the same name, its own.
  act({ action: "tag.scope", workspaceId: wid, tagId: kunde, spaceId: spaceA, resolve: "copy" });
  assert.equal(tagRow(kunde)?.space_id, spaceA);
  const copy = meta(inB).tags[0];
  assert.notEqual(copy, kunde);
  assert.deepEqual(tagRow(copy), { name: "Kunde", space_id: spaceB });
  assert.deepEqual(meta(inA).tags, [kunde]);
  // Promote A's back: B's same-named tag is in the way – merged on request.
  assert.throws(() => act({ action: "tag.scope", workspaceId: wid, tagId: kunde, spaceId: null }), /Gleichnamige/);
  act({ action: "tag.scope", workspaceId: wid, tagId: kunde, spaceId: null, mergeSameName: true });
  assert.equal(tagRow(kunde)?.space_id, null);
  assert.deepEqual(meta(inB).tags, [kunde]);
  assert.equal(tagRow(copy), undefined);
  // Demote a property with "remove": its values outside the target go.
  const budget = all<{ id: string }>("SELECT id FROM page_property_defs WHERE name='Budget'")[0].id;
  act({ action: "page.properties", pageId: inA, values: { Budget: 10 } });
  act({ action: "page.properties", pageId: inB, values: { Budget: 20 } });
  act({ action: "property.scope", workspaceId: wid, propertyId: budget, spaceId: spaceA, resolve: "remove" });
  assert.equal(meta(inA).values[budget], 10);
  assert.equal(meta(inB).values[budget], undefined);
});

test("moving pages: check, refusal without a choice, map / copy / remove, records follow", () => {
  // In A: a page with A's tag "Urgent", the workspace tag "Kunde", A's
  // property "Phase" and A's "Region"; a sub-database with A's tag in records.
  const urgentA = tagsNamed("urgent").find((t) => t.space_id === spaceA)!.id;
  const urgentB = tagsNamed("urgent").find((t) => t.space_id === spaceB)!.id;
  const kunde = tagsNamed("Kunde")[0].id;
  const root = page("Projekt X", spaceA);
  act({ action: "page.properties", pageId: root, addTags: [urgentA, kunde, "Lead"], values: { Phase: "Offen", Region: "Nord" } });
  const db = act({ action: "page.create", workspaceId: wid, spaceId: spaceA, parentId: root, title: "Aufgaben", kind: "database" }).id;
  const d = database(db);
  act({ action: "database.update", pageId: db, version: d.version, fields: [...d.fields, { id: "themen", name: "Themen", type: "multiselect", tagOptions: true, options: [] } as Field], views: d.views });
  const row = act({ action: "row.create", pageId: db, cells: { [d.fields[0].id]: "Eins", themen: ["Lead", "Kunde"] } }).id;
  const cells = () => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row)!.cells).themen;
  // What moving to B brings: A's tags and definitions, not the workspace's.
  const check = act({ action: "page.moveCheck", pageId: root, spaceId: spaceB }) as unknown as { foreign: { kind: string; id: string; name: string; sameName: string | null; records: number }[] };
  const names = check.foreign.map((f) => `${f.kind}:${f.name}`).sort();
  assert.deepEqual(names, ["property:Phase", "property:Region", "tag:Lead", "tag:Urgent"]);
  assert.equal(check.foreign.find((f) => f.name === "Urgent")?.sameName, urgentB);
  // Phase in B is text, A's is a select: no same-named one of that type.
  assert.equal(check.foreign.find((f) => f.name === "Phase")?.sameName, null);
  assert.equal(check.foreign.find((f) => f.name === "Lead")?.records, 1);
  // Without a choice: refused, nothing moved.
  assert.throws(() => act({ action: "page.move", pageId: root, spaceId: spaceB, parentId: null }), /zuordnen, kopieren oder entfernen/);
  assert.equal(one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", root)?.space_id, spaceA);
  // Urgent → B's Urgent, Lead copied, Phase copied, Region removed.
  const phaseA = all<{ id: string }>("SELECT id FROM page_property_defs WHERE name='Phase' AND space_id=?", spaceA)[0].id;
  const regionA = all<{ id: string }>("SELECT id FROM page_property_defs WHERE name='Region' AND space_id=?", spaceA)[0].id;
  const leadA = tagsNamed("Lead")[0].id;
  act({
    action: "page.move",
    pageId: root,
    spaceId: spaceB,
    parentId: null,
    meta: {
      tags: { [urgentA]: { action: "map", to: urgentB }, [leadA]: { action: "copy" } },
      properties: { [phaseA]: { action: "copy" }, [regionA]: { action: "remove" } },
    },
  });
  assert.equal(one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", db)?.space_id, spaceB);
  const after = meta(root);
  const leadB = tagsNamed("Lead").find((t) => t.space_id === spaceB)!.id;
  assert.deepEqual(after.tags.sort(), [urgentB, kunde, leadB].sort());
  // The copied "Phase" keeps its value under a free name (B has a text "Phase").
  const phaseB = one<{ id: string; name: string; type: string; options: string }>("SELECT id,name,type,options FROM page_property_defs WHERE space_id=? AND type='select'", spaceB)!;
  assert.equal(phaseB.name, "Phase (Vertrieb)");
  assert.equal(after.values[phaseB.id], "Offen");
  assert.equal(after.values[regionA], undefined);
  // Records keep their names; they are B's now.
  assert.deepEqual(cells(), ["Lead", "Kunde"]);
  assert.ok(database(db).fields.find((f) => f.id === "themen")!.options!.includes("Lead"));
  // A keeps its own tags and definitions.
  assert.equal(tagRow(urgentA)?.space_id, spaceA);
  assert.equal(tagRow(leadA)?.space_id, spaceA);
  // Moving back with "auto" (undo): the same-named ones of A.
  act({ action: "page.move", pageId: root, spaceId: spaceA, parentId: null, meta: "auto" });
  assert.deepEqual(meta(root).tags.sort(), [urgentA, kunde, leadA].sort());
  // Bulk moves pass the plan on.
  const loose = page("Lose", spaceA);
  act({ action: "page.properties", pageId: loose, addTags: [urgentA] });
  assert.throws(() => act({ action: "pages.bulk", workspaceId: wid, operation: "move", pageIds: [loose], spaceId: spaceB }), /zuordnen/);
  act({ action: "pages.bulk", workspaceId: wid, operation: "move", pageIds: [loose], spaceId: spaceB, meta: { default: "remove" } });
  assert.deepEqual(meta(loose).tags, []);
});

test("templates: scope on saving, workspace templates without a space's tags, use and copy across spaces", () => {
  const source = page("Angebotsvorlage", spaceA);
  const urgentA = tagsNamed("urgent").find((t) => t.space_id === spaceA)!.id;
  const urgentB = tagsNamed("urgent").find((t) => t.space_id === spaceB)!.id;
  act({ action: "page.properties", pageId: source, addTags: [urgentA, "Kunde", "Lead"], values: { Phase: "Offen" } });
  // By default for the page's space; only visible to who may open it.
  const own = act({ action: "template.save", pageId: source, name: "Angebot A" }, editor).id;
  assert.equal(one<{ space_id: string }>("SELECT space_id FROM templates WHERE id=?", own)?.space_id, spaceA);
  const listed = listPageTemplates(editor, wid).find((t) => t.id === own) as unknown as { space_id: string; space_name: string };
  assert.deepEqual([listed.space_id, listed.space_name], [spaceA, "Vertrieb"]);
  // For the whole workspace: owners only, and without the space's tags.
  assert.throws(() => act({ action: "template.save", pageId: source, name: "Global", spaceId: null }, editor), /Eigentümer/);
  assert.throws(() => act({ action: "template.save", pageId: source, name: "Global", spaceId: null }), /#Urgent/);
  const global = act({ action: "template.save", pageId: source, name: "Global", spaceId: null, spaceMeta: "remove" }).id;
  const payload = JSON.parse(one<{ payload: string }>("SELECT payload FROM templates WHERE id=?", global)!.payload);
  assert.deepEqual(payload.meta.tags.map((t: { name: string }) => t.name), ["Kunde"]);
  // Private space templates stay hidden from those who cannot open it.
  const secretPage = page("Geheimvorlage", spaceP);
  const secret = act({ action: "template.save", pageId: secretPage, name: "Geheim" }).id;
  assert.ok(!listPageTemplates(editor, wid).some((t) => t.id === secret));
  assert.throws(() => act({ action: "page.create", workspaceId: wid, spaceId: spaceB, title: "x", templateId: secret }, editor), /anderen Bereichs/);
  // Used in B: Urgent → B's (same name), Lead copied, Phase removed.
  const deps = act({ action: "template.dependencies", workspaceId: wid, templateId: own, spaceId: spaceB }) as unknown as {
    items: { id: string; name: string; sameName: string | null }[];
  };
  assert.deepEqual(deps.items.map((i) => i.id).sort(), ["property:phase", "tag:lead", "tag:urgent"]);
  assert.equal(deps.items.find((i) => i.name === "Urgent")?.sameName, urgentB);
  const made = act({
    action: "page.create",
    workspaceId: wid,
    spaceId: spaceB,
    title: "Angebot in B",
    templateId: own,
    meta: { tags: { "tag:urgent": { action: "map", to: urgentB }, "tag:lead": { action: "copy" } }, properties: { "property:phase": { action: "remove" } } },
  }).id;
  // B has its own "Lead" (from the move): a copy takes a free name.
  const leadCopy = tagsNamed("Lead (Vertrieb)").find((t) => t.space_id === spaceB)!.id;
  assert.deepEqual(meta(made).tags.sort(), [urgentB, tagsNamed("Kunde")[0].id, leadCopy].sort());
  assert.deepEqual(meta(made).values, {});
  // Without a plan: the same-named ones, else copies (Phase: B's is text, so a copy).
  const auto = act({ action: "page.create", workspaceId: wid, spaceId: spaceB, title: "Auto", templateId: own }).id;
  const values = Object.entries(meta(auto).values).map(([pid, value]) => ({ value, ...one<{ name: string; space_id: string; type: string }>("SELECT name,space_id,type FROM page_property_defs WHERE id=?", pid) }));
  assert.equal(values.length, 1);
  assert.match(values[0].name!, /^Phase \(/);
  assert.deepEqual([values[0].space_id, values[0].type, values[0].value], [spaceB, "select", "Offen"]);
  assert.ok(meta(auto).tags.includes(tagsNamed("Lead").find((t) => t.space_id === spaceB)!.id));
  // A copy of the template for B, its tags resolved there.
  const copied = act({ action: "template.copy", workspaceId: wid, templateId: own, spaceId: spaceB, meta: "auto" }, editor).id;
  assert.equal(one<{ space_id: string }>("SELECT space_id FROM templates WHERE id=?", copied)?.space_id, spaceB);
  assert.deepEqual(
    (act({ action: "template.dependencies", workspaceId: wid, templateId: copied, spaceId: spaceB }) as unknown as { items: unknown[] }).items,
    [],
  );
  // Promoting a space template: refused while it uses the space's tags.
  const version = () => one<{ version: number }>("SELECT version FROM templates WHERE id=?", own)!.version;
  assert.throws(
    () => act({ action: "template.update", workspaceId: wid, templateId: own, version: version(), name: "Angebot A", visibility: "workspace", spaceId: null }),
    /#Urgent/,
  );
  act({ action: "template.update", workspaceId: wid, templateId: own, version: version(), name: "Angebot A", visibility: "workspace", spaceId: null, spaceMeta: "remove" });
  assert.equal(one<{ space_id: string | null }>("SELECT space_id FROM templates WHERE id=?", own)?.space_id, null);
  // Demoting to a space needs no resolution.
  act({ action: "template.update", workspaceId: wid, templateId: own, version: version(), name: "Angebot A", visibility: "workspace", spaceId: spaceB });
  assert.equal(one<{ space_id: string }>("SELECT space_id FROM templates WHERE id=?", own)?.space_id, spaceB);
});

test("copies of pages into another space bring their space's tags along by name", () => {
  const urgentA = tagsNamed("urgent").find((t) => t.space_id === spaceA)!.id;
  const original = page("Original", spaceA);
  act({ action: "page.properties", pageId: original, addTags: [urgentA, "Kunde"] });
  const copy = act({ action: "page.duplicate", pageId: original }).id;
  assert.deepEqual(meta(copy).tags.sort(), meta(original).tags.sort());
});

test("the API lists the scope actions", () => {
  for (const action of ["tag.scope", "property.scope", "meta.usage", "page.moveCheck", "template.copy", "template.dependencies"])
    assert.ok((commandActionNames as readonly string[]).includes(action), action);
});
