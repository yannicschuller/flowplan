import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-board-import-"));
const { id, run, one, all } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { whiteboardSnapshotItems } = await import("../lib/whiteboard");
const { writeZip } = await import("../lib/archive");
const { importZip } = await import("../lib/zip-import");
const { importWhiteboardFile } = await import("../lib/whiteboard-import-server");
const { parseBoardFile, parseXml, importText, boardFormat, placeDrafts, BOARD_IMPORT_LIMITS, BoardImportError } =
  await import("../lib/whiteboard-import");

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "whiteboard-import", name), "utf8");
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));
function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("board-owner"),
  reader = user("board-reader"),
  wid = createWorkspace(owner.id, "Imports"),
  space = bootstrap(owner, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");

test("Excalidraw scenes become shapes, labels, connectors, pens, images and notes", async () => {
  const board = await parseBoardFile("skizze.excalidraw", fixture("board.excalidraw"));
  assert.equal(board.format, "excalidraw");
  const items = byId(board.items);
  // Deleted elements are gone; bound texts are their shape's label.
  assert.equal(board.items.length, 11);
  const rect = items.get("x0")!;
  assert.equal(rect.type, "shape");
  assert.equal(rect.shape, "rounded");
  assert.equal(rect.fill, "#ffc9c9");
  // Text stays text: markup is shown literally, never interpreted.
  assert.equal(rect.text, "Start <b>here</b>");
  assert.equal(rect.textColor, "#1971c2");
  assert.equal(items.get("x2")!.shape, "ellipse");
  assert.equal(items.get("x2")!.dashed, true);
  assert.equal(items.get("x2")!.fill, "transparent");
  assert.equal(items.get("x3")!.shape, "diamond");
  assert.equal(items.get("x3")!.rotation, 90);
  // Arrows keep their bindings; lines have no arrow head.
  const arrow = items.get("x4")!;
  assert.equal(arrow.type, "connector");
  assert.equal(arrow.from?.id, "x0");
  assert.equal(arrow.to?.id, "x2");
  assert.equal(arrow.endArrow, true);
  assert.equal(arrow.startArrow, undefined);
  const line = items.get("x5")!;
  assert.equal(line.endArrow, false);
  assert.equal(line.from?.id, undefined);
  assert.deepEqual([line.to!.x - line.from!.x, line.to!.y - line.from!.y], [100, 50]);
  // Freehand: points relative to the item's box (0–1).
  const pen = items.get("x6")!;
  assert.equal(pen.type, "pen");
  assert.deepEqual(pen.points, [0, 0, 0.5, 1, 1, 0]);
  assert.equal(items.get("x7")!.type, "text");
  assert.equal(items.get("x7")!.align, "left");
  // The PNG comes along; the "image" that is really an SVG does not.
  assert.equal(items.get("x8")!.src, "import:img1");
  assert.equal(board.images.length, 1);
  assert.equal(board.images[0].mime, "image/png");
  assert.equal(items.get("x9")!.type, "sticky");
  assert.equal(items.get("x10")!.type, "frame");
  assert.equal(items.get("x10")!.text, "Skizze");
  // Unknown elements: a note with what is known about them.
  assert.equal(items.get("x11")!.text, "https://example.com/video");
  assert.equal(board.replaced, 2);
  // Content starts at the origin.
  assert.equal(Math.min(...board.items.filter((i) => i.type !== "connector").map((i) => i.x)), 0);
});

test("draw.io diagrams: shapes, HTML labels as text, groups, edges with labels", async () => {
  const board = await parseBoardFile("ablauf.drawio", fixture("board.drawio"));
  assert.equal(board.format, "drawio");
  const items = byId(board.items);
  const start = items.get("p0-a")!,
    check = items.get("p0-b")!;
  assert.equal(start.shape, "ellipse");
  assert.equal(start.fill, "#d5e8d4");
  assert.equal(check.shape, "diamond");
  assert.equal(check.bold, true);
  // HTML labels lose every tag and attribute, including handlers.
  assert.equal(check.text, "Prüfen\nzweite Zeile");
  assert.equal(items.get("p0-c")!.shape, "rounded");
  assert.equal(items.get("p0-c")!.strokeWidth, 3);
  assert.equal(items.get("p0-c")!.dashed, true);
  assert.equal(items.get("p0-d")!.type, "sticky");
  const label = items.get("p0-t")!;
  assert.equal(label.type, "text");
  assert.equal(label.textColor, "#ff0000");
  assert.equal(label.fontSize, 18);
  // Stencils and external pictures become notes; embedded PNGs come along.
  assert.equal(items.get("p0-aws")!.type, "sticky");
  assert.equal(items.get("p0-ext")!.type, "sticky");
  assert.equal(items.get("p0-img")!.src, "import:img1");
  assert.equal(board.replaced, 2);
  // Children of a group are placed relative to it.
  assert.deepEqual([items.get("p0-gi")!.x - start.x, items.get("p0-gi")!.y - start.y], [570, 280]);
  assert.equal(items.get("p0-u")!.text, "Mit Link");
  const e1 = items.get("p0-e1")!,
    e2 = items.get("p0-e2")!,
    e3 = items.get("p0-e3")!;
  assert.deepEqual([e1.from?.id, e1.to?.id, e1.route, e1.endArrow], ["p0-a", "p0-b", "elbow", true]);
  assert.deepEqual([e2.endArrow, e2.stroke, e2.text], [false, "#0000ff", "ja Label"]);
  assert.deepEqual([e3.route, e3.startArrow, e3.from?.id], ["curved", true, undefined]);
  assert.ok(!JSON.stringify(board.items).includes("onerror"));
});

test("compressed draw.io pages and SVG exports with an embedded diagram", async () => {
  const plain = await parseBoardFile("a.drawio", fixture("board.drawio"));
  const compressed = await parseBoardFile("b.drawio", fixture("board-compressed.drawio"));
  // Two pages side by side, each in a frame named like the page.
  const frames = compressed.items.filter((i) => i.type === "frame");
  assert.deepEqual(frames.map((f) => f.text), ["Übersicht", "Details"]);
  assert.ok(frames[1].x > frames[0].x + frames[0].w);
  // The first page holds the same items as the uncompressed file.
  const first = compressed.items.filter((i) => i.id.startsWith("p0-") && i.type !== "frame");
  assert.deepEqual(
    first.map((i) => [i.id, i.type, i.text]),
    plain.items.map((i) => [i.id, i.type, i.text]),
  );
  const second = byId(compressed.items);
  assert.equal(second.get("p1-x")!.text, "Zweite Seite & mehr");
  assert.equal(second.get("p1-xy")!.to?.id, "p1-y");
  assert.equal(boardFormat("export.svg", fixture("board.drawio.svg")), "drawio");
  const svg = await parseBoardFile("export.svg", fixture("board.drawio.svg"));
  assert.deepEqual(svg.items.map((i) => i.type), ["shape", "shape", "connector"]);
  await assert.rejects(
    parseBoardFile("plain.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
    BoardImportError,
  );
});

test("imports are validated strictly: formats, sizes, counts and broken data", async () => {
  await assert.rejects(parseBoardFile("x.txt", "hello"), /Unbekanntes Format/);
  await assert.rejects(parseBoardFile("x.excalidraw", "{nope"), /kein gültiges JSON/);
  await assert.rejects(parseBoardFile("x.excalidraw", '{"type":"other","elements":[]}'), /keine Excalidraw/);
  const many = JSON.stringify({
    type: "excalidraw",
    elements: Array.from({ length: BOARD_IMPORT_LIMITS.elements + 1 }, (_, i) => ({ id: `e${i}`, type: "rectangle", x: i, y: 0, width: 1, height: 1 })),
  });
  await assert.rejects(parseBoardFile("x.excalidraw", many), /Zu viele Elemente/);
  await assert.rejects(parseBoardFile("x.drawio", "<mxfile><diagram>"), /fehlerhaft/);
  await assert.rejects(parseBoardFile("x.drawio", "<mxfile><diagram>!!!kein base64!!!</diagram></mxfile>"), /beschädigt/);
  // A small file that unpacks to more than allowed (zip bomb) is refused.
  const bomb = deflateRawSync(Buffer.alloc(BOARD_IMPORT_LIMITS.inflated + 1024, 0x41)).toString("base64");
  await assert.rejects(parseBoardFile("x.drawio", `<mxfile><diagram>${bomb}</diagram></mxfile>`), /zu groß/);
  await assert.rejects(parseBoardFile("big.excalidraw", " ".repeat(BOARD_IMPORT_LIMITS.bytes + 1)), /zu groß/);
  // Entities beyond the predefined ones are never expanded.
  const xml = parseXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x v="&a;&amp;&#65;">t &lt; &a;</x>');
  assert.deepEqual([xml.attrs.v, xml.text], ["&a;&A", "t < &a;"]);
  assert.equal(importText("a\u0000b‮c<script>x</script>", true), "abc");
  assert.equal(importText("x".repeat(9000)).length, BOARD_IMPORT_LIMITS.text);
  // Coordinates are finite and bounded.
  const wild = await parseBoardFile(
    "w.excalidraw",
    JSON.stringify({ type: "excalidraw", elements: [{ id: "a", type: "rectangle", x: 1e300, y: "NaN", width: -5, height: 3 }] }),
  );
  assert.ok(wild.items.every((i) => Number.isFinite(i.x) && Number.isFinite(i.y) && i.w > 0));
});

test("placing drafts gives fresh ids, keeps bindings and moves free ends", () => {
  let n = 0;
  const placed = placeDrafts(
    [
      { id: "a", type: "shape", x: 0, y: 0, w: 10, h: 10 },
      { id: "f", type: "frame", x: 0, y: 0, w: 100, h: 100 },
      { id: "c", type: "connector", x: 0, y: 0, w: 0, h: 0, from: { id: "a", x: 5, y: 5 }, to: { x: 50, y: 50 } },
      { id: "i", type: "image", x: 0, y: 0, w: 4, h: 4, src: "import:img9" },
    ],
    { dx: 100, dy: 200, newId: () => `n${++n}`, topZ: 7, bottomZ: -2, image: () => null },
  );
  assert.deepEqual(placed.map((i) => i.id), ["n1", "n2", "n3", "n4"]);
  assert.deepEqual(placed.map((i) => i.z), [8, -3, 9, 10]);
  assert.equal(placed[2].from?.id, "n1");
  assert.deepEqual(placed[2].to, { x: 150, y: 250 });
  assert.equal(placed[3].type, "sticky");
});

test("the server stores embedded pictures and creates whiteboards from files", async () => {
  const file = Buffer.from(fixture("board.excalidraw"));
  const created = await importWhiteboardFile(owner, "Skizze.excalidraw", file, { workspaceId: wid, spaceId: space });
  assert.ok("pageId" in created);
  const page = one<{ title: string; kind: string }>("SELECT title,kind FROM pages WHERE id=?", created.pageId)!;
  assert.deepEqual([page.title, page.kind], ["Skizze", "whiteboard"]);
  const items = whiteboardSnapshotItems({ id: created.pageId } as never);
  assert.equal(items.length, 11);
  const image = items.find((i) => i.type === "image")!;
  const files = all<{ id: string; mime: string }>("SELECT id,mime FROM files WHERE page_id=?", created.pageId);
  assert.deepEqual(files.map((f) => f.mime), ["image/png"]);
  assert.equal(image.src, `/api/files/${files[0].id}`);
  // Connectors point at the new ids of their shapes.
  const arrow = items.find((i) => i.type === "connector" && i.endArrow)!;
  assert.ok(items.some((i) => i.id === arrow.from?.id && i.type === "shape"));
  // Search and previews see the texts.
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", created.pageId)!.html;
  assert.match(html, /Freier Text/);
  assert.match(html, /Start &lt;b&gt;here/);

  // Onto an existing board: items to place, pictures already stored.
  const board = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Board", kind: "whiteboard" }) as { id: string }).id;
  const onto = await importWhiteboardFile(owner, "x.drawio", Buffer.from(fixture("board-compressed.drawio")), { pageId: board });
  assert.ok("items" in onto && Array.isArray(onto.items));
  const drawn = (onto as { items: { type: string; src?: string }[] }).items;
  assert.match(drawn.find((i) => i.type === "image")!.src!, /^\/api\/files\/[\w-]+$/);
  await assert.rejects(importWhiteboardFile(reader, "x.drawio", Buffer.from(fixture("board.drawio")), { pageId: board }), (e: any) => e.status === 403);
  await assert.rejects(
    importWhiteboardFile(reader, "x.drawio", Buffer.from(fixture("board.drawio")), { workspaceId: wid, spaceId: space }),
    (e: any) => e.status === 403,
  );
  const doc = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title: "Doc" }) as { id: string }).id;
  await assert.rejects(importWhiteboardFile(owner, "x.drawio", Buffer.from(fixture("board.drawio")), { pageId: doc }), (e: any) => e.status === 400);
  await assert.rejects(importWhiteboardFile(owner, "x.txt", Buffer.from("nothing"), { pageId: board }), (e: any) => e.status === 400);
});

test("Excalidraw files inside a ZIP export become whiteboard pages", async () => {
  const zip = await writeZip(
    new Map([
      ["Projekt.md", Buffer.from("# Projekt\n\nText")],
      ["Projekt/Skizze.excalidraw", Buffer.from(fixture("board.excalidraw"))],
      ["Projekt/Ablauf.drawio", Buffer.from(fixture("board-compressed.drawio"))],
      ["Kaputt.excalidraw", Buffer.from("{kaputt")],
    ]),
  );
  const result = await importZip(owner, wid, space, zip);
  assert.equal(result.pages, 4);
  assert.equal(result.files, 2);
  const page = (title: string) =>
    one<{ id: string; kind: string; parent_id: string | null }>(
      "SELECT id,kind,parent_id FROM pages WHERE workspace_id=? AND title=? AND deleted_at IS NULL ORDER BY rowid DESC",
      wid,
      title,
    )!;
  const sketch = page("Skizze"),
    flow = page("Ablauf");
  assert.equal(sketch.kind, "whiteboard");
  assert.equal(sketch.parent_id, page("Projekt").id);
  assert.equal(whiteboardSnapshotItems({ id: sketch.id } as never).length, 11);
  assert.ok(whiteboardSnapshotItems({ id: flow.id } as never).some((i) => i.text === "Zweite Seite & mehr"));
  // A drawing that cannot be read still arrives, with a note saying why.
  const broken = whiteboardSnapshotItems({ id: page("Kaputt").id } as never);
  assert.match(broken[0].text || "", /Kaputt\.excalidraw: .*JSON/);
});
