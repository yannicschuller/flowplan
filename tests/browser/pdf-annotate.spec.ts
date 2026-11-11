import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { samplePdf } from "../helpers/pdf";

// Writing on a PDF in the viewer (components/ink, lib/ink): pen with
// pressure, pen-only drawing (fingers scroll), saving as a version, the ink
// after reloading, download with annotations. Pen and touch come from the
// browser itself (DevTools protocol), as on a tablet.
test.use({ hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.INK_SCREENSHOTS || "";
type Point = { x: number; y: number };

// The document state for some HTML (lib/document-server.ts), built in a
// child process: Playwright's own module loader cannot load sanitize-html.
const htmlUpdate = (html: string) =>
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { htmlState } from "./lib/document-server.ts"; process.stdout.write(Buffer.from(htmlState(${JSON.stringify(html)})).toString("base64"));`,
    ],
    { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "ignore"] },
  ).toString();

async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.3, ...base });
  for (const [i, p] of points.slice(1).entries())
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.3 + (i % 6) * 0.1, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const path = (from: Point, to: Point, steps = 12) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 6 }));
async function finger(cdp: CDPSession, from: Point, to: Point) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function pdfPage(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  // Past the introduction new accounts see first.
  await command({ action: "profile.onboarded" });
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  const uploaded = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId: p.id, file: { name: "Vertrag.pdf", mimeType: "application/pdf", buffer: samplePdf(["Seite eins", "Seite zwei"]) } },
  });
  const { url } = await uploaded.json();
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: p.id,
    generation: data.generation,
    update: htmlUpdate(`<p>Bitte unterschreiben:</p><div data-pdf="${url}" data-title="Vertrag.pdf" class="pdf-block"><a href="${url}">Vertrag.pdf</a></div>`),
  });
  return { id: p.id as string, url: url as string };
}
async function openViewer(page: Page, pageId: string) {
  await page.goto(`/#page=${pageId}`);
  const card = page.getByLabel("Dokumentinhalt", { exact: true }).getByRole("button", { name: "PDF „Vertrag.pdf“ öffnen" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const viewer = page.getByRole("dialog", { name: "Vertrag.pdf" });
  await expect(viewer.locator(".pdf-page-wrap .ink-layer")).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(() => viewer.locator("canvas.pdf-page").first().evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(300);
  return viewer;
}
const strokes = (page: Page, n: number) => page.locator(`.pdf-page-wrap[data-page="${n}"] .ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)`);

test("write on a PDF with the pen, fingers scroll, save, reload, download with annotations", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers pen and touch.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { id, url } = await pdfPage(page, `Tinte ${Date.now()}`);
  let viewer = await openViewer(page, id);
  // Nothing written yet: only the original to download.
  await expect(viewer.getByRole("button", { name: "Mit Anmerkungen herunterladen" })).toHaveCount(0);
  await viewer.getByRole("button", { name: "Anmerken" }).click();
  const tools = page.getByRole("toolbar", { name: "Werkzeuge zum Anmerken" });
  await expect(tools.getByRole("radio", { name: "Stift", exact: true })).toHaveAttribute("aria-checked", "true");
  const cdp = await page.context().newCDPSession(page);

  const first = (await page.locator('.pdf-page-wrap[data-page="1"]').boundingBox())!;
  await pen(cdp, path({ x: first.x + 80, y: first.y + 120 }, { x: first.x + 360, y: first.y + 170 }));
  await expect(strokes(page, 1)).toHaveCount(1);
  // With pressure the stroke is a filled outline.
  await expect(strokes(page, 1).first()).toHaveAttribute("fill", "#1f1f1f");
  // The first pen switched on pen-only drawing: a finger scrolls instead of drawing.
  await tools.getByRole("button", { name: "Stifteinstellungen" }).click();
  await expect(page.getByLabel("Nur mit dem Stift zeichnen")).toBeChecked();
  // Escape closes the menu, not the viewer.
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Nur mit dem Stift zeichnen")).toHaveCount(0);
  await expect(tools).toBeVisible();
  await page.waitForTimeout(700); // longer than palm rejection after the pen
  const area = viewer.locator(".pdf-viewer-pages-area");
  const scrolled = await area.evaluate((el) => el.scrollTop);
  await finger(cdp, { x: first.x + 200, y: first.y + 400 }, { x: first.x + 220, y: first.y + 250 });
  await expect(strokes(page, 1)).toHaveCount(1);
  await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrolled + 50);

  // Highlighter on page 2, after scrolling there.
  // After the finger's fling has come to rest.
  await expect
    .poll(async () => {
      const a = await area.evaluate((el) => el.scrollTop);
      await page.waitForTimeout(150);
      return (await area.evaluate((el) => el.scrollTop)) === a;
    })
    .toBe(true);
  await page.locator('.pdf-page-wrap[data-page="2"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
  await tools.getByRole("radio", { name: "Textmarker" }).click();
  const second = (await page.locator('.pdf-page-wrap[data-page="2"]').boundingBox())!;
  await pen(cdp, path({ x: second.x + 60, y: second.y + 90 }, { x: second.x + 300, y: second.y + 90 }));
  await expect(page.locator('.pdf-page-wrap[data-page="2"] .ink-highlights > g[clip-path] > path:not(.ink-draft)')).toHaveCount(1);
  await expect(strokes(page, 2)).toHaveCount(0);
  // Undo and redo.
  await tools.getByRole("button", { name: "Rückgängig" }).click();
  await expect(page.locator('.pdf-page-wrap[data-page="2"] .ink-highlights > g[clip-path] > path:not(.ink-draft)')).toHaveCount(0);
  await tools.getByRole("button", { name: "Wiederholen" }).click();
  await expect(page.locator('.pdf-page-wrap[data-page="2"] .ink-highlights > g[clip-path] > path:not(.ink-draft)')).toHaveCount(1);

  // Apple Pencil double-tap (iPad app) switches to the eraser and back.
  const tap = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("flowplan:pencil", { detail: { gesture: "tap", preferred: "switchEraser" } })));
  await tap();
  await expect(tools.getByRole("radio", { name: "Radierer" })).toHaveAttribute("aria-checked", "true");
  await tap();
  await expect(tools.getByRole("radio", { name: "Textmarker" })).toHaveAttribute("aria-checked", "true");

  // Pen-only off: a finger draws too.
  await tools.getByRole("radio", { name: "Stift", exact: true }).click();
  await tools.getByRole("button", { name: "Stifteinstellungen" }).click();
  await page.getByLabel("Nur mit dem Stift zeichnen").uncheck();
  await tools.getByRole("button", { name: "Stifteinstellungen" }).click();
  await page.waitForTimeout(700);
  await finger(cdp, { x: second.x + 80, y: second.y + 300 }, { x: second.x + 300, y: second.y + 340 });
  await expect(strokes(page, 2)).toHaveCount(1);
  await expect(tools.getByRole("status")).toHaveText("Nicht gespeichert");

  // "Fertig" saves; the ink is a version on the server.
  await tools.getByRole("button", { name: "Fertig" }).click();
  await expect(tools).toHaveCount(0);
  const stored = await (await page.request.get(`${url}/ink`)).json();
  expect(stored.version).toBe(1);
  expect(stored.canEdit).toBe(true);
  expect(Object.keys(stored.doc.pages).sort()).toEqual(["1", "2"]);
  expect(stored.doc.pages["2"].map((i: { type: string }) => i.type).sort()).toEqual(["highlighter", "pen"]);
  // Pressure was kept per point.
  const pressures = stored.doc.pages["1"][0].points.filter((_: number, i: number) => i % 3 === 2);
  expect(new Set(pressures).size).toBeGreaterThan(1);

  // Escape closes the viewer; after reloading, the ink is there for reading.
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await page.reload();
  viewer = await openViewer(page, id);
  await expect(strokes(page, 1)).toHaveCount(1);
  await expect(strokes(page, 2)).toHaveCount(1);
  await expect(page.locator(".ink-layer[data-editing]")).toHaveCount(0);

  // Download with annotations: the same pages with the ink.
  const download = page.waitForEvent("download");
  await viewer.getByRole("button", { name: "Mit Anmerkungen herunterladen" }).click();
  const file = await (await download).path();
  const pdf = await PDFDocument.load(readFileSync(file!));
  expect(pdf.getPageCount()).toBe(2);
  expect((await download).suggestedFilename()).toBe("Vertrag (mit Anmerkungen).pdf");
  // The original stays the original.
  await expect(viewer.getByRole("link", { name: "Herunterladen" })).toHaveAttribute("href", url);
  expect(errors).toEqual([]);
});

test("holding the pen snaps a line; the lasso moves and recolours it; ⌘S saves a version", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers pen and touch.");
  const { id, url } = await pdfPage(page, `Lasso ${Date.now()}`);
  await openViewer(page, id);
  await page.getByRole("button", { name: "Anmerken" }).click();
  const tools = page.getByRole("toolbar", { name: "Werkzeuge zum Anmerken" });
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator('.pdf-page-wrap[data-page="1"]').boundingBox())!;
  // A wobbly line, then the pen rests: it snaps to a straight line of two points.
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1, force: 0.5 };
  const start = { x: box.x + 60, y: box.y + 200 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, clickCount: 1, ...base });
  for (let i = 1; i <= 20; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + i * 15, y: start.y + (i % 2) * 3, ...base });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + 300, y: start.y, clickCount: 1, ...base });
  await expect(strokes(page, 1)).toHaveCount(1);
  await tools.getByRole("button", { name: "Fertig" }).click();
  await expect(tools).toHaveCount(0);
  let stored = await (await page.request.get(`${url}/ink`)).json();
  expect(stored.doc.pages["1"][0].points.length).toBe(6);
  const y0 = stored.doc.pages["1"][0].points[1];

  // Lasso around it and drag it down.
  await page.getByRole("button", { name: "Anmerken" }).click();
  await tools.getByRole("radio", { name: "Lasso" }).click();
  const ring = [
    { x: start.x - 20, y: start.y - 30 },
    { x: start.x + 330, y: start.y - 30 },
    { x: start.x + 330, y: start.y + 30 },
    { x: start.x - 20, y: start.y + 30 },
    { x: start.x - 20, y: start.y - 29 },
  ];
  await page.mouse.move(ring[0].x, ring[0].y);
  await page.mouse.down();
  for (const p of ring.slice(1)) await page.mouse.move(p.x, p.y, { steps: 5 });
  await page.mouse.up();
  // The snapped line is a shape: one shape in the loop gets the shape's own
  // bar and handles (components/ink/shape-editor.tsx), not the selection bar.
  const bar = page.getByRole("toolbar", { name: "Form bearbeiten" });
  await expect(bar).toBeVisible();
  await page.mouse.move(start.x + 150, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 150, start.y + 100, { steps: 6 });
  await page.mouse.up();
  await bar.getByRole("button", { name: "Farbe #e03131" }).click();
  await page.keyboard.press("Control+s");
  await expect(tools.getByRole("status")).toHaveText("Gespeichert");
  stored = await (await page.request.get(`${url}/ink`)).json();
  const moved = stored.doc.pages["1"][0];
  expect(moved.color).toBe("#e03131");
  expect(moved.points[1]).toBeGreaterThan(y0 + 40);
  const versions = await (await page.request.get(`${url}/ink?versions=1`)).json();
  expect(versions.versions.length).toBe(2);
});

// Two fingers zoom the pages as in notebooks (components/notebook/use-pinch-zoom.ts):
// live while they move, continuously (not in 25 % steps), anchored at the
// pinch centre, also with pen-only drawing on; the ink stays on its spot of
// the page and the pen still draws after it. On phones too, without jumping
// to 300 %.
async function pinch(cdp: CDPSession, centre: Point, from: number, to: number, steps = 10, during?: (i: number) => Promise<void>) {
  const at = (d: number) => [
    { x: centre.x - d / 2, y: centre.y, id: 1 },
    { x: centre.x + d / 2, y: centre.y, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(from)[0]] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from + ((to - from) * i) / steps) });
    await during?.(i);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
test("two fingers zoom the pages smoothly around the pinch, the ink stays on the page", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { id } = await pdfPage(page, `Zoom ${Date.now()}`);
  const viewer = await openViewer(page, id);
  await viewer.getByRole("button", { name: "Anmerken" }).click();
  const tools = page.getByRole("toolbar", { name: "Werkzeuge zum Anmerken" });
  const cdp = await page.context().newCDPSession(page);
  const wrap = page.locator('.pdf-page-wrap[data-page="1"]');
  const zoom = viewer.locator(".pdf-viewer-zoom");
  let box = (await wrap.boundingBox())!;
  const stroke = (b: { x: number; y: number; width: number }) => ({ x: b.x + b.width * 0.2, y: b.y + b.width * 0.25 });
  const s = stroke(box);
  await pen(cdp, path(s, { x: s.x + box.width * 0.4, y: s.y + 20 }));
  await expect(strokes(page, 1)).toHaveCount(1);
  // Pen-only drawing is on now: fingers do not draw, they zoom.
  await page.waitForTimeout(700);
  await expect(zoom).toHaveText("100 %");
  // Where the ink lies on the page, as fractions of it.
  const inkOnPage = async () => {
    const page1 = (await wrap.boundingBox())!;
    const ink = (await strokes(page, 1).first().boundingBox())!;
    return { x: (ink.x - page1.x) / page1.width, y: (ink.y - page1.y) / page1.height, w: ink.width / page1.width };
  };
  const before = await inkOnPage();
  const centre = { x: box.x + box.width * 0.4, y: Math.min(box.y + box.height * 0.3, (page.viewportSize()!.height * 2) / 3) };
  const spot = { x: (centre.x - box.x) / box.width, y: (centre.y - box.y) / box.height };
  // Halfway through, the pages are already drawn larger, around the fingers.
  const widths: number[] = [];
  if (shots) await page.screenshot({ path: `${shots}/pdf-pinch-${info.project.name}-1-before.png` });
  await pinch(cdp, centre, 120, 180, 10, async (i) => {
    widths.push((await wrap.boundingBox())!.width);
    if (shots && i === 5) await page.screenshot({ path: `${shots}/pdf-pinch-${info.project.name}-2-during.png` });
  });
  expect(widths[4] / box.width).toBeGreaterThan(1.2);
  expect(widths[4] / box.width).toBeLessThan(1.3);
  for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1]);
  // At the end: 150 %, not rounded to a quarter step, the spot under the fingers stays.
  await expect(zoom).toHaveText("150 %");
  await expect.poll(async () => Math.round((await wrap.boundingBox())!.width / box.width * 100)).toBe(150);
  box = (await wrap.boundingBox())!;
  expect(Math.abs(box.y + spot.y * box.height - centre.y)).toBeLessThan(4);
  // Sideways the page stays under the fingers where it can scroll there; still narrower than the window it is centred.
  const area = (await viewer.locator(".pdf-viewer-pages-area").boundingBox())!;
  if (box.width > area.width - 32) expect(Math.abs(box.x + spot.x * box.width - centre.x)).toBeLessThan(4);
  else expect(Math.abs(box.x + box.width / 2 - (area.x + area.width / 2))).toBeLessThan(10);
  expect(await page.locator(".pdf-viewer-sheets").evaluate((el) => (el as HTMLElement).style.transform)).toBe("");
  if (shots) await page.screenshot({ path: `${shots}/pdf-pinch-${info.project.name}-3-after.png` });
  // The ink lies where it lay on the page.
  const after = await inkOnPage();
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.005);
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.005);
  expect(Math.abs(after.w - before.w)).toBeLessThan(0.005);
  // A small pinch zooms a little (no 25 % steps, no jump to 300 %).
  await pinch(cdp, centre, 150, 130);
  await expect(zoom).toHaveText("130 %");
  // The buttons step on from there.
  await viewer.getByRole("button", { name: "Vergrößern" }).click();
  await expect(zoom).toHaveText("150 %");
  // The pen still writes where it touches the zoomed page.
  box = (await wrap.boundingBox())!;
  const p2 = { x: box.x + box.width * 0.3, y: Math.min(box.y + box.height * 0.5, page.viewportSize()!.height - 120) };
  await pen(cdp, path(p2, { x: p2.x + 120, y: p2.y }));
  await expect(strokes(page, 1)).toHaveCount(2);
  const drawn = (await strokes(page, 1).nth(1).boundingBox())!;
  expect(Math.abs(drawn.x - p2.x)).toBeLessThan(12);
  expect(Math.abs(drawn.y + drawn.height / 2 - p2.y)).toBeLessThan(14);
  // With fingers drawing too, two fingers zoom and leave no stroke.
  await tools.getByRole("button", { name: "Stifteinstellungen" }).click();
  await page.getByLabel("Nur mit dem Stift zeichnen").uncheck();
  await tools.getByRole("button", { name: "Stifteinstellungen" }).click();
  await page.waitForTimeout(700);
  box = (await wrap.boundingBox())!;
  await pinch(cdp, { x: box.x + Math.min(box.width * 0.5, 180), y: Math.min(box.y + box.height * 0.5, page.viewportSize()!.height - 160) }, 160, 120);
  await expect(zoom).toHaveText("113 %");
  await expect(strokes(page, 1)).toHaveCount(2);
  await expect(tools).toBeVisible();
  expect(errors).toEqual([]);
});

test("screenshots: iPad and desktop", async ({ page }, info) => {
  test.skip(!shots || info.project.name !== "desktop", "Only when screenshots are asked for.");
  test.setTimeout(240_000);
  for (const [name, viewport] of [
    ["ipad", { width: 1024, height: 1366 }],
    ["desktop", { width: 1440, height: 1000 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    const { id } = await pdfPage(page, `Bilder ${name} ${Date.now()}`);
    await page.setViewportSize(viewport);
    await openViewer(page, id);
    await page.getByRole("button", { name: "Anmerken" }).click();
    const cdp = await page.context().newCDPSession(page);
    const box = (await page.locator('.pdf-page-wrap[data-page="1"]').boundingBox())!;
    const tools = page.getByRole("toolbar", { name: "Werkzeuge zum Anmerken" });
    await tools.getByRole("radio", { name: "Textmarker" }).click();
    await pen(cdp, path({ x: box.x + 64, y: box.y + 82 }, { x: box.x + 200, y: box.y + 82 }, 6).map((p) => ({ ...p, y: box.y + 84 })));
    await tools.getByRole("radio", { name: "Stift", exact: true }).click();
    await tools.getByRole("radio", { name: "Farbe #1c5fd6" }).click();
    await pen(cdp, path({ x: box.x + 80, y: box.y + 180 }, { x: box.x + 380, y: box.y + 220 }, 24));
    await pen(cdp, path({ x: box.x + 100, y: box.y + 260 }, { x: box.x + 300, y: box.y + 240 }, 24));
    await tools.getByRole("radio", { name: "Text", exact: true }).click();
    await page.mouse.click(box.x + 90, box.y + 320);
    await page.keyboard.type("Geprüft – passt so");
    await page.keyboard.press("Enter");
    await expect(page.locator('.pdf-page-wrap[data-page="1"] .ink-strokes text')).toHaveText("Geprüft – passt so");
    await page.screenshot({ path: `${shots}/pdf-annotate-${name}.png` });
    await tools.getByRole("button", { name: "Fertig" }).click();
    await page.getByRole("dialog", { name: "Vertrag.pdf" }).getByRole("button", { name: "Schließen" }).click();
    await expect(page.getByRole("dialog", { name: "Vertrag.pdf" })).toHaveCount(0);
  }
});
