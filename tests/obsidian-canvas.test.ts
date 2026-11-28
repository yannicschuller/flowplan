// Obsidian canvases (JSON Canvas 1.0) as whiteboards (#667): nodes of each
// type, edges, groups, colours, invalid entries and the limits, with a
// vault built at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-canvas-"));
const { parseObsidian } = await import("../lib/importers/obsidian");
const { canvasBoard, canvasText, readCanvas } = await import("../lib/importers/obsidian-canvas");
const { BOARD_IMPORT_LIMITS } = await import("../lib/whiteboard-import");
const { pageRef } = await import("../lib/importers/html");

// The smallest PNG signature the importer accepts.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function vault() {
  const canvas = {
    nodes: [
      { id: "g1", type: "group", x: -100, y: -100, width: 900, height: 600, label: "Ideas", color: "4" },
      { id: "t1", type: "text", x: 0, y: 0, width: 250, height: 120, text: "# Plan\n**bold** and [[Note|the note]] <b>x</b>\n- [ ] open\n[web](https://example.org) [local](file.md)", color: "1" },
      { id: "f1", type: "file", x: 300, y: 0, width: 400, height: 400, file: "Folder/Note.md", subpath: "#Heading" },
      { id: "f2", type: "file", x: 0, y: 200, width: 200, height: 150, file: "assets/pic.png" },
      { id: "f3", type: "file", x: 300, y: 450, width: 200, height: 80, file: "docs/report.pdf" },
      { id: "f4", type: "file", x: 600, y: 450, width: 200, height: 80, file: "missing.png" },
      { id: "l1", type: "link", x: 0, y: 400, width: 300, height: 100, url: "https://www.example.com/page", color: "#123abc" },
      { id: "l2", type: "link", x: 0, y: 600, width: 300, height: 100, url: "javascript:alert(1)" },
      { id: "bad", type: "text", x: "nope", y: 0, width: 10, height: 10, text: "x" },
      { id: "u1", type: "widget", x: 0, y: 0, width: 10, height: 10 },
      null,
      { id: "t1", type: "text", x: 1, y: 1, width: 10, height: 10, text: "duplicate id" },
      { id: "c2", type: "file", x: 900, y: 0, width: 200, height: 100, file: "Other.canvas", extra: { deep: [1, 2, 3] } },
    ],
    edges: [
      { id: "e1", fromNode: "t1", fromSide: "right", toNode: "f1", toSide: "left", label: "see", color: "5" },
      { id: "e2", fromNode: "f1", toNode: "f2", fromEnd: "arrow", toEnd: "none" },
      { id: "e3", fromNode: "t1", toNode: "gone" },
      "garbage",
    ],
    unknownTopLevel: true,
  };
  return new Map<string, Buffer>([
    [".obsidian/app.json", Buffer.from("{}")],
    ["Folder/Note.md", Buffer.from("# Note\n\n## Heading\n\nSee [[Map.canvas]] and [[Maps/Map]].\n")],
    ["Maps/Map.canvas", json(canvas)],
    ["Other.canvas", json({ nodes: [] })],
    ["Broken.canvas", Buffer.from("{ not json")],
    ["assets/pic.png", png],
    ["docs/report.pdf", Buffer.from("%PDF-1.4")],
  ]);
}

test("a .canvas file becomes a whiteboard in its folder, with every node type mapped", () => {
  const tree = parseObsidian(vault());
  const board = tree.pages.find((p) => p.key === "Maps/Map.canvas")!;
  assert.ok(board, "the canvas is a page");
  assert.equal(board.kind, "whiteboard");
  assert.equal(board.title, "Map");
  assert.equal(board.parent, "folder:Maps", "placed below its folder");
  const items = board.board!.items;
  const byType = (type: string) => items.filter((i) => i.type === type);

  const [frame] = byType("frame");
  assert.equal(frame.text, "Ideas");
  assert.equal(frame.fill, "#b2f2bb", "preset 4 is green");
  assert.equal(items[0].type, "frame", "frames first (below)");

  const text = byType("sticky").find((i) => i.text?.startsWith("**Plan**"))!;
  assert.ok(text, "the heading turns bold");
  assert.equal(text.fill, "#ffc9c9", "preset 1 is red");
  assert.match(text.text!, /\*\*bold\*\* and the note x/);
  assert.match(text.text!, /- ☐ open/);
  assert.match(text.text!, /\[web\]\(https:\/\/example\.org\/\) local/);
  assert.doesNotMatch(text.text!, /<b>|\[\[/);

  const cards = byType("card");
  assert.deepEqual(cards.map((c) => c.pageId).sort(), [pageRef("Folder/Note.md"), pageRef("Other.canvas")].sort(), "notes and canvases of the vault become cards");
  assert.ok(cards.every((c) => c.h <= 160 && c.w >= 200));

  const [image] = byType("image");
  assert.match(image.src!, /^import:img1$/);
  assert.equal(board.board!.images.length, 1);
  assert.equal(board.board!.images[0].mime, "image/png");

  const notes = byType("sticky").map((i) => i.text);
  assert.ok(notes.includes("📎 report.pdf"), "other files are a note with their name");
  assert.ok(notes.includes("📎 missing.png"), "a missing file too");
  assert.ok(!notes.includes("duplicate id"), "a repeated id is left out");

  const embeds = byType("embed");
  assert.equal(embeds.length, 1, "only http(s) links");
  assert.equal(embeds[0].url, "https://www.example.com/page");
  assert.deepEqual(embeds[0].preview, { title: "example.com", site: "example.com" });

  const connectors = byType("connector");
  assert.equal(connectors.length, 2, "edges without both nodes are left out");
  const see = connectors.find((c) => c.text === "see")!;
  assert.equal(see.stroke, "#1971c2", "preset 5 is cyan/blue");
  assert.equal(see.endArrow, true);
  assert.equal(see.startArrow, undefined);
  const textItem = items.find((i) => i.id === see.from!.id)!;
  assert.equal(see.from!.x, textItem.x + textItem.w, "bound at the right side");
  const back = connectors.find((c) => !c.text)!;
  assert.equal(back.endArrow, false);
  assert.equal(back.startArrow, true);
  assert.ok(Math.min(...items.filter((i) => i.type !== "connector").map((i) => i.x)) === 0, "positions start at 0");

  // Reported: bad nodes, unknown type, the bad link, the files, the bad edges.
  const entries = tree.report!.entries.filter((e) => e.page === "Maps/Map.canvas");
  assert.ok(entries.some((e) => e.kind === "file" && /missing\.png/.test(e.detail)));
  assert.ok(entries.some((e) => /report\.pdf/.test(e.detail)));
  assert.ok(entries.some((e) => /widget/.test(e.detail)));
  assert.ok(entries.some((e) => /http/.test(e.detail)));
  assert.ok(board.board!.replaced >= 7);
  assert.ok(!tree.files.has("assets/pic.png"), "the image travels with the board, not as a page file");
});

test("wikilinks to a canvas lead to its board; a broken canvas is reported and left out", () => {
  const tree = parseObsidian(vault());
  const note = tree.pages.find((p) => p.key === "Folder/Note.md")!;
  assert.equal((note.html.match(new RegExp(pageRef("Maps/Map.canvas").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1, "[[Map.canvas]] resolves");
  assert.ok(!tree.pages.some((p) => p.key === "Broken.canvas"));
  assert.ok(tree.report!.entries.some((e) => e.kind === "other" && /Broken\.canvas/.test(e.detail)));
  assert.ok(tree.pages.find((p) => p.key === "Other.canvas")?.kind === "whiteboard", "an empty canvas is an empty board");
});

test("canvas limits: elements, text length, file size", () => {
  const many = { nodes: Array.from({ length: BOARD_IMPORT_LIMITS.elements + 5 }, (_, i) => ({ id: `n${i}`, type: "text", x: i, y: 0, width: 10, height: 10, text: "x" })), edges: [{ fromNode: "n0", toNode: "n1" }] };
  const { board, problems } = canvasBoard(many, { page: () => null, file: () => null });
  assert.equal(board.items.length, BOARD_IMPORT_LIMITS.elements);
  assert.ok(problems.some((p) => /limit|Grenze/.test(p.detail)));
  assert.ok(canvasText("a".repeat(100_000)).length <= BOARD_IMPORT_LIMITS.text);
  assert.ok("error" in readCanvas(Buffer.alloc(BOARD_IMPORT_LIMITS.bytes + 1, 32)));
  assert.ok("error" in readCanvas(json([1, 2])));
  assert.ok("error" in readCanvas(json({ nodes: "x" })));
  assert.deepEqual(readCanvas(Buffer.from("")), { nodes: [], edges: [] });
  // Coordinates beyond the board's range are bounded, never NaN.
  const far = canvasBoard({ nodes: [{ id: "a", type: "text", x: 1e300, y: -1e300, width: 1e300, height: 5, text: "far" }], edges: [] }, { page: () => null, file: () => null });
  assert.ok(far.board.items.every((i) => Number.isFinite(i.x) && Number.isFinite(i.y) && i.w <= BOARD_IMPORT_LIMITS.coordinate));
});

test("writing the import: the board's cards name the imported pages, its image is a stored file", async () => {
  const Y = await import("yjs");
  const { one, run, id } = await import("../lib/db");
  const { createWorkspace } = await import("../lib/seed");
  const { command } = await import("../lib/api");
  const { writeImport } = await import("../lib/importers/write");
  const { whiteboardItems } = await import("../lib/whiteboard");
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Olga", "olga@example.test");
  const owner = { id: uid, name: "Olga", email: "olga@example.test", groups: [], isAdmin: false, disabled: 0, created_at: "" };
  const wid = await createWorkspace(uid, "Vault");
  const space = ((await command(owner, { action: "space.create", workspaceId: wid, name: "Obsidian" })) as { id: string }).id;
  await writeImport(owner, wid, space, parseObsidian(vault()));
  const pageOf = async (title: string) => (await one<{ id: string; kind: string }>("SELECT id,kind FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL", wid, title))!;
  const map = await pageOf("Map"),
    note = await pageOf("Note"),
    other = await pageOf("Other");
  assert.equal(map.kind, "whiteboard");
  const row = (await one<{ state: Uint8Array }>("SELECT state FROM whiteboards WHERE page_id=?", map.id))!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.state);
  const items = whiteboardItems(doc);
  doc.destroy();
  assert.deepEqual(items.filter((i) => i.type === "card").map((i) => i.pageId).sort(), [note.id, other.id].sort());
  assert.match(items.find((i) => i.type === "image")!.src!, /^\/api\/files\//);
  const connector = items.find((i) => i.type === "connector" && i.text === "see")!;
  assert.ok(items.some((i) => i.id === connector.from!.id) && items.some((i) => i.id === connector.to!.id), "connectors stay bound");
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", note.id))!.html;
  assert.match(html, new RegExp(map.id), "[[Map.canvas]] links the board");
});
