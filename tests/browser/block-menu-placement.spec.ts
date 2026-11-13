import { test, expect, type Locator, type Page } from "@playwright/test";

// The block menu opens left of its handle (#253), like Notion: over the
// page margin, not over the block; its flyouts open further left. Its
// heading names the kind of block, the rows are a little closer with a
// mouse. Phones keep the bottom sheet.
const RESULTS = process.env.BLOCK_MENU_SHOTS || "test-results";

async function fixture(page: Page, title: string, html: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return host;
}
// A box once it stops moving (menus fade and slide in; the page may still
// settle after loading).
async function settled(locator: Locator) {
  let last = await locator.boundingBox();
  for (let i = 0; i < 40; i++) {
    await locator.page().waitForTimeout(50);
    const next = await locator.boundingBox();
    if (next && last && next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height) return next;
    last = next;
  }
  return last!;
}
const handle = (page: Page, label: string) => page.getByRole("button", { name: `Blockaktionen: ${label}`, exact: true });

test("the block menu opens left of the handle, its flyouts further left, with the kind of block as its heading (#253)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Phones: the next test.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const host = await fixture(page, `Menü links ${Date.now()}`, '<p>Alpha</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Einkaufen</p></li></ul><p>Ende</p>');
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 20_000 });

  await settled(editor.getByText("Alpha", { exact: true }));
  await editor.getByText("Alpha", { exact: true }).hover();
  const alpha = handle(page, "Absatz · Alpha");
  await alpha.click();
  const menu = page.getByRole("menu", { name: "Absatz · Alpha" });
  await expect(menu).toBeVisible();
  const h = (await settled(alpha));
  const m = (await settled(menu));
  // Its right edge beside the handle, not over the text.
  expect(m.x + m.width).toBeLessThanOrEqual(h.x);
  expect(h.x - (m.x + m.width)).toBeLessThan(12);
  await expect(menu.locator(".block-menu-kind")).toHaveText("Absatz");
  // Rows about 28–30 px with a mouse.
  const row = (await settled(menu.getByRole("menuitem", { name: "Duplizieren" })));
  expect(row.height).toBeGreaterThanOrEqual(26);
  expect(row.height).toBeLessThanOrEqual(31);
  // At 1440 px with the sidebar there is no room for a flyout further left:
  // it opens over the menu, below its entry – never over the block's text.
  const text = (await settled(editor.getByText("Alpha", { exact: true })));
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlaps(m, text)).toBe(false);
  const entry = menu.getByRole("menuitem", { name: "Umwandeln in …" });
  await entry.hover();
  const flyout = page.getByRole("menu", { name: "Umwandeln in …" });
  await expect(flyout).toBeVisible();
  let f = (await settled(flyout));
  expect(overlaps(f, text)).toBe(false);
  expect(f.x).toBeGreaterThanOrEqual(m.x - 1);
  expect(f.x + f.width).toBeLessThanOrEqual(m.x + m.width + 1);
  // Its entry stays visible above it.
  const e = (await settled(entry));
  expect(f.y).toBeGreaterThanOrEqual(e.y + e.height - 1);
  await page.screenshot({ path: `${RESULTS}/block-menu-left-1440.png` });
  // The pointer goes straight down into it and it stays open.
  await flyout.getByRole("menuitemradio", { name: /^Überschrift 1/ }).hover();
  await page.waitForTimeout(300);
  await expect(flyout).toBeVisible();
  // By keyboard: → opens it with the focus inside, ← goes back to the entry.
  await entry.focus();
  await page.keyboard.press("ArrowRight");
  await expect(flyout).toBeVisible();
  await expect(flyout.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(flyout).toHaveCount(0);
  await expect(entry).toBeFocused();
  // Escape: back from the flyout, then the menu closes.
  await page.keyboard.press("ArrowRight");
  await expect(flyout).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(flyout).toHaveCount(0);
  await expect(entry).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // With room (a wide window without the sidebar), "Umwandeln in" opens
  // further left, not back over the text.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.getByTitle("Navigation schließen").click();
  await settled(editor.getByText("Alpha", { exact: true }));
  await editor.getByText("Alpha", { exact: true }).hover();
  await alpha.click();
  await expect(menu).toBeVisible();
  const h2 = (await settled(alpha));
  const m2 = (await settled(menu));
  expect(m2.x + m2.width).toBeLessThanOrEqual(h2.x);
  await menu.getByRole("menuitem", { name: "Umwandeln in …" }).hover();
  await expect(flyout).toBeVisible();
  f = (await settled(flyout));
  // (Placed 4 px from its entry: it may reach into the menu's padding.)
  expect(f.x + f.width, JSON.stringify({ f, m2, h2 })).toBeLessThanOrEqual(m2.x + 4);
  await page.screenshot({ path: `${RESULTS}/block-menu-left.png` });
  // The search hides the heading; the entries still work.
  const search = menu.getByRole("searchbox", { name: "Aktionen und Blocktypen suchen" });
  await search.fill("dupl");
  await expect(flyout).toHaveCount(0);
  await expect(menu.locator(".block-menu-kind")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(editor.getByText("Alpha", { exact: true })).toHaveCount(2);

  // A task: the menu is the task list's kind.
  await editor.getByText("Einkaufen", { exact: true }).hover();
  await handle(page, "Aufgabe · Einkaufen").click();
  await expect(page.getByRole("menu", { name: "Aufgabe · Einkaufen" }).locator(".block-menu-kind")).toHaveText("Aufgabenliste");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("without room left of the handle, the menu opens right of it (#253)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Phones: the bottom sheet.");
  await page.setViewportSize({ width: 680, height: 800 });
  const host = await fixture(page, `Menü rechts ${Date.now()}`, "<p>Alpha</p><p>Ende</p>");
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Alpha", { exact: true }).hover();
  const alpha = handle(page, "Absatz · Alpha");
  const near = (await settled(alpha));
  // A narrow window (not yet a phone): no room for the menu left of the handle.
  expect(near.x).toBeLessThan(290);
  await alpha.click();
  const menu = page.getByRole("menu", { name: "Absatz · Alpha" });
  await expect(menu).toBeVisible();
  const m = (await settled(menu));
  expect(m.x).toBeGreaterThanOrEqual(near.x + near.width);
});

test("phones keep the bottom sheet for the block menu (#253)", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phones only.");
  const host = await fixture(page, `Menü Telefon ${Date.now()}`, "<p>Alpha</p><p>Ende</p>");
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Alpha", { exact: true }).tap();
  await handle(page, "Absatz · Alpha").tap();
  await expect(page.locator(".block-menu-sheet")).toBeVisible();
  await expect(page.locator(".block-menu-kind")).toHaveCount(0);
});
