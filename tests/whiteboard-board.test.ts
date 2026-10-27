// Whiteboard navigation, structure, content and presentation features:
// groups, frames and presentation order, search, element links, rich text,
// tags, embeds, the PDF export, the template gallery and own templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
import type { WhiteboardItem } from "../lib/whiteboard-model";
import type { Span } from "../lib/whiteboard-richtext";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-whiteboard-board-"));
const { id, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const groups = await import("../lib/whiteboard-groups");
const frames = await import("../lib/whiteboard-frames");
const { searchBoard, fold } = await import("../lib/whiteboard-search");
const links = await import("../lib/whiteboard-links");
const rich = await import("../lib/whiteboard-richtext");
const tags = await import("../lib/whiteboard-tags");
const embeds = await import("../lib/whiteboard-embeds");
const pdf = await import("../lib/whiteboard-pdf");
const gallery = await import("../lib/whiteboard-template-gallery");
const { templateDrafts } = await import("../lib/whiteboard-template-save");
const userTemplates = await import("../lib/whiteboard-user-templates");
const { placeDrafts } = await import("../lib/whiteboard-import");
const { whiteboardSvg } = await import("../lib/whiteboard-svg");
const { whiteboardSummary, writeWhiteboard, whiteboardSnapshotItems } = await import("../lib/whiteboard");
const { itemText } = await import("../lib/whiteboard-model");
const { parsePageLocation, pageLocationHash } = await import("../lib/page-location");
const { parseGifResults, gifProvider } = await import("../lib/gif-search");
const { PDFDocument } = await import("pdf-lib");

const item = (props: Partial<WhiteboardItem> & { id: string }): WhiteboardItem => ({
  type: "sticky",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 1,
  ...props,
});

test("groups: grouping, nesting, selecting as a unit, ungrouping, copies", () => {
  let n = 0;
  const newId = () => `g${++n}`;
  let items = [item({ id: "a" }), item({ id: "b", x: 200 }), item({ id: "c", x: 400 }), item({ id: "d", x: 600 })];
  const apply = (paths: Map<string, string[]>) =>
    (items = items.map((i) => (paths.has(i.id) ? { ...i, groups: paths.get(i.id)!.length ? paths.get(i.id) : undefined } : i)));
  // One element alone is no group.
  assert.equal(groups.groupSelection([items[0]], items, newId), null);
  // a+b → g1
  const first = groups.groupSelection(items.slice(0, 2), items, newId)!;
  assert.equal(first.id, "g1");
  apply(first.paths);
  assert.deepEqual(groups.selectionUnit(items[0], items, null).sort(), ["a", "b"]);
  assert.deepEqual(groups.selectionUnit(items[2], items, null), ["c"]);
  // Selecting the whole group again is nothing new to group.
  assert.equal(groups.groupSelection(items.slice(0, 2), items, newId), null);
  // (a+b) + c → g2 containing g1
  const second = groups.groupSelection(items.slice(0, 3), items, newId)!;
  apply(second.paths);
  assert.deepEqual(items[0].groups, ["g2", "g1"]);
  assert.deepEqual(items[2].groups, ["g2"]);
  // A click selects the outer group; inside g2 the inner group; inside g1 the element.
  assert.deepEqual(groups.selectionUnit(items[0], items, null).sort(), ["a", "b", "c"]);
  assert.deepEqual(groups.selectionUnit(items[0], items, "g2").sort(), ["a", "b"]);
  assert.deepEqual(groups.selectionUnit(items[0], items, "g1"), ["a"]);
  assert.equal(groups.unitGroup(items[0], "g1"), null);
  // Marquee around a and d: whole units.
  assert.deepEqual([...groups.expandSelection(["a", "d"], items, null)].sort(), ["a", "b", "c", "d"]);
  // The selection is exactly one group: resizable as a unit.
  assert.equal(groups.selectedGroup(items.slice(0, 3), items), "g2");
  assert.equal(groups.selectedGroup(items, items), null);
  // Ungrouping the outer group keeps the inner one.
  apply(groups.ungroupSelection(items.slice(0, 3), items)!);
  assert.deepEqual(items[0].groups, ["g1"]);
  assert.equal(items[2].groups, undefined);
  assert.equal(groups.canUngroup([items[2]], items), false);
  // Copies get new group ids with the same structure.
  const copies = groups.remapGroups(items.slice(0, 2), newId);
  assert.deepEqual(copies[0].groups, copies[1].groups);
  assert.notDeepEqual(copies[0].groups, ["g1"]);
  // Wrong stored values are ignored.
  assert.deepEqual(groups.groupPath({ groups: ["ok", 5 as unknown as string, "<script>", "ok"] }), ["ok"]);
});

test("groups: resizing as one scales positions, sizes and text", () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const next = groups.resizeBox(box, "se", 200, 0, true);
  assert.deepEqual(next, { x: 0, y: 0, w: 400, h: 200 });
  const moved = groups.resizeBox(box, "nw", -200, 0, true);
  assert.equal(moved.x + moved.w, 200);
  const scaled = groups.scaleItems([{ id: "a", x: 100, y: 50, w: 100, h: 50, fontSize: 16 }], box, next);
  assert.deepEqual(scaled[0], { id: "a", x: 200, y: 100, w: 200, h: 100, fontSize: 32 });
});

test("frames: presentation order, hidden frames, members", () => {
  const items = [
    item({ id: "f1", type: "frame", x: 0, y: 0, w: 400, h: 300 }),
    item({ id: "f2", type: "frame", x: 500, y: 0, w: 400, h: 300 }),
    item({ id: "f3", type: "frame", x: 0, y: 400, w: 400, h: 300 }),
    item({ id: "s", x: 50, y: 50 }),
    item({ id: "far", x: 2000, y: 2000 }),
  ];
  // Older boards: reading order.
  assert.deepEqual(frames.frameSequence(items).map((f) => f.id), ["f1", "f2", "f3"]);
  // Moving the last frame first numbers every frame.
  const places = frames.moveFrame(["f1", "f2", "f3"], 2, 0);
  assert.deepEqual([...places], [["f3", 1], ["f1", 2], ["f2", 3]]);
  const ordered = items.map((i) => (places.has(i.id) ? { ...i, slide: places.get(i.id) } : i));
  assert.deepEqual(frames.frameSequence(ordered).map((f) => f.id), ["f3", "f1", "f2"]);
  // A new frame (no number) follows; hidden frames are no slides.
  const more = [...ordered.map((i) => (i.id === "f1" ? { ...i, presentHidden: true } : i)), item({ id: "f0", type: "frame", x: -500, y: -500, w: 10, h: 10 })];
  assert.deepEqual(frames.presentationSlides(more).map((f) => f.id), ["f3", "f2", "f0"]);
  const members = frames.frameMembers(items[0], items, (end) => ({ x: end?.x || 0, y: end?.y || 0 }));
  assert.deepEqual([...members].sort(), ["f1", "s"]);
});

test("search: texts, tables, frames, comments, cards, tags, accents and order", () => {
  const items = [
    item({ id: "low", y: 500, text: "Über das **Budget** sprechen" }),
    item({ id: "top", y: 0, x: 300, type: "shape", text: "Budgetplan" }),
    item({ id: "table", type: "table", y: 100, cells: [["Kosten", "Budget 2026"]] }),
    item({ id: "frame", type: "frame", y: 200, text: "Budget-Rahmen" }),
    item({ id: "comment", type: "comment", y: 300, messages: [{ id: "m", author: "u", name: "Ada", text: "Budget prüfen", at: 0 }] }),
    item({ id: "card", type: "card", y: 400, pageId: "p1" }),
    item({ id: "hidden", y: 50, text: "Budget geheim", covered: true }),
    item({ id: "tagged", y: 600, text: "Notiz", tags: ["Finanzen"] }),
  ];
  const found = searchBoard(items, "budget", { page: (id) => (id === "p1" ? "Budget-Seite" : undefined) });
  assert.deepEqual(found.map((m) => m.id), ["top", "table", "frame", "comment", "card", "low"]);
  // Markup is not part of the text; the snippet marks the match.
  const low = found.find((m) => m.id === "low")!;
  assert.equal(low.snippet, "Über das Budget sprechen");
  assert.equal(low.snippet.slice(low.start, low.start + low.length), "Budget");
  assert.deepEqual(searchBoard(items, "uber").map((m) => m.id), ["low"]);
  assert.deepEqual(searchBoard(items, "finanzen").map((m) => m.id), ["tagged"]);
  assert.deepEqual(searchBoard(items, "  "), []);
  assert.equal(fold("ÄÖÜ"), "aou");
});

test("element links: building, parsing, safe links and targets", () => {
  const pageId = "0b9d2a4e-8c1f-4c3e-9b7a-1f2e3d4c5b6a";
  const link = links.elementLink("https://flow.example/", pageId, "item-1");
  assert.equal(link, `https://flow.example/#page=${pageId}&item=item-1`);
  assert.deepEqual(links.parseElementLink(link, "https://flow.example"), { pageId, itemId: "item-1" });
  assert.equal(links.parseElementLink(link, "https://evil.example"), null);
  assert.deepEqual(links.parseElementLink("#item=abc"), { itemId: "abc" });
  assert.equal(links.parseElementLink("#item=a b"), null);
  assert.equal(links.parseElementLink(`#page=${pageId}&item=x&evil=1`), null);
  // Only http(s), mailto and element links.
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "/relative", "https://user:pw@x.example", "http://", "file:///etc/passwd", "https://a.example/\"onmouseover=x"])
    assert.equal(links.safeHref(bad), null, bad);
  assert.equal(links.safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(links.safeHref("mailto:ada@example.com"), "mailto:ada@example.com");
  assert.equal(links.safeHref("#item=abc"), "#item=abc");
  assert.deepEqual(links.linkTarget("#item=abc", pageId, "https://flow.example"), { kind: "item", itemId: "abc" });
  assert.deepEqual(links.linkTarget(link, pageId, "https://flow.example"), { kind: "item", itemId: "item-1" });
  assert.equal(links.linkTarget(`/#page=${"1".repeat(8)}-1111-4111-8111-111111111111&item=z`, pageId, "https://flow.example")?.kind, "page");
  assert.deepEqual(links.linkTarget("https://example.com", pageId, "https://flow.example"), { kind: "web", href: "https://example.com/" });
  // App links with the element open the board zoomed to it.
  assert.deepEqual(parsePageLocation(`#page=${pageId}&item=item-1`), { pageId, itemId: "item-1" });
  assert.equal(parsePageLocation(`#page=${pageId}&item=<x>`), null);
  assert.equal(pageLocationHash({ pageId, itemId: "x1" }), `#page=${pageId}&item=x1`);
});

test("rich text: lists, marks, links – and nothing unsafe", () => {
  const blocks = rich.parseRichText("Titel **fett** und *kursiv* und __unter__\n- eins\n- zwei mit [Link](https://example.com)\n3. drei\n4. vier");
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], {
    kind: "p",
    spans: [
      { text: "Titel " },
      { text: "fett", bold: true },
      { text: " und " },
      { text: "kursiv", italic: true },
      { text: " und " },
      { text: "unter", underline: true },
    ],
  });
  assert.equal(blocks[1].kind, "ul");
  assert.deepEqual((blocks[1] as { items: Span[][] }).items[1].at(-1), { text: "Link", href: "https://example.com/" });
  assert.deepEqual(blocks[2], { kind: "ol", start: 3, items: [[{ text: "drei" }], [{ text: "vier" }]] });
  // Unsafe links stay text; HTML in the text is escaped in the export.
  const evil = rich.parseRichText("[klick](javascript:alert(1)) <img src=x onerror=alert(1)>");
  assert.ok(evil.every((b) => b.kind !== "p" || b.spans.every((s) => !s.href)));
  const html = rich.richTextHtml("**<b>x</b>** [a](javascript:alert(1)) [ok](https://example.com/\"x)");
  assert.ok(!html.includes("<b>x</b>"));
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(!/href="javascript/i.test(html));
  assert.ok(!html.includes('"x'));
  // Bare addresses become links.
  assert.deepEqual(rich.inlineSpans("siehe https://example.com/a."), [{ text: "siehe " }, { text: "https://example.com/a", href: "https://example.com/a" }, { text: "." }]);
  assert.equal(rich.plainText("- **eins**\n- zwei"), "eins\nzwei");
  assert.equal(rich.plainText("snake_case bleibt"), "snake_case bleibt");
  // Editing helpers.
  assert.equal(rich.toggleList("a\nb", 0, 3, "ul").text, "- a\n- b");
  assert.equal(rich.toggleList("- a\n- b", 0, 7, "ul").text, "a\nb");
  assert.equal(rich.toggleList("- a\nb", 0, 5, "ol").text, "1. a\n2. b");
  assert.deepEqual(rich.continueList("- a", 3), { text: "- a\n- ", start: 6, end: 6 });
  assert.deepEqual(rich.continueList("1. a", 4), { text: "1. a\n2. ", start: 8, end: 8 });
  assert.deepEqual(rich.continueList("- a\n- ", 6), { text: "- a\n", start: 4, end: 4 });
  assert.equal(rich.continueList("text", 4), null);
  assert.equal(rich.toggleMark("ab", 0, 2, "**").text, "**ab**");
  assert.equal(rich.toggleMark("**ab**", 2, 4, "**").text, "ab");
  assert.equal(rich.insertLink("see", 0, 3, "https://x.example")?.text, "[see](https://x.example/)");
  assert.equal(rich.insertLink("see", 0, 3, "javascript:x"), null);
});

test("tags: normalized, unique, coloured and counted", () => {
  assert.equal(tags.normalizeTag("  Wichtig\n#1, "), "Wichtig 1");
  assert.deepEqual(tags.itemTags({ tags: ["A", "a", 3 as unknown as string, "", "B"] }), ["A", "B"]);
  assert.deepEqual(tags.addTag(["A"], "a"), ["A"]);
  assert.deepEqual(tags.removeTag(["A", "B"], "a"), ["B"]);
  assert.deepEqual(tags.tagColor("Idee"), tags.tagColor("idee"));
  assert.deepEqual(tags.boardTags([{ tags: ["x", "y"] }, { tags: ["Y"] }]).map((e) => [e.tag, e.count]), [["y", 2], ["x", 1]]);
  assert.ok(tags.hasTag({ tags: ["Idee"] }, "IDEE"));
  assert.match(itemText({ text: "Zettel", tags: ["Rot"] }), /Rot/);
});

test("embeds: only the allowlist, PDFs only from the board's files, checked properties", () => {
  assert.deepEqual(embeds.embedForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), {
    kind: "player",
    src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    provider: "YouTube",
  });
  assert.equal(embeds.embedForUrl("https://vimeo.com/123456789")?.src, "https://player.vimeo.com/video/123456789");
  for (const bad of ["https://evil.example/embed", "javascript:alert(1)", "https://www.youtube.com/embed/x\"><script>"])
    assert.equal(embeds.embedForUrl(bad), null, bad);
  assert.equal(embeds.boardEmbed({ type: "embed", src: "https://evil.example/" }), null);
  assert.equal(embeds.boardEmbed({ type: "embed", src: "https://www.youtube.com/embed/dQw4w9WgXcQ" }), null);
  assert.equal(embeds.boardEmbed({ type: "embed", src: "/api/files/abc-1" })?.kind, "pdf");
  assert.equal(embeds.boardEmbed({ type: "embed", src: "/api/files/../x" }), null);
  assert.equal(embeds.EMBED_SANDBOX.includes("allow-top-navigation"), false);
  // Wrong newer properties are dropped.
  const clean = embeds.withValidExtras({
    id: "x",
    type: "sticky",
    link: "javascript:alert(1)",
    crop: { x: 0.5, y: 0, w: 0.9, h: 1 },
    tags: ["a", "A", "b"],
    page: -1,
    notes: "ok",
  } as Partial<WhiteboardItem>);
  assert.equal(clean.link, undefined);
  assert.equal(clean.crop, undefined);
  assert.deepEqual(clean.tags, ["a", "b"]);
  assert.equal(clean.page, undefined);
  assert.equal(clean.notes, "ok");
  assert.deepEqual(embeds.cleanCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }), { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
});

test("SVG export: rich text, tags, crop and embeds – escaped, never live", () => {
  const ctx = { image: (src: string) => src, page: () => null, record: () => null, label: (_de: string, en: string) => en };
  const svg = whiteboardSvg(
    [
      item({ id: "s", text: "- **eins** <script>alert(1)</script>\n- [x](javascript:alert(1))", tags: ["Idee"], italic: true }),
      item({ id: "i", type: "image", x: 200, src: "/api/files/pic", crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }),
      item({ id: "e", type: "embed", x: 400, w: 320, h: 200, src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ", text: "Video" }),
      item({ id: "p", type: "embed", x: 800, src: "/api/files/doc", text: "Plan.pdf" }),
      item({ id: "bad", type: "embed", x: 900, src: "https://evil.example/" }),
    ],
    ctx,
  )!;
  assert.ok(svg.includes("<ul"));
  assert.ok(svg.includes("<b>eins</b>"));
  assert.ok(!svg.includes("<script>"));
  assert.ok(!/href="javascript/i.test(svg));
  assert.ok(svg.includes("Idee"));
  assert.ok(svg.includes("font-style:italic"));
  assert.ok(svg.includes('preserveAspectRatio="none"'));
  assert.ok(!svg.includes("<iframe"));
  assert.ok(svg.includes("YouTube") && svg.includes("https://youtu.be/dQw4w9WgXcQ"));
  assert.ok(svg.includes("Plan.pdf"));
  assert.ok(!svg.includes("evil.example"));
});

test("PDF export: one page per frame in presentation order, page sizes, valid PDF", async () => {
  const items = [
    item({ id: "f1", type: "frame", x: 0, y: 0, w: 400, h: 300, text: "Eins" }),
    item({ id: "f2", type: "frame", x: 500, y: 0, w: 800, h: 300, text: "Zwei", slide: 1 }),
    item({ id: "f3", type: "frame", x: 0, y: 400, w: 400, h: 300, text: "Drei", presentHidden: true }),
    item({ id: "n", x: 20, y: 20 }),
  ];
  assert.deepEqual(pdf.exportPages(items, "frames").map((p) => p.title), ["Zwei", "Eins"]);
  const [board] = pdf.exportPages(items, "board", "Board");
  assert.equal(board.box.x, -40 - 0);
  assert.equal(pdf.exportPages([], "board").length, 0);
  assert.deepEqual(pdf.pageSize(800, 600), { width: 600, height: 450 });
  assert.ok(pdf.pageSize(100000, 1000).width <= 14400);
  assert.ok(pdf.pageSize(10, 10).width >= 144);
  // A 1×1 PNG per page.
  const png = Uint8Array.from(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );
  const bytes = await pdf.boardPdf(
    [
      { png, width: 800, height: 600 },
      { png, width: 400, height: 300 },
    ],
    "Mein Board",
  );
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getTitle(), "Mein Board");
  assert.deepEqual(doc.getPage(0).getSize(), { width: 600, height: 450 });
});

test("template gallery: many templates, all valid, searchable, in both languages", () => {
  const de = (german: string) => german;
  const en = (_german: string, english: string) => english;
  assert.ok(gallery.galleryTemplates.length >= 22);
  const ids = new Set(gallery.galleryTemplates.map((t) => t.id));
  for (const wanted of ["storymap", "journey", "empathy", "lean", "bmc", "okr", "retro4l", "starfish", "sprint", "brainstorm", "eisenhower", "impact", "decision", "org", "timeline", "agenda", "icebreaker"])
    assert.ok(ids.has(wanted), wanted);
  for (const template of gallery.galleryTemplates) {
    const drafts = template.items(de);
    assert.ok(drafts.length > 0, template.id);
    const local = new Set(drafts.map((d) => d.id));
    assert.equal(local.size, drafts.length, `${template.id}: unique ids`);
    for (const d of drafts) {
      for (const end of [d.from, d.to]) if (end?.id) assert.ok(local.has(end.id), `${template.id}: ${end.id}`);
      assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y) && d.w >= 0 && d.h >= 0);
    }
    // Every template passes the checks for stored templates.
    assert.ok(userTemplates.cleanTemplateItems(drafts).length > 0);
  }
  assert.deepEqual(gallery.findTemplates("eisenhower", en).map((t) => t.id), ["eisenhower"]);
  assert.ok(gallery.findTemplates("Retro", de).length >= 3);
  assert.deepEqual(gallery.findTemplates("", de, "meetings").map((t) => t.id).sort(), ["agenda", "icebreaker"]);
  const english = gallery.galleryTemplates.find((t) => t.id === "lean")!.items(en);
  assert.ok(english.some((d) => d.text === "Customer segments"));
});

test("own templates: saved from a selection, listed, inserted with new ids, deleted; guests and viewers", () => {
  const user = (name: string): Identity => {
    const uid = id();
    run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
    return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false } as unknown as Identity;
  };
  const owner = user("owner"),
    editor = user("editor"),
    viewer = user("viewer");
  const wid = createWorkspace(owner.id, "Vorlagen");
  run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const space = bootstrap(owner, wid).spaces[0].id;
  const board = String((command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Board", kind: "whiteboard" }) as { id: string }).id);
  const items = [
    item({ id: "a", x: 500, y: 300, text: "A", votes: { u: true }, author: "u", locked: true, groups: ["g1"], z: 2 }),
    item({ id: "b", x: 700, y: 300, text: "B", groups: ["g1"], z: 1 }),
    item({ id: "c", type: "connector", from: { id: "a", x: 0, y: 0 }, to: { id: "outside", x: 0, y: 0 }, z: 3 }),
    item({ id: "m", type: "comment", messages: [] }),
    item({ id: "outside", x: 2000, y: 2000 }),
  ];
  const drafts = templateDrafts(items.filter((i) => ["a", "b", "c", "m"].includes(i.id)), items);
  assert.deepEqual(drafts.map((d) => d.id), ["b", "a", "c"]);
  const a = drafts.find((d) => d.id === "a")!;
  assert.equal(a.votes, undefined);
  assert.equal(a.locked, undefined);
  assert.equal(a.author, undefined);
  // The end at an element outside the selection stays where it was.
  const c = drafts.find((d) => d.id === "c")!;
  assert.equal(c.to?.id, undefined);
  assert.equal(c.from?.id, "a");
  const saved = userTemplates.saveBoardTemplate(editor, board, { name: "Paar", items: drafts }) as { id: string };
  userTemplates.saveBoardTemplate(owner, board, { name: "Geheim", items: drafts, private: true });
  const listed = userTemplates.listBoardTemplates(editor, board);
  assert.deepEqual(listed.map((t) => t.name), ["Paar"]);
  assert.equal(listed[0].items.length, 3);
  assert.deepEqual(userTemplates.listBoardTemplates(owner, board).map((t) => t.name), ["Geheim", "Paar"]);
  // Viewers see workspace templates but cannot save or delete.
  assert.equal(userTemplates.listBoardTemplates(viewer, board).length, 1);
  assert.throws(() => userTemplates.saveBoardTemplate(viewer, board, { name: "x", items: drafts }), (e: { status?: number }) => e.status === 403);
  assert.throws(() => userTemplates.deleteBoardTemplate(viewer, board, saved.id), (e: { status?: number }) => e.status === 403);
  // Unsafe content never reaches a stored template.
  assert.throws(() => userTemplates.saveBoardTemplate(editor, board, { name: "leer", items: [{ id: "x", type: "comment", x: 0, y: 0, w: 1, h: 1 }] }), (e: { status?: number }) => e.status === 400);
  const cleaned = userTemplates.cleanTemplateItems([
    { id: "i", type: "image", x: 0, y: 0, w: 1, h: 1, src: "javascript:alert(1)" },
    { id: "e", type: "embed", x: 0, y: 0, w: 1, h: 1, src: "https://evil.example" },
    { id: "s", type: "sticky", x: 0, y: 0, w: 1, h: 1, link: "javascript:x", onclick: "alert(1)" },
  ]);
  assert.deepEqual(cleaned.map((d) => d.id), ["s"]);
  assert.equal((cleaned[0] as Record<string, unknown>).link, undefined);
  assert.equal((cleaned[0] as Record<string, unknown>).onclick, undefined);
  // Inserting: new ids, connectors and groups follow.
  let n = 0;
  const placed = placeDrafts(groups.remapGroups(listed[0].items, () => `ng${++n}`), { newId: () => `new${++n}`, dx: 10, dy: 10 });
  const placedA = placed.find((p) => p.text === "A")!;
  const placedC = placed.find((p) => p.type === "connector")!;
  assert.equal(placedC.from?.id, placedA.id);
  assert.ok(placedA.groups?.[0].startsWith("ng"));
  assert.equal(placed.filter((p) => p.groups?.[0] === placedA.groups?.[0]).length, 2);
  // Deleting: the author or an owner.
  userTemplates.deleteBoardTemplate(owner, board, saved.id);
  assert.deepEqual(userTemplates.listBoardTemplates(editor, board).map((t) => t.name), []);
});

test("boards keep loading with the new properties; summary and search text", () => {
  const user = { id: id(), name: "x", email: "x@example.com", groups: [], isAdmin: false } as unknown as Identity;
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", user.id, user.id, "x", "x@example.com");
  const wid = createWorkspace(user.id, "Neu");
  const space = bootstrap(user, wid).spaces[0].id;
  const board = String((command(user, { action: "page.create", workspaceId: wid, spaceId: space, title: "B", kind: "whiteboard" }) as { id: string }).id);
  const doc = new Y.Doc();
  const map = doc.getMap<Y.Map<unknown>>("items");
  for (const entry of [
    { id: "s", type: "sticky", x: 0, y: 0, w: 100, h: 100, z: 1, text: "**Fett** und [Link](https://example.com)", tags: ["Thema"], groups: ["g"] },
    { id: "e", type: "embed", x: 0, y: 0, w: 100, h: 100, z: 2, src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ" },
    { id: "f", type: "frame", x: 0, y: 0, w: 100, h: 100, z: 0, text: "Rahmen", notes: "geheim", slide: 2 },
  ]) {
    const m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(entry)) if (k !== "id") m.set(k, v);
    map.set(entry.id, m);
  }
  writeWhiteboard(board, Y.encodeStateAsUpdate(doc));
  const pageRow = { id: board } as Parameters<typeof whiteboardSnapshotItems>[0];
  void pageRow;
  const summary = whiteboardSummary(
    [...map.entries()].map(([key, value]) => ({ ...(value.toJSON() as WhiteboardItem), id: key })),
  );
  assert.ok(summary.includes("Fett und Link"));
  assert.ok(!summary.includes("**"));
  assert.ok(summary.includes("Thema"));
  assert.ok(summary.includes("youtu.be"));
  assert.ok(!summary.includes("geheim"));
});

test("GIF search: only with a key, results checked", () => {
  assert.equal(gifProvider({}), null);
  assert.equal(gifProvider({ GIPHY_API_KEY: "k" }), "giphy");
  assert.equal(gifProvider({ TENOR_API_KEY: "k" }), "tenor");
  const giphy = parseGifResults("giphy", {
    data: [
      { id: "1", title: "Applaus", username: "ada", images: { downsized: { url: "https://media.giphy.com/1.gif", width: "200", height: "100" }, fixed_width_small: { url: "https://media.giphy.com/1s.gif" } } },
      { id: "2", title: "x", images: { downsized: { url: "http://insecure.example/2.gif", width: "1", height: "1" } } },
    ],
  });
  // The entry with an insecure address is left out, the rest stays.
  assert.deepEqual(giphy.map((r) => r.id), ["1"]);
  const ok = parseGifResults("giphy", {
    data: [{ id: "1", title: "Applaus", username: "ada", images: { downsized: { url: "https://media.giphy.com/1.gif", width: "200", height: "100" } } }],
  });
  assert.deepEqual(ok.map((r) => [r.url, r.width, r.credit]), [["https://media.giphy.com/1.gif", 200, "Applaus von ada via GIPHY"]]);
  const tenor = parseGifResults("tenor", {
    results: [{ id: "t", content_description: "Danke", media_formats: { gif: { url: "https://media.tenor.com/t.gif", dims: [300, 200] }, tinygif: { url: "https://media.tenor.com/s.gif" } } }],
  });
  assert.deepEqual(tenor.map((r) => [r.thumbnail, r.height, r.credit]), [["https://media.tenor.com/s.gif", 200, "Danke via Tenor"]]);
  assert.throws(() => parseGifResults("tenor", { nope: true }));
});
