// Obsidian vaults (#657 #659 #660 #661 #662 #663 #665 #669 #670 #671):
// link labels and table pipes, missing embeds, colours that are no tags,
// folder notes in any case, the closest of several notes of one name,
// highlights and comments, the page's dates, icon and cover from the
// frontmatter, properties as database columns, and what the report names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-obsidian-vault-"));
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { writeZip } = await import("../lib/archive");
const { importFromSource } = await import("../lib/importers");
const { convertWikilinks, noteTags, parseObsidian, stripComments, highlights, dataviewQueries, pageMeta, closestPath } = await import("../lib/importers/obsidian");
const { propertyColumns, MAX_DATABASE_FIELDS } = await import("../lib/importers/property-columns");
const { importReport } = await import("../lib/importers/types");
type FrontmatterValue = import("../lib/frontmatter").FrontmatterValue;

const vault = (files: Record<string, string | Buffer>) => new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
// A 1×1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("wikilinks: a page's label without .md, files and aliases as written; escaped table pipes", () => {
  const lookup = (target: string) =>
    /^(Ordner\/)?Seite(\.md|\.markdown)?$/.test(target) ? { href: "fp-import://page/Seite.md", kind: "page" as const } : target === "a.png" ? { href: "fp-import://file/a.png", kind: "file" as const } : null;
  assert.equal(convertWikilinks("[[Seite.md]]", lookup), "[Seite](fp-import://page/Seite.md)");
  assert.equal(convertWikilinks("[[Ordner/Seite.markdown]]", lookup), "[Seite](fp-import://page/Seite.md)");
  assert.equal(convertWikilinks("[[Seite.md|Custom]]", lookup), "[Custom](fp-import://page/Seite.md)");
  assert.equal(convertWikilinks("[[Seite.md|Seite.md]]", lookup), "[Seite.md](fp-import://page/Seite.md)");
  assert.equal(convertWikilinks("[[a.png]] ![[a.png]]", lookup), "[a.png](fp-import://file/a.png) ![a.png](fp-import://file/a.png)");
  // #659: the pipe escaped for a table.
  assert.equal(convertWikilinks("[[Seite\\|Label]]", lookup), "[Label](fp-import://page/Seite.md)");
  assert.equal(convertWikilinks("[[Seite#Abschnitt\\|Label]]", lookup), "[Label](fp-import://page/Seite.md#Abschnitt)");
  assert.equal(convertWikilinks("| a | [[Seite\\|Plan]] |\n|---|---|", lookup), "| a | [Plan](fp-import://page/Seite.md) |\n|---|---|");
  assert.equal(convertWikilinks("![[a.png\\|300]]", lookup), "![a.png](fp-import://file/a.png)");
  // #660: an embed of nothing is reported, a link to nothing is not.
  const missing: string[] = [];
  assert.equal(convertWikilinks("![[fehlt.png]] [[Fehlt]] ![[Weg.pdf|x]]", lookup, undefined, undefined, (t) => missing.push(t)), "fehlt.png Fehlt x");
  assert.deepEqual(missing, ["fehlt.png", "Weg.pdf"]);
});

test("inline tags: six or eight hex digits mixing letters and digits are colours, not tags", () => {
  assert.deepEqual(noteTags({}, "Farben #ff00aa, (#1a2b3c) und #ff00aa80; #dev #project/v2 #todo #fff #cafe #face #bad #deadbeef #123456"), [
    "dev",
    "project/v2",
    "todo",
    "fff",
    "cafe",
    "face",
    "bad",
    "deadbeef",
  ]);
  // The frontmatter's tags are taken as written.
  assert.deepEqual(noteTags({ tags: ["1a2b3c"] }, ""), ["1a2b3c"]);
});

test("highlights and comments outside code; Dataview queries are counted", () => {
  assert.equal(highlights("Ein ==wichtiger **Satz**== und `==Code==`"), "Ein <mark>wichtiger **Satz**</mark> und `==Code==`");
  assert.equal(highlights("```\n==a==\n```\nx == y\n====\n==b=="), "```\n==a==\n```\nx == y\n====\n<mark>b</mark>");
  const stripped = stripComments("Text %%geheim%% weiter\n%%\nmehrere\nZeilen\n%%\nDanach `%%Code%%`\n```\n%%im Block%%\n```\n100%% sicher");
  assert.equal(stripped.markdown, "Text  weiter\nDanach `%%Code%%`\n```\n%%im Block%%\n```\n100%% sicher");
  assert.equal(stripped.count, 2);
  assert.deepEqual(stripComments("ohne"), { markdown: "ohne", count: 0 });
  assert.deepEqual(dataviewQueries("```dataview\nLIST\n```\n````\n```dataview\n````\nHeute: `= date(today)` und `$= dv.current()` aber `==` und `a = b`\n~~~dataviewjs\ndv.list()\n~~~"), {
    blocks: 2,
    inline: 2,
  });
});

test("the frontmatter's dates, icon and cover are the page's, other values stay properties", () => {
  const image = (target: string) => (target === "Bilder/titel.png" || target === "titel.png" ? "Bilder/titel.png" : null);
  const { meta, properties } = pageMeta(
    { "Date created": "2025-03-01", modified: "2025-04-02T10:30:00Z", icon: "🚀", banner: "![[titel.png]]", status: "aktiv", date: "2025-05-05" },
    image,
  );
  assert.deepEqual(meta, { created: "2025-03-01T00:00:00.000Z", updated: "2025-04-02T10:30:00.000Z", icon: "🚀", cover: "Bilder/titel.png" });
  assert.deepEqual(properties, { status: "aktiv", date: "2025-05-05" });
  // Values that do not fit stay properties: a word, an icon name, a URL, a missing image.
  const rest = pageMeta({ created: "gestern", icon: "LiHome", cover: "https://example.net/a.png", image: "[[fehlt.png]]" }, image);
  assert.deepEqual(rest.meta, {});
  assert.deepEqual(Object.keys(rest.properties), ["created", "icon", "cover", "image"]);
  assert.equal(pageMeta({ cover: "![](Bilder/titel.png)" }, image).meta.cover, "Bilder/titel.png");
});

test("several notes of one name: the closest one", () => {
  const candidates = ["Archiv/Notizen.md", "Projekte/Alpha/Notizen.md", "Projekte/Beta/Notizen.md"];
  assert.equal(closestPath("Projekte/Alpha/Übersicht.md", candidates), "Projekte/Alpha/Notizen.md");
  assert.equal(closestPath("Projekte/Alpha/Sub/Aufgabe.md", candidates), "Projekte/Alpha/Notizen.md");
  assert.equal(closestPath("Archiv/2024/Alt.md", candidates), "Archiv/Notizen.md");
  // Equally far: the one sharing more of the path, then the first by path.
  assert.equal(closestPath("Projekte/Start.md", candidates), "Projekte/Alpha/Notizen.md");
  assert.equal(closestPath("Start.md", ["B/x.md", "A/x.md"].sort()), "A/x.md");
  assert.equal(closestPath("Start.md", ["Tief/A/x.md", "B/x.md"]), "B/x.md");

  const tree = parseObsidian(
    vault({
      "Archiv/Notizen.md": "alt",
      "Projekte/Alpha/Notizen.md": "neu",
      "Projekte/Alpha/Übersicht.md": "[[Notizen]] ![[bild.png]]",
      "Projekte/Alpha/Sub/Aufgabe.md": "[[Notizen]]",
      "Archiv/bild.png": png,
      "Projekte/Alpha/bild.png": png,
    }),
  );
  const html = (key: string) => tree.pages.find((p) => p.key === key)!.html;
  assert.match(html("Projekte/Alpha/Übersicht.md"), /fp-import:\/\/page\/Projekte%2FAlpha%2FNotizen\.md/);
  assert.match(html("Projekte/Alpha/Übersicht.md"), /fp-import:\/\/file\/Projekte%2FAlpha%2Fbild\.png/);
  assert.match(html("Projekte/Alpha/Sub/Aufgabe.md"), /fp-import:\/\/page\/Projekte%2FAlpha%2FNotizen\.md/);
});

test("folder notes in any case and as .markdown stand for their folder", () => {
  const tree = parseObsidian(
    vault({
      "Projects/projects.md": "Ordnernotiz",
      "Projects/Plan.md": "x",
      "Areas.markdown": "daneben",
      "Areas/Haus.md": "x",
      "Inbox/INBOX.markdown": "drin",
      "Inbox/Idee.md": "x",
    }),
  );
  const page = (key: string) => tree.pages.find((p) => p.key === key)!;
  assert.equal(page("Projects/Plan.md").parent, "Projects/projects.md");
  assert.equal(page("Projects/projects.md").parent, null);
  assert.equal(page("Areas/Haus.md").parent, "Areas.markdown");
  assert.equal(page("Inbox/Idee.md").parent, "Inbox/INBOX.markdown");
  assert.equal(tree.pages.filter((p) => p.folder).length, 0, "no folder page beside its folder note");
});

test("the report names missing embeds, comments, Dataview queries, Bases and Canvas files", () => {
  const tree = parseObsidian(
    vault({
      "Start.md": "![[fehlt.png]] ![[fehlt.pdf]] ![](weg.png)\n%%privat%%\n```dataview\nTABLE x\n```\n`= this.file.name`",
      "Aufgaben.base": "views: []",
      "Tafel.canvas": "{}",
    }),
  );
  const details = tree.report!.entries.map((e) => `${e.kind}: ${e.detail}${e.page ? ` @${e.page}` : ""}`);
  for (const expected of [
    "file: Bild „fehlt.png“ fehlt im Tresor @Start.md",
    "file: Eingebettete Datei „fehlt.pdf“ fehlt im Tresor @Start.md",
    "file: Bild „weg.png“ fehlt im Tresor @Start.md",
    "other: Kommentare (%%…%%) entfernt: 1 @Start.md",
    "block: Dataview-Abfrage als Codeblock übernommen (wird nicht ausgeführt) @Start.md",
    "block: Dataview-Inline-Abfrage als Code übernommen (wird nicht ausgeführt) @Start.md",
    "other: Obsidian-Base „Aufgaben.base“ nicht übernommen",
    "other: Canvas „Tafel.canvas“ nicht übernommen",
  ])
    assert.ok(details.includes(expected), `${expected} in ${details.join("\n")}`);
  for (const warning of ["Eingebettete Datei fehlt im Tresor. (2×)", "Kommentare (%%…%%) werden nicht übernommen.", "Dataview-Abfragen werden als Code übernommen, nicht ausgeführt.", "Obsidian-Bases (.base) werden nicht übernommen.", "Canvas-Dateien (.canvas) werden nicht übernommen."])
    assert.ok(tree.warnings.includes(warning), warning);
  const html = tree.pages[0].html;
  assert.doesNotMatch(html, /privat/);
  assert.match(html, /<pre><code class="language-dataview">TABLE x/);
});

test("database columns: types of the vault, fixed names kept, caps reported", () => {
  const fixed = [{ id: "title", name: "Name", type: "text" as const }, { id: "imp_tags", name: "Tags", type: "multiselect" as const }];
  const pages: { properties: Record<string, FrontmatterValue> }[] = [
    { properties: { status: "aktiv", score: 3, done: true, due: "2026-01-02", Name: "Doppelt", tags: ["a"], topics: ["x", "y"] } },
    { properties: { Status: "ruhend", score: "4,5", done: "nein", due: "bald", topics: "z" } },
    { properties: { status: "aktiv" } },
    { properties: { status: "ruhend" } },
  ];
  const hints = new Map([
    ["status", { type: "select" as const, options: ["aktiv", "ruhend"] }],
    ["topics", { type: "multiselect" as const, options: ["x", "y", "z"] }],
  ]);
  const columns = propertyColumns(pages, hints, fixed);
  assert.deepEqual(
    columns.fields.map((f) => [f.name, f.type, f.options]),
    [
      ["status", "select", ["aktiv", "ruhend"]],
      ["score", "number", undefined],
      ["done", "checkbox", undefined],
      ["due", "date", undefined],
      ["Name (2)", "text", undefined],
      ["topics", "multiselect", ["x", "y", "z"]],
    ],
  );
  const cells = pages.map((p) => columns.cells(p));
  assert.deepEqual(cells[0], { imp_p1: "aktiv", imp_p2: 3, imp_p3: true, imp_p4: "2026-01-02", imp_p5: "Doppelt", imp_p6: ["x", "y"] });
  assert.deepEqual(cells[1], { imp_p1: "ruhend", imp_p2: 4.5, imp_p3: false, imp_p6: ["z"] });
  // Over the caps: the columns and option values left out are reported.
  const report = importReport();
  const wide = { properties: Object.fromEntries(Array.from({ length: MAX_DATABASE_FIELDS + 5 }, (_, i) => [`k${i}`, "v"])) };
  assert.equal(propertyColumns([wide], undefined, fixed, report).fields.length, MAX_DATABASE_FIELDS - fixed.length);
  assert.equal(report.counts.property, 7);
  const many = propertyColumns(
    [{ properties: { list: Array.from({ length: 105 }, (_, i) => `o${i}`) } }],
    new Map([["list", { type: "multiselect" as const }]]),
    fixed,
    report,
  );
  assert.equal(many.fields[0].options!.length, 100);
  assert.ok(report.entries.some((e) => /„list“: 5 Werte über 100 Optionen/.test(e.detail)));
});

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

test("an imported vault: highlights, dates, icon and cover on the page; properties as columns in a database", async () => {
  const owner = await account("obsidian-vault");
  const wid = await createWorkspace(owner.id, "Tresor");
  const space = (await bootstrap(owner, wid)).spaces[0].id;
  const bytes = await writeZip(
    vault({
      ".obsidian/app.json": "{}",
      "Bilder/titel.png": png,
      "Buch.md": "---\ncreated: 2024-02-03\nupdated: 2024-05-06T07:08:09Z\nicon: 📚\ncover: \"[[titel.png]]\"\nautor: Ada\nseiten: 120\nstatus: gelesen\n---\nEin ==guter== Text %%nur für mich%%",
      "Zweites Buch.md": "---\nautor: Bob\nseiten: 80\nstatus: gelesen\nTags: [x]\n---\n[[Buch]]",
      "Drittes.md": "---\nstatus: offen\n---\n",
      "Viertes.md": "---\nstatus: offen\n---\n",
    }),
  );
  const result = await importFromSource(owner, wid, space, { name: "Tresor.zip", bytes });
  const page = (await one<{ id: string; icon: string; cover: string; created_at: string; updated_at: string }>(
    "SELECT id,icon,cover,created_at,updated_at FROM pages WHERE workspace_id=? AND title='Buch' AND deleted_at IS NULL",
    wid,
  ))!;
  assert.equal(page.icon, "📚");
  assert.match(page.cover, /^\/api\/files\/[0-9a-f-]{36}$/);
  assert.equal(page.created_at, "2024-02-03 00:00:00");
  assert.equal(page.updated_at, "2024-05-06 07:08:09");
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id))!.html;
  assert.match(html, /Ein <mark>guter<\/mark> Text/);
  assert.doesNotMatch(html, /nur für mich/);
  // The consumed keys are no properties of the page.
  const names = (await all<{ name: string }>("SELECT d.name FROM page_property_values v JOIN page_property_defs d ON d.id=v.property_id WHERE v.page_id=?", page.id)).map((r) => r.name);
  assert.deepEqual(names.sort(), ["autor", "seiten", "status"]);
  assert.ok(result.report);

  const db = await importFromSource(owner, wid, space, { name: "Tresor.zip", bytes }, { mode: "database" });
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db.databaseId!))!.fields) as { id: string; name: string; type: string; options?: string[] }[];
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.autor.type, "text");
  assert.equal(byName.seiten.type, "number");
  assert.deepEqual(byName.status.options, ["gelesen", "offen"]);
  assert.equal(byName.status.type, "select");
  assert.equal(byName.icon, undefined);
  const rows = (await all<{ cells: string; created_at: string }>("SELECT cells,created_at FROM rows WHERE page_id=?", db.databaseId!)).map((r) => ({ ...JSON.parse(r.cells), at: r.created_at }));
  const book = rows.find((r) => r.title === "Buch");
  assert.equal(book[byName.autor.id], "Ada");
  assert.equal(book[byName.seiten.id], 120);
  assert.equal(book[byName.status.id], "gelesen");
  assert.equal(book.imp_created, "2024-02-03");
  assert.equal(rows.find((r) => r.title === "Drittes")[byName.status.id], "offen");
});
