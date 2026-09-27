import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-clip-"));
const { run, id, all, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { extractArticle, parseBookmarksHtml } = await import("../lib/web-clip");
const { bookmarklet } = await import("../components/clipper-settings");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Anna", "anna@example.test");
const anna = { id: uid, name: "Anna", email: "anna@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
const wid = createWorkspace(anna.id, "Team");
const space = bootstrap(anna, wid).spaces[0].id;

test("the article text is taken without navigation, scripts and ads", () => {
  const article = extractArticle(
    `<html><head><title>Fallback</title><meta property="og:title" content="Gute Software &amp; Teams"></head>
     <body><nav><a href="/">Start</a></nav><header>Kopf</header>
     <article><h1>Überschrift</h1><p>Erster <b>wichtiger</b> Absatz mit <a href="/mehr">Link</a>.</p><p></p>
     <script>alert(1)</script><img src="x.png" onerror="evil()"><aside>Werbung</aside><p>Zweiter Absatz.</p></article>
     <footer>Impressum</footer></body></html>`,
    "https://example.com/blog/post",
  );
  assert.equal(article.title, "Gute Software & Teams");
  assert.match(article.html, /<h2>Überschrift<\/h2>/);
  assert.match(article.html, /<strong>wichtiger<\/strong>/);
  assert.match(article.html, /href="https:\/\/example.com\/mehr"/);
  assert.doesNotMatch(article.html, /script|Werbung|Impressum|Start|img|onerror|<p><\/p>/);
  assert.equal(article.words, 9);
});

test("browser bookmark files keep folders and dates", () => {
  const items = parseBookmarksHtml(`<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3 ADD_DATE="1">Lesezeichenleiste</H3>
  <DL><p>
    <DT><A HREF="https://example.com/a" ADD_DATE="1700000000">Artikel &amp; mehr</A>
    <DT><H3>Rezepte</H3>
    <DL><p>
      <DT><A HREF="https://kochen.example/pasta">Pasta</A>
    </DL><p>
    <DT><A HREF="https://example.com/b">Zweiter</A>
  </DL><p>
  <DT><A HREF="javascript:alert(1)">Böse</A>
</DL>`);
  assert.deepEqual(
    items.map((i) => [i.title, i.folder]),
    [
      ["Artikel & mehr", "Lesezeichenleiste"],
      ["Pasta", "Rezepte"],
      ["Zweiter", "Lesezeichenleiste"],
      ["Böse", undefined],
    ],
  );
  assert.equal(items[0].added, "2023-11-14");
});

test("imports and clips land in the space's bookmarks database", () => {
  const html = `<DL><DT><H3>Tools</H3><DL><DT><A HREF="https://example.com/a">A</A><DT><A HREF="https://example.com/a">A doppelt</A><DT><A HREF="javascript:x">X</A></DL></DL>`;
  const imported = command(anna, { action: "bookmarks.import", workspaceId: wid, spaceId: space, html }) as { id: string; added: number; skipped: number };
  assert.equal(imported.added, 1);
  assert.equal(imported.skipped, 2);
  const shared = command(anna, {
    action: "page.fromShare",
    workspaceId: wid,
    spaceId: space,
    title: "Lesenswert",
    text: "Unbedingt ansehen",
    url: "https://www.news.example/story",
    as: "bookmark",
    article: "<p>Artikeltext</p><script>x</script>",
  }) as { id: string; rowId: string };
  assert.equal(shared.id, imported.id, "same database");
  const row = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", shared.rowId)!;
  const cells = JSON.parse(row.cells);
  assert.equal(cells.bm_site, "news.example");
  assert.equal(cells.bm_note, "Unbedingt ansehen");
  assert.match(row.content, /Artikeltext/);
  assert.doesNotMatch(row.content, /script/);
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", imported.id)!.fields);
  assert.deepEqual(fields.find((f: { id: string }) => f.id === "bm_folder").options, ["Tools"]);
  assert.throws(
    () => command(anna, { action: "page.fromShare", workspaceId: wid, spaceId: space, url: "https://www.news.example/story", as: "bookmark" }),
    /schon unter den Lesezeichen/,
  );
  assert.equal(all("SELECT 1 FROM pages WHERE title='Lesezeichen'").length, 1);
  // As a page, the article follows the shared link.
  const page = command(anna, { action: "page.fromShare", workspaceId: wid, spaceId: space, url: "https://x.example/", article: "<h2>Titel</h2><p>Text</p>" }) as { id: string };
  assert.match(String(one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id)!.html), /<hr ?\/?><h2>Titel<\/h2>/);
});

test("the bookmarklet opens the save window with title, address and selection", () => {
  const link = bookmarklet("https://flowplan.example");
  assert.ok(link.startsWith("javascript:"));
  const code = decodeURIComponent(link.slice("javascript:".length));
  assert.match(code, /https:\/\/flowplan\.example\/share-target\?/);
  assert.match(code, /getSelection/);
});
