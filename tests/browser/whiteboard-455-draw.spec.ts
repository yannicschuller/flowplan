import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { boardDraw, boardDrawOptions, boardView } from "./whiteboard-ui";

// #455 on the whiteboard: the pen's highlighter and opacity (remembered,
// stored per stroke), the colour wheel besides the palettes (own colours
// stay as chosen on the dark canvas) and collapsible frames (hidden
// content, connectors to the bar, moving along, synced, opened by search).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

type Item = Record<string, unknown> & { id: string };
async function setup(page: Page, title: string, items: Record<string, unknown>[] = []) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  // The demo account is shared by the specs: the canvas follows the theme.
  await command({ action: "profile.whiteboardCanvas", whiteboardCanvas: "theme" });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  const ids: string[] = [];
  if (items.length) {
    const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Buffer.from(data.whiteboard.state, "base64"));
    const before = Y.encodeStateVector(ydoc);
    for (const props of items) {
      const id = (props.id as string) || randomUUID();
      const map = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(props)) if (k !== "id") map.set(k, v);
      ydoc.getMap("items").set(id, map);
      ids.push(id);
    }
    await command({
      action: "whiteboard.sync",
      pageId: board.id,
      generation: data.whiteboard.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64"),
    });
  }
  return { board, ids };
}
// The board's items as the server has them.
async function stored(page: Page, boardId: string): Promise<Item[]> {
  const data = await (await page.request.get(`/api/pages/${boardId}`)).json();
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(data.whiteboard.state, "base64"));
  const out: Item[] = [];
  ydoc.getMap<Y.Map<unknown>>("items").forEach((value, id) => out.push({ ...(value.toJSON() as Record<string, unknown>), id }));
  return out;
}
// Opens the board with world (0, 0) at the canvas's top left corner.
async function open(page: Page, boardId: string) {
  await page.addInitScript(([key, value]) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }, [`flowplan-board-view:${boardId}`, JSON.stringify({ x: 0, y: 0, zoom: 1 })] as const);
  await page.goto(`/#page=${boardId}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  // The board's code loads on first use (slow on a busy machine).
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const at = async (x: number, y: number) => {
    const box = (await canvas.boundingBox())!;
    return { x: box.x + x, y: box.y + y };
  };
  return { wb, at };
}

test("highlighter with its opacity: drawn, stored per stroke, remembered", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Textmarker ${Date.now()}`, [
    { type: "image", x: 100, y: 100, w: 300, h: 200, z: 1, src: "https://example.test/none.png" },
  ]);
  const { wb, at } = await open(page, board.id);
  await boardDraw(wb, "Stift");
  const menu = wb.locator(".wb-pen-menu");
  await menu.getByRole("button", { name: "Textmarker", exact: true }).click();
  await expect(menu.getByRole("button", { name: "Textmarker", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The highlighter starts at 35 %; the slider sets 50 %.
  await expect(menu.getByRole("slider", { name: "Deckkraft" })).toHaveValue("35");
  await menu.getByRole("slider", { name: "Deckkraft" }).fill("50");
  await expect(menu.locator(".wb-pen-opacity output")).toHaveText("50 %");
  const start = await at(150, 200);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 200, start.y + 10, { steps: 12 });
  await page.mouse.up();
  const stroke = wb.locator(".wb-pen path.wb-pen-highlight");
  await expect(stroke).toHaveCount(1);
  await expect(stroke).toHaveAttribute("opacity", "0.5");
  expect(await stroke.evaluate((el) => getComputedStyle(el).mixBlendMode)).toBe("multiply");
  await expect
    .poll(async () => (await stored(page, board.id)).find((i) => i.type === "pen"))
    .toMatchObject({ highlight: true, opacity: 0.5, strokeWidth: 20, stroke: "#ffd43b" });

  // The pen keeps its own setting; back to the highlighter after a reload.
  await menu.getByRole("button", { name: "Normaler Stift", exact: true }).click();
  await expect(menu.getByRole("slider", { name: "Deckkraft" })).toHaveValue("100");
  await menu.getByRole("button", { name: "Textmarker", exact: true }).click();
  await page.reload();
  await expect(wb.locator(".wb-pen path.wb-pen-highlight")).toHaveCount(1);
  await boardDrawOptions(wb);
  await expect(menu.getByRole("button", { name: "Textmarker", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(menu.getByRole("slider", { name: "Deckkraft" })).toHaveValue("50");

  // A selected stroke: its opacity in the style bar.
  await wb.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+a");
  const bar = wb.getByRole("toolbar", { name: "Element gestalten" });
  await bar.getByLabel("Deckkraft").selectOption("75");
  await expect(wb.locator(".wb-pen path")).toHaveAttribute("opacity", "0.75");
  expect(errors).toEqual([]);
});

test("colour wheel: own colours on notes and strokes, kept as chosen on the dark canvas", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const { board, ids } = await setup(page, `Eigene Farben ${Date.now()}`, [
    { type: "sticky", x: 60, y: 60, w: 160, h: 160, z: 1, fill: "#fff6b6", text: "Farbig" },
    { type: "pen", x: 300, y: 60, w: 200, h: 100, z: 2, points: [0, 0, 1, 1], stroke: "#0b0b0b", strokeWidth: 5, ownColors: ["#0b0b0b"] },
    { type: "pen", x: 300, y: 200, w: 200, h: 100, z: 3, points: [0, 0, 1, 1], stroke: "#000000", strokeWidth: 5 },
  ]);
  const { wb } = await open(page, board.id);
  await wb.locator(".wb-sticky", { hasText: "Farbig" }).click();
  const bar = wb.getByRole("toolbar", { name: "Element gestalten" });
  await bar.getByRole("button", { name: "Eigene Zettelfarbe", exact: true }).click();
  const dialog = wb.getByRole("dialog", { name: "Eigene Zettelfarbe" });
  await expect(dialog.locator(".color-picker")).toBeVisible();
  const hex = dialog.locator(".color-picker-hex input");
  await hex.fill("#3a7bd5");
  await hex.press("Enter");
  await expect(wb.locator(`g[data-item="${ids[0]}"] rect`).first()).toHaveAttribute("fill", "#3a7bd5");
  await expect
    .poll(async () => (await stored(page, board.id)).find((i) => i.id === ids[0]))
    .toMatchObject({ fill: "#3a7bd5", ownColors: ["#3a7bd5"] });
  // Remembered among the recent colours of this device.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await bar.getByRole("button", { name: "Eigene Zettelfarbe", exact: true }).click();
  await expect(dialog.locator(".color-picker-recent").getByRole("button", { name: "Farbe #3a7bd5" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Dark canvas: the own colour as chosen, the other dark ink lightened.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(wb.locator(`g[data-item="${ids[1]}"] path`)).toHaveAttribute("stroke", "#0b0b0b");
  await expect(wb.locator(`g[data-item="${ids[2]}"] path`)).not.toHaveAttribute("stroke", "#000000");
  await expect(wb.locator(`g[data-item="${ids[0]}"] rect`).first()).toHaveAttribute("fill", "#3a7bd5");
  await page.emulateMedia({ colorScheme: "light" });
});

test("collapsible frames: hidden content, connector to the bar, moving, sync, search", async ({ page, browser }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const frameId = randomUUID(),
    noteId = randomUUID(),
    shapeId = randomUUID();
  const { board } = await setup(page, `Einklappen ${Date.now()}`, [
    { id: frameId, type: "frame", x: 40, y: 80, w: 400, h: 300, z: -1, text: "Abschnitt" },
    { id: noteId, type: "sticky", x: 80, y: 140, w: 120, h: 100, z: 1, text: "Drinnen" },
    { id: shapeId, type: "shape", shape: "rectangle", x: 600, y: 140, w: 120, h: 80, z: 2, text: "Draußen" },
    { type: "connector", x: 0, y: 0, w: 0, h: 0, z: 3, from: { id: noteId, x: 0, y: 0 }, to: { id: shapeId, x: 0, y: 0 } },
  ]);
  const { wb, at } = await open(page, board.id);
  const note = wb.locator(".wb-sticky", { hasText: "Drinnen" });
  await expect(note).toBeVisible();
  await wb.getByRole("button", { name: "„Abschnitt“ einklappen" }).click();
  await expect(note).toHaveCount(0);
  await expect(wb.locator(".wb-frame-folded")).toHaveText("1 Element eingeklappt");
  // The connector now ends at the collapsed frame's bar.
  await expect(wb.locator(".wb-connector")).toHaveCount(1);
  await expect
    .poll(async () => (await stored(page, board.id)).find((i) => i.id === frameId)?.collapsed)
    .toEqual([noteId]);
  const frame = (await stored(page, board.id)).find((i) => i.id === frameId)!;
  expect(frame.h).toBe(300);

  // Someone else sees it collapsed.
  const other = await browser.newPage({ storageState: await page.context().storageState() });
  await other.goto(`${origin}/#page=${board.id}`);
  const otherWb = other.getByLabel("Whiteboard", { exact: true });
  await expect(otherWb.locator(".wb-frame-folded")).toBeVisible();
  await expect(otherWb.locator(".wb-sticky", { hasText: "Drinnen" })).toHaveCount(0);
  await other.close();

  // Moving the bar moves what it hides.
  const bar = await at(240, 98);
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.keyboard.down("Alt");
  await page.mouse.move(bar.x + 100, bar.y + 60, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect
    .poll(async () => (await stored(page, board.id)).find((i) => i.id === noteId)?.x)
    .toBe(180);
  expect((await stored(page, board.id)).find((i) => i.id === noteId)?.y).toBe(200);

  // The style bar of the selected frame opens it again; the frames panel folds it.
  await wb.getByRole("toolbar", { name: "Element gestalten" }).getByRole("button", { name: "Rahmen aufklappen" }).click();
  await expect(note).toBeVisible();
  await page.keyboard.press("Escape");
  await wb.getByRole("button", { name: "„Abschnitt“ einklappen" }).click();
  await expect(note).toHaveCount(0);

  // A search hit inside opens the frame.
  await wb.click({ position: { x: 900, y: 600 } });
  await page.keyboard.press("Control+f");
  await page.getByRole("searchbox", { name: "Suchbegriff" }).fill("Drinnen");
  await expect(note).toBeVisible();
  // … only for the person who searched: the board keeps it collapsed.
  await page.waitForTimeout(1500);
  expect((await stored(page, board.id)).find((i) => i.id === frameId)?.collapsed).toEqual([noteId]);
  expect(errors).toEqual([]);
});

test("collapsed frames: presenting opens one for the presenter only, its own export shows it all, deleting takes what it hides", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const frameId = randomUUID(),
    noteId = randomUUID(),
    openId = randomUUID(),
    otherNote = randomUUID();
  const { board } = await setup(page, `Eingeklappt präsentieren ${Date.now()}`, [
    { id: frameId, type: "frame", x: 40, y: 80, w: 400, h: 300, z: -2, text: "Zu", collapsed: [noteId] },
    { id: noteId, type: "sticky", x: 80, y: 140, w: 300, h: 200, z: 1, text: "Versteckt", fill: "#e03131" },
    { id: openId, type: "frame", x: 600, y: 80, w: 300, h: 200, z: -1, text: "Offen" },
    { id: otherNote, type: "sticky", x: 640, y: 120, w: 120, h: 100, z: 2, text: "Sichtbar" },
  ]);
  const { wb, at } = await open(page, board.id);
  const hidden = wb.locator(".wb-sticky", { hasText: "Versteckt" });
  await expect(wb.locator(".wb-frame-folded")).toBeVisible();
  await expect(hidden).toHaveCount(0);

  // Presenting opens it for the presenter; the board keeps it collapsed.
  await wb.getByRole("button", { name: "Präsentieren", exact: true }).first().click();
  await expect(hidden).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await stored(page, board.id)).find((i) => i.id === frameId)?.collapsed).toEqual([noteId]);
  // When the presentation ends it is collapsed again.
  await wb.getByRole("button", { name: "Präsentation beenden" }).click();
  await expect(hidden).toHaveCount(0);
  await expect(wb.locator(".wb-frame-folded")).toBeVisible();
  // (Back to the view at 100 % for the clicks below.)
  await page.reload();
  await expect(wb.locator(".wb-frame-folded")).toBeVisible();

  // Its own export (one frame, a page per frame) shows all it holds; the
  // whole board keeps the bar.
  await boardView(wb, "Exportieren … (PNG, SVG, PDF)");
  const exporting = page.getByRole("dialog", { name: "Exportieren" });
  await exporting.getByLabel("Was exportieren").selectOption({ label: "Rahmen: Zu" });
  await exporting.getByRole("radio", { name: "1×" }).click();
  const [png] = await Promise.all([page.waitForEvent("download"), exporting.getByRole("button", { name: "Exportieren" }).click()]);
  const image = (await import("node:fs")).readFileSync((await png.path())!);
  expect(image.readUInt32BE(20)).toBe(300 + 48);
  const red = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 190 && pixels[i + 1] < 90 && pixels[i + 2] < 90) count++;
    return count;
  }, image.toString("base64"));
  expect(red).toBeGreaterThan(20_000);
  // Still collapsed on the board afterwards.
  await expect(hidden).toHaveCount(0);
  await boardView(wb, "Exportieren … (PNG, SVG, PDF)");
  await exporting.getByRole("radio", { name: "PDF" }).click();
  await exporting.getByLabel("Was exportieren").selectOption("board");
  await exporting.getByRole("radio", { name: "Eine Seite pro Rahmen" }).click();
  const [pdf] = await Promise.all([page.waitForEvent("download"), exporting.getByRole("button", { name: "Exportieren" }).click()]);
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load((await import("node:fs")).readFileSync((await pdf.path())!));
  // The collapsed frame's page has the whole frame (424 × 348 px → 318 × 261 pt).
  const sizes = doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  expect(sizes).toContainEqual([318, 261]);
  await expect(hidden).toHaveCount(0);

  // Deleting the collapsed frame deletes what it hides; one undo brings back all.
  const bar = await at(240, 98);
  await page.mouse.click(bar.x, bar.y);
  await page.keyboard.press("Delete");
  await expect(wb.locator(".wb-frame-folded")).toHaveCount(0);
  await expect(hidden).toHaveCount(0);
  await expect.poll(async () => (await stored(page, board.id)).map((i) => i.id).sort()).toEqual([openId, otherNote].sort());
  await page.keyboard.press("ControlOrMeta+z");
  await expect(wb.locator(".wb-frame-folded")).toBeVisible();
  await expect.poll(async () => (await stored(page, board.id)).map((i) => i.id).sort()).toEqual([frameId, noteId, openId, otherNote].sort());
  // An open frame leaves its content.
  await wb.locator(".wb-frame-title", { hasText: "Offen" }).click();
  await page.keyboard.press("Delete");

  await expect.poll(async () => (await stored(page, board.id)).some((i) => i.id === openId)).toBe(false);
  await expect(wb.locator(".wb-sticky", { hasText: "Sichtbar" })).toBeVisible();
  expect(errors).toEqual([]);
});
