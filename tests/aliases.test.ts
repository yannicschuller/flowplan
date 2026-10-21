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

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("alias-owner"),
  member = account("alias-member"),
  viewer = account("alias-viewer");
const wid = createWorkspace(owner.id, "Haus");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = bootstrap(owner, wid).spaces[0].id;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as { id: string } & Record<string, unknown>;
const page = (title: string, kind = "document", spaceId = team) => act({ action: "page.create", workspaceId: wid, spaceId, title, kind }).id;
const write = (pageId: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
const html = (pageId: string) => String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html);
const pageOf = (pageId: string) => one<Page>("SELECT * FROM pages WHERE id=?", pageId)!;
const withAliasField = (pageId: string, name = "Aliasse") => {
  const d = database(pageId);
  const field = { id: `al${id().slice(0, 6)}`, name, type: "aliases" as const };
  act({ action: "database.update", pageId, version: d.version, fields: [...d.fields, field], views: d.views });
  return field.id;
};

const chauffage = page("Chauffage");
const notes = page("Notizen");

test("aliases are trimmed, deduplicated and limited", () => {
  assert.deepEqual(aliasList([" PAC ", "pac", "Pompe  à chaleur", "", 7]), ["PAC", "Pompe à chaleur", "7"]);
  assert.deepEqual(aliasList("PAC, Pompe à chaleur"), ["PAC", "Pompe à chaleur"]);
  assert.equal(aliasList(Array.from({ length: 30 }, (_, i) => `A${i}`)).length, 10);
  assert.deepEqual(parseAliases(["PAC", "PAC", " Wärmepumpe "]), ["PAC", "Wärmepumpe"]);
  assert.throws(() => parseAliases(Array.from({ length: 11 }, (_, i) => `Name ${i}`)), /Höchstens 10 Aliasse/);
  assert.throws(() => parseAliases(["x".repeat(101)]), /höchstens 100 Zeichen/);
  // Page aliases: editors only.
  const result = act({ action: "page.aliases", pageId: chauffage, aliases: ["PAC", "Pompe à chaleur", "pac"] });
  assert.deepEqual(result.aliases, ["PAC", "Pompe à chaleur"]);
  assert.deepEqual(pageAliases(pageOf(chauffage)), ["PAC", "Pompe à chaleur"]);
  assert.throws(() => act({ action: "page.aliases", pageId: chauffage, aliases: ["X"] }, viewer), /Berechtigung|Schreibrechte|Rechte/);
  // One aliases property per database; its cells follow the same rules.
  const db = page("Geräte", "database");
  const fieldId = withAliasField(db);
  const d = database(db);
  assert.throws(
    () => act({ action: "database.update", pageId: db, version: d.version, fields: [...d.fields, { id: "second", name: "Mehr", type: "aliases" }], views: d.views }),
    /höchstens eine Alias-Eigenschaft/,
  );
  assert.throws(
    () => act({ action: "row.create", pageId: db, cells: { title: "Kessel", [fieldId]: Array.from({ length: 12 }, (_, i) => `K${i}`) } }),
    /Höchstens 10 Aliasse/,
  );
  const row = act({ action: "row.create", pageId: db, cells: { title: "Kessel", [fieldId]: [" Brenner ", "brenner"] } }).id;
  assert.deepEqual(JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row)!.cells)[fieldId], ["Brenner"]);
});

test("search finds pages and records by alias, with the real title and the alias", () => {
  write(notes, "<p>Eine Pompe à chaleur ist eine Pompe à chaleur ist eine Pompe à chaleur.</p>");
  const hits = searchWorkspace(member, wid, "Pompe à chaleur");
  assert.equal(hits[0].id, chauffage, "an alias weighs like the title");
  assert.equal(hits[0].title, "Chauffage");
  assert.equal(hits[0].alias, "Pompe à chaleur");
  assert.ok(hits.some((h) => h.id === notes && !h.alias));
  // Short queries (no trigram) match aliases too.
  assert.equal(searchWorkspace(member, wid, "PA").find((h) => h.id === chauffage)?.alias, "PAC");
  // A title match shows no alias.
  assert.equal(searchWorkspace(member, wid, "Chauffage").find((h) => h.id === chauffage)?.alias, undefined);
  // Records (the @ mention dialog searches with kind "row").
  const db = page("Anlagen", "database");
  const fieldId = withAliasField(db);
  const row = act({ action: "row.create", pageId: db, cells: { title: "Heizung Keller", [fieldId]: ["Wärmepumpe", "WP"] } }).id;
  const [record] = searchWorkspace(member, wid, "wärmepumpe", { kind: "row" });
  assert.equal(record.rowId, row);
  assert.equal(record.title, "Heizung Keller");
  assert.equal(record.alias, "Wärmepumpe");
  assert.equal(record.pageTitle, "Anlagen");
  // The alias is not repeated in the body snippet.
  assert.doesNotMatch(record.snippet, /Wärmepumpe/);
  // Changing the aliases updates the index.
  act({ action: "row.update", pageId: db, rowId: row, version: one<{ version: number }>("SELECT version FROM rows WHERE id=?", row)!.version, cells: { [fieldId]: ["Erdwärme"] } });
  assert.deepEqual(searchWorkspace(member, wid, "wärmepumpe", { kind: "row" }), []);
  assert.equal(searchWorkspace(member, wid, "erdwärme", { kind: "row" })[0]?.alias, "Erdwärme");
  assert.equal(matchedAlias("Chauffage", ["Pompe à chaleur"], "pompe a"), "Pompe à chaleur");
});

test("aliases of items the person may not read are not found", () => {
  const secret = act({ action: "space.create", workspaceId: wid, name: "Privat", private: true }).id;
  const hidden = page("Gehaltsliste", "document", secret);
  act({ action: "page.aliases", pageId: hidden, aliases: ["Lohnzettelgeheimnis"] });
  assert.equal(searchWorkspace(owner, wid, "Lohnzettelgeheimnis")[0]?.id, hidden);
  assert.deepEqual(searchWorkspace(member, wid, "Lohnzettelgeheimnis"), []);
  const db = page("Personal", "database", secret);
  const fieldId = withAliasField(db);
  act({ action: "row.create", pageId: db, cells: { title: "Vertrag", [fieldId]: ["Geheimvertragsalias"] } });
  assert.equal(searchWorkspace(owner, wid, "Geheimvertragsalias", { kind: "row" }).length, 1);
  assert.deepEqual(searchWorkspace(member, wid, "Geheimvertragsalias", { kind: "row" }), []);
  // Unlinked mentions only come from documents the person may read.
  const note = page("Privatnotiz", "document", secret);
  write(note, "<p>Die PAC läuft.</p>");
  assert.ok(unlinkedMentions(owner, pageOf(chauffage)).some((m) => m.id === note));
  assert.ok(!unlinkedMentions(member, pageOf(chauffage)).some((m) => m.id === note));
  write(note, "<p>leer</p>");
});

test("unlinked mentions find aliases as whole words and keep the text when linking", () => {
  assert.equal(aliasIndex("Die PAC läuft", "pac"), 4);
  assert.equal(aliasIndex("PACKAGE und Spacer", "PAC"), -1);
  assert.equal(aliasIndex("A und B", "A"), -1, "too short");
  const visit = page("Wartung");
  write(visit, "<p>Ein PACKAGE kam an. Danach haben wir die pac gewartet.</p>");
  const found = unlinkedMentions(member, pageOf(chauffage));
  const mention = found.find((m) => m.id === visit);
  assert.equal(mention?.alias, "PAC");
  assert.match(mention!.snippet, /die pac gewartet/);
  act({ action: "mention.link", pageId: visit, targetId: chauffage }, member);
  assert.match(html(visit), new RegExp(`PACKAGE kam an\\. Danach haben wir die <a[^>]*href="/#page=${chauffage}"[^>]*>pac</a> gewartet`));
  assert.ok(!unlinkedMentions(member, pageOf(chauffage)).some((m) => m.id === visit));
  // The title still comes first when both are there.
  write(visit, "<p>PAC oder Chauffage?</p>");
  act({ action: "mention.link", pageId: visit, targetId: chauffage }, member);
  assert.match(html(visit), /PAC oder <a[^>]*>Chauffage<\/a>\?/);
});

test("Obsidian aliases round trip through Markdown for records", async () => {
  const db = page("Bereich Haus", "database");
  const note = Buffer.from("---\naliases: [PAC, Pompe à chaleur]\nalias: Heizpumpe\ntags: [heating]\n---\n# Chauffage\n\nEntretien annuel.\n");
  const entries = await markdownEntries("Chauffage.md", note);
  // Without an aliases property, the import offers to create one.
  const plan = importMarkdownRecords(owner, db, entries, { dryRun: true });
  assert.deepEqual(plan.missing.find((m) => m.type === "aliases"), { name: "Aliases", type: "aliases" });
  assert.ok(!plan.missing.some((m) => m.name.toLowerCase() === "alias"));
  importMarkdownRecords(owner, db, entries, { createMissing: true });
  const fields = database(db).fields;
  const aliasProperty = fields.find((f) => f.type === "aliases")!;
  assert.equal(fields.filter((f) => f.type === "aliases").length, 1);
  const row = one<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=?", db)!;
  assert.deepEqual(JSON.parse(row.cells)[aliasProperty.id], ["PAC", "Pompe à chaleur", "Heizpumpe"]);
  // Export writes Obsidian's key; the import reads it back into the same property.
  const { bytes } = await exportMarkdown(owner, { pageId: db, format: "zip", includeSubpages: false });
  const files = await readExportZip(bytes as Buffer);
  const [, file] = [...files].find(([name]) => name.startsWith("records/"))!;
  const { data } = splitFrontmatter(file.toString("utf8"));
  assert.deepEqual(data.aliases, ["PAC", "Pompe à chaleur", "Heizpumpe"]);
  assert.ok(!(aliasProperty.name in data));
  const again = importMarkdownRecords(owner, db, files, { dryRun: true });
  assert.deepEqual(again.missing, []);
  assert.ok(again.matched.includes(aliasProperty.name));
  importMarkdownRecords(owner, db, files, { updateExisting: true });
  assert.deepEqual(JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row.id)!.cells)[aliasProperty.id], ["PAC", "Pompe à chaleur", "Heizpumpe"]);
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
  const space = act({ action: "space.create", workspaceId: wid, name: "Import" }).id;
  await importZip(owner, wid, space, archive);
  const imported = one<Page>("SELECT * FROM pages WHERE space_id=? AND title='Chauffage'", space)!;
  assert.deepEqual(pageAliases(imported), ["PAC", "Pompe à chaleur"]);
  assert.doesNotMatch(html(imported.id), /aliases/);
  const garage = one<Page>("SELECT * FROM pages WHERE space_id=? AND title='Garage'", space)!;
  assert.deepEqual(pageAliases(garage), ["Carport"]);
  // Other frontmatter stays in the text, as before.
  assert.match(html(garage.id), /status/);
  assert.equal(searchWorkspace(owner, wid, "Carport")[0]?.id, garage.id);
});
