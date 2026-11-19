// The docked side panel (#392): widths and places (lib/side-panel.ts), who
// has the shell's column (lib/side-dock.ts), regions of PDF pages on their
// way into a notebook or document (lib/pdf-clip.ts), the caption a picture
// keeps (lib/ink/model.ts source) and record links of published pages
// (lib/public-nav.ts recordLinkOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampSidePanel,
  neighbourRecord,
  readSidePanelWidth,
  recordDocks,
  SIDE_PANEL_WIDTH,
  sidePanelMax,
  writeSidePanelWidth,
} from "../lib/side-panel";
import { claimDock, dockState, evictDock, releaseDock, subscribeDock, updateDock } from "../lib/side-dock";
import { clipFileName, clipHref, clipScale, clipTarget, getClip, lassoRegion, pdfFileId, pdfPageLink, putClip, registerClipTarget, touchClipTarget } from "../lib/pdf-clip";
import { cleanItem, mapInkFiles, parseInk, serializeInk, type InkImage } from "../lib/ink/model";
import { recordLinkOf } from "../lib/public-nav";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
};

test("side panel widths: default, dragged, within 360 px and 60 % of the window, kept per kind", () => {
  assert.equal(clampSidePanel("record", null, 1600), SIDE_PANEL_WIDTH.record.fallback);
  assert.equal(clampSidePanel("pdf", null, 1600), SIDE_PANEL_WIDTH.pdf.fallback);
  assert.equal(clampSidePanel("record", 200, 1600), 360);
  assert.equal(clampSidePanel("record", 1400, 1600), 960);
  assert.equal(sidePanelMax("pdf", 1600), 960);
  // A narrow window: the minimum wins over the share.
  assert.equal(clampSidePanel("pdf", null, 500), 360);
  assert.equal(clampSidePanel("pdf", Number.NaN, 1600), SIDE_PANEL_WIDTH.pdf.fallback);
  const store = memory();
  assert.equal(readSidePanelWidth("pdf", store), null);
  writeSidePanelWidth("pdf", 612.4, store);
  assert.equal(readSidePanelWidth("pdf", store), 612);
  assert.equal(readSidePanelWidth("record", store), null, "each kind its own width");
  writeSidePanelWidth("pdf", null, store);
  assert.equal(readSidePanelWidth("pdf", store), null);
  store.setItem(SIDE_PANEL_WIDTH.record.key, "garbage");
  assert.equal(readSidePanelWidth("record", store), null);
  // Without storage (private mode, blocked): the defaults, no error.
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  assert.equal(readSidePanelWidth("pdf", broken), null);
  assert.doesNotThrow(() => writeSidePanelWidth("pdf", 500, broken));
});

test("records dock beside timelines by default, beside tables, boards and lists when asked", () => {
  assert.equal(recordDocks("timeline", undefined), true);
  assert.equal(recordDocks("timeline", "over"), false);
  for (const type of ["table", "board", "list"]) {
    assert.equal(recordDocks(type, undefined), false, type);
    assert.equal(recordDocks(type, "beside"), true, type);
  }
  assert.equal(recordDocks("calendar", "beside"), false);
  assert.equal(recordDocks("gallery", "beside"), false);
});

test("↑/↓ in the docked panel: the record before or after in the view's order", () => {
  const ids = ["a", "b", "b", "c", "a"];
  assert.equal(neighbourRecord(ids, "a", 1), "b");
  assert.equal(neighbourRecord(ids, "b", 1), "c");
  assert.equal(neighbourRecord(ids, "b", -1), "a");
  assert.equal(neighbourRecord(ids, "a", -1), null);
  assert.equal(neighbourRecord(ids, "c", 1), null);
  assert.equal(neighbourRecord(ids, "gone", 1), null);
});

test("one docked panel at a time: a new claim closes the one before; KI fragen evicts it", () => {
  let changes = 0;
  const off = subscribeDock(() => changes++);
  const closed: string[] = [];
  claimDock({ owner: "record:x", kind: "record", width: 520, docked: true, onEvict: () => closed.push("record") });
  assert.deepEqual(dockState(), { owner: "record:x", kind: "record", width: 520, docked: true });
  const before = dockState();
  // The same claim again changes nothing (no new state, no render).
  claimDock({ owner: "record:x", kind: "record", width: 520, docked: true });
  assert.equal(dockState(), before);
  updateDock("record:x", { width: 600 });
  assert.equal(dockState()?.width, 600);
  updateDock("someone-else", { width: 100 });
  assert.equal(dockState()?.width, 600);
  claimDock({ owner: "pdf-panel", kind: "pdf", width: 560, docked: true, onEvict: () => closed.push("pdf") });
  assert.deepEqual(closed, ["record"]);
  assert.equal(dockState()?.kind, "pdf");
  // The record's late release does not take the PDF's column.
  releaseDock("record:x");
  assert.equal(dockState()?.owner, "pdf-panel");
  evictDock();
  assert.deepEqual(closed, ["record", "pdf"]);
  assert.equal(dockState(), null);
  evictDock();
  assert.ok(changes >= 4);
  off();
});

test("regions of PDF pages: the box, free shapes or rectangles, a sharp but bounded scale", () => {
  const page = { width: 600, height: 800 };
  // A quick diagonal drag: the whole box.
  const drag = lassoRegion([{ x: 100, y: 100 }, { x: 200, y: 150 }, { x: 300, y: 260 }], page)!;
  assert.deepEqual(drag.box, { x: 100, y: 100, w: 200, h: 160 });
  assert.equal(drag.freeform, false);
  assert.deepEqual(drag.points, []);
  // Drawn around: a free shape, kept on the page.
  const ring = lassoRegion([{ x: 100, y: 100 }, { x: 400, y: 90 }, { x: 420, y: 400 }, { x: 90, y: 420 }, { x: -20, y: 200 }], page)!;
  assert.equal(ring.freeform, true);
  assert.equal(ring.box.x, 0);
  assert.equal(ring.points.length, 5);
  assert.ok(ring.points.every((p) => p.x >= 0 && p.y >= 0));
  // Too small to be meant.
  assert.equal(lassoRegion([{ x: 10, y: 10 }, { x: 14, y: 40 }], page), null);
  assert.equal(lassoRegion([{ x: 10, y: 10 }], page), null);
  // About 1600 px across, 2–6 times the points, at most 12 megapixels.
  assert.equal(clipScale({ w: 800, h: 100 }), 2);
  assert.equal(clipScale({ w: 100, h: 100 }), 6);
  const big = clipScale({ w: 595, h: 842 });
  assert.ok(big * big * 595 * 842 <= 12_000_000 + 1);
});

test("clips wait under an id; links back to the PDF page", () => {
  const blob = new Blob(["png"], { type: "image/png" });
  const clip = putClip({ blob, width: 10, height: 10, points: { width: 5, height: 5 }, src: "/api/files/x", title: "Vertrag.pdf", page: 3 });
  assert.equal(getClip(clip.id), clip);
  assert.equal(getClip("nope"), null);
  for (let i = 0; i < 6; i++) putClip({ blob, width: 1, height: 1, points: { width: 1, height: 1 }, src: "/api/files/x", title: "", page: 1 });
  assert.equal(getClip(clip.id), null, "only the latest few wait");
  const fid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  assert.equal(pdfFileId(`/api/files/${fid}`), fid);
  assert.equal(pdfFileId(`/api/share/tok/files/${fid}`), null);
  assert.equal(clipHref(`/api/files/${fid}`, 3.7), `/api/files/${fid}#pdf-page=3`);
  assert.deepEqual(pdfPageLink(`/api/files/${fid}#pdf-page=12`), { src: `/api/files/${fid}`, page: 12 });
  assert.deepEqual(pdfPageLink(`/api/share/tok/files/${fid}#pdf-page=2`), { src: `/api/share/tok/files/${fid}`, page: 2 });
  assert.equal(pdfPageLink(`/api/files/${fid}#pdf-page=0`), null);
  assert.equal(pdfPageLink(`/api/files/${fid}#page=2`), null, "#page= is an address of a Flowplan page");
  assert.equal(pdfPageLink(`https://example.test/a.pdf#pdf-page=2`), null);
  assert.equal(clipFileName("Vertrag.pdf", 3), "Vertrag – 3.png");
  assert.equal(clipFileName('a/b:c?.pdf', 1), "a b c – 1.png");
  assert.equal(clipFileName("", 2), "PDF – 2.png");
});

test("Einfügen goes to the notebook or document touched last that is still on screen", async () => {
  const el = (connected = true) => ({ isConnected: connected }) as unknown as HTMLElement;
  const got: string[] = [];
  const target = (id: string, element: HTMLElement) => ({ id, element: () => element, insert: async () => (got.push(id), true) });
  assert.equal(clipTarget(), null);
  const offA = registerClipTarget(target("a", el()));
  const offB = registerClipTarget(target("b", el()));
  assert.equal(clipTarget()?.id, "b");
  touchClipTarget("a");
  assert.equal(clipTarget()?.id, "a");
  const offC = registerClipTarget(target("c", el(false)));
  assert.equal(clipTarget()?.id, "a", "not on screen");
  await clipTarget()!.insert(null as never);
  assert.deepEqual(got, ["a"]);
  offA();
  assert.equal(clipTarget()?.id, "b");
  offB();
  offC();
  assert.equal(clipTarget(), null);
});

test("a picture taken from a PDF keeps its source; copies point it to the copied PDF", () => {
  const file = "11111111-2222-4333-8444-555555555555",
    pdf = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const item = cleanItem({ id: "p1", type: "image", x: 1, y: 2, w: 30, h: 40, file, source: { file: pdf.toUpperCase(), page: 3.9, title: " Vertrag.pdf\n" } }) as InkImage;
  assert.deepEqual(item.source, { file: pdf, page: 3, title: "Vertrag.pdf" });
  // Unusable sources go, the picture stays.
  assert.equal((cleanItem({ id: "p2", type: "image", x: 1, y: 2, w: 3, h: 4, file, source: { file: "x", page: 1 } }) as InkImage).source, undefined);
  assert.equal((cleanItem({ id: "p3", type: "image", x: 1, y: 2, w: 3, h: 4, file, source: { file: pdf, page: 0 } }) as InkImage).source, undefined);
  assert.equal((cleanItem({ id: "p4", type: "image", x: 1, y: 2, w: 3, h: 4, sticker: "star", source: { file: pdf, page: 1 } }) as InkImage).source, undefined);
  const doc = parseInk(serializeInk(parseInk({ pages: { s1: [item] } })));
  assert.deepEqual((doc.pages.s1[0] as InkImage).source, item.source);
  const copyFile = "99999999-2222-4333-8444-555555555555",
    copyPdf = "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const both = mapInkFiles(doc, (f) => (f === file ? copyFile : f === pdf ? copyPdf : null));
  assert.deepEqual((both.pages.s1[0] as InkImage).source, { file: copyPdf, page: 3, title: "Vertrag.pdf" });
  assert.equal((both.pages.s1[0] as InkImage).file, copyFile);
  // The PDF not copied: the picture stays without its caption.
  const only = mapInkFiles(doc, (f) => (f === file ? copyFile : null));
  assert.equal((only.pages.s1[0] as InkImage).source, undefined);
});

test("published pages: record links of the database shown", () => {
  const here = { origin: "https://flow.example", pathname: "/share/tok/page1" };
  assert.deepEqual(recordLinkOf("/share/tok/page1?row=r1&view=v2", here), { url: "/share/tok/page1?row=r1&view=v2", row: "r1" });
  assert.deepEqual(recordLinkOf("?row=r2", here), { url: "/share/tok/page1?row=r2", row: "r2" });
  assert.equal(recordLinkOf("/share/tok/other?row=r1", here), null);
  assert.equal(recordLinkOf("https://elsewhere.example/share/tok/page1?row=r1", here), null);
  assert.equal(recordLinkOf("/share/tok/page1?view=v2", here), null);
});
