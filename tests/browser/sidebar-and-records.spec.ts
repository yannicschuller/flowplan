import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, kind: string, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind, title },
  });
  expect(response.ok()).toBe(true);
  return { origin, host: (await response.json()) as { id: string } };
}

test("a right click on a page in the sidebar opens its actions", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Right click is for mouse users.");
  const title = `Kontext ${Date.now()}`;
  const { host } = await setup(page, "document", title);
  await page.goto("/#home");
  const nav = page.locator(`.page-nav[data-page-id="${host.id}"]`);
  await nav.click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Aktionen für ${title}` });
  for (const item of ["Link kopieren", "Zu Favoriten", "Teilen", "Duplizieren", "Verschieben", "In den Papierkorb"])
    await expect(menu.getByRole("menuitem", { name: item })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Zu Favoriten" }).click();
  await expect(page.locator(".favorite-nav", { hasText: title })).toBeVisible();
  // Dialogs open the page first.
  await nav.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Teilen" }).click();
  await expect(page.getByRole("dialog", { name: "Seite teilen" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(host.id));
});

test("a new record opens with its title ready for typing", async ({ page }) => {
  const { host } = await setup(page, "database", `Titel ${Date.now()}`);
  await page.goto(`/#page=${host.id}`);
  await page.getByRole("button", { name: /^Neu$/ }).first().click();
  const title = page.getByRole("textbox", { name: "Titel des Eintrags" });
  await expect(title).toBeFocused();
  await page.keyboard.type("Objektive packen");
  await page.keyboard.press("Enter");
  await expect(page.locator(".data-table, .record-card, .record-list").first()).toContainText("Objektive packen");
  // The title is not repeated among the properties.
  await expect(page.getByRole("dialog").locator(".row-property", { hasText: /^Aufgabe/ })).toHaveCount(0);
  const width = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')!;
    return d.scrollWidth - d.clientWidth;
  });
  expect(width).toBeLessThanOrEqual(1);
});

test("list items take their handle beside the bullet, not on it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Handles are measured with a mouse layout.");
  const { host } = await setup(page, "document", `Liste ${Date.now()}`);
  await page.goto(`/#page=${host.id}`);
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Absatz");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 90mm Macro");
  await page.keyboard.press("Enter");
  await page.keyboard.type("28-70mm Kit");
  const handle = (text: string) => page.getByRole("button", { name: new RegExp(`^Blockaktionen: [^·]+ · ${text}$`) });
  await expect(handle("28-70mm Kit")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Blockaktionen: Aufzählung/ })).toHaveCount(0);
  const paragraph = (await handle("Absatz").boundingBox())!;
  const item = (await handle("28-70mm Kit").boundingBox())!;
  const text = (await editor.locator("li", { hasText: "28-70mm Kit" }).boundingBox())!;
  expect(Math.abs(item.x - paragraph.x)).toBeLessThan(2);
  // The bullet sits between the handle and the text.
  expect(item.x + item.width).toBeLessThan(text.x - 12);
});

test("photos are made smaller before they are uploaded", async ({ page }) => {
  const { host } = await setup(page, "document", `Foto ${Date.now()}`);
  await page.goto(`/#page=${host.id}`);
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  // A 3200×2000 PNG with gradients and grain: large, like a photo.
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3200;
    canvas.height = 2000;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(3200, 2000);
    for (let y = 0; y < 2000; y++)
      for (let x = 0; x < 3200; x++) {
        const i = (y * 3200 + x) * 4,
          grain = Math.random() * 24;
        img.data[i] = (x / 3200) * 200 + grain;
        img.data[i + 1] = (y / 2000) * 180 + grain;
        img.data[i + 2] = 120 + grain;
        img.data[i + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "foto.png", { type: "image/png" }));
    (window as unknown as { originalSize: number }).originalSize = blob.size;
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  const image = editor.locator("img").first();
  await expect(image).toBeVisible({ timeout: 20_000 });
  const src = await image.getAttribute("src");
  const response = await page.request.get(src!);
  expect(response.headers()["content-type"]).toBe("image/webp");
  const size = (await response.body()).length;
  const original = await page.evaluate(() => (window as unknown as { originalSize: number }).originalSize);
  expect(size).toBeLessThan(original / 2);
  const width = await image.evaluate((el: HTMLImageElement) => el.naturalWidth);
  expect(width).toBe(2560);
});

test("the page filter in the sidebar finds nested pages and keeps their parents", async ({ page }, info) => {
  const stamp = Date.now();
  const { origin, host } = await setup(page, "document", `Elternseite ${stamp}`);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const child = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, parentId: host.id, kind: "document", title: `Gesuchtes Kind ${stamp}` },
  });
  expect(child.ok()).toBe(true);
  await page.goto("/#home");
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Navigation öffnen" }).click();
  const sidebar = page.locator(".sidebar");
  await sidebar.getByRole("searchbox", { name: "Seiten filtern" }).fill(`kind ${stamp}`);
  await expect(sidebar.locator(".page-nav")).toHaveCount(2);
  await expect(sidebar.locator(".page-nav", { hasText: `Elternseite ${stamp}` })).toBeVisible();
  await expect(sidebar.locator(".page-nav", { hasText: `Gesuchtes Kind ${stamp}` })).toBeVisible();
  await sidebar.getByRole("searchbox", { name: "Seiten filtern" }).fill(`nichts ${stamp}`);
  await expect(sidebar.getByText("Keine Seite heißt so.")).toBeVisible();
  await sidebar.getByRole("searchbox", { name: "Seiten filtern" }).press("Escape");
  await expect(sidebar.locator(".page-nav").first()).toBeVisible();
  // The less used places are still reachable by name.
  for (const name of ["Vorlagen", "Medien", "Papierkorb", "Einstellungen"])
    await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
});

test("on phones a long press opens the page menu", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Long press is for touch screens.");
  const title = `Langdruck ${Date.now()}`;
  const { host } = await setup(page, "document", title);
  await page.goto("/#home");
  await page.getByRole("button", { name: "Navigation öffnen" }).click();
  const row = page.locator(`.page-nav[data-page-id="${host.id}"] .page-nav-title`);
  await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + 30, y: box.y + box.height / 2, id: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByRole("menu", { name: `Aktionen für ${title}` })).toBeVisible();
  // The page itself did not open.
  await expect(page).not.toHaveURL(new RegExp(host.id));
});

test("text and links shared from another app become a page", async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const stamp = Date.now();
  const query = new URLSearchParams({
    title: `Geteilt ${stamp}`,
    text: "Schau dir das an:\nhttps://example.com/artikel",
    url: "",
  });
  await page.goto(`/share-target?${query}`);
  await expect(page.getByRole("heading", { name: "In Flowplan speichern" })).toBeVisible();
  await expect(page.getByLabel("Geteilter Inhalt")).toContainText("example.com/artikel");
  await page.getByRole("button", { name: "Als Seite speichern" }).click();
  await expect(page).toHaveURL(/#page=/);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toContainText("Schau dir das an:");
  await expect(editor.locator('a[href="https://example.com/artikel"]')).toBeVisible();
  await expect(page.locator(".page-title, h1").first()).toBeVisible();
  // The manifest registers Flowplan as a share target.
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.share_target.action).toBe("/share-target");
});
