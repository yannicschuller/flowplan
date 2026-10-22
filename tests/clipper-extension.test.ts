import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import { Window } from "happy-dom";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-clipper-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id, one, all } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { createApiToken, identityFromApiToken } = await import("../lib/api-tokens");
const { clipHtml, clipperCors, clipperUser, clipperTargets, saveClip, isExtensionOrigin } = await import("../lib/clipper");
// The content script is a plain script (no module), as the browser runs it.
runInThisContext(readFileSync("extensions/browser/extract.js", "utf8"), { filename: "extract.js" });
type Extract = {
  meta: (doc: Document) => { url: string; title: string; description: string; favicon: string };
  extractArticle: (doc: Document) => { title: string; html: string; text: string; favicon: string };
  selection: (win: Window | typeof globalThis) => { html: string; text: string };
};
const extract = (globalThis as unknown as { FlowplanExtract: Extract }).FlowplanExtract;

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const anna = account("clip-anna"),
  ben = account("clip-ben");
const wid = createWorkspace(anna.id, "Clips");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "viewer");
const space = bootstrap(anna, wid).spaces[0].id;
const html = (pageId: string) => one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html;

const ARTICLE = `<!doctype html><html><head><title>Fallback</title>
<meta property="og:title" content="Wie Teams besser planen">
<meta name="description" content="Ein Artikel über Planung.">
<link rel="icon" href="/static/icon.png">
</head><body>
<nav class="main-nav"><a href="/">Start</a><a href="/blog">Blog</a></nav>
<div class="cookie-banner">Wir nutzen Cookies.</div>
<div class="layout">
  <aside class="sidebar"><p>Beliebte Beiträge, die du lesen solltest, weil sie sehr beliebt sind und viele Klicks haben.</p></aside>
  <div class="post-content">
    <h1>Wie Teams besser planen</h1>
    <p>Gute Planung beginnt mit klaren Zielen, einem gemeinsamen Verständnis und ehrlichen Schätzungen. Wer das beherzigt, plant besser.</p>
    <p>Zweitens helfen kurze Zyklen, regelmäßige Rückblicke und sichtbare Aufgaben, damit niemand den Überblick verliert, auch nicht <a href="/glossar#zyklus">im Glossar</a>.</p>
    <img data-src="/bilder/plan.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Plan">
    <script>window.evil = 1</script>
    <div class="share-buttons"><a href="https://social.example/share">Teilen</a></div>
    <p>Drittens: Dokumentiere Entscheidungen, damit sie später nachvollziehbar bleiben, und verlinke sie mit den Aufgaben, zu denen sie gehören.</p>
  </div>
  <div class="comments"><p>Toller Artikel, danke! Ich habe das gleich in meinem Team ausprobiert und es klappt, wirklich.</p></div>
</div>
<footer><p>Impressum und Datenschutz, alle Rechte vorbehalten, Musterfirma GmbH, Musterstraße 1.</p></footer>
</body></html>`;

test("the content script finds the article, not navigation, ads or comments", () => {
  const window = new Window({ url: "https://news.example/blog/planung.html" });
  window.document.write(ARTICLE);
  const article = extract.extractArticle(window.document as unknown as Document);
  assert.equal(article.title, "Wie Teams besser planen");
  assert.equal(article.favicon, "https://news.example/static/icon.png");
  assert.match(article.html, /Gute Planung beginnt/);
  assert.match(article.html, /Drittens: Dokumentiere/);
  assert.match(article.html, /href="https:\/\/news\.example\/glossar#zyklus"/);
  assert.match(article.html, /src="https:\/\/news\.example\/bilder\/plan\.png"/);
  assert.doesNotMatch(article.html, /Cookies|Beliebte Beiträge|Toller Artikel|Impressum|<script|Teilen|<nav|<h1/);
  const meta = extract.meta(window.document as unknown as Document);
  assert.equal(meta.description, "Ein Artikel über Planung.");
  assert.equal(meta.url, "https://news.example/blog/planung.html");
  window.close();
});

test("the content script takes the selection as HTML and text", () => {
  const window = new Window({ url: "https://news.example/x" });
  window.document.write(`<body><p id="a">Vorher <b>fett</b> und <a href="/ziel">Link</a> danach.</p><p>Rest</p></body>`);
  const range = window.document.createRange();
  range.selectNodeContents(window.document.getElementById("a")!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const picked = extract.selection(window);
  assert.match(picked.html, /<b>fett<\/b>/);
  assert.match(picked.html, /href="https:\/\/news\.example\/ziel"/);
  assert.match(picked.text, /Vorher fett und Link danach\./);
  assert.doesNotMatch(picked.html, /Rest/);
  window.getSelection()!.removeAllRanges();
  assert.deepEqual(extract.selection(window), { html: "", text: "" });
  window.close();
});

test("the server sanitises clipped HTML and makes addresses absolute", () => {
  const clean = clipHtml(
    `<h1 style="color:red" onclick="x()">Titel</h1><p class="lead">Text <a href="/a">rel</a> <a href="javascript:alert(1)">js</a></p>
     <img src="bild.png" onerror="x()"><img src="data:image/png;base64,AAAA"><img data-src="//cdn.example/lazy.jpg">
     <script>alert(1)</script><iframe src="https://evil.example"></iframe><style>p{}</style>`,
    "https://site.example/dir/page",
  );
  assert.match(clean, /href="https:\/\/site\.example\/a"/);
  assert.match(clean, /src="https:\/\/site\.example\/dir\/bild\.png"/);
  assert.match(clean, /src="https:\/\/cdn\.example\/lazy\.jpg"/);
  assert.doesNotMatch(clean, /javascript|onclick|onerror|<script|data:image|evil|class=|style=|p\{\}/);
  assert.match(clean, /<a>js<\/a>|>js</);
});

test("clipper tokens only reach the clipper endpoints", () => {
  const clipper = createApiToken(anna, { name: "Browser", scope: "clipper" }).token;
  const write = createApiToken(anna, { name: "Skript", scope: "write" }).token;
  const read = createApiToken(anna, { name: "Lesen", scope: "read" }).token;
  assert.equal(identityFromApiToken(`Bearer ${clipper}`), null, "everywhere else a clipper token is no token");
  assert.equal(identityFromApiToken(`Bearer ${clipper}`, { clipper: true })?.apiScope, "clipper");
  assert.equal(clipperUser(`Bearer ${clipper}`).id, anna.id);
  assert.equal(clipperUser(`Bearer ${write}`).apiScope, "write");
  assert.throws(() => clipperUser(`Bearer ${read}`), /nur lesen/);
  assert.throws(() => clipperUser(null), /API-Token/);
  assert.throws(() => clipperUser("Bearer fp_unknownunknownunknownunknown"), /ungültig/);
  assert.equal(one<{ scope: string }>("SELECT scope FROM api_tokens WHERE prefix=?", clipper.slice(0, 10))!.scope, "clipper");
});

test("CORS only for browser-extension origins, never with credentials", () => {
  const chrome = clipperCors("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  assert.equal(chrome["Access-Control-Allow-Origin"], "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
  assert.equal(clipperCors("moz-extension://0b7c8a52-7e5c-4b6a-9f0e-0d5a1c2b3d4e")["Access-Control-Allow-Origin"], "moz-extension://0b7c8a52-7e5c-4b6a-9f0e-0d5a1c2b3d4e");
  for (const origin of ["https://evil.example", "null", "chrome-extension://x", null]) assert.equal(clipperCors(origin)["Access-Control-Allow-Origin"], undefined, String(origin));
  assert.ok(!Object.keys(chrome).some((k) => /credentials/i.test(k)));
  assert.ok(isExtensionOrigin("safari-web-extension://0B7C8A52-7E5C-4B6A-9F0E-0D5A1C2B3D4E"));
});

test("the route answers preflights and refuses cookies", async () => {
  const { OPTIONS, GET, POST } = await import("../app/api/clipper/[action]/route");
  const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const preflight = OPTIONS(new Request("https://flowplan.example.test/api/clipper/save", { method: "OPTIONS", headers: { origin } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  const token = createApiToken(anna, { name: "Route", scope: "clipper" }).token;
  const params = (action: string) => ({ params: Promise.resolve({ action }) });
  const ok = await GET(new Request("https://flowplan.example.test/api/clipper/targets", { headers: { origin, authorization: `Bearer ${token}` } }), params("targets"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), origin);
  assert.ok(((await ok.json()) as { workspaces: unknown[] }).workspaces.length >= 1);
  const cookie = await GET(new Request("https://flowplan.example.test/api/clipper/targets", { headers: { origin, cookie: "flowplan_session=abc" } }), params("targets"));
  assert.equal(cookie.status, 401);
  const bad = await POST(
    new Request("https://flowplan.example.test/api/clipper/save", { method: "POST", headers: { authorization: `Bearer ${token}`, "accept-language": "en" }, body: "{" }),
    params("save"),
  );
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, "Invalid input.");
});

test("targets list writable spaces, pages and databases only", () => {
  const db = createPage(wid, space, anna.id, "Leseliste", "database");
  const targets = clipperTargets(anna);
  const workspace = targets.workspaces.find((w) => w.id === wid)!;
  assert.ok(workspace.spaces.some((s) => s.id === space));
  assert.ok(workspace.pages.some((p) => p.id === db && p.kind === "database"));
  assert.equal(clipperTargets(ben).workspaces.find((w) => w.id === wid), undefined, "viewers cannot save");
});

test("whole page and selection: new page in a space, sub-page, record with tags", () => {
  const url = "https://news.example/blog/planung.html";
  const saved = saveClip(anna, {
    mode: "page",
    target: { workspaceId: wid, spaceId: space },
    url,
    title: "Wie Teams besser planen",
    html: `<p>Inhalt <a href="/x">x</a></p><script>alert(1)</script>`,
    tags: ["planung", "teams"],
  });
  assert.equal(saved.url, `https://flowplan.example.test/#page=${saved.pageId}`);
  const page = html(saved.pageId);
  assert.match(page, new RegExp(`<a href="${url.replace(/[./]/g, "\\$&")}"`));
  assert.match(page, /#planung #teams/);
  assert.match(page, /href="https:\/\/news\.example\/x"/);
  assert.doesNotMatch(page, /<script/);
  const parent = createPage(wid, space, anna.id, "Recherche", "document");
  const sub = saveClip(anna, { mode: "selection", target: { workspaceId: wid, pageId: parent }, url, title: "Auszug", html: "<p>Nur dieser Satz.</p>" });
  assert.equal(one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", sub.pageId)!.parent_id, parent);
  // A database: a record; its "Tags" property gets the tags.
  const db = createPage(wid, space, anna.id, "Artikel", "database");
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "link", name: "Link", type: "url" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["teams"] },
  ];
  run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), db);
  const record = saveClip(anna, { mode: "page", target: { workspaceId: wid, pageId: db }, url, title: "Artikel A", html: "<p>Text</p>", tags: ["Teams", "neu"] });
  assert.ok(record.rowId);
  const cells = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", record.rowId!)!.cells);
  assert.equal(cells.title, "Artikel A");
  assert.equal(cells.link, url);
  assert.deepEqual(cells.tags, ["teams", "neu"]);
  assert.match(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", record.rowId!)!.html, /Text/);
  // Viewers and foreign workspaces are refused.
  assert.throws(() => saveClip(ben, { mode: "page", target: { workspaceId: wid, spaceId: space }, url, html: "<p>x</p>" }));
  assert.throws(() => saveClip(anna, { mode: "page", target: { workspaceId: wid, spaceId: space }, url: "javascript:alert(1)", html: "<p>x</p>" }));
});

test("bookmarks: title, address, description, favicon and tags; no duplicates", () => {
  const url = "https://tools.example/editor";
  const saved = saveClip(anna, {
    mode: "bookmark",
    target: { workspaceId: wid, spaceId: space },
    url,
    title: "Ein Editor",
    description: "Schreibt Texte.",
    favicon: "https://tools.example/favicon.ico",
    tags: ["werkzeug"],
  });
  const row = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", saved.rowId!)!.cells);
  assert.equal(row.title, "Ein Editor");
  assert.equal(row.bm_url, url);
  assert.equal(row.bm_note, "Schreibt Texte.");
  assert.equal(row.bm_favicon, "https://tools.example/favicon.ico");
  assert.deepEqual(row.bm_tags, ["werkzeug"]);
  assert.throws(() => saveClip(anna, { mode: "bookmark", target: { workspaceId: wid, spaceId: space }, url }), /schon unter den Lesezeichen/);
});

test("highlights: quotes with a link to the source, appended to one page", () => {
  const url = "https://news.example/blog/zitat.html";
  const first = saveClip(anna, { mode: "highlight", target: { workspaceId: wid, spaceId: space }, url, title: "Zitate", html: "<b>Erster</b> Satz", text: "Erster Satz" });
  saveClip(anna, { mode: "highlight", target: { workspaceId: wid, pageId: first.pageId }, url, title: "Zitate", text: "Zweiter Satz" });
  const page = html(first.pageId);
  assert.equal((page.match(/<blockquote>/g) || []).length, 2);
  assert.match(page, /<strong>Erster<\/strong> Satz/);
  assert.match(page, /Zweiter Satz/);
  assert.match(page, new RegExp(`— <a [^>]*href="${url.replace(/[./]/g, "\\$&")}"[^>]*>Zitate</a>`));
  assert.ok(page.indexOf("Erster") < page.indexOf("Zweiter"));
  assert.throws(() => saveClip(anna, { mode: "highlight", target: { workspaceId: wid, pageId: first.pageId }, url, text: "" }), /Kein Text/);
  assert.equal(all("SELECT id FROM pages WHERE title='Zitate'").length, 1);
});

test("end-to-end encrypted spaces are neither offered nor written to", () => {
  run("UPDATE spaces SET encrypted=1 WHERE id=?", space);
  try {
    const workspace = clipperTargets(anna).workspaces.find((w) => w.id === wid)!;
    assert.ok(!workspace.spaces.some((s) => s.id === space));
    assert.throws(() => saveClip(anna, { mode: "page", target: { workspaceId: wid, spaceId: space }, url: "https://a.example/", html: "<p>x</p>" }), (e: { status?: number }) => e.status === 409);
  } finally {
    run("UPDATE spaces SET encrypted=0 WHERE id=?", space);
  }
});

test("the extension asks for minimal permissions and ships its strings", () => {
  const manifest = JSON.parse(readFileSync("extensions/browser/manifest.json", "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "contextMenus", "scripting", "storage"]);
  assert.equal(manifest.host_permissions, undefined, "host access is requested at runtime for the instance only");
  assert.equal(manifest.content_scripts, undefined, "nothing is injected into every page");
  const de = JSON.parse(readFileSync("extensions/browser/_locales/de/messages.json", "utf8"));
  const en = JSON.parse(readFileSync("extensions/browser/_locales/en/messages.json", "utf8"));
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  assert.equal(de.menuHighlight.message, "In Flowplan markieren");
  const sources = ["popup.html", "popup.js", "background.js", "api.js"].map((f) => readFileSync(`extensions/browser/${f}`, "utf8")).join("\n");
  for (const key of new Set([...sources.matchAll(/(?:msg\(|data-i18n=)"([A-Za-z]+)"/g)].map((m) => m[1]))) assert.ok(en[key], key);
});
