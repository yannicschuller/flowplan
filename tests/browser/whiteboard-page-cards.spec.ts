// Pages on the board (#549): "Neue Seite" makes a document below the board
// and opens it beside it (the split view's right frame); what is typed
// there shows on the card, enlarged to show the whole document; a
// connector to the card survives a reload; on phones the page opens as
// before.
import { test, expect, type Page } from "@playwright/test";
import * as Y from "yjs";
import { boardInsert } from "./whiteboard-ui";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.BOARD_PAGES_SHOTS || "test-results/board-pages";
async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  return { boot, command, board };
}

test("a new page from the board, edited beside it, live on its card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the split view is for wide windows");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(page, `Seitenkarten ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb).toBeVisible();

  await boardInsert(wb, "Neue Seite");
  // The card is on the board, the page beside it, editable.
  await expect(wb.locator(".wb-card")).toHaveCount(1);
  const pane = page.locator(".split-pane");
  const editor = pane.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(wb).toBeVisible();
  // The new page is a sub-page of the board.
  const pageId = new URL(page.url()).searchParams.get("split");
  expect(pageId).toBeTruthy();
  const created = await (await page.request.get(`/api/pages/${pageId}`)).json();
  expect(created.page.parent_id).toBe(board.id);
  expect(created.page.kind).toBe("document");

  await editor.click();
  await page.keyboard.type("Notizen vom Rand");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Punkt eins");
  // The large card shows the whole document, refreshed after the save.
  const shown = wb.locator(".wb-pagecard-doc");
  await expect(shown).toContainText("Notizen vom Rand", { timeout: 30_000 });
  await expect(shown.locator("li")).toContainText("Punkt eins", { timeout: 30_000 });

  // A note beside the card, connected to it.
  const canvas = wb.locator(".wb-canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.dblclick({ position: { x: 90, y: box.height - 120 } });
  await page.keyboard.type("Idee");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-sticky")).toContainText("Idee");
  await wb.getByRole("button", { name: "Verbindungslinie", exact: true }).click();
  const sticky = (await wb.locator(".wb-sticky").boundingBox())!;
  const card = (await wb.locator(".wb-card").boundingBox())!;
  await page.mouse.move(sticky.x + sticky.width / 2, sticky.y + sticky.height / 2);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2, card.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect(wb.locator(".wb-connector")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/connected.png` });

  // "Daneben öffnen" sits in the selected card's bar.
  // (Inside the card's foreignObject Playwright sees no stable box: by position.)
  await page.mouse.click(card.x + 60, card.y + 15);
  await expect(wb.getByRole("button", { name: "Daneben öffnen", exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/beside.png` });

  // Moving the card keeps the connector attached; all of it survives a reload.
  await page.mouse.move(card.x + card.width / 2, card.y + 15);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width / 2 + 40, card.y + 55, { steps: 6 });
  await page.mouse.up();
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 10_000 });
  // Stored: the card names the page, the connector ends at the card.
  const stored = await (await page.request.get(`/api/pages/${board.id}`)).json();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(stored.whiteboard.state, "base64"));
  const elements = [...doc.getMap<Y.Map<unknown>>("items").entries()].map(([id, map]): Record<string, unknown> & { id: string } => ({ ...(map.toJSON() as Record<string, unknown>), id }));
  const pageCard = elements.find((e) => e.type === "card" && e.pageId === pageId);
  expect(pageCard).toBeTruthy();
  const connector = elements.find((e) => e.type === "connector") as { from?: { id?: string }; to?: { id?: string } } | undefined;
  expect([connector?.from?.id, connector?.to?.id]).toContain(pageCard!.id);
  await page.reload();
  const again = page.getByLabel("Whiteboard", { exact: true });
  await expect(again.locator(".wb-connector")).toHaveCount(1, { timeout: 30_000 });
  await expect(again.locator(".wb-pagecard-doc")).toContainText("Notizen vom Rand", { timeout: 30_000 });
  const line = (await again.locator(".wb-connector").boundingBox())!;
  const moved = (await again.locator(".wb-card").boundingBox())!;
  // The connector still ends at the card (its box touches the card's).
  expect(line.x + line.width).toBeGreaterThanOrEqual(moved.x - 2);
  await page.screenshot({ path: `${shots}/after-reload.png` });

  // Double-click on the card opens it beside the board (here: already there).
  await page.mouse.dblclick(moved.x + 60, moved.y + 15);
  await expect(page.locator(".split-pane .ProseMirror").first()).toBeVisible();
  await expect(again).toBeVisible();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});

test("small page cards keep their look; on phones the page opens as before", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command, board } = await setup(page, `Kleine Karte ${Date.now()}`);
  const title = `Ziel ${Date.now()}`;
  const target = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await boardInsert(wb, "Seite verknüpfen");
  const dialog = page.getByRole("dialog", { name: "Seite verknüpfen" });
  await dialog.getByLabel("Seiten suchen").fill(title);
  await dialog.getByRole("button", { name: new RegExp(title) }).click();
  await expect(wb.locator(".wb-card")).toContainText(title);
  await expect(wb.locator(".wb-pagecard")).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    await wb.locator(".wb-card").dblclick();
    await expect(page).toHaveURL(new RegExp(`page=${target.id}`));
  }
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
  await command({ action: "page.delete", pageId: target.id });
});
