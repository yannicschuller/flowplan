// draw.io diagrams (#110): the address of the editor (DRAWIO_URL), its
// messages, the stored picture's cleaning, the frame-src of the app and
// the Markdown export (ZIP: a .drawio.svg draw.io opens again; plain: a
// ```drawio fence the import reads back).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-drawio-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.DRAWIO_URL;
const { drawioConfig, drawioEditorUrl, drawioDark, parseDrawioMessage, svgFromDataUrl, drawioSvgFile, drawioImageUrl, isDrawioXml, DEFAULT_DRAWIO_URL } = await import(
  "../lib/drawio"
);
const { sanitizeDrawioSvg } = await import("../lib/drawio-svg");
const { cleanHtml, htmlState } = await import("../lib/document-server");
const { htmlToMarkdown } = await import("../lib/markdown");
const { markdownToRawHtml } = await import("../lib/markdown-html");
const { contentSecurityPolicy, editorFrameOrigins } = await import("../proxy");
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { exportMarkdown } = await import("../lib/markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");

const XML = '<mxfile host="embed.diagrams.net"><diagram id="a" name="Seite-1">7Vhdb5swFP01PFIBJh95TNJ0m7RJ0zJp3aODb8CqsZExDdmv3zXYCYS2y7Ql1aY+gH3PtcE+5/hiCMiyaN5rWuafFQMRJBFrAnIbJEk8iWbYWGTfIdNw3gGZ5sw1OgBr/hMcGDm05gyqQUOjlDC8HIKpkhJSM8Co1mo3bLZVYvjUkmYwAtYpFWP0G2cm79B5Mjvi4HxufuzeTGXT9tX+aXcLkyn4Dc0V1CNapQa3Y6R6JJn3FT/QXstBh9KL0q</diagram></mxfile>';
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="121px" height="61px" viewBox="-0.5 -0.5 121 61" content="&lt;mxfile&gt;old&lt;/mxfile&gt;"><defs/><g><rect x="0" y="0" width="120" height="60" rx="9" fill="#ffffff" stroke="#000000" pointer-events="all"/><g transform="translate(-0.5 -0.5)"><switch><foreignObject pointer-events="none" width="100%" height="100%" requiredFeatures="http://www.w3.org/TR/SVG11/feature#Extensibility" style="overflow: visible; text-align: left;"><div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: unsafe center; width: 118px;"><div style="font-size: 12px;">Start&nbsp;<b>hier</b></div></div></foreignObject><text x="60" y="34" font-size="12px" text-anchor="middle">Start hier</text></switch></g></g></svg>`;

test("DRAWIO_URL: https anywhere, http only on this machine, the public service by default", () => {
  assert.deepEqual(drawioConfig(""), { url: "https://embed.diagrams.net/", origin: "https://embed.diagrams.net", external: true });
  assert.equal(drawioConfig(undefined)?.url, `${DEFAULT_DRAWIO_URL}/`);
  assert.deepEqual(drawioConfig("https://drawio.example.com/"), { url: "https://drawio.example.com/", origin: "https://drawio.example.com", external: false });
  assert.deepEqual(drawioConfig("https://tools.example.com/drawio"), { url: "https://tools.example.com/drawio/", origin: "https://tools.example.com", external: false });
  assert.equal(drawioConfig("http://localhost:8080")?.origin, "http://localhost:8080");
  assert.equal(drawioConfig("http://127.0.0.1:8080/")?.origin, "http://127.0.0.1:8080");
  assert.equal(drawioConfig("https://app.diagrams.net")?.external, true);
  // Not usable: draw.io is switched off rather than falling back to the public service.
  for (const bad of ["http://drawio.lan", "http://localhost.example.com", "javascript:alert(1)", "ftp://x.example", "https://user:pw@x.example", "https://x.example/?a=1", "https://x.example/#a", "not a url", "//x.example"])
    assert.equal(drawioConfig(bad), null, bad);
});

test("the editor address: embed mode with JSON messages, interface, theme and language", () => {
  const config = drawioConfig("https://drawio.example.com")!;
  const url = new URL(drawioEditorUrl(config, { ui: "sketch", dark: true, lang: "de" }));
  assert.equal(url.origin + url.pathname, "https://drawio.example.com/");
  for (const [key, value] of Object.entries({ embed: "1", proto: "json", spin: "1", ui: "sketch", dark: "1", lang: "de", saveAndExit: "1", noSaveBtn: "1" }))
    assert.equal(url.searchParams.get(key), value, key);
  const plain = new URL(drawioEditorUrl(config, { ui: "<script>", lang: "x\"y" }));
  assert.equal(plain.searchParams.get("ui"), "kennedy");
  assert.equal(plain.searchParams.get("dark"), "0");
  assert.equal(plain.searchParams.has("lang"), false);
  assert.equal(new URL(drawioEditorUrl(config, { ui: "min" })).searchParams.get("ui"), "min");
  // Automatic follows Flowplan's theme.
  assert.equal(drawioDark("auto", true), true);
  assert.equal(drawioDark("auto", false), false);
  assert.equal(drawioDark("light", true), false);
  assert.equal(drawioDark("dark", false), true);
});

test("messages from draw.io are read strictly", () => {
  assert.deepEqual(parseDrawioMessage('{"event":"init"}'), { event: "init" });
  assert.deepEqual(parseDrawioMessage(JSON.stringify({ event: "save", xml: XML, exit: true })), { event: "save", xml: XML, exit: true });
  assert.deepEqual(parseDrawioMessage(JSON.stringify({ event: "save", xml: 5 })), { event: "save", xml: "", exit: false });
  assert.deepEqual(parseDrawioMessage(JSON.stringify({ event: "export", data: "data:x", xml: XML })), { event: "export", data: "data:x", xml: XML });
  assert.deepEqual(parseDrawioMessage('{"event":"exit","modified":true}'), { event: "exit", modified: true });
  for (const other of [{ event: "init" }, '{"event":"open"}', "not json", "null", '"init"', null])
    assert.equal(parseDrawioMessage(other), null, String(other));
  // The export's picture, base64 (UTF-8) or URL-encoded.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Grüße</text></svg>';
  assert.equal(svgFromDataUrl(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`), svg);
  assert.equal(svgFromDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`), svg);
  assert.equal(svgFromDataUrl("data:image/png;base64,AAAA"), "");
  assert.equal(svgFromDataUrl("data:image/svg+xml;base64,%%%"), "");
  assert.ok(drawioImageUrl(svg).startsWith("data:image/svg+xml;charset=utf-8,%3Csvg"));
  assert.ok(isDrawioXml(XML) && isDrawioXml("<mxGraphModel><root/></mxGraphModel>") && !isDrawioXml("<svg/>"));
});

test("the stored picture keeps the drawing and labels, nothing that runs or loads", () => {
  const clean = sanitizeDrawioSvg(SVG);
  assert.match(clean, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(clean, /viewBox="-0.5 -0.5 121 61"/);
  assert.match(clean, /<foreignObject[^>]*requiredFeatures=/);
  assert.match(clean, /Start <b>hier<\/b>/);
  assert.match(clean, /<text x="60" y="34"/);
  // Without the diagram copy (stored next to it) and the prolog.
  assert.doesNotMatch(clean, /content=|<\?xml|DOCTYPE/);

  const attack = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
    <script>alert(2)</script><script><![CDATA[alert(3)]]></script>
    <style>@import url(https://evil.example/a.css);</style>
    <defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs>
    <rect fill="url(#g)" stroke="url(https://evil.example/s)" onclick="alert(4)" style="fill: url(https://evil.example/f); stroke: red"/>
    <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onmouseover="alert(5)" style="background-image: url('https://evil.example/b.png')">
      <img src="https://evil.example/t.png"/><img src="data:image/png;base64,AAAA" onerror="alert(6)"/>
      <iframe src="https://evil.example"></iframe><object data="https://evil.example/o"></object><embed src="https://evil.example/e"/>
      <a href="javascript:alert(7)">x</a><form action="https://evil.example"><input name="q"/></form></div></foreignObject>
    <a xlink:href="javascript:alert(8)"><text>a</text></a><a href="https://example.com/info"><text>b</text></a>
    <image xlink:href="https://evil.example/i.png"/><image href="data:image/svg+xml;base64,PHN2Zy8+"/>
    <use href="#g"/><use xlink:href="https://evil.example/sprite.svg#x"/>
    <animate attributeName="href" to="javascript:alert(9)"/><set attributeName="onclick" to="alert(10)"/>
    <feImage href="https://evil.example/f.png"/><handler>void 0</handler>
  </svg>`;
  const safe = sanitizeDrawioSvg(attack);
  assert.match(safe, /^<svg/);
  for (const bad of [/alert/, /evil\.example/, /<script/i, /<style/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /<input/i, /<animate/i, /<set/i, /<feImage/i, /<handler/i, /\son\w+=/i, /javascript:/i, /@import/])
    assert.doesNotMatch(safe, bad, String(bad));
  // What stays: references within the picture, data: images, links on shapes.
  assert.match(safe, /fill="url\(#g\)"/);
  assert.match(safe, /<use href="#g">/);
  assert.match(safe, /<img src="data:image\/png;base64,AAAA" \/>/);
  assert.match(safe, /<image href="data:image\/svg\+xml;base64,PHN2Zy8\+">/);
  assert.match(safe, /<a href="https:\/\/example.com\/info">/);
  assert.match(safe, /stroke:red/);

  // Not a picture, or too large: nothing.
  assert.equal(sanitizeDrawioSvg("<div>no svg</div>"), "");
  assert.equal(sanitizeDrawioSvg(""), "");
  assert.equal(sanitizeDrawioSvg(`<svg xmlns="http://www.w3.org/2000/svg"><text>${"x".repeat(2_000_000)}</text></svg>`), "");
});

test("stored HTML: the block keeps its diagram, its picture is cleaned", () => {
  const attr = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="5" height="5"/></svg>';
  const html = cleanHtml(`<div data-drawio="${attr(XML)}" data-drawio-svg="${attr(evil)}" class="drawio-block">draw.io</div><p data-drawio-svg="${attr(evil)}">x</p>`);
  assert.doesNotMatch(html, /alert/);
  assert.match(html, /data-drawio="&lt;mxfile/);
  assert.match(html, /data-drawio-svg="&lt;svg xmlns=&quot;http:\/\/www.w3.org\/2000\/svg&quot;&gt;&lt;rect width=&quot;5&quot; height=&quot;5&quot;&gt;&lt;\/rect&gt;&lt;\/svg&gt;"/);
  // Only a <div> is a draw.io block.
  assert.match(html, /<p>x<\/p>/);
  // Through the document (Yjs) and back.
  assert.ok(htmlState(html).length > 0);
  // Too large a diagram is dropped, the block stays.
  const large = cleanHtml(`<div data-drawio="${"x".repeat(900_000)}" data-drawio-svg="">draw.io</div>`);
  assert.match(large, /^<div data-drawio[\s>=]/);
  assert.doesNotMatch(large, /xxx/);
});

test("Markdown: a ```drawio fence outside ZIP exports, read back by the import", () => {
  const attr = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = `<p>Vorher</p><div data-drawio="${attr(XML)}" data-drawio-svg="${attr(sanitizeDrawioSvg(SVG))}"></div>`;
  const markdown = htmlToMarkdown(html, { url: () => null, linked: () => null }).trimEnd();
  assert.equal(markdown, `Vorher\n\n\`\`\`drawio\n${XML}\n\`\`\``);
  const back = markdownToRawHtml(markdown);
  assert.match(back, /<div class="drawio-block" data-drawio="&lt;mxfile host=&quot;embed.diagrams.net&quot;&gt;/);
  // Other fences labelled drawio that are no diagram stay code.
  assert.match(markdownToRawHtml("```drawio\nhello\n```"), /<pre/);
  // A picture from the context (ZIP) instead.
  assert.equal(htmlToMarkdown(html, { url: () => null, linked: () => null, drawio: () => "assets/a.drawio.svg" }).trimEnd(), "Vorher\n\n![draw.io-Diagramm](<assets/a.drawio.svg>)");
});

test("a .drawio.svg: the picture with the diagram inside", () => {
  const file = drawioSvgFile(sanitizeDrawioSvg(SVG), XML);
  assert.match(file, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg content="&lt;mxfile host=&quot;embed.diagrams.net&quot;&gt;&lt;diagram/);
  assert.equal((file.match(/content=/g) || []).length, 1);
  assert.equal(drawioSvgFile("no svg", XML), "");
});

test("ZIP export: each diagram as a .drawio.svg next to the page", async () => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Zeichnerin", "zeichnerin@example.test");
  const owner: Identity = { id: uid, name: "Zeichnerin", email: "zeichnerin@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false };
  const wid = createWorkspace(owner.id, "Diagramme");
  const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!;
  const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Ablauf", kind: "document" }) as { id: string }).id;
  const attr = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = `<p>Plan</p><div data-drawio="${attr(XML)}" data-drawio-svg="${attr(SVG)}"></div>`;
  run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  const zip = await readExportZip((await exportMarkdown(owner, { pageId, format: "zip", includeSubpages: false })).bytes);
  const index = zip.get("index.md")!.toString();
  const asset = [...zip.keys()].find((key) => key.endsWith(".drawio.svg"))!;
  assert.match(asset, /^assets\/Ablauf-[0-9a-f-]{36}-[0-9a-f]{12}\.drawio\.svg$/);
  assert.match(index, new RegExp(`!\\[draw.io-Diagramm\\]\\(<${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>\\)`));
  const file = zip.get(asset)!.toString();
  assert.match(file, /<svg content="&lt;mxfile/);
  assert.match(file, /Start <b>hier<\/b>/);
  // The single Markdown file keeps the diagram as a fence.
  const single = (await exportMarkdown(owner, { pageId, format: "markdown", includeSubpages: false })).bytes.toString();
  assert.match(single, /```drawio\n<mxfile/);
});

test("frame-src: the draw.io origin only for the app itself", () => {
  const original = process.env.DRAWIO_URL;
  try {
    delete process.env.DRAWIO_URL;
    assert.deepEqual(editorFrameOrigins("/"), ["https://embed.diagrams.net"]);
    assert.deepEqual(editorFrameOrigins("/share/abc"), []);
    assert.deepEqual(editorFrameOrigins("/login"), []);
    process.env.DRAWIO_URL = "https://drawio.example.com/app";
    assert.deepEqual(editorFrameOrigins("/"), ["https://drawio.example.com"]);
    process.env.DRAWIO_URL = "http://drawio.lan";
    assert.deepEqual(editorFrameOrigins("/"), []);
  } finally {
    if (original === undefined) delete process.env.DRAWIO_URL;
    else process.env.DRAWIO_URL = original;
  }
  const policy = contentSecurityPolicy("n", false, [], true, ["https://drawio.example.com"]);
  assert.match(policy, /frame-src 'self' [^;]*https:\/\/drawio\.example\.com/);
  assert.doesNotMatch(contentSecurityPolicy("n", false, [], true), /drawio|diagrams\.net/);
});
