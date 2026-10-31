import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { samplePdf } from "../helpers/pdf";

// Notebooks (components/notebook) and drawing blocks (components/ink/
// draw-block-editor.tsx): sheets, pen input from the browser itself
// (DevTools protocol, as on a tablet), saving while writing, paper, PDF
// import and export, and handwriting recognition through a stubbed
// window.FlowplanApp.recognizeInk (the contract of lib/ink/recognition.ts).
test.use({ hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.NOTEBOOK_SCREENSHOTS || "";
type Point = { x: number; y: number };

async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.3, ...base });
  for (const [i, p] of points.slice(1).entries())
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.3 + (i % 6) * 0.1, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const path = (from: Point, to: Point, steps = 14) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 5 }));
async function lasso(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const ring = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
    { x: box.x, y: box.y + 1 },
  ];
  await page.mouse.move(ring[0].x, ring[0].y);
  await page.mouse.down();
  for (const p of ring.slice(1)) await page.mouse.move(p.x, p.y, { steps: 5 });
  await page.mouse.up();
}

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const create = async (title: string, kind: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  return { boot, command, create };
}
const sheet = (page: Page, n: number) => page.locator(".notebook-sheet").nth(n);
const strokes = (scope: ReturnType<Page["locator"]>) => scope.locator(".ink-strokes > path:not(.ink-draft):not(.ink-lasso)");
async function openNotebook(page: Page, id: string, sheets = 1) {
  await page.goto(`/#page=${id}`);
  await expect(page.locator(".notebook-sheet")).toHaveCount(sheets, { timeout: 30_000 });
  return page.getByRole("toolbar", { name: "Schreibwerkzeuge" });
}

test("notebook: add and reorder sheets, write with the pen, reload, change paper, export as PDF", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pen input runs on the desktop project.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create } = await setup(page);
  const id = await create(`Heft ${Date.now()}`, "notebook");
  const tools = await openNotebook(page, id);
  await expect(tools.getByRole("radio", { name: "Stift", exact: true })).toHaveAttribute("aria-checked", "true");
  const controls = page.getByRole("toolbar", { name: "Notizbuch" });
  await expect(controls.getByText("Blatt 1 von 1")).toBeVisible();

  // A second sheet at the end; the view goes there.
  await page.locator(".notebook-add-end").click();
  await expect(page.locator(".notebook-sheet")).toHaveCount(2);
  await expect(controls.getByText("Blatt 2 von 2")).toBeVisible();

  // Back to the first through the overview, then write on it with the pen; it saves itself.
  const thumbs = page.getByRole("navigation", { name: "Seitenübersicht" });
  if (!(await thumbs.isVisible())) await controls.getByRole("button", { name: "Seitenübersicht" }).click();
  await thumbs.getByRole("button", { name: "Blatt 1", exact: true }).click();
  await expect(controls.getByText("Blatt 1 von 2")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const box = (await sheet(page, 0).boundingBox())!;
  await pen(cdp, path({ x: box.x + 90, y: box.y + 140 }, { x: box.x + 380, y: box.y + 180 }));
  await expect(strokes(sheet(page, 0))).toHaveCount(1);
  await expect(strokes(sheet(page, 0)).first()).toHaveAttribute("fill", "#1f1f1f");
  await expect(controls.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });
  let data = await (await page.request.get(`/api/pages/${id}`)).json();
  const [first, second] = data.notebook.sheets.map((s: { id: string }) => s.id);
  expect(data.notebook.sheets[0].version).toBe(1);
  expect(data.notebook.sheets[0].ink.pages[first]).toHaveLength(1);

  // Reorder in the overview: the written sheet goes down, then up again with the keyboard, then down by dragging.
  await thumbs.getByRole("button", { name: "Aktionen für Blatt 1" }).click();
  await page.getByRole("menuitem", { name: "Nach unten" }).click();
  await expect(strokes(sheet(page, 1))).toHaveCount(1);
  await expect(strokes(sheet(page, 0))).toHaveCount(0);
  const order = async () => (await (await page.request.get(`/api/pages/${id}`)).json()).notebook.sheets.map((s: { id: string }) => s.id);
  await expect.poll(order).toEqual([second, first]);
  await thumbs.getByRole("button", { name: "Blatt 2", exact: true }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(strokes(sheet(page, 0))).toHaveCount(1);
  await expect.poll(order).toEqual([first, second]);
  await thumbs.locator(".notebook-thumb").nth(0).dragTo(thumbs.locator(".notebook-thumb").nth(1), { targetPosition: { x: 40, y: 150 } });
  await expect.poll(order).toEqual([second, first]);

  // After reloading, the ink is still there, on the moved sheet.
  await page.reload();
  await openNotebook(page, id, 2);
  await expect(strokes(sheet(page, 1))).toHaveCount(1);
  await expect(strokes(sheet(page, 0))).toHaveCount(0);

  // Dotted paper for the first sheet only.
  await page.getByRole("navigation", { name: "Seitenübersicht" }).getByRole("button", { name: "Blatt 1", exact: true }).click();
  await expect(controls.getByText("Blatt 1 von 2")).toBeVisible();
  await controls.getByRole("button", { name: "Papier ändern" }).click();
  const dialog = page.getByRole("dialog", { name: "Papier" });
  await dialog.getByText("Gepunktet", { exact: true }).click();
  await dialog.getByRole("button", { name: "Übernehmen" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => sheet(page, 0).locator(".notebook-paper circle").count()).toBeGreaterThan(500);
  await expect(sheet(page, 1).locator(".notebook-paper circle")).toHaveCount(0);
  data = await (await page.request.get(`/api/pages/${id}`)).json();
  expect(data.notebook.sheets[0].paper).toEqual({ template: "dotted" });

  // Export: one PDF page per sheet.
  await controls.getByRole("button", { name: "Weitere Aktionen" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Als PDF exportieren" }).click();
  const file = await (await download).path();
  const pdf = await PDFDocument.load(readFileSync(file!));
  expect(pdf.getPageCount()).toBe(2);
  expect((await download).suggestedFilename()).toMatch(/^Heft \d+\.pdf$/);
  expect(errors).toEqual([]);
});

test("a PDF becomes a notebook: one sheet per page, ink on top, exported again", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough.");
  const { create } = await setup(page);
  const id = await create(`Skript ${Date.now()}`, "notebook");
  const tools = await openNotebook(page, id);
  const controls = page.getByRole("toolbar", { name: "Notizbuch" });
  await controls.getByRole("button", { name: "Weitere Aktionen" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "PDF importieren …" }).click();
  await (await chooser).setFiles({ name: "Skript.pdf", mimeType: "application/pdf", buffer: samplePdf(["Kapitel eins", "Kapitel zwei", "Kapitel drei"]) });
  // The empty first sheet made way for the three pages.
  await expect(page.locator(".notebook-sheet")).toHaveCount(3, { timeout: 20_000 });
  await expect(page.locator(".notebook-sheet canvas.notebook-pdf")).toHaveCount(3);
  await expect.poll(() => sheet(page, 0).locator("canvas").evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(300);
  const data = await (await page.request.get(`/api/pages/${id}`)).json();
  expect(data.notebook.sheets.map((s: { background: { page: number } }) => s.background.page)).toEqual([1, 2, 3]);
  expect(data.notebook.sheets[0].background.width).toBe(612);

  // Write on page 2.
  const thumbs = page.getByRole("navigation", { name: "Seitenübersicht" });
  if (!(await thumbs.isVisible())) await controls.getByRole("button", { name: "Seitenübersicht" }).click();
  await thumbs.getByRole("button", { name: "Blatt 2", exact: true }).click();
  await expect(controls.getByText("Blatt 2 von 3")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const box = (await sheet(page, 1).boundingBox())!;
  await pen(cdp, path({ x: box.x + 80, y: box.y + 200 }, { x: box.x + 300, y: box.y + 220 }));
  await expect(strokes(sheet(page, 1))).toHaveCount(1);
  await expect(controls.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });
  await expect(tools).toBeVisible();

  await controls.getByRole("button", { name: "Weitere Aktionen" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Als PDF exportieren" }).click();
  const pdf = await PDFDocument.load(readFileSync((await (await download).path())!));
  expect(pdf.getPageCount()).toBe(3);
  expect(pdf.getPage(1).getWidth()).toBe(612);
});

test("drawing block in a document: /zeichnen, the pen draws, it is saved and comes back", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pen input runs on the desktop project.");
  const { create } = await setup(page);
  const id = await create(`Protokoll ${Date.now()}`, "document");
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.type("Skizze:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block");
  await expect(block).toHaveCount(1);
  await expect(block.locator(".ink-layer")).toHaveCount(1, { timeout: 15_000 });
  await expect(block.locator(".notebook-paper line").first()).toBeAttached();

  const cdp = await page.context().newCDPSession(page);
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  await pen(cdp, path({ x: box.x + 60, y: box.y + 60 }, { x: box.x + 300, y: box.y + 110 }));
  await expect(strokes(block)).toHaveCount(1);
  const tools = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await expect(tools.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });
  // The paper of the block: grid.
  await tools.getByRole("combobox", { name: "Papier" }).selectOption("grid");
  await tools.getByRole("button", { name: "Fertig" }).click();
  await expect(tools).toHaveCount(0);

  const blockId = await page.locator("[data-ink-block]").first().getAttribute("data-ink-block");
  const versions = await (await page.request.get(`/api/pages/${id}/ink`)).json();
  expect(versions.versions[blockId!]).toBeGreaterThanOrEqual(1);
  // The document stores only the block (id, height, paper), the ink lives apart.
  await expect.poll(async () => String((await (await page.request.get(`/api/pages/${id}`)).json()).html)).toContain(`data-ink-block="${blockId}"`);
  await expect.poll(async () => String((await (await page.request.get(`/api/pages/${id}`)).json()).html)).toContain('data-ink-paper="grid"');

  await page.reload();
  await expect(page.locator(".ink-block .ink-layer")).toHaveCount(1, { timeout: 30_000 });
  await expect(strokes(page.locator(".ink-block"))).toHaveCount(1);
});

// The iPad app's recognition, stubbed: answers every request with text;
// "convert" requests with "Hallo Welt", search requests with "Zebrastreifen".
async function stubRecognition(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __inkRequests: unknown[]; FlowplanApp: unknown };
    w.__inkRequests = [];
    w.FlowplanApp = {
      platform: "ios",
      version: "test",
      recognizeInk(request: { id: string; strokes: { points: [number, number][] }[] }) {
        w.__inkRequests.push(request);
        const xs = request.strokes.flatMap((s) => s.points.map((p) => p[0]));
        const ys = request.strokes.flatMap((s) => s.points.map((p) => p[1]));
        const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
        const text = request.id.startsWith("convert") ? "Hallo Welt" : "Zebrastreifen";
        setTimeout(() => window.dispatchEvent(new CustomEvent("flowplan:ink-recognized", { detail: { id: request.id, text, lines: [{ text, box }] } })), 30);
      },
    };
  });
}

test("handwriting recognition: search finds it, Convert to text replaces the strokes (notebook and drawing block)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pen input runs on the desktop project.");
  await stubRecognition(page);
  const { boot, create } = await setup(page);
  const id = await create(`Erkennung ${Date.now()}`, "notebook");
  const tools = await openNotebook(page, id);
  const controls = page.getByRole("toolbar", { name: "Notizbuch" });
  const cdp = await page.context().newCDPSession(page);
  const box = (await sheet(page, 0).boundingBox())!;
  await pen(cdp, path({ x: box.x + 100, y: box.y + 150 }, { x: box.x + 300, y: box.y + 160 }));
  await expect(controls.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });

  // After saving, the app was asked (pen strokes in pt of the sheet) and its text is searchable.
  const request = await page.waitForFunction(() => (window as unknown as { __inkRequests: { id: string }[] }).__inkRequests.find((r) => r.id.startsWith("search")));
  const sent = (await request.jsonValue()) as { id: string; width: number; height: number; strokes: { points: number[][] }[] };
  expect(sent.width).toBe(595.28);
  expect(sent.height).toBe(841.89);
  expect(sent.strokes).toHaveLength(1);
  expect(sent.strokes[0].points[0]).toHaveLength(2);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/search?workspace=${boot.workspace.id}&q=Zebrastreifen`)).json()) as { id: string }[]).map((r) => r.id), { timeout: 15_000 })
    .toContain(id);

  // Lasso, then Convert to text: typed text in place of the strokes; undo brings them back.
  await tools.getByRole("radio", { name: "Lasso", exact: true }).click();
  await lasso(page, { x: box.x + 80, y: box.y + 120, width: 250, height: 70 });
  const bar = page.getByRole("toolbar", { name: "Auswahl" });
  await bar.getByRole("button", { name: "In Text umwandeln" }).click();
  await expect(sheet(page, 0).locator(".ink-strokes text")).toHaveText("Hallo Welt");
  await expect(strokes(sheet(page, 0))).toHaveCount(0);
  await tools.getByRole("button", { name: "Rückgängig" }).click();
  await expect(strokes(sheet(page, 0))).toHaveCount(1);
  await expect(sheet(page, 0).locator(".ink-strokes text")).toHaveCount(0);
  await tools.getByRole("button", { name: "Wiederholen" }).click();
  await expect(sheet(page, 0).locator(".ink-strokes text")).toHaveText("Hallo Welt");

  // In a drawing block: the text becomes a paragraph below it.
  const doc = await create(`Block ${Date.now()}`, "document");
  await page.goto(`/#page=${doc}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.type("/draw");
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block");
  await expect(block.locator(".ink-layer")).toHaveCount(1, { timeout: 15_000 });
  const area = (await block.locator(".ink-block-surface").boundingBox())!;
  await pen(cdp, path({ x: area.x + 60, y: area.y + 60 }, { x: area.x + 260, y: area.y + 80 }));
  await expect(strokes(block)).toHaveCount(1);
  const blockTools = page.getByRole("toolbar", { name: "Zeichenwerkzeuge" });
  await blockTools.getByRole("radio", { name: "Lasso", exact: true }).click();
  await lasso(page, { x: area.x + 40, y: area.y + 30, width: 260, height: 80 });
  await page.getByRole("toolbar", { name: "Auswahl" }).getByRole("button", { name: "In Text umwandeln" }).click();
  await expect(strokes(block)).toHaveCount(0);
  await expect(editor.locator("p", { hasText: "Hallo Welt" })).toHaveCount(1);
  // The paragraph follows the block.
  expect(
    await editor.evaluate((el) => {
      const blockNode = el.querySelector(".ink-block-node")!;
      const paragraph = [...el.querySelectorAll("p")].find((p) => p.textContent === "Hallo Welt")!;
      return !!(blockNode.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
});

test("without the app there is no Convert to text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough.");
  const { create } = await setup(page);
  const id = await create(`Ohne App ${Date.now()}`, "notebook");
  const tools = await openNotebook(page, id);
  const cdp = await page.context().newCDPSession(page);
  const box = (await sheet(page, 0).boundingBox())!;
  await pen(cdp, path({ x: box.x + 100, y: box.y + 150 }, { x: box.x + 300, y: box.y + 160 }));
  await tools.getByRole("radio", { name: "Lasso", exact: true }).click();
  await lasso(page, { x: box.x + 80, y: box.y + 120, width: 250, height: 70 });
  const bar = page.getByRole("toolbar", { name: "Auswahl" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "In Text umwandeln" })).toHaveCount(0);
});

test("notebooks on the phone: sheets fit the width, the overview opens over them", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone layout.");
  const { create } = await setup(page);
  const id = await create(`Telefon ${Date.now()}`, "notebook");
  await page.goto(`/#page=${id}`);
  await expect(page.locator(".notebook-sheet")).toHaveCount(1, { timeout: 30_000 });
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const box = (await sheet(page, 0).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.getByRole("toolbar", { name: "Notizbuch" }).getByRole("button", { name: "Seitenübersicht" }).click();
  await expect(page.getByRole("navigation", { name: "Seitenübersicht" })).toBeVisible();
});

test("the pen settings open under the gear and inside the window, wherever the toolbar wraps it", async ({ page }, info) => {
  const { create } = await setup(page);
  const id = await create(`Einstellungen ${Date.now()}`, "notebook");
  const tools = await openNotebook(page, id);
  // Without the sidebar the gear wraps to the start of the second row (it
  // used to open 264 px to its left, off the screen); on the phone it sits
  // at the right edge of a scrolled bar.
  if (info.project.name === "desktop") await page.getByRole("button", { name: "Navigation schließen", exact: true }).click();
  const gear = tools.getByRole("button", { name: "Stifteinstellungen" });
  await gear.click();
  const menu = page.getByRole("group", { name: "Stifteinstellungen" });
  await expect(menu.getByText("Formen beim Halten begradigen")).toBeVisible();
  const view = page.viewportSize()!;
  const at = (await gear.boundingBox())!;
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(Math.abs(box.y - (at.y + at.height))).toBeLessThan(16);
  expect(box.x).toBeLessThanOrEqual(at.x + at.width);
  expect(box.x + box.width).toBeGreaterThanOrEqual(at.x);
});

test("screenshots: iPad and desktop, light and dark", async ({ page }, info) => {
  test.skip(!shots || info.project.name !== "desktop", "Only when screenshots are asked for.");
  test.setTimeout(240_000);
  const { create, command } = await setup(page);
  for (const scheme of ["light", "dark"] as const)
    for (const [name, viewport] of [
      ["ipad", { width: 1024, height: 1366 }],
      ["desktop", { width: 1440, height: 900 }],
    ] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(viewport);
      const id = await create(`Physik – Mechanik`, "notebook");
      // Dark paper with a grid in the dark screenshots.
      if (scheme === "dark") await command({ action: "notebook.paper", pageId: id, paper: { color: "dark", template: "grid" } });
      await command({ action: "notebook.sheet.add", pageId: id, paper: { template: "cornell" } });
      await openNotebook(page, id, 2);
      const controls = page.getByRole("toolbar", { name: "Notizbuch" });
      const thumbs = page.getByRole("navigation", { name: "Seitenübersicht" });
      if (!(await thumbs.isVisible())) await controls.getByRole("button", { name: "Seitenübersicht" }).click();
      await thumbs.getByRole("button", { name: "Blatt 1", exact: true }).click();
      await expect(controls.getByText("Blatt 1 von 2")).toBeVisible();
      const tools = page.getByRole("toolbar", { name: "Schreibwerkzeuge" });
      const cdp = await page.context().newCDPSession(page);
      const box = (await sheet(page, 0).boundingBox())!;
      const s = box.width / 595;
      await tools.getByRole("radio", { name: "Textmarker", exact: true }).click();
      await pen(cdp, path({ x: box.x + 96 * s, y: box.y + 108 * s }, { x: box.x + 300 * s, y: box.y + 108 * s }, 8).map((p) => ({ ...p, y: box.y + 110 * s })));
      await tools.getByRole("radio", { name: "Stift", exact: true }).click();
      await tools.getByRole("radio", { name: "Farbe #1c5fd6" }).click();
      for (let line = 0; line < 4; line++)
        await pen(cdp, path({ x: box.x + 100 * s, y: box.y + (150 + line * 40.5) * s }, { x: box.x + (330 + line * 30) * s, y: box.y + (152 + line * 40.5) * s }, 26));
      await tools.getByRole("radio", { name: "Text", exact: true }).click();
      await page.mouse.click(box.x + 100 * s, box.y + 86 * s);
      await page.keyboard.type("Newton: F = m · a");
      await page.keyboard.press("Enter");
      await expect(controls.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });
      await tools.getByRole("radio", { name: "Stift", exact: true }).click();
      await page.screenshot({ path: `${shots}/notebook-${name}-${scheme}.png` });
    }
  // A drawing block in a document, and the paper dialog.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const doc = await create("Besprechung", "document");
  await page.goto(`/#page=${doc}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.type("Skizze vom Whiteboard:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block");
  await expect(block.locator(".ink-layer")).toHaveCount(1, { timeout: 15_000 });
  const cdp = await page.context().newCDPSession(page);
  const area = (await block.locator(".ink-block-surface").boundingBox())!;
  await pen(cdp, path({ x: area.x + 60, y: area.y + 70 }, { x: area.x + 380, y: area.y + 90 }, 30));
  await pen(cdp, path({ x: area.x + 60, y: area.y + 140 }, { x: area.x + 300, y: area.y + 150 }, 30));
  await page.screenshot({ path: `${shots}/notebook-draw-block-desktop-light.png` });
});
