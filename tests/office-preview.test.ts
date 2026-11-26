// The Office preview (#562): the content of uploaded presentations (.pptx,
// .odp) and text documents (.docx, .odt) as text – slide order from
// presentation.xml and content.xml, titles, bullets with levels, tables,
// pictures, speaker notes; headings, numbered and bulleted lists, tables
// and pictures of documents – capped, .ppt and .doc refused (415), the
// size limit (413), the download's permissions, pictures only when a slide
// or the document shows them (type sniffed), the published variant and the
// document block. The files are built here from minimal XML
// (tests/helpers/office-fixtures.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
import { docx, odp, odt, pptx, zip } from "./helpers/office-fixtures";
import { diagramPng } from "./helpers/png";

const dir = mkdtempSync(join(tmpdir(), "flowplan-office-preview-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { readableFile } = await import("../lib/file-access");
const { readOffice, officePreviewLimit, officePreviewResponse, officeImageResponse, shownImages } = await import("../lib/office-preview");
const files = await import("../lib/office-files");
const { HttpError } = await import("../lib/auth");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const owner = await user("Owner"),
  viewer = await user("Viewer"),
  stranger = await user("Stranger");
const wid = await createWorkspace(owner.id, "Folien");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = (await bootstrap(owner, wid)).spaces[0].id;
const doc = ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: team, title: "Folien", kind: "document" })) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
async function file(name: string, content: string | Buffer, mime = "application/octet-stream") {
  const fid = id();
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  writeFileSync(join(uploads, fid), bytes);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, doc, name, mime, bytes.length, owner.id);
  return fid;
}
const refused = async (promise: Promise<unknown>, status: number) =>
  await assert.rejects(promise, (e: unknown) => e instanceof HttpError && e.status === status);
const PNG = diagramPng(48, 32);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);

const deck = () =>
  pptx(
    [
      { title: "Einleitung", body: ["Warum", { text: "Weil es geht", level: 1 }, { text: "Ganz tief", level: 2 }, { text: "Ohne Punkt", bullet: "none" }], notes: ["Begrüßen", "Zeit: 5 Minuten"] },
      { title: "Zahlen", box: ["Freier Text", { text: "Erstens", bullet: "num" }, { text: "Zweitens", bullet: "num" }], table: [["Jahr", "Umsatz"], ["2025", "12"]], pictures: ["chart.png", "logo.jpeg", "vektor.emf"] },
      { title: "Geheim", body: ["Versteckt"], hidden: true },
      { title: "Schluss\nDanke", body: ["Zeile eins\nZeile zwei"] },
    ],
    // The second slide's part comes first, the hidden one stays out.
    { order: [1, 0, 2, 3], media: { "ppt/media/chart.png": PNG, "ppt/media/logo.jpeg": JPEG, "ppt/media/vektor.emf": Buffer.from("EMF"), "ppt/media/background.png": PNG, "ppt/media/unused.png": PNG } },
  );

test("names, the preview's addresses, the size limit, list numbers", () => {
  assert.equal(files.officeKindOf("Vortrag.PPTX"), "pptx");
  assert.equal(files.officeKindOf(" brief.docx "), "docx");
  for (const [name, kind] of [["a.odp", "odp"], ["a.odt", "odt"], ["a.ppt", "ppt"], ["a.doc", "doc"]] as const) assert.equal(files.officeKindOf(name), kind);
  for (const name of ["a.pptm", "a.docm", "a.potx", "a.docx.zip", "docx", "a.pdf", ""]) assert.equal(files.officeKindOf(name), null, name);
  assert.equal(files.isPreviewableOffice("a.ppt"), false);
  assert.equal(files.isPreviewableOffice("a.doc"), false);
  assert.equal(files.isPreviewableOffice("a.odt"), true);
  assert.equal(files.isPresentationKind("odp"), true);
  assert.equal(files.isPresentationKind("docx"), false);
  assert.equal(files.officePreviewUrl("/api/files/abc"), "/api/files/abc/office");
  assert.equal(files.officeImageUrl("/api/share/t/files/abc", "ppt/media/a b.png"), "/api/share/t/files/abc/office/image?name=ppt%2Fmedia%2Fa%20b.png");
  assert.equal(files.OFFICE_PREVIEW_LIMIT, 20 * 1024 * 1024);
  assert.equal(officePreviewLimit(undefined), files.OFFICE_PREVIEW_LIMIT);
  assert.equal(officePreviewLimit("x"), files.OFFICE_PREVIEW_LIMIT);
  assert.equal(officePreviewLimit("0"), files.OFFICE_PREVIEW_LIMIT);
  assert.equal(officePreviewLimit("3"), 3 * 1024 * 1024);
  assert.equal(officePreviewLimit("500"), 100 * 1024 * 1024);
  const p = (text: string, level: number, list?: "bullet" | "number") => ({ type: "paragraph" as const, text, level, ...(list ? { list } : {}) });
  assert.deepEqual(
    files.listNumbers([p("a", 0, "number"), p("b", 1, "number"), p("c", 1, "number"), p("d", 0, "number"), p("e", 1, "number"), p("x", 0), p("f", 0, "number"), p("g", 0, "bullet"), p("h", 0, "number")]),
    [1, 1, 2, 2, 1, null, 1, null, 1],
  );
});

test("PPTX: slide order from presentation.xml, titles, bullets with levels, tables, pictures, notes; hidden slides and layout left out", async () => {
  const preview = await readOffice(await deck(), "vortrag.pptx");
  assert.equal(preview.kind, "pptx");
  assert.equal(preview.truncated, false);
  assert.equal(preview.blocks, undefined);
  const slides = preview.slides!;
  assert.deepEqual(
    slides.map((s) => s.title),
    ["Zahlen", "Einleitung", "Schluss\nDanke"],
  );
  const [numbers, intro, end] = slides;
  // A body placeholder is bulleted; levels kept; an explicit "no bullet" honoured.
  assert.deepEqual(intro.blocks, [
    { type: "paragraph", text: "Warum", level: 0, list: "bullet" },
    { type: "paragraph", text: "Weil es geht", level: 1, list: "bullet" },
    { type: "paragraph", text: "Ganz tief", level: 2, list: "bullet" },
    { type: "paragraph", text: "Ohne Punkt", level: 0 },
  ]);
  assert.deepEqual(intro.notes, ["Begrüßen", "Zeit: 5 Minuten"]);
  // A text box only where a paragraph asks for a marker; the slide number
  // placeholder is no content; the background picture and the EMF are no
  // pictures of the slide.
  assert.deepEqual(numbers.blocks, [
    { type: "paragraph", text: "Freier Text", level: 0 },
    { type: "paragraph", text: "Erstens", level: 0, list: "number" },
    { type: "paragraph", text: "Zweitens", level: 0, list: "number" },
    { type: "table", rows: [["Jahr", "Umsatz"], ["2025", "12"]] },
    { type: "image", image: "ppt/media/chart.png" },
    { type: "image", image: "ppt/media/logo.jpeg" },
  ]);
  assert.deepEqual(numbers.notes, []);
  assert.deepEqual(end.blocks, [{ type: "paragraph", text: "Zeile eins\nZeile zwei", level: 0, list: "bullet" }]);
  assert.deepEqual([...shownImages(preview)].sort(), ["ppt/media/chart.png", "ppt/media/logo.jpeg"]);
  // All slides hidden: all are shown.
  const hidden = await readOffice(await pptx([{ title: "A", hidden: true }, { title: "B", hidden: true }]), "a.pptx");
  assert.deepEqual(hidden.slides!.map((s) => s.title), ["A", "B"]);
});

test("ODP: slide order from content.xml, titles, outline bullets with levels, text, tables, pictures, notes", async () => {
  const preview = await readOffice(
    await odp(
      [
        { title: "Start", outline: ["Punkt", ["Unterpunkt", ["Tiefer"]], "Noch einer"], notes: ["Erst lächeln"], pictures: ["foto.png"] },
        { title: "Tabelle", text: ["Einfach Text"], table: [["A", "B"], ["1", "2"]] },
        { title: "Leer" },
      ],
      { media: { "foto.png": PNG, "foto.png.svg": SVG } },
    ),
    "folien.odp",
  );
  assert.equal(preview.kind, "odp");
  const slides = preview.slides!;
  assert.deepEqual(slides.map((s) => s.title), ["Start", "Tabelle", "Leer"]);
  assert.deepEqual(slides[0].blocks, [
    { type: "paragraph", text: "Punkt", level: 0, list: "bullet" },
    { type: "paragraph", text: "Unterpunkt", level: 1, list: "bullet" },
    { type: "paragraph", text: "Tiefer", level: 2, list: "bullet" },
    { type: "paragraph", text: "Noch einer", level: 0, list: "bullet" },
    // Of the two formats of the picture the one a browser shows safely.
    { type: "image", image: "Pictures/foto.png" },
  ]);
  assert.deepEqual(slides[0].notes, ["Erst lächeln"]);
  assert.deepEqual(slides[1].blocks, [
    { type: "paragraph", text: "Einfach Text", level: 0 },
    { type: "table", rows: [["A", "B"], ["1", "2"]] },
  ]);
  // The page number frame is layout.
  assert.deepEqual(slides[2].blocks, []);
});

test("DOCX: headings by style name, bullets and numbers with levels, tables, pictures; deleted text, field codes and fallbacks left out", async () => {
  const preview = await readOffice(
    await docx(
      [
        { heading: 1, text: "Bericht" },
        { text: "Ein Absatz  mit\nZeilenumbruch" },
        { bullet: "Apfel" },
        { bullet: "Boskop", level: 1 },
        { number: "Erstens" },
        { number: "Unterpunkt", level: 1 },
        { number: "Zweitens" },
        { heading: 2, text: "Tabelle" },
        { table: [["Name", "Wert"], ["A", "1"], ["", ""]] },
        { picture: "bild.png" },
        { text: "Titelzeile", style: "Titel" },
        {
          raw: `<w:p><w:r><w:t>Sicht</w:t></w:r><w:del><w:r><w:delText>gelöscht</w:delText></w:r></w:del><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>bar</w:t></w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>!</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>doppelt</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>`,
        },
        { raw: `<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Gliederung</w:t></w:r></w:p>` },
      ],
      { media: { "bild.png": PNG, "unused.png": PNG } },
    ),
    "bericht.docx",
  );
  assert.equal(preview.kind, "docx");
  assert.equal(preview.slides, undefined);
  assert.deepEqual(preview.blocks, [
    { type: "heading", level: 1, text: "Bericht" },
    { type: "paragraph", text: "Ein Absatz mit\nZeilenumbruch", level: 0 },
    { type: "paragraph", text: "Apfel", level: 0, list: "bullet" },
    { type: "paragraph", text: "Boskop", level: 1, list: "bullet" },
    { type: "paragraph", text: "Erstens", level: 0, list: "number" },
    { type: "paragraph", text: "Unterpunkt", level: 1, list: "number" },
    { type: "paragraph", text: "Zweitens", level: 0, list: "number" },
    { type: "heading", level: 2, text: "Tabelle" },
    { type: "table", rows: [["Name", "Wert"], ["A", "1"]] },
    { type: "image", image: "word/media/bild.png" },
    { type: "heading", level: 1, text: "Titelzeile" },
    { type: "paragraph", text: "Sichtbar!", level: 0 },
    { type: "heading", level: 3, text: "Gliederung" },
  ]);
  // The picture the relationships name but no paragraph shows is not listed.
  assert.deepEqual([...shownImages(preview)], ["word/media/bild.png"]);
});

test("ODT: headings, bullets and numbers by list style with levels, tables, pictures; comments and notes left out", async () => {
  const preview = await readOffice(
    await odt(
      [
        { heading: 1, text: "Protokoll" },
        { text: "Mit   Leerraum" },
        { bullets: ["Milch", ["Hafer"]] },
        { numbers: ["Eins", "Zwei", ["Zwei a"]] },
        { table: [["Wer", "Was"], ["Ich", "Alles"]] },
        { picture: "skizze.png" },
        { raw: `<text:p>Text<office:annotation><text:p>Kommentar</text:p></office:annotation> mit<text:note><text:note-body><text:p>Fußnote</text:p></text:note-body></text:note><text:s text:c="2"/>Rest</text:p>` },
      ],
      { media: { "skizze.png": PNG } },
    ),
    "protokoll.odt",
  );
  assert.deepEqual(preview.blocks, [
    { type: "heading", level: 1, text: "Protokoll" },
    { type: "paragraph", text: "Mit Leerraum", level: 0 },
    { type: "paragraph", text: "Milch", level: 0, list: "bullet" },
    { type: "paragraph", text: "Hafer", level: 1, list: "bullet" },
    { type: "paragraph", text: "Eins", level: 0, list: "number" },
    { type: "paragraph", text: "Zwei", level: 0, list: "number" },
    { type: "paragraph", text: "Zwei a", level: 1, list: "number" },
    { type: "table", rows: [["Wer", "Was"], ["Ich", "Alles"]] },
    { type: "image", image: "Pictures/skizze.png" },
    { type: "paragraph", text: "Text mit Rest", level: 0 },
  ]);
});

test("caps: slides, blocks, characters and table size, then truncated; crafted XML stays fast", async () => {
  const limits = { ...files.OFFICE_LIMITS, slides: 3, blocks: 5, chars: 40, rows: 2, columns: 2 };
  const many = await readOffice(await pptx(Array.from({ length: 6 }, (_, i) => ({ title: `S${i + 1}` }))), "a.pptx", limits);
  assert.equal(many.slides!.length, 3);
  assert.equal(many.truncated, true);
  const long = await readOffice(await docx(Array.from({ length: 20 }, (_, i) => ({ text: `Absatz ${i + 1}` }))), "a.docx", limits);
  assert.equal(long.blocks!.length, 5);
  assert.equal(long.truncated, true);
  const big = await readOffice(await docx([{ table: [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]] }]), "a.docx", limits);
  assert.deepEqual(big.blocks, [{ type: "table", rows: [["a", "b"], ["d", "e"]] }]);
  assert.equal(big.truncated, true);
  const ok = await readOffice(await odt([{ text: "kurz" }]), "a.odt", limits);
  assert.equal(ok.truncated, false);
  // Unclosed tags and attributes without end: linear, no hang (#470).
  const crafted = "<w:p " + "a='x' ".repeat(200_000) + "<w:t>" + "<w:r".repeat(100_000);
  const started = Date.now();
  await readOffice(await docx([{ raw: crafted }]), "a.docx");
  assert.ok(Date.now() - started < 5000, "crafted XML took too long");
  // Nesting deeper than any document: unreadable, not a stack overflow.
  await refused(readOffice(await docx([{ raw: "<w:sdt>".repeat(2000) }]), "a.docx"), 422);
});

test("broken and foreign files: 422; old formats and other files: 415", async () => {
  await refused(readOffice(Buffer.from("kein zip"), "a.pptx"), 422);
  await refused(readOffice(await zip({ "hallo.txt": "x" }), "a.docx"), 422);
  await refused(readOffice(await zip({ "hallo.txt": "x" }), "a.odt"), 422);
  await assert.rejects(readOffice(Buffer.alloc(0), "alt.ppt"), (e: unknown) => e instanceof HttpError && e.status === 415 && /97–2003/.test(e.message));
  await assert.rejects(readOffice(Buffer.alloc(0), "alt.doc"), (e: unknown) => e instanceof HttpError && e.status === 415 && /97–2003/.test(e.message));
  await refused(readOffice(Buffer.alloc(0), "a.txt"), 415);
});

test("the routes: the download's permissions, old formats refused, the size limit; pictures only when shown, type sniffed", async () => {
  const get = (path: string, q = "") => new Request(`http://localhost/api/files/x/${path}${q}`);
  const preview = async (as: Identity, fid: string) => await officePreviewResponse(get("office"), await readableFile(as, fid));
  const image = async (as: Identity, fid: string, name: string) => await officeImageResponse(get("office/image", `?name=${encodeURIComponent(name)}`), await readableFile(as, fid));
  const pres = await file("vortrag.pptx", await deck(), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const response = await preview(viewer, pres);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual((await response.json()).slides.map((s: { title: string }) => s.title), ["Zahlen", "Einleitung", "Schluss\nDanke"]);
  await refused(preview(stranger, pres), 403);
  await refused(readableFile(stranger, pres), 403);
  await refused(preview(owner, id()), 404);
  // A shown picture: its sniffed type, nosniff, sandboxed.
  const shown = await image(viewer, pres, "ppt/media/chart.png");
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
  assert.match(shown.headers.get("content-security-policy") || "", /sandbox/);
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), PNG);
  assert.equal((await image(owner, pres, "ppt/media/logo.jpeg")).headers.get("content-type"), "image/jpeg");
  // Parts of the file no slide shows, other parts, other names: 404.
  for (const name of ["ppt/media/background.png", "ppt/media/unused.png", "ppt/media/vektor.emf", "ppt/presentation.xml", "../ppt/media/chart.png", ""])
    await refused(image(owner, pres, name), 404);
  await refused(image(stranger, pres, "ppt/media/chart.png"), 403);
  // A "picture" whose bytes are no picture (here SVG with a script): 415.
  const tricky = await file("trick.docx", await docx([{ picture: "bild.png" }], { media: { "bild.png": SVG } }));
  await refused(image(owner, tricky, "word/media/bild.png"), 415);
  // Text documents too.
  const text = await file("brief.odt", await odt([{ heading: 1, text: "Brief" }, { picture: "s.png" }], { media: { "s.png": PNG } }));
  assert.deepEqual((await (await preview(viewer, text)).json()).blocks[0], { type: "heading", level: 1, text: "Brief" });
  assert.equal((await image(viewer, text, "Pictures/s.png")).status, 200);
  // Old formats and anything else: 415, unread.
  await refused(preview(owner, await file("alt.ppt", Buffer.from("d0cf11e0a1b11ae1", "hex"), "application/vnd.ms-powerpoint")), 415);
  await refused(preview(owner, await file("alt.doc", Buffer.from("d0cf11e0a1b11ae1", "hex"), "application/msword")), 415);
  await refused(image(owner, await file("alt2.ppt", Buffer.from("d0cf11e0a1b11ae1", "hex")), "ppt/media/a.png"), 415);
  await refused(preview(owner, await file("notiz.txt", "Hallo")), 415);
  await refused(preview(owner, await file("kaputt.docx", "kein zip")), 422);
  const previous = process.env.FLOWPLAN_OFFICE_PREVIEW_MB;
  process.env.FLOWPLAN_OFFICE_PREVIEW_MB = "0.0001";
  try {
    await assert.rejects(preview(owner, pres), (e: unknown) => e instanceof HttpError && e.status === 413 && /MB/.test(e.message));
    await refused(image(owner, pres, "ppt/media/chart.png"), 413);
  } finally {
    if (previous === undefined) delete process.env.FLOWPLAN_OFFICE_PREVIEW_MB;
    else process.env.FLOWPLAN_OFFICE_PREVIEW_MB = previous;
  }
});

test("published pages: the preview and its pictures have the checks of the published file", async () => {
  const { GET } = await import("../app/api/share/[token]/files/[fileId]/office/handler");
  const { GET: IMAGE } = await import("../app/api/share/[token]/files/[fileId]/office/image/handler");
  const fid = await file("veroeffentlicht.pptx", await deck());
  const unused = await file("anderes.pptx", await deck());
  await run("UPDATE documents SET html=? WHERE page_id=?", `<div data-office-file="true" data-title="veroeffentlicht.pptx" class="office-block"><a href="/api/files/${fid}">veroeffentlicht.pptx</a></div>`, doc);
  const { token } = (await command(owner, { action: "share.create", pageId: doc, name: "Öffentlich", role: "viewer" })) as { token: string };
  const call = async (fileId: string) => await GET(new Request(`http://localhost/api/share/${token}/files/${fileId}/office`), { params: Promise.resolve({ token, fileId }) });
  const picture = async (fileId: string, name: string) =>
    await IMAGE(new Request(`http://localhost/api/share/${token}/files/${fileId}/office/image?name=${encodeURIComponent(name)}`), { params: Promise.resolve({ token, fileId }) });
  const shown = await call(fid);
  assert.equal(shown.status, 200);
  assert.equal((await shown.json()).slides.length, 3);
  assert.equal((await call(unused)).status, 404);
  assert.equal((await picture(fid, "ppt/media/chart.png")).status, 200);
  assert.equal((await picture(fid, "ppt/media/background.png")).status, 404);
  assert.equal((await picture(unused, "ppt/media/chart.png")).status, 404);
});

test("the document block survives cleaning and saving; only Flowplan files", async () => {
  const { cleanHtml, htmlState, stateHtml } = await import("../lib/document-server");
  const fid = "0f5c6a1e-2b3c-4d5e-8f90-123456789abc";
  const block = `<div data-office-file="true" data-title="vortrag.pptx" class="office-block"><a href="/api/files/${fid}">vortrag.pptx</a></div>`;
  const clean = cleanHtml(`<p>Vorher</p>${block}<p>Nachher</p>`);
  assert.match(clean, /data-office-file="true"/);
  const saved = new Y.Doc();
  Y.applyUpdate(saved, htmlState(clean));
  assert.match(stateHtml(saved), new RegExp(`<div data-office-file="true" data-title="vortrag.pptx" class="office-block"><a href="/api/files/${fid}"[^>]*>vortrag.pptx</a></div>`));
  const foreign = new Y.Doc();
  Y.applyUpdate(foreign, htmlState(`<div data-office-file="true" data-title="x.docx"><a href="https://example.com/x.docx">x.docx</a></div>`));
  assert.doesNotMatch(stateHtml(foreign), /data-office-file/);
  // A plain link to such a file stays a link.
  const link = new Y.Doc();
  Y.applyUpdate(link, htmlState(`<p><a href="/api/files/${fid}">alt.pptx</a></p>`));
  assert.doesNotMatch(stateHtml(link), /data-office-file/);
});
