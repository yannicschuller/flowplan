import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-aliases-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { searchWorkspace } = await import("../lib/search-index");
const { unlinkedMentions } = await import("../lib/page-graph");
const { aliasList, aliasIndex, matchedAlias, pageAliases, frontmatterAliases } = await import("../lib/aliases");
const { parseAliases } = await import("../lib/page-aliases");
const { splitFrontmatter } = await import("../lib/frontmatter");
const { exportMarkdown } = await import("../lib/markdown-export");
const { importMarkdownRecords, markdownEntries } = await import("../lib/markdown-records");
const { importZip } = await import("../lib/zip-import");
const { writeZip } = await import("../lib/archive");
const { readExportZip } = await import("./helpers/read-export-zip");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("alias-owner"),
  member = await account("alias-member"),
  viewer = await account("alias-viewer");
const wid = await createWorkspace(owner.id, "Haus");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as { id: string } & Record<string, unknown>;
const page = async (title: string, kind = "document", spaceId = team) => (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind })).id;
const write = async (pageId: string, html: string) => await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const html = async (pageId: string) => String((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html);
const pageOf = async (pageId: string) => (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
const withAliasField = async (pageId: string, name = "Aliasse") => {
  const d = await database(pageId);
  const field = { id: `al${id().slice(0, 6)}`, name, type: "aliases" as const };
  await act({ action: "database.update", pageId, version: d.version, fields: [...d.fields, field], views: d.views });
  return field.id;
};

const chauffage = await page("Chauffage");
const notes = await page("Notizen");

test("aliases are trimmed, deduplicated and limited", async () => {
  assert.deepEqual(aliasList([" PAC ", "pac", "Pompe  à chaleur", "", 7]), ["PAC", "Pompe à chaleur", "7"]);
  assert.deepEqual(aliasList("PAC, Pompe à chaleur"), ["PAC", "Pompe à chaleur"]);
  assert.equal(aliasList(Array.from({ length: 30 }, (_, i) => `A${i}`)).length, 10);
  assert.deepEqual(parseAliases(["PAC", "PAC", " Wärmepumpe "]), ["PAC", "Wärmepumpe"]);
  assert.throws(() => parseAliases(Array.from({ length: 11 }, (_, i) => `Name ${i}`)), /Höchstens 10 Aliasse/);
  assert.throws(() => parseAliases(["x".repeat(101)]), /höchstens 100 Zeichen/);
  // Page aliases: editors only.
  const result = await act({ action: "page.aliases", pageId: chauffage, aliases: ["PAC", "Pompe à chaleur", "pac"] });
  assert.deepEqual(result.aliases, ["PAC", "Pompe à chaleur"]);
  assert.deepEqual(pageAliases(await pageOf(chauffage)), ["PAC", "Pompe à chaleur"]);
  await assert.rejects(async () => await act({ action: "page.aliases", pageId: chauffage, aliases: ["X"] }, viewer), /Berechtigung|Schreibrechte|Rechte/);
  // One aliases property per database; its cells follow the same rules.
  const db = await page("Geräte", "database");
  const fieldId = await withAliasField(db);
  const d = await database(db);
  await assert.rejects(
    async () => await act({ action: "database.update", pageId: db, version: d.version, fields: [...d.fields, { id: "second", name: "Mehr", type: "aliases" }], views: d.views }),
    /höchstens eine Alias-Eigenschaft/,
  );
  await assert.rejects(
    async () => await act({ action: "row.create", pageId: db, cells: { title: "Kessel", [fieldId]: Array.from({ length: 12 }, (_, i) => `K${i}`) } }),
    /Höchstens 10 Aliasse/,
  );
  const row = (await act({ action: "row.create", pageId: db, cells: { title: "Kessel", [fieldId]: [" Brenner ", "brenner"] } })).id;
  assert.deepEqual(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row))!.cells)[fieldId], ["Brenner"]);
});

test("search finds pages and records by alias, with the real title and the alias", async () => {
  await write(notes, "<p>Eine Pompe à chaleur ist eine Pompe à chaleur ist eine Pompe à chaleur.</p>");
  const hits = await searchWorkspace(member, wid, "Pompe à chaleur");
  assert.equal(hits[0].id, chauffage, "an alias weighs like the title");
  assert.equal(hits[0].title, "Chauffage");
  assert.equal(hits[0].alias, "Pompe à chaleur");
  assert.ok(hits.some((h) => h.id === notes && !h.alias));
  // Short queries (no trigram) match aliases too.
  assert.equal((await searchWorkspace(member, wid, "PA")).find((h) => h.id === chauffage)?.alias, "PAC");
  // A title match shows no alias.
  assert.equal((await searchWorkspace(member, wid, "Chauffage")).find((h) => h.id === chauffage)?.alias, undefined);
  // Records (the @ mention dialog searches with kind "row").
  const db = await page("Anlagen", "database");
  const fieldId = await withAliasField(db);
  const row = (await act({ action: "row.create", pageId: db, cells: { title: "Heizung Keller", [fieldId]: ["Wärmepumpe", "WP"] } })).id;
  const [record] = await searchWorkspace(member, wid, "wärmepumpe", { kind: "row" });
  assert.equal(record.rowId, row);
  assert.equal(record.title, "Heizung Keller");
  assert.equal(record.alias, "Wärmepumpe");
  assert.equal(record.pageTitle, "Anlagen");
  // The alias is not repeated in the body snippet.
  assert.doesNotMatch(record.snippet, /Wärmepumpe/);
  // Changing the aliases updates the index.
  await act({ action: "row.update", pageId: db, rowId: row, version: (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", row))!.version, cells: { [fieldId]: ["Erdwärme"] } });
  assert.deepEqual(await searchWorkspace(member, wid, "wärmepumpe", { kind: "row" }), []);
  assert.equal((await searchWorkspace(member, wid, "erdwärme", { kind: "row" }))[0]?.alias, "Erdwärme");
  assert.equal(matchedAlias("Chauffage", ["Pompe à chaleur"], "pompe a"), "Pompe à chaleur");
});

test("aliases of items the person may not read are not found", async () => {
  const secret = (await act({ action: "space.create", workspaceId: wid, name: "Privat", private: true })).id;
  const hidden = await page("Gehaltsliste", "document", secret);
  await act({ action: "page.aliases", pageId: hidden, aliases: ["Lohnzettelgeheimnis"] });
  assert.equal((await searchWorkspace(owner, wid, "Lohnzettelgeheimnis"))[0]?.id, hidden);
  assert.deepEqual(await searchWorkspace(member, wid, "Lohnzettelgeheimnis"), []);
  const db = await page("Personal", "database", secret);
  const fieldId = await withAliasField(db);
  await act({ action: "row.create", pageId: db, cells: { title: "Vertrag", [fieldId]: ["Geheimvertragsalias"] } });
  assert.equal((await searchWorkspace(owner, wid, "Geheimvertragsalias", { kind: "row" })).length, 1);
  assert.deepEqual(await searchWorkspace(member, wid, "Geheimvertragsalias", { kind: "row" }), []);
  // Unlinked mentions only come from documents the person may read.
  const note = await page("Privatnotiz", "document", secret);
  await write(note, "<p>Die PAC läuft.</p>");
  assert.ok((await unlinkedMentions(owner, await pageOf(chauffage))).some((m) => m.id === note));
  assert.ok(!(await unlinkedMentions(member, await pageOf(chauffage))).some((m) => m.id === note));
  await write(note, "<p>leer</p>");
});

test("unlinked mentions find aliases as whole words and keep the text when linking", async () => {
  assert.equal(aliasIndex("Die PAC läuft", "pac"), 4);
  assert.equal(aliasIndex("PACKAGE und Spacer", "PAC"), -1);
  assert.equal(aliasIndex("A und B", "A"), -1, "too short");
  const visit = await page("Wartung");
  await write(visit, "<p>Ein PACKAGE kam an. Danach haben wir die pac gewartet.</p>");
  const found = await unlinkedMentions(member, await pageOf(chauffage));
  const mention = found.find((m) => m.id === visit);
  assert.equal(mention?.alias, "PAC");
  assert.match(mention!.snippet, /die pac gewartet/);
  await act({ action: "mention.link", pageId: visit, targetId: chauffage }, member);
  assert.match(await html(visit), new RegExp(`PACKAGE kam an\\. Danach haben wir die <a[^>]*href="/#page=${chauffage}"[^>]*>pac</a> gewartet`));
  assert.ok(!(await unlinkedMentions(member, await pageOf(chauffage))).some((m) => m.id === visit));
  // The title still comes first when both are there.
  await write(visit, "<p>PAC oder Chauffage?</p>");
  await act({ action: "mention.link", pageId: visit, targetId: chauffage }, member);
  assert.match(await html(visit), /PAC oder <a[^>]*>Chauffage<\/a>\?/);
});

test("Obsidian aliases round trip through Markdown for records", async () => {
  const db = await page("Bereich Haus", "database");
  const note = Buffer.from("---\naliases: [PAC, Pompe à chaleur]\nalias: Heizpumpe\ntags: [heating]\n---\n# Chauffage\n\nEntretien annuel.\n");
  const entries = await markdownEntries("Chauffage.md", note);
  // Without an aliases property, the import offers to create one.
  const plan = await importMarkdownRecords(owner, db, entries, { dryRun: true });
  assert.deepEqual(plan.missing.find((m) => m.type === "aliases"), { name: "Aliases", type: "aliases" });
  assert.ok(!plan.missing.some((m) => m.name.toLowerCase() === "alias"));
  await importMarkdownRecords(owner, db, entries, { createMissing: true });
  const fields = (await database(db)).fields;
  const aliasProperty = fields.find((f) => f.type === "aliases")!;
  assert.equal(fields.filter((f) => f.type === "aliases").length, 1);
  const row = (await one<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", db))!;
  assert.deepEqual(JSON.parse(row.cells)[aliasProperty.id], ["PAC", "Pompe à chaleur", "Heizpumpe"]);
  // Export writes Obsidian's key; the import reads it back into the same property.
  const { bytes } = await exportMarkdown(owner, { pageId: db, format: "zip", includeSubpages: false });
  const files = await readExportZip(bytes as Buffer);
  const [, file] = [...files].find(([name]) => name.startsWith("records/"))!;
  const { data } = splitFrontmatter(file.toString("utf8"));
  assert.deepEqual(data.aliases, ["PAC", "Pompe à chaleur", "Heizpumpe"]);
  assert.ok(!(aliasProperty.name in data));
  const again = await importMarkdownRecords(owner, db, files, { dryRun: true });
  assert.deepEqual(again.missing, []);
  assert.ok(again.matched.includes(aliasProperty.name));
  await importMarkdownRecords(owner, db, files, { updateExisting: true });
  assert.deepEqual(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row.id))!.cells)[aliasProperty.id], ["PAC", "Pompe à chaleur", "Heizpumpe"]);
  // One string means one alias list split at commas.
  assert.deepEqual(frontmatterAliases({ alias: "A1, B2" }), ["A1", "B2"]);
});

test("page aliases go to frontmatter in the export and come back with a vault import", async () => {
  const plain = (await exportMarkdown(owner, { pageId: notes, format: "markdown", includeSubpages: false })).bytes.toString("utf8");
  assert.match(plain, /^# Notizen/, "pages without aliases keep no frontmatter");
  const md = (await exportMarkdown(owner, { pageId: chauffage, format: "markdown", includeSubpages: false })).bytes.toString("utf8");
  const { data, body } = splitFrontmatter(md);
  assert.deepEqual(data, { aliases: ["PAC", "Pompe à chaleur"] });
  assert.match(body, /^\n?# Chauffage/);
  // An Obsidian vault: the aliases become the page's, the text stays without them.
  const archive = await writeZip(
    new Map([
      ["Vault/Chauffage.md", Buffer.from(md)],
      ["Vault/Garage.md", Buffer.from("---\nalias: Carport\nstatus: done\n---\n# Garage\n\nText.\n")],
    ]),
  );
  const space = (await act({ action: "space.create", workspaceId: wid, name: "Import" })).id;
  await importZip(owner, wid, space, archive);
  const imported = (await one<Page>("SELECT * FROM pages WHERE space_id=? AND title='Chauffage'", space))!;
  assert.deepEqual(pageAliases(imported), ["PAC", "Pompe à chaleur"]);
  assert.doesNotMatch(await html(imported.id), /aliases/);
  const garage = (await one<Page>("SELECT * FROM pages WHERE space_id=? AND title='Garage'", space))!;
  assert.deepEqual(pageAliases(garage), ["Carport"]);
  // Other frontmatter becomes properties of the page (#70, the importer
  // owns the workspace), so the text stays without it.
  assert.doesNotMatch(await html(garage.id), /status/);
  assert.equal(
    (await one<{ value: string }>("SELECT v.value FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=? AND d.name='status'", garage.id))?.value,
    JSON.stringify("done"),
  );
  assert.equal((await searchWorkspace(owner, wid, "Carport"))[0]?.id, garage.id);
});
