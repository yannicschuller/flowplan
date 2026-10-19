import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-whiteboard-export-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { writeWhiteboard } = await import("../lib/whiteboard");
const { exportMarkdown } = await import("../lib/markdown-export");
const { whiteboardSvg } = await import("../lib/whiteboard-svg");
const { readExportZip } = await import("./helpers/read-export-zip");
const { markdownToHtml } = await import("../lib/markdown-import");

const uid = id();
run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, "Ada", "ada@example.test");
const ada = { id: uid, name: "Ada", email: "ada@example.test", groups: [], isAdmin: false } as unknown as Identity;
const wid = createWorkspace(uid, "Familie");
const space = bootstrap(ada, wid).spaces[0].id;
const act = (b: Record<string, unknown>) => command(ada, { workspaceId: wid, ...b }) as Record<string, unknown>;

function board(pageId: string, items: Record<string, unknown>[]) {
  const doc = new Y.Doc();
  const map = doc.getMap<Y.Map<unknown>>("items");
  for (const item of items) {
    const entry = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(item)) if (key !== "id") entry.set(key, value);
    map.set(String(item.id), entry);
  }
  writeWhiteboard(pageId, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

const house = String(act({ action: "page.create", spaceId: space, title: "Haus", kind: "document" }).id);
const plan = String(act({ action: "page.create", spaceId: space, title: "Grundriss", kind: "whiteboard", parentId: house }).id);
const empty = String(act({ action: "page.create", spaceId: space, title: "Leer", kind: "whiteboard", parentId: house }).id);
act({ action: "page.create", spaceId: space, title: "Tagebuch", kind: "journal", parentId: house });
// An uploaded image on the board.
const fileId = id();
mkdirSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads"), { recursive: true });
writeFileSync(join(process.env.FLOWPLAN_DATA_DIR!, "uploads", fileId), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fileId, plan, "foto.svg", "image/svg+xml", 40, uid);
board(plan, [
  { id: "a", type: "sticky", x: 0, y: 0, w: 160, h: 120, z: 1, text: "Haupthahn <Keller>" },
  { id: "b", type: "shape", shape: "ellipse", x: 300, y: 0, w: 120, h: 80, z: 2, text: "Heizung" },
  { id: "c", type: "connector", x: 0, y: 0, w: 0, h: 0, z: 3, from: { id: "a", x: 0, y: 0 }, to: { id: "b", x: 0, y: 0 }, text: "Leitung" },
  { id: "d", type: "image", x: 0, y: 200, w: 100, h: 100, z: 4, src: `/api/files/${fileId}` },
  { id: "e", type: "card", x: 300, y: 200, w: 200, h: 60, z: 5, pageId: house },
  { id: "f", type: "sticky", x: 600, y: 0, w: 100, h: 100, z: 6, text: "Geheim", covered: true },
  { id: "g", type: "comment", x: 900, y: 900, w: 32, h: 32, z: 7, messages: [{ text: "Nur Gespräch" }] },
]);
const html = `<p>Plan:</p><div data-whiteboard="${plan}" data-whiteboard-height="380"></div><div data-whiteboard="${empty}" data-whiteboard-height="300"></div>`;
run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), house);

test("whiteboards come along as SVG images: pages, embeds and their pictures", async () => {
  const { bytes } = await exportMarkdown(ada, { pageId: house, format: "zip", includeSubpages: true });
  const files = await readExportZip(bytes as Buffer);
  const svgName = [...files.keys()].find((n) => n.startsWith("assets/") && n.endsWith(`${plan}.svg`))!;
  assert.ok(svgName, [...files.keys()].join(", "));
  const svg = files.get(svgName)!.toString("utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-40 -40 /);
  assert.match(svg, /Haupthahn &lt;Keller&gt;/, "texts are escaped");
  assert.match(svg, /Heizung/);
  assert.match(svg, /Leitung/);
  assert.match(svg, /<path d="M 60 0 A 60 40/, "ellipse at the shape's place");
  // The picture is in assets/ next to the SVG and referenced relatively.
  const picture = [...files.keys()].find((n) => n.startsWith(`assets/${fileId}`))!;
  assert.ok(picture);
  assert.match(svg, new RegExp(`<image href="${picture.slice("assets/".length)}"`));
  // The card names the page; covered items stay covered; comments stay out.
  assert.match(svg, /Haus/);
  assert.doesNotMatch(svg, /Geheim/);
  assert.match(svg, /Verdeckt/);
  assert.doesNotMatch(svg, /Nur Gespräch/);
  // The document embeds the image and links the board.
  const index = files.get("index.md")!.toString("utf8");
  assert.match(index, new RegExp(`!\\[Grundriss\\]\\(<${svgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>\\)`));
  assert.match(index, new RegExp(`\\[Grundriss\\]\\(<https://flowplan\\.example\\.test/#page=${plan}>\\)`));
  // An empty board: no image, only the link; its own page says so.
  assert.ok(![...files.keys()].some((n) => n.endsWith(`${empty}.svg`)));
  assert.match(index, new RegExp(`\\[Leer\\]\\(<https://flowplan\\.example\\.test/#page=${empty}>\\)`));
  const emptyPage = [...files.keys()].find((n) => n.startsWith("pages/") && n.endsWith(`${empty}.md`))!;
  assert.match(files.get(emptyPage)!.toString("utf8"), /leer|empty/);
  // The board's own page shows the image, relative from pages/.
  const planPage = [...files.keys()].find((n) => n.startsWith("pages/") && n.endsWith(`${plan}.md`))!;
  assert.match(files.get(planPage)!.toString("utf8"), new RegExp(`!\\[Grundriss\\]\\(<\\.\\./${svgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>\\)`));
  // A journal below the page no longer breaks the export.
  assert.ok([...files.keys()].some((n) => n.startsWith("pages/Tagebuch-")));
});

test("in a space export each folder has its own copy of the SVG", async () => {
  const files = await readExportZip((await exportMarkdown(ada, { spaceId: space, format: "zip", includeSubpages: false })).bytes as Buffer);
  const folder = `Haus-${house.slice(0, 8)}`;
  assert.ok([...files.keys()].some((n) => n.startsWith(`${folder}/assets/`) && n.endsWith(`${plan}.svg`)));
  assert.match(files.get(`${folder}/index.md`)!.toString("utf8"), /!\[Grundriss\]\(<assets\//);
});

test("board data from clients cannot break out of the SVG", () => {
  const svg = whiteboardSvg(
    [
      { id: "x", type: "sticky", x: '0" onload="alert(1)' as unknown as number, y: 0, w: 10, h: 10, z: 1, fill: "red\" onclick=\"x", text: "</foreignObject><script>alert(1)</script>" },
    ],
    { image: () => null, page: () => null, record: () => null, label: (de) => de },
  )!;
  assert.doesNotMatch(svg, /onload|onclick|<script/);
  assert.match(svg, /translate\(0 0\)/);
  assert.equal(whiteboardSvg([], { image: () => null, page: () => null, record: () => null, label: (de) => de }), null);
});

test("a re-import (Git) turns the exported image back into the embed", async () => {
  const files = await readExportZip((await exportMarkdown(ada, { pageId: house, format: "zip", includeSubpages: true })).bytes as Buffer);
  const index = files.get("index.md")!.toString("utf8");
  assert.match(index, new RegExp(`<!-- flowplan:whiteboard ${plan} 380 -->`));
  const back = markdownToHtml(index, (href) => href, { whiteboard: (id) => id === plan || id === empty });
  assert.match(back, new RegExp(`<div data-whiteboard="${plan}" data-whiteboard-height="380"></div>`));
  assert.match(back, new RegExp(`<div data-whiteboard="${empty}" data-whiteboard-height="300"></div>`));
  assert.doesNotMatch(back, /\.svg|flowplan:whiteboard/);
  // Elsewhere (a plain Markdown import) the image and link stay, the marker goes.
  const plain = markdownToHtml(index, (href) => href);
  assert.doesNotMatch(plain, /data-whiteboard|flowplan:whiteboard/);
  assert.match(plain, /<img src="assets\//);
});
