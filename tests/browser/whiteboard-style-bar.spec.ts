import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";

// The selection's style bar on a narrow board (components/whiteboard/
// whiteboard.tsx, lib/whiteboard-style-bar.ts): wrapped to two or three
// rows, it lay on the connector or on the text being typed in, and near the
// board's top it was pushed onto the element. It goes above the selection
// when it fits, else below it, and stays on the board.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.WB_BAR_SHOTS;

type Box = { x: number; y: number; width: number; height: number };
const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const within = (a: Box, b: Box) =>
  a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;

// World coordinates of the two elements.
const CONNECTOR = { x1: 0, y1: 0, x2: 240, y2: 0 };
const TEXT = { x: 400, y: 0, w: 180, h: 32 };

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const create = (title: string, kind: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind });
  const tag = Date.now();
  const board = await create(`Stilleiste ${tag}`, "whiteboard");
  const doc = await create(`Notizen ${tag}`, "document");
  const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(data.whiteboard.state, "base64"));
  const before = Y.encodeStateVector(ydoc);
  const add = (props: Record<string, unknown>) => {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(props)) map.set(k, v);
    ydoc.getMap("items").set(randomUUID(), map);
  };
  const { x1, y1, x2, y2 } = CONNECTOR;
  add({ type: "connector", x: x1, y: y1, w: x2 - x1, h: 0, z: 1, from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
  add({ type: "text", ...TEXT, z: 2, text: "Rechts oben", fontSize: 16 });
  add({ type: "sticky", x: 0, y: 360, w: 160, h: 160, z: 3, text: "Weiter unten" });
  await command({
    action: "whiteboard.sync",
    pageId: board.id,
    generation: data.whiteboard.generation,
    update: Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64"),
  });
  return { board, doc, command };
}

// The board opens with this view (the last view on this device).
async function openAt(page: Page, boardId: string, url: string, view: { x: number; y: number; zoom: number }) {
  await page.addInitScript(([key, value]) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }, [
    `flowplan-board-view:${boardId}`,
    JSON.stringify(view),
  ] as const);
  await page.goto("about:blank");
  await page.goto(url);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();
  await expect(wb.locator("g.wb-text", { hasText: "Rechts oben" })).toBeVisible();
  return wb;
}

async function expectClear(wb: Locator, label: string, element: Locator) {
  const bar = wb.getByRole("toolbar", { name: "Element gestalten" });
  await expect(bar).toBeVisible();
  // Past the bar's scale-in (menu-in), its box is final.
  await bar.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const barBox = (await bar.boundingBox())!;
  const canvas = (await wb.boundingBox())!;
  const box = (await element.boundingBox())!;
  expect(intersects(barBox, box), `${label}: bar ${JSON.stringify(barBox)} on ${JSON.stringify(box)}`).toBe(false);
  expect(within(barBox, canvas), `${label}: bar ${JSON.stringify(barBox)} outside ${JSON.stringify(canvas)}`).toBe(true);
  return barBox;
}

// A connector near the board's top and a text near its right edge, selected
// and (the text) edited, at the given zoom.
async function checkBoard(page: Page, boardId: string, url: string, zoom: number, label: string, wide: () => Promise<number>) {
  // The connector 24 px below the board's top edge.
  let wb = await openAt(page, boardId, url, { x: -40 / zoom, y: -24 / zoom, zoom });
  const width = await wide();
  const canvas = (await wb.locator(".wb-canvas").boundingBox())!;
  await page.mouse.click(canvas.x + 40 + ((CONNECTOR.x2 - CONNECTOR.x1) / 2) * zoom, canvas.y + 24);
  const selection = wb.locator(".wb-selection");
  await expect(selection).toBeVisible();
  const bar = await expectClear(wb, `${label} connector`, selection);
  // A connector's bar wraps on a board this narrow (the case of the report).
  await expect(wb).not.toHaveClass(/wb-layout-dock/);
  if (width < 700) expect(bar.height, `${label}: wrapped`).toBeGreaterThan(50);
  if (shots) await page.screenshot({ path: `${shots}-${label}-connector.png` });
  // Its Start/End lists open in view.
  const end = wb.getByRole("toolbar", { name: "Element gestalten" }).getByRole("combobox", { name: "Linienende" });
  if (await end.count()) {
    await end.locator("xpath=..").click();
    const list = page.locator(".fp-select-list");
    await expect(list).toBeVisible();
    const listBox = (await list.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(listBox.y).toBeGreaterThanOrEqual(0);
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
  }

  // The text 60 px below the top (below the "Moderation" button), its right
  // edge 16 px inside the board's: no room above for a wrapped bar.
  wb = await openAt(page, boardId, url, {
    x: TEXT.x + TEXT.w - (width - 16) / zoom,
    y: TEXT.y - 60 / zoom,
    zoom,
  });
  // Clicked at its first word (its box reaches past the text).
  const board = (await wb.locator(".wb-canvas").boundingBox())!;
  const at = { x: board.x + width - 16 - (TEXT.w - 30) * zoom, y: board.y + 60 + (TEXT.h / 2) * zoom };
  await page.mouse.click(at.x, at.y);
  await expect(selection).toBeVisible();
  await expectClear(wb, `${label} text`, selection);
  // Typing in it: the field stays free as well.
  await page.mouse.dblclick(at.x, at.y);
  const field = wb.locator("textarea.wb-editor");
  await expect(field).toBeFocused();
  await page.keyboard.type(" und mehr");
  await expectClear(wb, `${label} text field`, field);
  await expectClear(wb, `${label} text in editing`, selection);
  if (shots) await page.screenshot({ path: `${shots}-${label}-text.png` });
  await page.keyboard.press("Escape");
}

test("the style bar of a narrow board leaves the selected connector and text free", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Mouse; phones keep the bar in one row at the top");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board, doc, command } = await setup(page);
  const boardWidth = async () => (await page.getByLabel("Whiteboard", { exact: true }).boundingBox())!.width;

  // Next to a document (split view): a board about 600 px wide.
  await page.setViewportSize({ width: 1700, height: 900 });
  const split = `/?split=${board.id}#page=${doc.id}`;
  for (const zoom of [1, 1.5]) await checkBoard(page, board.id, split, zoom, `split-${zoom}`, boardWidth);

  // The board as a page in a narrow window, also zoomed out.
  await page.setViewportSize({ width: 900, height: 800 });
  for (const zoom of [1, 0.75]) await checkBoard(page, board.id, `/#page=${board.id}`, zoom, `page-${zoom}`, boardWidth);

  // Full screen.
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await wb.getByRole("button", { name: "Ansicht und Aktionen" }).click();
  await wb.getByRole("dialog", { name: "Ansicht und Aktionen" }).getByRole("button", { name: "Vollbild", exact: true }).click();
  await expect(wb).toHaveClass(/wb-fullscreen/);
  const canvas = (await wb.locator(".wb-canvas").boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  const sticky = wb.locator(".wb-sticky", { hasText: "Weiter unten" });
  await sticky.click();
  await expect(wb.locator(".wb-selection")).toBeVisible();
  await expectClear(wb, "fullscreen sticky", wb.locator(".wb-selection"));
  // The arrange menu of two selected elements opens on the board.
  await page.keyboard.press("ControlOrMeta+a");
  const bar = wb.getByRole("toolbar", { name: "Element gestalten" });
  await bar.getByRole("button", { name: "Anordnen", exact: true }).click();
  const menu = bar.locator(".wb-arrange-menu");
  await expect(menu).toBeVisible();
  expect(within((await menu.boundingBox())!, (await wb.boundingBox())!)).toBe(true);
  expect(intersects((await menu.boundingBox())!, (await bar.boundingBox())!)).toBe(false);

  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: doc.id });
  await command({ action: "page.delete", pageId: board.id });
});
