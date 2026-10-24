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
const strokes = (page: Page, n: number) => page.locator(`.pdf-page-wrap[data-page="${n}"] .ink-strokes > path:not(.ink-draft):not(.ink-lasso)`);

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
  await expect(page.locator('.pdf-page-wrap[data-page="2"] .ink-highlights > path:not(.ink-draft)')).toHaveCount(1);
  await expect(strokes(page, 2)).toHaveCount(0);
  // Undo and redo.
  await tools.getByRole("button", { name: "Rückgängig" }).click();
  await expect(page.locator('.pdf-page-wrap[data-page="2"] .ink-highlights > path:not(.ink-draft)')).toHaveCount(0);
  await tools.getByRole("button", { name: "Wiederholen" }).click();
  await expect(page.locator('.pdf-page-wrap[data-page="2"] .ink-highlights > path:not(.ink-draft)')).toHaveCount(1);

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
  const bar = page.getByRole("toolbar", { name: "Auswahl" });
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
