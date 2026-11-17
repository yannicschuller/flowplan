// The BookStack import through its REST API (#329, lib/importers/bookstack-api.ts)
// against a mock of BookStack's API on a local port: the sandbox reaches no
// BookStack, and the address is the person's own – a local one only with
// FLOWPLAN_IMPORT_ALLOW_PRIVATE=true (set here, unset in the policy test).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-bookstack-"));
process.env.FLOWPLAN_IMPORT_ALLOW_PRIVATE = "true";
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { bootstrap } = await import("../lib/api");
const { launchJob, jobOutcome } = await import("../lib/background-jobs");
const { bookStackBase, bookStackCredentials, bookStackClient, listBookStack, readBookStack, retryWait, scrubToken, BOOKSTACK_PRIVATE, BOOKSTACK_PAGE_SIZE } = await import("../lib/importers/bookstack-api");
const { importBookStack, listBookStackFor } = await import("../lib/importers/bookstack-import");

const TOKEN_ID = "TokId" + "Q7wX9zK2".repeat(3);
const TOKEN_SECRET = "S3cr" + "Vb8nM4pL".repeat(3) + "ZZ";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(3000, 0x20), Buffer.from("\n%%EOF\n")]);

const server = createServer((req, res) => void handle(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// BookStack below a path: links and files carry it.
const B = `${origin}/wiki`;
after(() => server.close());

const stamp = { created_at: "2025-03-01T10:00:00.000000Z", updated_at: "2025-04-01T10:00:00.000000Z" };
const shelves = [
  { id: 2, name: "B-Regal", slug: "b-regal", books: [11], description_html: "", tags: [] },
  { id: 1, name: "A-Regal", slug: "a-regal", books: [10, 11], description_html: `<p>Alles zum <a href="${B}/books/betrieb">Betrieb</a>.</p>`, tags: [{ name: "Bereich", value: "IT" }] },
];
const books = [
  { id: 10, name: "Betrieb", slug: "betrieb", description_html: "<p>Wie wir arbeiten.</p>", tags: [{ name: "Team", value: "" }] },
  { id: 11, name: "Gemeinsam", slug: "gemeinsam", description_html: "", tags: [] },
  { id: 12, name: "Lose", slug: "lose", description: "Ein Buch\nohne Regal", tags: [] },
  { id: 13, name: "Viel", slug: "viel", description_html: "", tags: [] },
];
const chapters = [{ id: 100, book_id: 10, name: "Kapitel Eins", slug: "kapitel-eins", priority: 1, description_html: "<p>Intro <strong>Kapitel</strong></p>", tags: [{ name: "Status", value: "Entwurf" }] }];
const startHtml = `<h1 id="bkmrk-start">Start</h1>
<p id="bkmrk-intro">Siehe <a href="${B}/books/betrieb/page/details#bkmrk-ziel">Ziel</a>, <a href="${B}/link/1002">Vorher</a>, <a href="${B}/books/lose">Lose</a>, <a href="${B}/books/viel/page/fuell-1">Draußen</a>, <a href="https://example.org/doc">extern</a> und <a href="${B}/attachments/5000">das Handbuch</a>.</p>
<p class="callout info">Info-Hinweis</p>
<p class="callout danger">Gefahr!</p>
<pre id="bkmrk-code"><code class="language-JavaScript">const x = 1 &lt; 2;</code></pre>
<table><tbody><tr><td>Kopf</td><td>Wert</td></tr><tr><td>A</td><td>1</td></tr></tbody></table>
<p><a href="${B}/uploads/images/gallery/2026-01/foto.png" target="_blank"><img src="${B}/uploads/images/gallery/2026-01/scaled-1680-/foto.png" alt="Foto"></a></p>
<div drawio-diagram="7"><img src="${B}/uploads/images/drawio/2026-01/drawing-1.png"></div>
<p><img src="${B}/uploads/images/gallery/2026-01/secure.png" alt="Geschützt"></p>
<p><img src="${B}/uploads/images/gallery/2026-01/missing.png" alt=""></p>
<p><img src="https://example.org/extern.png" alt="Extern"></p>
<p><img src="${origin}/other/uploads/images/x.png" alt="Daneben"></p>
<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked="checked" disabled> Erledigt</li><li class="task-list-item"><input type="checkbox" disabled> Offen</li></ul>
<details><summary>Mehr</summary><p>Versteckt</p></details>`;
const realPages = [
  { id: 1000, book_id: 10, chapter_id: 0, name: "Start", slug: "start", priority: 0, draft: false, html: startHtml, markdown: "", tags: [{ name: "wichtig", value: "" }] },
  { id: 1001, book_id: 10, chapter_id: 100, name: "Details", slug: "details", priority: 2, draft: false, html: `<h2 id="bkmrk-ziel">Ziel</h2><p id="bkmrk-text">Text</p>`, markdown: "", tags: [] },
  { id: 1002, book_id: 10, chapter_id: 100, name: "Vorher", slug: "vorher", priority: 1, draft: false, html: "<p>Davor</p>", markdown: "", tags: [] },
  {
    id: 1003, book_id: 12, chapter_id: 0, name: "Notizen", slug: "notizen", priority: 0, draft: false,
    html: `<h1>Titel</h1><p><img src="${B}/uploads/images/gallery/2026-01/md.png" alt="bild"></p>`,
    markdown: `# Titel\n\n- [x] erledigt\n- [ ] offen\n\n![bild](${B}/uploads/images/gallery/2026-01/md.png)\n\n[Zum Start](${B}/books/betrieb/page/start)\n`,
    tags: [{ name: "markdown", value: "" }, { name: "Status", value: "Entwurf" }],
  },
  { id: 1004, book_id: 10, chapter_id: 0, name: "Entwurf", slug: "entwurf", priority: 9, draft: true, html: "<p>geheim</p>", markdown: "", tags: [] },
  { id: 1005, book_id: 11, chapter_id: 0, name: "Geteilt", slug: "geteilt", priority: 0, draft: false, html: "<p>Auf zwei Regalen</p>", markdown: "", tags: [] },
];
// More than one list page (500 per answer).
const fillers = Array.from({ length: 600 }, (_, i) => ({ id: 2000 + i, book_id: 13, chapter_id: 0, name: `Füll ${i}`, slug: `fuell-${i}`, priority: i, draft: false, html: `<p>${i}</p>`, markdown: "", tags: [] }));
const pages = [...realPages, ...fillers];
const attachments = [
  { id: 5001, name: "Website", extension: "", uploaded_to: 1000, external: true, order: 2, content: "https://example.org/site" },
  { id: 5000, name: "handbuch", extension: "pdf", uploaded_to: 1000, external: false, order: 1, content: PDF.toString("base64") },
  { id: 5002, name: "notiz.txt", extension: "txt", uploaded_to: 1001, external: false, order: 1, content: Buffer.from("Hallo").toString("base64") },
];

const seen: { path: string; auth: string; query: URLSearchParams }[] = [];
let throttledPage = false;
let throttledChapter = false;
const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const listOf = (items: Record<string, unknown>[], query: URLSearchParams) => {
  const count = Math.min(BOOKSTACK_PAGE_SIZE, Number(query.get("count") || 100));
  const offset = Number(query.get("offset") || 0);
  const sorted = [...items].sort((a, b) => Number(a.id) - Number(b.id));
  return { data: sorted.slice(offset, offset + count).map(({ html, markdown, content, books, tags, description_html, ...rest }) => (void [html, markdown, content, books, tags, description_html], rest)), total: sorted.length };
};
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", origin);
  seen.push({ path: url.pathname, auth: String(req.headers.authorization || ""), query: url.searchParams });
  if (!url.pathname.startsWith("/wiki/")) return send(res, 404, {});
  const path = url.pathname.slice(5);
  // Images in the uploads folder: the default storage serves them; the
  // "secure" one only through the API.
  if (path.startsWith("/uploads/images/")) {
    if (/\/(foto|drawing-1|md)\.png$/.test(path) && !/scaled-/.test(path)) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (/secure\.png$/.test(path)) {
      res.writeHead(302, { location: `${B}/login` });
      return res.end();
    }
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<html>nicht da</html>");
  }
  if (!path.startsWith("/api/")) return send(res, 404, {});
  if (req.headers.authorization !== `Token ${TOKEN_ID}:${TOKEN_SECRET}`) return send(res, 401, { error: { message: "The provided API token is invalid", code: 401 } });
  const api = path.slice(4);
  if (api === "/image-gallery/url/data") {
    if (/secure\.png$/.test(url.searchParams.get("url") || "")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    return send(res, 404, { error: { message: "Not found" } });
  }
  const m = /^\/(shelves|books|chapters|pages|attachments)(?:\/(\d+))?$/.exec(api);
  if (!m) return send(res, 404, { error: { message: "Not found" } });
  const items = { shelves, books, chapters, pages, attachments }[m[1] as "shelves"] as Record<string, unknown>[];
  if (!m[2]) return send(res, 200, listOf(items, url.searchParams));
  // Rate limits: once with Retry-After, once with X-RateLimit-Reset.
  if (api === "/pages/1000" && !throttledPage) {
    throttledPage = true;
    return send(res, 429, { error: { message: "Too many requests" } }, { "retry-after": "3", "x-ratelimit-remaining": "0" });
  }
  if (api === "/chapters/100" && !throttledChapter) {
    throttledChapter = true;
    return send(res, 429, { error: { message: "Too many requests" } }, { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 7) });
  }
  const item = items.find((i) => i.id === Number(m[2]));
  if (!item) return send(res, 404, { error: { message: "Not found" } });
  send(res, 200, { ...item, ...stamp, ...(m[1] === "shelves" ? { books: (item.books as number[]).map((bid) => ({ id: bid, name: books.find((b) => b.id === bid)!.name })) } : {}) });
}

const slept: number[] = [];
const test0 = { sleep: async (ms: number) => void slept.push(ms) };
const input = { url: `${B}/`, tokenId: TOKEN_ID, tokenSecret: TOKEN_SECRET };
const credentials = bookStackCredentials(input);
const chosen = { shelves: [1, 2], books: [10, 11, 12] };

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("bookstack-owner");
const wid = await createWorkspace(owner.id, "BookStack");
const space = (await bootstrap(owner, wid)).spaces[0].id;

test("the address and the token are checked; internal addresses only with FLOWPLAN_IMPORT_ALLOW_PRIVATE", () => {
  assert.equal(bookStackBase("https://wiki.example.org/api/"), "https://wiki.example.org");
  assert.equal(bookStackBase("wiki.example.org/docs/"), "https://wiki.example.org/docs");
  assert.throws(() => bookStackBase(""), /Adresse/);
  assert.throws(() => bookStackBase("https://user:pw@wiki.example.org"), /ungültig/);
  assert.throws(() => bookStackCredentials({ url: "https://wiki.example.org", tokenId: "abc", tokenSecret: TOKEN_SECRET }), /Token-ID/);
  delete process.env.FLOWPLAN_IMPORT_ALLOW_PRIVATE;
  try {
    assert.throws(() => bookStackBase(B), /https:\/\//);
    for (const address of ["https://127.0.0.1", "https://10.0.0.5/wiki", "https://[::1]", "https://localhost", "https://192.168.1.20"])
      assert.throws(() => bookStackBase(address), (e: Error) => e.message === BOOKSTACK_PRIVATE, address);
  } finally {
    process.env.FLOWPLAN_IMPORT_ALLOW_PRIVATE = "true";
  }
  assert.equal(bookStackBase(B), B);
});

test("a 429 waits as Retry-After or X-RateLimit-Reset say, at most a minute", () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);
  assert.equal(retryWait({ "retry-after": "3" }, now), 3000);
  assert.equal(retryWait({ "retry-after": new Date(now + 10_000).toUTCString() }, now), 10_000);
  assert.equal(retryWait({ "x-ratelimit-reset": String(now / 1000 + 20) }, now), 20_000);
  assert.equal(retryWait({}, now), 5000);
  assert.equal(retryWait({ "retry-after": "3600" }, now), 60_000);
});

test("the token goes in BookStack's header, only to its address; a wrong one is refused without showing it", async () => {
  const client = bookStackClient(credentials, test0);
  await client.call("/books/10");
  const last = seen.at(-1)!;
  assert.equal(last.auth, `Token ${TOKEN_ID}:${TOKEN_SECRET}`);
  // Another address of the same host (outside BookStack's path) or another
  // host is not fetched with the token.
  const before = seen.length;
  assert.deepEqual(await client.file(`${origin}/other/uploads/images/x.png`, 1000), { error: "outside" });
  assert.deepEqual(await client.file("https://evil.example/uploads/images/x.png", 1000), { error: "outside" });
  assert.equal(seen.length, before);
  const wrong = { ...input, tokenSecret: "WrongSecretWrongSecret" };
  await assert.rejects(listBookStack(bookStackCredentials(wrong), test0), (e: Error) => /abgelehnt/.test(e.message) && !e.message.includes("WrongSecret"));
  assert.equal(scrubToken(`x ${TOKEN_ID}:${TOKEN_SECRET} y`, credentials), "x …:… y");
});

test("listing: shelves with their books, books on no shelf, over every page of the lists", async () => {
  const listed = await listBookStackFor(owner, wid, space, input, test0);
  assert.deepEqual(listed.shelves, [
    { id: 1, name: "A-Regal", books: [{ id: 10, name: "Betrieb" }, { id: 11, name: "Gemeinsam" }] },
    { id: 2, name: "B-Regal", books: [{ id: 11, name: "Gemeinsam" }] },
  ]);
  assert.deepEqual(listed.books, [
    { id: 12, name: "Lose" },
    { id: 13, name: "Viel" },
  ]);
});

test("the preview counts without downloading anything; with everything chosen it is too many, and the import is refused", async () => {
  const from = seen.length;
  const preview = await importBookStack(owner, wid, space, { ...input, ...chosen }, { ...test0, dryRun: true });
  assert.equal(preview.source, "bookstack");
  assert.deepEqual(
    [preview.shelves, preview.books, preview.chapters, preview.pages, preview.images, preview.attachments, preview.links, preview.tags],
    [2, 3, 1, 5, 5, 2, 1, 5],
  );
  assert.ok(!preview.tooMany);
  assert.ok(preview.warnings.includes("Das Buch „Gemeinsam“ steht in mehreren Regalen und wird nur einmal unter „A-Regal“ importiert."), preview.warnings.join("\n"));
  // No image, no attachment's content was fetched.
  assert.ok(!seen.slice(from).some((r) => r.path.includes("/uploads/") || /\/api\/attachments\/\d+$/.test(r.path) || r.path.includes("image-gallery")));
  assert.equal((await one<{ n: number }>("SELECT count(*) n FROM pages WHERE workspace_id=? AND title='Start'", wid))!.n, 0);

  process.env.FLOWPLAN_IMPORT_MAX_DOCS = "100";
  try {
    const start = seen.length;
    const all = await importBookStack(owner, wid, space, input, { ...test0, dryRun: true });
    assert.equal(all.tooMany, true);
    assert.equal(all.pages, 605);
    assert.match(all.warnings[0], /FLOWPLAN_IMPORT_MAX_DOCS/);
    // The pages list in two answers of 500; no page was read.
    const offsets = seen.slice(start).filter((r) => r.path === "/wiki/api/pages").map((r) => [r.query.get("offset"), r.query.get("count")]);
    assert.deepEqual(offsets, [["0", "500"], ["500", "500"]]);
    assert.ok(!seen.slice(start).some((r) => /\/api\/pages\/\d+$/.test(r.path)));
    await assert.rejects(importBookStack(owner, wid, space, input, test0), (e: Error & { status?: number }) => e.status === 413 && /FLOWPLAN_IMPORT_MAX_DOCS/.test(e.message));
  } finally {
    delete process.env.FLOWPLAN_IMPORT_MAX_DOCS;
  }
});

test("the import: hierarchy and order, descriptions, content, images, attachments, links between pages, tags", async () => {
  slept.length = 0;
  throttledPage = throttledChapter = false;
  const result = await importBookStack(owner, wid, space, { ...input, ...chosen }, test0);
  // Both rate limits were waited out.
  assert.ok(slept.includes(3000), String(slept));
  assert.ok(slept.some((ms) => ms >= 6000 && ms <= 8000), String(slept));
  const pageOf = async (title: string) => (await one<{ id: string; parent_id: string | null }>("SELECT id,parent_id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL", wid, title))!;
  const kids = async (parent: string | null) =>
    (await all<{ title: string }>(`SELECT title FROM pages WHERE workspace_id=? AND space_id=? AND deleted_at IS NULL AND ${parent ? "parent_id=?" : "parent_id IS NULL"} ORDER BY position`, wid, space, ...(parent ? [parent] : []))).map((p) => p.title);
  const htmlOf = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;
  const shelfA = await pageOf("A-Regal"),
    shelfB = await pageOf("B-Regal"),
    betrieb = await pageOf("Betrieb"),
    chapter = await pageOf("Kapitel Eins"),
    start = await pageOf("Start"),
    details = await pageOf("Details"),
    vorher = await pageOf("Vorher"),
    lose = await pageOf("Lose"),
    notizen = await pageOf("Notizen");
  assert.deepEqual((await kids(null)).filter((t) => /Regal|Lose|Viel/.test(t)), ["A-Regal", "B-Regal", "Lose"]);
  assert.deepEqual(await kids(shelfA.id), ["Betrieb", "Gemeinsam"]);
  assert.deepEqual(await kids(shelfB.id), []);
  assert.deepEqual(await kids(betrieb.id), ["Start", "Kapitel Eins"]);
  assert.deepEqual(await kids(chapter.id), ["Vorher", "Details"]);
  assert.deepEqual(await kids(lose.id), ["Notizen"]);
  assert.equal(await one("SELECT id FROM pages WHERE workspace_id=? AND title='Entwurf'", wid), undefined);
  assert.deepEqual(result.rootIds.slice(0, 3), [shelfA.id, shelfB.id, lose.id]);

  // Descriptions as the text of their page, links in them rewritten.
  assert.match(await htmlOf(chapter.id), /Intro <strong>Kapitel<\/strong>/);
  assert.match(await htmlOf(shelfA.id), new RegExp(`href="/#page=${betrieb.id}"`));
  assert.match(await htmlOf(lose.id), /Ein Buch<br ?\/?>ohne Regal/);

  const html = await htmlOf(start.id);
  assert.match(html, /<aside[^>]*data-callout="note"[^>]*><p[^>]*>Info-Hinweis<\/p><\/aside>/);
  assert.match(html, /<aside[^>]*data-callout="caution"[^>]*><p[^>]*>Gefahr!<\/p><\/aside>/);
  assert.match(html, /<pre[^>]*><code class="language-javascript">const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<td[^>]*><p[^>]*>Kopf<\/p><\/td>/);
  assert.match(html, /data-type="taskItem" data-checked="true"[^>]*><p[^>]*>Erledigt<\/p>/);
  assert.match(html, /data-type="taskItem" data-checked="false"[^>]*><p[^>]*>Offen<\/p>/);
  assert.match(html, /<details[^>]*><summary>Mehr<\/summary>/);
  // Links between pages: to a paragraph of another page, by /link/<id>, to
  // a book; to a page outside the import its address; external ones stay.
  assert.match(html, new RegExp(`href="/#page=${details.id}&amp;block=[^"]+"[^>]*>Ziel</a>`));
  assert.match(html, new RegExp(`href="/#page=${vorher.id}"[^>]*>Vorher</a>`));
  assert.match(html, new RegExp(`href="/#page=${lose.id}"[^>]*>Lose</a>`));
  assert.match(html, new RegExp(`href="${B.replace(/[.]/g, "\\.")}/books/viel/page/fuell-1"`));
  assert.match(html, /href="https:\/\/example\.org\/doc"/);
  // Images of the BookStack (the original, not the thumbnail; the draw.io
  // drawing; one only through the API) and the attachments are files of the page.
  const files = await all<{ id: string; name: string; mime: string }>("SELECT id,name,mime FROM files WHERE page_id=? ORDER BY name", start.id);
  assert.deepEqual(files.map((f) => f.name), ["drawing-1.png", "foto.png", "handbuch.pdf", "secure.png"]);
  for (const f of files.filter((f) => f.name.endsWith(".png"))) assert.match(html, new RegExp(`<img [^>]*src="/api/files/${f.id}"`));
  const pdf = files.find((f) => f.name === "handbuch.pdf")!;
  assert.match(html, new RegExp(`href="/api/files/${pdf.id}[^"]*"[^>]*>das Handbuch</a>`));
  // The link attachment as a link; the PDF linked in the text is not listed twice.
  assert.match(html, /<a [^>]*href="https:\/\/example\.org\/site"[^>]*>Website<\/a>/);
  assert.equal(html.split(`/api/files/${pdf.id}`).length - 1, 1, html);
  assert.match(html, /src="https:\/\/example\.org\/extern\.png"/);
  assert.doesNotMatch(html, /scaled-1680|missing\.png|uploads\/images\/gallery/);
  assert.ok(!seen.some((r) => r.path.startsWith("/other/")));
  // An attachment the text does not link to comes below the text.
  const notiz = (await one<{ id: string }>("SELECT id FROM files WHERE page_id=? AND name='notiz.txt'", details.id))!;
  assert.match(await htmlOf(details.id), new RegExp(`/api/files/${notiz.id}`));

  // A Markdown page through the Markdown converter.
  const md = await htmlOf(notizen.id);
  assert.match(md, /data-type="taskItem" data-checked="true"/);
  assert.match(md, new RegExp(`href="/#page=${start.id}"[^>]*>Zum Start</a>`));
  assert.match(md, /<img [^>]*src="\/api\/files\//);

  // Tags: "name" and "name: value".
  const tagsOf = async (pageId: string) =>
    (await all<{ name: string }>("SELECT t.name FROM page_tag_links l JOIN page_tags t ON t.id=l.tag_id WHERE l.page_id=? ORDER BY t.name", pageId)).map((t) => t.name);
  assert.deepEqual(await tagsOf(chapter.id), ["Status: Entwurf"]);
  assert.deepEqual(await tagsOf(notizen.id), ["markdown", "Status: Entwurf"].sort());
  assert.deepEqual(await tagsOf(shelfA.id), ["Bereich: IT"]);

  // Failures are warnings and in the report, not a failed import.
  assert.ok(result.warnings.includes("Ein Bild konnte nicht geladen werden."), result.warnings.join("\n"));
  assert.ok(result.report);
  const report = await htmlOf(result.report!.pageId);
  assert.match(report, /missing\.png/);
  assert.deepEqual([result.shelves, result.books, result.chapters, result.images, result.attachments, result.links], [2, 3, 1, 5, 2, 1]);
});

test("files above the upload limit are left out and named in the report", async () => {
  const { tree } = await readBookStack(credentials, { books: [10] }, { ...test0, maxFileBytes: 1000 });
  try {
    assert.ok(![...tree.files.values()].some((f) => f.name === "handbuch.pdf"));
    assert.ok(tree.warnings.includes("Ein Anhang ist größer als die Grenze beim Hochladen und wurde ausgelassen."), tree.warnings.join("\n"));
    assert.ok(tree.report!.entries.some((e) => e.kind === "file" && /handbuch/.test(e.detail) && e.page === "page-1000"));
    // Only the book, at the top: no shelf was chosen.
    assert.equal(tree.pages.find((p) => p.key === "book-10")!.parent, null);
  } finally {
    tree.close?.();
  }
});

const filesBelow = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesBelow(join(dir, name)) : [join(dir, name)]));

test("as background jobs, done or failed: the token is nowhere in the outcome, the database or the data folder", async () => {
  const done = await launchJob(owner, "import", "BookStack", () => importBookStack(owner, wid, space, { ...input, books: [11] }, test0));
  const failed = await launchJob(owner, "import", "BookStack", () => importBookStack(owner, wid, space, { ...input, tokenId: TOKEN_ID + "x", books: [11] }, test0));
  const wait = async (job: string) => {
    let outcome = await jobOutcome(owner, job);
    for (let i = 0; i < 300 && outcome?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      outcome = await jobOutcome(owner, job);
    }
    return outcome;
  };
  const ok = await wait(done);
  assert.equal(ok?.status, "done");
  const bad = await wait(failed);
  assert.equal(bad?.status, "failed");
  for (const outcome of [ok, bad]) assert.ok(!JSON.stringify(outcome).includes(TOKEN_SECRET) && !JSON.stringify(outcome).includes(TOKEN_ID));
  const tables = /^postgres/.test(process.env.DATABASE_URL || "")
    ? await all<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()")
    : await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
  for (const { name } of tables) {
    const content = JSON.stringify(await all(`SELECT * FROM "${name}"`), (_, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    assert.ok(!content.includes(TOKEN_SECRET) && !content.includes(TOKEN_ID), `token in table ${name}`);
  }
  for (const path of filesBelow(process.env.FLOWPLAN_DATA_DIR!)) {
    const data = readFileSync(path);
    assert.ok(!data.includes(TOKEN_SECRET) && !data.includes(TOKEN_ID), `token in ${path}`);
  }
  // The downloaded files' temporary folder is gone.
  assert.ok(!filesBelow(process.env.FLOWPLAN_DATA_DIR!).some((p) => /bookstack-[0-9a-f-]{36}/.test(p)));
});

test("an editor of the target space only; demo guests and an empty choice are refused", async () => {
  const other = await account("bookstack-stranger");
  await assert.rejects(importBookStack(other, wid, space, { ...input, ...chosen }, { ...test0, dryRun: true }));
  await assert.rejects(listBookStackFor({ ...owner, demo: true }, wid, space, input, test0));
  await assert.rejects(importBookStack(owner, wid, space, { ...input, books: [] }, test0), /mindestens ein/);
});
