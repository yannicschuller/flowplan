import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { diagramPng } from "../helpers/png";

// #455: colours of rows and columns of a whiteboard table, links and link
// previews in cells, link cards for any web page, and the board menu's
// quick PNG export (which failed: the SVG was drawn from a blob: address,
// and Chromium taints a canvas that drew an SVG with foreignObject from
// one). Pictures of link cards and video stills are files of the board
// (POST /api/whiteboards/<id>/links): nothing loads from another site while
// the board is viewed. No network: that endpoint (demo accounts may not
// make the server fetch) and the board's picture files are answered here,
// and any request to another site fails the spec.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const RED = diagramPng(64, 48, [{ shape: "rect", x: 0, y: 0, w: 1, h: 1, color: [230, 20, 20] }]);
const BLUE = diagramPng(64, 48, [{ shape: "rect", x: 0, y: 0, w: 1, h: 1, color: [20, 40, 230] }]);
// The board's files the server stored for the previews (answered here).
const COVER = "/api/files/test-cover",
  ICON = "/api/files/test-icon",
  STILL = "/api/files/test-still";

async function setup(page: Page, title: string, items: Record<string, unknown>[] = []) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const r = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" },
  });
  expect(r.ok(), await r.text()).toBe(true);
  const board = await r.json();
  if (items.length) {
    const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Buffer.from(data.whiteboard.state, "base64"));
    const before = Y.encodeStateVector(ydoc);
    for (const props of items) {
      const map = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(props)) if (k !== "id") map.set(k, v);
      ydoc.getMap("items").set(String(props.id), map);
    }
    const synced = await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "whiteboard.sync", pageId: board.id, generation: data.whiteboard.generation, update: Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64") },
    });
    expect(synced.ok(), await synced.text()).toBe(true);
  }
  const embeds: string[] = [];
  // Previews as the server would find them, with their pictures stored.
  await page.route(new RegExp(`/api/whiteboards/${board.id}/links$`), (route) => {
    const url = (route.request().postDataJSON() as { url: string }).url;
    embeds.push(url);
    if (/youtu/.test(url))
      return route.fulfill({ json: { kind: "player", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", provider: "YouTube", image: STILL } });
    if (url.startsWith("https://example.org/"))
      return route.fulfill({
        json: { kind: "card", url, title: "Beispielseite", site: "Beispiel", description: "Eine Seite zum Testen", image: COVER, icon: ICON },
      });
    return route.fulfill({ status: 422, json: { error: "Für diese Seite gibt es keine Vorschau." } });
  });
  await page.route(/\/api\/files\/test-(cover|icon|still)$/, (route) =>
    route.fulfill({ body: route.request().url().endsWith("still") ? RED : BLUE, contentType: "image/png" }),
  );
  // Nothing of another site loads while the board is viewed.
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== new URL(origin).origin) foreign.push(request.url());
  });
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\//, (route) => route.fulfill({ body: "<p>player</p>", contentType: "text/html" }));
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();
  return { wb, embeds, foreign, board };
}
async function placeTable(page: Page, wb: Locator, dx = 0, dy = 0) {
  await wb.getByRole("button", { name: "Tabelle", exact: true }).click();
  const box = (await wb.locator(".wb-canvas").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  const table = wb.locator("[data-item]:has(.wb-table-grid)").last();
  await expect(table).toBeVisible();
  return table;
}
async function typeInCell(page: Page, table: Locator, cell: string, text: string) {
  await table.locator(`[data-cell='${cell}']`).dblclick();
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}
const background = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);
// A paste as Ctrl+V sends it.
async function paste(wb: Locator, text: string) {
  await wb.locator(".wb-canvas").click({ position: { x: 30, y: 30 } });
  await wb.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    (document.activeElement || el).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test("table colours: rows, columns, header column, undo, export", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { wb } = await setup(page, `Tabellenfarben ${Date.now()}`);
  const table = await placeTable(page, wb);
  await typeInCell(page, table, "1:0", "Ada");
  // A click on a cell of row 2 picks that row for the colour.
  await table.locator("[data-cell='1:1']").click();
  await wb.getByRole("button", { name: "Farbe von Zeile oder Spalte" }).click();
  const colours = wb.getByRole("dialog", { name: "Tabellenfarben" });
  await expect(colours.locator("select")).toHaveValue("row:1");
  await colours.getByRole("radio", { name: "Hintergrund #ffe3e3" }).click();
  for (const c of ["1:0", "1:1", "1:2"]) await expect(table.locator(`[data-cell='${c}']`)).toHaveClass(/filled/);
  await expect.poll(() => background(table.locator("[data-cell='1:2']"))).toBe("rgb(255, 227, 227)");
  await expect(table.locator("[data-cell='2:2']")).not.toHaveClass(/filled/);
  // A whole column, header cell included; the row's colour goes first.
  await colours.locator("select").selectOption("col:2", { force: true });
  await colours.getByRole("radio", { name: "Hintergrund #d3f9d8" }).click();
  await expect.poll(() => background(table.locator("[data-cell='0:2']"))).toBe("rgb(211, 249, 216)");
  await expect.poll(() => background(table.locator("[data-cell='2:2']"))).toBe("rgb(211, 249, 216)");
  await expect.poll(() => background(table.locator("[data-cell='1:2']"))).toBe("rgb(255, 227, 227)");
  await expect(colours.getByRole("radio", { name: "Hintergrund #d3f9d8" })).toHaveAttribute("aria-checked", "true");
  // Besides the palette, the colour wheel.
  await colours.getByRole("button", { name: "Eigene Hintergrundfarbe" }).click();
  await expect(colours.getByRole("group", { name: "Eigene Hintergrundfarbe" })).toBeVisible();
  // The header column.
  await wb.getByRole("button", { name: "Kopfspalte", exact: true }).click();
  await expect(table.locator("[data-cell='2:0']")).toHaveClass(/head/);
  await expect(table.locator("[data-cell='2:1']")).not.toHaveClass(/head/);
  // Undo takes back the last step only.
  await wb.locator(".wb-canvas").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(table.locator("[data-cell='2:0']")).not.toHaveClass(/head/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(table.locator("[data-cell='2:2']")).not.toHaveClass(/filled/);
  await expect(table.locator("[data-cell='1:2']")).toHaveClass(/filled/);
  // Removing the last row drops its colour with it.
  await table.locator("[data-cell='0:0']").click();
  await wb.getByRole("button", { name: "− Zeile" }).click();
  await wb.getByRole("button", { name: "− Zeile" }).click();
  await wb.getByRole("button", { name: "+ Zeile" }).click();
  await expect(table.locator("[data-cell='1:2']")).not.toHaveClass(/filled/);
  // Colours stay after a reload (stored with the board).
  await table.locator("[data-cell='1:1']").click();
  await wb.getByRole("button", { name: "Farbe von Zeile oder Spalte" }).click();
  await colours.getByRole("radio", { name: "Hintergrund #e5dbff" }).click();
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 10000 });
  await page.reload();
  const again = wb.locator("[data-item]:has(.wb-table-grid)").last();
  await expect.poll(() => background(again.locator("[data-cell='1:0']"))).toBe("rgb(229, 219, 255)");
  // The SVG export carries the colours.
  const download = page.waitForEvent("download");
  await wb.getByRole("button", { name: "Ansicht und Aktionen", exact: true }).click();
  await wb.getByRole("dialog", { name: "Ansicht und Aktionen" }).getByRole("button", { name: "Als SVG exportieren", exact: true }).click();
  const svg = readFileSync((await (await download).path())!, "utf8");
  expect(svg).toContain("--wb-cell-fill: #e5dbff");
  expect(svg).toContain(".wb-cell.filled{background:var(--wb-cell-fill)");
  expect(errors).toEqual([]);
});

test("links and previews in table cells, link cards for any web page", async ({ page, context }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { wb, embeds, foreign } = await setup(page, `Tabellenlinks ${Date.now()}`);
  const table = await placeTable(page, wb);
  await typeInCell(page, table, "1:0", "siehe https://docs.example.net/a?b=1.");
  await typeInCell(page, table, "1:1", "javascript:alert(1)");
  const link = table.locator("[data-cell='1:0'] a");
  await expect(link).toHaveText("https://docs.example.net/a?b=1");
  await expect(link).toHaveAttribute("href", "https://docs.example.net/a?b=1");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener noreferrer/);
  await expect(table.locator("[data-cell='1:1'] a")).toHaveCount(0);
  // A click opens the page in a new tab.
  await context.route(/^https:\/\/docs\.example\.net\//, (route) => route.fulfill({ body: "<p>docs</p>", contentType: "text/html" }));
  const popup = context.waitForEvent("page");
  await link.click();
  expect((await popup).url()).toBe("https://docs.example.net/a?b=1");
  await (await popup).close();

  // A lone page address: its preview, fetched once and kept on the table,
  // its picture a file of the board.
  await typeInCell(page, table, "2:0", "https://example.org/seite");
  const card = table.locator("[data-cell='2:0'] .wb-cell-card");
  await expect(card).toContainText("Beispielseite");
  await expect(card).toContainText("Beispiel");
  await expect(card.locator("img")).toHaveAttribute("src", COVER);
  expect(embeds.filter((u) => u === "https://example.org/seite")).toHaveLength(1);
  // A video: its still picture (a file of the board), a click plays it in a frame.
  await typeInCell(page, table, "2:1", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const video = table.locator("[data-cell='2:1'] .wb-cell-video");
  await expect(video.locator("img")).toHaveAttribute("src", STILL);
  await video.getByRole("button", { name: "YouTube abspielen" }).click();
  const player = page.getByRole("dialog", { name: "YouTube" });
  await expect(player.locator("iframe")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(player.locator("iframe")).toHaveAttribute("sandbox", /allow-scripts/);
  await page.keyboard.press("Escape");
  await expect(player).toHaveCount(0);
  expect(embeds.filter((u) => u.includes("youtube"))).toHaveLength(1);

  // Pasting a web page's address: a link card with the page's preview.
  await paste(wb, "https://example.org/artikel");
  const linkCard = wb.locator(".wb-linkcard").last();
  await expect(linkCard.locator(".wb-linkcard-title")).toHaveText("Beispielseite");
  await expect(linkCard.locator(".wb-linkcard-title")).toHaveAttribute("href", "https://example.org/artikel");
  await expect(linkCard.locator(".wb-linkcard-title")).toHaveAttribute("rel", /noopener noreferrer/);
  await expect(linkCard).toContainText("Eine Seite zum Testen");
  await expect(linkCard.locator(".wb-linkcard-image")).toHaveAttribute("src", COVER);
  await expect(linkCard.locator(".wb-linkcard-icon")).toHaveAttribute("src", ICON);
  // A page without a preview still becomes a card, named by its host.
  await paste(wb, "https://keine-vorschau.example.com/x");
  await expect(wb.locator(".wb-linkcard-title", { hasText: "keine-vorschau.example.com" })).toBeVisible();
  // A player of the allowlist stays an embed.
  await paste(wb, "https://youtu.be/dQw4w9WgXcQ");
  await expect(wb.locator(".wb-embed-preview").last()).toContainText("YouTube");
  // The embed dialog takes any web page too.
  await wb.getByRole("button", { name: "Einfügen und mehr", exact: true }).click();
  await wb.locator(".wb-plus").getByRole("button", { name: "Einbetten", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Einbetten" });
  await dialog.getByLabel("Video oder Webseite").fill("https://example.org/dialog");
  await dialog.getByRole("button", { name: "Einbetten", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wb.locator(".wb-linkcard-title[href='https://example.org/dialog']")).toBeVisible();
  // Undo removes the last card at once.
  await wb.locator(".wb-canvas").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(wb.locator(".wb-linkcard-title[href='https://example.org/dialog']")).toHaveCount(0);
  // (The player's frame loaded only after the click on play.)
  expect(foreign.filter((u) => !u.startsWith("https://www.youtube-nocookie.com/"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("link cards of older versions: no picture of another site is loaded; an editor fetches them anew once", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { wb, embeds, foreign, board } = await setup(page, `Alte Linkkarten ${Date.now()}`, [
    {
      id: "old-card",
      type: "embed",
      x: 100,
      y: 100,
      w: 340,
      h: 265,
      z: 1,
      url: "https://example.org/alt",
      preview: { title: "Alter Titel", site: "Alt", image: "https://img.example.org/cover.png", icon: "https://cors.example.org/icon.png" },
    },
    { id: "old-table", type: "table", x: 500, y: 100, w: 360, h: 120, z: 2, cells: [["https://youtu.be/dQw4w9WgXcQ", "x"]] },
  ]);
  const card = wb.locator(".wb-linkcard");
  await expect(card.locator(".wb-linkcard-title")).toBeVisible();
  // Fetched anew (as files of the board) by this editor, once.
  await expect(card.locator(".wb-linkcard-image")).toHaveAttribute("src", COVER, { timeout: 10_000 });
  await expect(card.locator(".wb-linkcard-title")).toHaveText("Beispielseite");
  await expect(wb.locator("[data-cell='0:0'] .wb-cell-video img")).toHaveAttribute("src", STILL);
  expect(embeds.sort()).toEqual(["https://example.org/alt", "https://youtu.be/dQw4w9WgXcQ"]);
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 10_000 });
  const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(data.whiteboard.state, "base64"));
  const items = ydoc.getMap<Y.Map<unknown>>("items");
  expect(items.get("old-card")!.get("preview")).toMatchObject({ image: COVER, icon: ICON });
  expect((items.get("old-table")!.get("links") as Record<string, { image?: string }>)["https://youtu.be/dQw4w9WgXcQ"].image).toBe(STILL);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test("the board menu's PNG export works with pictures of other sites (#455 bug)", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { wb, foreign } = await setup(page, `PNG-Export ${Date.now()}`);
  // Text in foreignObject (a table), a YouTube embed (its still picture
  // fetched as a file of the board) and a link card with its picture.
  const table = await placeTable(page, wb, -250, -150);
  await typeInCell(page, table, "0:0", "Kopf");
  await paste(wb, "https://youtu.be/dQw4w9WgXcQ");
  await expect(wb.locator(".wb-embed-preview")).toHaveCount(1);
  await paste(wb, "https://example.org/artikel");
  await expect(wb.locator(".wb-linkcard-title")).toHaveText("Beispielseite");
  // The player got its still picture (for the exports).
  await expect(wb.locator(`[data-export-thumb="${STILL}"]`)).toHaveCount(1, { timeout: 10_000 });

  const download = page.waitForEvent("download");
  await wb.getByRole("button", { name: "Ansicht und Aktionen", exact: true }).click();
  await wb.getByRole("dialog", { name: "Ansicht und Aktionen" }).getByRole("button", { name: "Als PNG exportieren", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("whiteboard.png");
  const png = readFileSync((await file.path())!);
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  await expect(page.getByText("Der Browser erlaubt keinen PNG-Export dieses Boards", { exact: false })).toHaveCount(0);
  // The YouTube still (red) and the link card's picture and icon (blue)
  // are files of the board: all in the picture, nothing from other sites.
  const counts = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    let red = 0,
      blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      if (r > 200 && g < 60 && b < 60) red++;
      if (b > 200 && r < 60 && g < 80) blue++;
    }
    return { red, blue };
  }, png.toString("base64"));
  expect(counts.red).toBeGreaterThan(5000);
  expect(counts.blue).toBeGreaterThan(5000);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
