// The HTML preview (#398): an uploaded .html/.htm file served as an inert,
// sandboxed page – its headers (the policy's sandbox, nothing loaded from
// elsewhere, framed only by the app), the download's permissions, the size
// limit, other files refused, the character set, the published variant
// and the document block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-html-preview-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { readableFile } = await import("../lib/file-access");
const { HTML_PREVIEW_CSP, htmlCharset, htmlPreviewResponse } = await import("../lib/html-preview");
const { HTML_PREVIEW_LIMIT, htmlPreviewUrl, isHtmlName } = await import("../lib/html-files");
const { htmlPreviewLimit } = await import("../lib/html-preview");
const { HttpError } = await import("../lib/auth");
const { contentSecurityPolicy } = await import("../proxy");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Owner"),
  viewer = await user("Viewer"),
  stranger = await user("Stranger");
const wid = await createWorkspace(owner.id, "HTML");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const doc = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Seiten", kind: "document" })) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
async function file(name: string, content: string | Buffer, mime = "application/octet-stream") {
  const fid = id();
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  writeFileSync(join(uploads, fid), bytes);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, doc, name, mime, bytes.length, owner.id);
  return fid;
}
const PAGE = `<!doctype html><html><head><title>Bericht</title><script>document.title = "gehackt"</script></head><body><h1>Hallo</h1><img src="https://example.com/x.png"></body></html>`;
const get = (method = "GET") => new Request("http://localhost/api/files/x/html", { method });
const preview = async (as: Identity, fid: string, method = "GET") => await htmlPreviewResponse(get(method), await readableFile(as, fid));
const refused = async (promise: Promise<unknown>, status: number) =>
  await assert.rejects(promise, (e: unknown) => e instanceof HttpError && e.status === status);

test("names: .html and .htm in any case, nothing else; the preview's address", () => {
  for (const name of ["a.html", "B.HTM", " bericht.Html "]) assert.equal(isHtmlName(name), true, name);
  for (const name of ["a.xhtml", "a.html.zip", "html", "a.svg", "a.htmlx", ""]) assert.equal(isHtmlName(name), false, name);
  assert.equal(htmlPreviewUrl("/api/files/abc"), "/api/files/abc/html");
  assert.equal(htmlPreviewUrl("/api/share/t/files/abc"), "/api/share/t/files/abc/html");
  assert.equal(HTML_PREVIEW_LIMIT, 5 * 1024 * 1024);
  assert.equal(htmlPreviewLimit(undefined), HTML_PREVIEW_LIMIT);
  assert.equal(htmlPreviewLimit(""), HTML_PREVIEW_LIMIT);
  assert.equal(htmlPreviewLimit("abc"), HTML_PREVIEW_LIMIT);
  assert.equal(htmlPreviewLimit("-3"), HTML_PREVIEW_LIMIT);
  assert.equal(htmlPreviewLimit("20"), 20 * 1024 * 1024);
  assert.equal(htmlPreviewLimit("0.5"), 512 * 1024);
  assert.equal(htmlPreviewLimit("5000"), 100 * 1024 * 1024);
});

test("the file's bytes as text/html with a policy that sandboxes it and loads nothing", async () => {
  const fid = await file("bericht.html", PAGE);
  const response = await preview(owner, fid);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PAGE);
  const h = response.headers;
  assert.equal(h.get("content-type"), "text/html; charset=utf-8");
  assert.equal(h.get("content-security-policy"), HTML_PREVIEW_CSP);
  const policy = new Map(HTML_PREVIEW_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(" ")]));
  assert.equal(policy.get("default-src"), "'none'");
  assert.equal(policy.get("img-src"), "data:");
  assert.equal(policy.get("style-src"), "'unsafe-inline'");
  assert.equal(policy.get("font-src"), "data:");
  assert.equal(policy.get("frame-ancestors"), "'self'");
  // The directive itself: opened directly, the page is sandboxed too.
  assert.equal(policy.get("sandbox"), "");
  assert.ok(!policy.has("script-src") && !policy.has("connect-src"));
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(h.get("referrer-policy"), "no-referrer");
  assert.equal(h.get("cache-control"), "private, no-store");
  assert.equal(h.get("set-cookie"), null);
  assert.match(h.get("content-disposition") || "", /^inline; filename\*=UTF-8''bericht\.html$/);
  assert.equal(h.get("content-length"), String(Buffer.byteLength(PAGE)));
  // HEAD (the viewer asks first): the same headers, no body.
  const head = await preview(owner, fid, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-security-policy"), HTML_PREVIEW_CSP);
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(PAGE)));
  assert.equal(head.body, null);
});

test("the download's permissions: members may, others not", async () => {
  const fid = await file("intern.htm", PAGE);
  assert.equal((await preview(viewer, fid)).status, 200);
  await refused(preview(stranger, fid), 403);
  await refused(preview(owner, id()), 404);
  // The same check the download uses (GET /api/files/<id>).
  await refused(readableFile(stranger, fid), 403);
});

test("only HTML files, up to 5 MB", async () => {
  await refused(preview(owner, await file("bild.png", "\x89PNG", "image/png")), 415);
  await refused(preview(owner, await file("notiz.txt", "<b>hallo</b>")), 415);
  // Named .html but stored as something shown in the browser: refused.
  await refused(preview(owner, await file("falsch.html", "%PDF-1.4", "application/pdf")), 415);
  const big = await file("gross.html", Buffer.alloc(HTML_PREVIEW_LIMIT + 1, 0x20));
  await refused(preview(owner, big), 413);
  await refused(preview(owner, big, "HEAD"), 413);
  const edge = await file("genau.html", Buffer.alloc(HTML_PREVIEW_LIMIT, 0x20));
  assert.equal((await preview(owner, edge, "HEAD")).status, 200);
});

test("character set: byte order mark, <meta charset>, http-equiv, else UTF-8", async () => {
  const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
  assert.equal(htmlCharset(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c])), "utf-8");
  assert.equal(htmlCharset(new Uint8Array([0xff, 0xfe, 0x3c, 0])), "utf-16le");
  assert.equal(htmlCharset(new Uint8Array([0xfe, 0xff, 0, 0x3c])), "utf-16be");
  assert.equal(htmlCharset(bytes(`<html><head><meta charset="ISO-8859-1"></head>`)), "windows-1252");
  assert.equal(htmlCharset(bytes(`<meta charset=shift_jis>`)), "shift_jis");
  assert.equal(htmlCharset(bytes(`<meta http-equiv="Content-Type" content="text/html; charset=windows-1250">`)), "windows-1250");
  assert.equal(htmlCharset(bytes(`<META CHARSET='utf-8'>`)), "utf-8");
  // Unknown names, UTF-16 claimed from inside and nothing at all: UTF-8.
  assert.equal(htmlCharset(bytes(`<meta charset="klingon">`)), "utf-8");
  assert.equal(htmlCharset(bytes(`<meta charset="utf-16">`)), "utf-8");
  assert.equal(htmlCharset(bytes(`<p>nur Text</p>`)), "utf-8");
  // Only the first 1024 bytes count.
  assert.equal(htmlCharset(bytes(`${" ".repeat(1100)}<meta charset="iso-8859-2">`)), "utf-8");
  const latin = await file("alt.html", Buffer.from(`<meta charset="iso-8859-1"><p>Grüße</p>`, "latin1"));
  const response = await preview(owner, latin);
  assert.equal(response.headers.get("content-type"), "text/html; charset=windows-1252");
  // The bytes are sent unchanged.
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(`<meta charset="iso-8859-1"><p>Grüße</p>`, "latin1"));
});

test("published pages: the preview has the checks of the published file", async () => {
  const { GET } = await import("../app/api/share/[token]/files/[fileId]/html/handler");
  const fid = await file("veroeffentlicht.html", PAGE);
  const unused = await file("anderes.html", PAGE);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<div data-html-file="true" data-title="veroeffentlicht.html" class="html-block"><a href="/api/files/${fid}">veroeffentlicht.html</a></div>`, doc);
  const { token } = (await command(owner, { action: "share.create", pageId: doc, name: "Öffentlich", role: "viewer" })) as { token: string };
  const call = async (fileId: string) =>
    await GET(new Request(`http://localhost/api/share/${token}/files/${fileId}/html`), { params: Promise.resolve({ token, fileId }) });
  const shown = await call(fid);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-security-policy"), HTML_PREVIEW_CSP);
  assert.equal(await shown.text(), PAGE);
  // A file of the page the publication does not show is not served.
  assert.equal((await call(unused)).status, 404);
});

test("the document block survives cleaning and saving; only Flowplan files", async () => {
  const { cleanHtml, htmlState, stateHtml } = await import("../lib/document-server");
  const fid = "0f5c6a1e-2b3c-4d5e-8f90-123456789abc";
  const block = `<div data-html-file="true" data-title="bericht.html" class="html-block"><a href="/api/files/${fid}">bericht.html</a></div>`;
  const clean = cleanHtml(`<p>Vorher</p>${block}<p>Nachher</p>`);
  assert.match(clean, /data-html-file="true"/);
  const saved = new Y.Doc();
  Y.applyUpdate(saved, htmlState(clean));
  assert.match(stateHtml(saved), new RegExp(`<div data-html-file="true" data-title="bericht.html" class="html-block"><a href="/api/files/${fid}"[^>]*>bericht.html</a></div>`));
  const foreign = new Y.Doc();
  Y.applyUpdate(foreign, htmlState(`<div data-html-file="true" data-title="x.html"><a href="https://example.com/x.html">x.html</a></div>`));
  assert.doesNotMatch(stateHtml(foreign), /data-html-file/);
});

test("the app may frame the preview: its own policy allows frames from itself", () => {
  const policy = contentSecurityPolicy("nonce", false);
  assert.match(policy, /frame-src 'self'/);
  assert.match(policy, /frame-ancestors 'self'/);
});
