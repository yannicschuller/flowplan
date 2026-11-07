// Tags and custom properties of pages (#70): permissions, CRUD, the
// migration, the search tokens, frontmatter, templates, copies and archives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
import { filterAsync, mapAsync } from "../lib/each-async";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-properties-"));
const { db, one, all, run, id, tableNames } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { searchWorkspace } = await import("../lib/search-index");
const { splitFrontmatter } = await import("../lib/frontmatter");
const { exportMarkdown } = await import("../lib/markdown-export");
const { importZip } = await import("../lib/zip-import");
const { writeZip, exportArchive, importArchive } = await import("../lib/archive");
const { parseSearchTokens, matchesPropertyFilter, tagColorFrom, tagToken } = await import("../lib/page-properties");
const { tagListing, frontmatterMeta, workspaceProperties } = await import("../lib/page-properties-server");
const { commandActionNames, commandActions } = await import("../lib/openapi");
const { writeImport } = await import("../lib/importers/write");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  editor = await account("Emil"),
  viewer = await account("Vera"),
  guest = await account("Gustav");
const wid = await createWorkspace(owner.id, "Agentur");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.id, "editor");
await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, guest.id);
const team = (await bootstrap(owner, wid)).spaces[0].id;
type Result = { id: string } & Record<string, unknown>;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Result;
const page = async (title: string, kind = "document", spaceId = team) => (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind })).id;
const meta = async (pageId: string, as = owner) => ((await pageData(as, pageId)) as { properties?: { tags: string[]; values: Record<string, unknown> } }).properties;
const tagId = async (name: string) => (await one<{ id: string }>("SELECT id FROM page_tags WHERE workspace_id=? AND name=?", wid, name))?.id;

const angebot = await page("Angebot Müller");
const protokoll = await page("Protokoll Kick-off");
const board = await page("Moodboard", "whiteboard");

test("schema 82: tables, created_at on pages", async () => {
  for (const table of ["page_tags", "page_tag_links", "page_property_defs", "page_property_values"])
    assert.ok((await tableNames()).includes(table), table);
  const created = (await one<{ created_at: string | null }>("SELECT created_at FROM pages WHERE id=?", angebot))!;
  assert.match(String(created.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // Migrating again changes nothing (idempotent).
  (globalThis as { flowplanSchema?: number }).flowplanSchema = undefined;
  db();
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM page_tags"))!.n, 0);
});

test("tags: editors tag pages and create tags, owners manage them, viewers and guests may not", async () => {
  const result = await act({ action: "page.properties", pageId: angebot, tags: ["Kunde", "#Angebot"] }, editor);
  const kunde = (await tagId("Kunde"))!,
    angebotTag = (await tagId("Angebot"))!;
  assert.deepEqual(result.tags, [kunde, angebotTag]);
  // The same name (any case) is the same tag.
  await act({ action: "page.properties", pageId: protokoll, addTags: ["kunde", "Intern"] }, editor);
  assert.deepEqual((await meta(protokoll))!.tags, [kunde, await tagId("Intern")]);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, addTags: ["X"] }, viewer), /Berechtigung/);
  // Owners rename, recolour, merge, delete; editors may not.
  await assert.rejects(async () => await act({ action: "tag.save", workspaceId: wid, tagId: kunde, name: "Kunden" }, editor), /Eigentümer|Berechtigung/);
  await act({ action: "tag.save", workspaceId: wid, tagId: kunde, name: "Kunden", color: "purple" });
  assert.equal((await one<{ name: string; color: string }>("SELECT name,color FROM page_tags WHERE id=?", kunde))?.color, "purple");
  await assert.rejects(async () => await act({ action: "tag.save", workspaceId: wid, tagId: kunde, name: "intern" }), /gibt es schon/);
  await assert.rejects(async () => await act({ action: "tag.save", workspaceId: wid, name: "Angebot" }, editor), /gibt es schon/);
  await act({ action: "tag.merge", workspaceId: wid, tagId: (await tagId("Intern"))!, into: angebotTag });
  assert.equal(await tagId("Intern"), undefined);
  assert.deepEqual((await meta(protokoll))!.tags.sort(), [kunde, angebotTag].sort());
  await act({ action: "tag.reorder", workspaceId: wid, order: [angebotTag, kunde] });
  assert.deepEqual((await bootstrap(owner, wid)).taxonomy!.tags.map((t) => t.name), ["Angebot", "Kunden"]);
  // Removing a tag from a page, then deleting a tag.
  await act({ action: "page.properties", pageId: protokoll, removeTags: ["Angebot"] });
  assert.deepEqual((await meta(protokoll))!.tags, [kunde]);
  const temp = (await act({ action: "tag.save", workspaceId: wid, name: "Temp", spaceId: team }, editor)).id;
  await act({ action: "page.properties", pageId: protokoll, addTags: [temp] });
  await act({ action: "tag.delete", workspaceId: wid, tagId: temp });
  assert.deepEqual((await meta(protokoll))!.tags, [kunde]);
  // Guests: no new tags, and they see only tags of their pages.
  await run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", protokoll, guest.id, "editor");
  await assert.rejects(async () => await act({ action: "page.properties", pageId: protokoll, addTags: ["Geheim"] }, guest), /Neue Tags/);
  await act({ action: "page.properties", pageId: protokoll, addTags: ["Angebot"] }, guest);
  const guestView = (await bootstrap(guest, wid)).taxonomy!;
  assert.deepEqual(guestView.tags.map((t) => t.name).sort(), ["Angebot", "Kunden"]);
  assert.equal(guestView.manage, false);
  assert.equal(guestView.createTags, false);
  assert.deepEqual(Object.keys(guestView.links), [protokoll]);
  // Read tokens never write.
  await assert.rejects(async () => await act({ action: "tag.save", workspaceId: wid, name: "Lesen" }, { ...editor, apiScope: "read" }), /nur lesen/);
});

test("properties: owners define them, editors set values that follow the type", async () => {
  await assert.rejects(async () => await act({ action: "property.save", workspaceId: wid, name: "Status", type: "select", options: ["Offen"] }, editor), /Eigentümer|Berechtigung/);
  const status = (await act({ action: "property.save", workspaceId: wid, name: "Status", type: "select", options: ["Offen", "Erledigt", "offen", ""] })).id;
  assert.deepEqual((await workspaceProperties(wid)).find((p) => p.id === status)?.options, ["Offen", "Erledigt"]);
  const budget = (await act({ action: "property.save", workspaceId: wid, name: "Budget", type: "number" })).id;
  const due = (await act({ action: "property.save", workspaceId: wid, name: "Fällig", type: "date" })).id;
  const done = (await act({ action: "property.save", workspaceId: wid, name: "Abgerechnet", type: "checkbox" })).id;
  const lead = (await act({ action: "property.save", workspaceId: wid, name: "Verantwortlich", type: "person" })).id;
  const site = (await act({ action: "property.save", workspaceId: wid, name: "Website", type: "url" })).id;
  await act({ action: "property.save", workspaceId: wid, name: "Erstellt", type: "created_at" });
  await assert.rejects(async () => await act({ action: "property.save", workspaceId: wid, name: "status", type: "text" }), /gibt es schon/);
  const result = await act(
    { action: "page.properties", pageId: angebot, values: { [status]: "offen", Budget: "12,5", [due]: "2026-12-01", [done]: true, [lead]: editor.id, [site]: "example.com" } },
    editor,
  );
  assert.deepEqual(result.values, { [status]: "Offen", [budget]: 12.5, [due]: "2026-12-01", [done]: true, [lead]: editor.id, [site]: "example.com" });
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, values: { [status]: "Unbekannt" } }), /Unbekannte Auswahl/);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, values: { [due]: "morgen" } }), /Ungültiger Wert/);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, values: { [lead]: id() } }), /Mitglied fehlt/);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, values: { Erstellt: "2020-01-01" } }), /automatisch/);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, values: { Nichts: "x" } }), /Unbekannte Eigenschaft/);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: angebot, values: { [budget]: 3 } }, viewer), /Berechtigung/);
  // null and false remove a value.
  await act({ action: "page.properties", pageId: angebot, values: { [done]: false } });
  assert.equal((await meta(angebot))!.values[done], undefined);
  // Info for the read-only types.
  const info = ((await pageData(owner, angebot)) as { properties: { info: { createdBy: string; createdAt: string } } }).properties.info;
  assert.equal(info.createdBy, owner.id);
  assert.ok(info.createdAt);
  // Changing the definition: a removed option removes its values; select →
  // multiselect converts them.
  await act({ action: "page.properties", pageId: protokoll, values: { [status]: "Erledigt" } });
  await act({ action: "property.save", workspaceId: wid, propertyId: status, name: "Status", options: ["Offen"] });
  assert.equal((await meta(protokoll))!.values[status], undefined);
  await act({ action: "property.save", workspaceId: wid, propertyId: status, name: "Phase", type: "multiselect", options: ["Offen", "Pitch"] });
  assert.deepEqual((await meta(angebot))!.values[status], ["Offen"]);
  // Deleting a definition takes its values along.
  const temp = (await act({ action: "property.save", workspaceId: wid, name: "Temp", type: "text" })).id;
  await act({ action: "page.properties", pageId: angebot, values: { Temp: "weg" } });
  await act({ action: "property.delete", workspaceId: wid, propertyId: temp });
  assert.equal(await one("SELECT 1 FROM page_property_values WHERE property_id=?", temp), undefined);
  await act({ action: "property.reorder", workspaceId: wid, order: [budget, status] });
  assert.deepEqual((await workspaceProperties(wid)).slice(0, 2).map((p) => p.name), ["Budget", "Phase"]);
});

test("search tokens: #tag, -#tag, name:value and the index", async () => {
  const taxonomy = { tags: [{ id: "t1", name: "Kunden" }, { id: "t2", name: "Two Words" }], properties: [{ id: "p1", name: "Budget", type: "number" as const }, { id: "p2", name: "Phase", type: "multiselect" as const }] };
  const parsed = parseSearchTokens('Angebot #kunden -#"two words" budget:>10 Phase:Offen http://x.y #123', taxonomy);
  assert.equal(parsed.text, "Angebot http://x.y #123");
  assert.deepEqual(parsed.tags, [{ tagId: "t1", exclude: false }, { tagId: "t2", exclude: true }]);
  assert.deepEqual(parsed.properties, [
    { propertyId: "p1", op: "gt", value: "10" },
    { propertyId: "p2", op: "eq", value: "Offen" },
  ]);
  assert.equal(matchesPropertyFilter({ type: "number" }, 12.5, parsed.properties[0]), true);
  assert.equal(matchesPropertyFilter({ type: "number" }, 3, parsed.properties[0]), false);
  assert.equal(matchesPropertyFilter({ type: "date" }, "2026-12-01", { propertyId: "", op: "eq", value: "2026-12" }), true);
  assert.equal(matchesPropertyFilter({ type: "date" }, "2026-12-01", { propertyId: "", op: "between", value: "2026-11-01", to: "2026-11-30" }), false);
  assert.equal(matchesPropertyFilter({ type: "text" }, "", { propertyId: "", op: "empty", value: "" }), true);
  assert.equal(tagToken("Two Words"), '#"Two Words"');
  // In the workspace.
  const hits = async (q: string, as = owner) => (await searchWorkspace(as, wid, q)).map((h) => h.id);
  assert.deepEqual((await hits("#Kunden")).sort(), [angebot, protokoll].sort());
  assert.deepEqual(await hits("#Kunden Protokoll"), [protokoll]);
  assert.deepEqual(await hits("#Kunden -#Angebot"), []);
  assert.deepEqual(await hits("Moodboard -#Angebot"), [board]);
  assert.deepEqual(await hits("budget:>10"), [angebot]);
  assert.deepEqual(await hits("budget:<10"), []);
  assert.deepEqual(await hits("Phase:offen"), [angebot]);
  assert.deepEqual(await hits("verantwortlich:emil"), [angebot]);
  assert.deepEqual(await hits("verantwortlich:me", editor), [angebot]);
  assert.deepEqual(await hits("Fällig:2026-12"), [angebot]);
  assert.ok((await hits("Fällig:*")).includes(angebot) && !(await hits("Fällig:*")).includes(protokoll));
  assert.ok((await hits("Fällig:-")).includes(protokoll));
  // Tag names and values are words of the page.
  assert.ok((await hits("Kunden")).includes(angebot));
  assert.ok((await hits("example.com")).includes(angebot));
  // Private pages stay private.
  assert.deepEqual(await hits("#Kunden", guest), [protokoll]);
  // A name that is no tag stays a word.
  assert.deepEqual(await hits("#Unbekannt"), []);
});

test("tag view listing and pageData for readers", async () => {
  const listing = await tagListing(owner, wid, await tagId("Kunden"));
  assert.equal(listing.tags.find((t) => t.name === "Kunden")?.pages, 2);
  assert.deepEqual(listing.pages!.map((p) => p.id).sort(), [angebot, protokoll].sort());
  assert.deepEqual((await tagListing(guest, wid, await tagId("Kunden"))).pages!.map((p) => p.id), [protokoll]);
  await assert.rejects(async () => await tagListing(guest, wid, id()), /nicht gefunden/);
  // Viewers read the values.
  assert.ok((await meta(angebot, viewer))!.tags.length);
});

test("duplicates and templates carry tags and values; trash keeps them", async () => {
  const copy = (await act({ action: "page.duplicate", pageId: angebot })).id;
  assert.deepEqual((await meta(copy))!.tags, (await meta(angebot))!.tags);
  assert.deepEqual((await meta(copy))!.values, (await meta(angebot))!.values);
  const template = (await act({ action: "template.save", pageId: angebot, name: "Angebot" })).id;
  const fromTemplate = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Neues Angebot", templateId: template })).id;
  assert.deepEqual((await meta(fromTemplate))!.tags.sort(), (await meta(angebot))!.tags.sort());
  assert.equal(Object.keys((await meta(fromTemplate))!.values).length, Object.keys((await meta(angebot))!.values).length);
  await act({ action: "page.delete", pageId: copy });
  assert.ok(!(await searchWorkspace(owner, wid, "#Kunden")).some((h) => h.id === copy));
  await act({ action: "page.restore", pageId: copy });
  assert.deepEqual((await meta(copy))!.tags, (await meta(angebot))!.tags);
});

test("encrypted spaces have no tags or properties", async () => {
  const secret = (await act({ action: "space.create", workspaceId: wid, name: "Tresor" })).id;
  const p = await page("Geheim", "document", secret);
  await run("UPDATE spaces SET encrypted=1 WHERE id=?", secret);
  await assert.rejects(async () => await act({ action: "page.properties", pageId: p, addTags: ["Kunden"] }), /verschlüssel|Klartext|nicht möglich|plaintext/i);
  await run("UPDATE spaces SET encrypted=0 WHERE id=?", secret);
});

test("Markdown export writes frontmatter, the import reads it back", async () => {
  const md = (await exportMarkdown(owner, { pageId: angebot, format: "markdown", includeSubpages: false })).bytes.toString("utf8");
  const { data } = splitFrontmatter(md);
  assert.deepEqual(data.tags, ["Kunden", "Angebot"]);
  assert.equal(data.Budget, 12.5);
  assert.equal(data["Fällig"], "2026-12-01");
  assert.equal(data.Verantwortlich, "Emil");
  assert.deepEqual(data.Phase, ["Offen"]);
  // Into another workspace by an owner: tags and definitions are created.
  const other = await createWorkspace(owner.id, "Zweite");
  const space = (await bootstrap(owner, other)).spaces[0].id;
  await run("INSERT INTO members VALUES(?,?,?)", other, editor.id, "editor");
  // A person property that exists there takes people by name.
  await act({ action: "property.save", workspaceId: other, name: "Verantwortlich", type: "person" });
  const vault = await writeZip(
    new Map([
      ["Vault/Angebot.md", Buffer.from(md)],
      ["Vault/Obsidian.md", Buffer.from("---\ntags: [projekt, idee]\nrating: 4\nreviewed: true\ncssclass: wide\n---\n# Obsidian\n\nText.\n")],
    ]),
  );
  await importZip(owner, other, space, vault);
  const imported = (await one<Page>("SELECT * FROM pages WHERE workspace_id=? AND title IN ('Angebot','Angebot Müller')", other))!;
  const importedMeta = (await pageData(owner, imported.id)) as { properties: { tags: string[]; values: Record<string, unknown> }; html: string };
  const names = async (ids: string[]) => (await mapAsync(ids, async (t) => (await one<{ name: string }>("SELECT name FROM page_tags WHERE id=?", t))!.name)).sort();
  assert.deepEqual(await names(importedMeta.properties.tags), (await filterAsync(["Angebot", "Kunden"], async (n) => (await meta(angebot))!.tags.includes((await tagId(n))!))).sort());
  const defs = await workspaceProperties(other);
  const valueOf = (name: string) => importedMeta.properties.values[defs.find((d) => d.name === name)!.id];
  assert.equal(valueOf("Budget"), 12.5);
  assert.equal(valueOf("Fällig"), "2026-12-01");
  assert.equal(valueOf("Verantwortlich"), editor.id);
  assert.deepEqual(valueOf("Phase"), ["Offen"]);
  assert.doesNotMatch(importedMeta.html, /Budget/);
  const obsidian = (await one<Page>("SELECT * FROM pages WHERE workspace_id=? AND title='Obsidian'", other))!;
  const obsidianMeta = ((await pageData(owner, obsidian.id)) as { properties: { tags: string[]; values: Record<string, unknown> } }).properties;
  assert.deepEqual(await names(obsidianMeta.tags), ["idee", "projekt"]);
  assert.equal(obsidianMeta.values[(await workspaceProperties(other)).find((d) => d.name === "rating")!.id], 4);
  assert.equal((await workspaceProperties(other)).find((d) => d.name === "reviewed")?.type, "checkbox");
  assert.ok(!(await workspaceProperties(other)).some((d) => d.name === "cssclass"));
  // Editors import into known properties only.
  const known = await frontmatterMeta({ rating: 2, unknown: "x", tags: "a b" }, other, () => undefined);
  assert.deepEqual(known.consumed.sort(), ["rating", "tags"]);
  assert.deepEqual(known.meta.tags, [{ name: "a" }, { name: "b" }]);
});

test("importers write real tags instead of a #tag line", async () => {
  const space = (await act({ action: "space.create", workspaceId: wid, name: "AFFiNE" })).id;
  const result = await writeImport(owner, wid, space, {
    source: "affine",
    title: "AFFiNE",
    pages: [{ key: "a", parent: null, title: "Notiz", html: "<p>Hallo</p>", tags: ["Recherche"] }],
    files: new Map(),
    warnings: [],
    tagColors: { Recherche: "var(--affine-tag-teal)" },
  });
  const pid = result.rootIds[0];
  const tag = (await one<{ id: string; color: string }>("SELECT id,color FROM page_tags WHERE workspace_id=? AND name='Recherche'", wid))!;
  assert.equal(tag.color, "teal");
  assert.deepEqual((await meta(pid))!.tags, [tag.id]);
  assert.doesNotMatch(String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pid))!.html), /#Recherche/);
  assert.equal(tagColorFrom("#3b82f6"), "blue");
  assert.equal(tagColorFrom(undefined), "gray");
});

test("workspace archives carry tags, definitions and values", async () => {
  const bytes = await exportArchive(owner, wid);
  const target = await createWorkspace(owner.id, "Wiederhergestellt");
  await importArchive(owner, target, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array));
  const names = (await all<{ name: string }>("SELECT name FROM page_tags WHERE workspace_id=? ORDER BY name", target)).map((t) => t.name);
  assert.ok(names.includes("Kunden") && names.includes("Angebot"));
  assert.ok((await workspaceProperties(target)).some((d) => d.name === "Erstellt" && d.type === "created_at"), "definitions without values come too");
  const restored = (await one<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='Angebot Müller'", target))!;
  const values = ((await pageData(owner, restored.id)) as { properties: { values: Record<string, unknown> } }).properties.values;
  assert.equal(values[(await workspaceProperties(target)).find((d) => d.name === "Budget")!.id], 12.5);
});

test("the API lists the new actions", async () => {
  for (const action of ["page.properties", "pages.tag", "tag.save", "tag.delete", "tag.merge", "tag.reorder", "property.save", "property.delete", "property.reorder"])
    assert.ok((commandActionNames as readonly string[]).includes(action), action);
  assert.ok(commandActions.some((a) => a.action === "page.properties"));
  // Several pages at once.
  await act({ action: "pages.tag", workspaceId: wid, pageIds: [angebot, board], addTags: ["Sammlung"] }, editor);
  assert.ok((await searchWorkspace(owner, wid, "#Sammlung")).some((h) => h.id === board));
  await assert.rejects(async () => await act({ action: "pages.tag", workspaceId: wid, pageIds: [angebot], addTags: ["X"] }, viewer), /Berechtigung/);
});
