import { test, expect, type Page } from "@playwright/test";

// #120: on a touch phone the formatting toolbar that docks above the
// on-screen keyboard ends with "Tastatur ausblenden". It ends the input (the
// keyboard closes), the text stays; on a desktop the button does not exist.
async function openNewPage(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Tastatur ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  // A new account's welcome tour.
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  return editor;
}

const focusInEditor = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));

test("the docked toolbar hides the on-screen keyboard on a touch phone", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The keyboard of a touch phone.");
  test.setTimeout(120_000);
  const editor = await openNewPage(page);
  const hide = page.getByRole("button", { name: "Tastatur ausblenden" });
  await expect(hide).toHaveCount(0);
  await editor.tap();
  await page.keyboard.type("Hinter der Tastatur");
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expect(page.locator(".app-shell")).toHaveClass(/keyboard-open/);
  // At the right end of the docked toolbar, inside the screen.
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute("title", "Tastatur ausblenden");
  const box = (await hide.boundingBox())!;
  const bar = (await page.locator(".page-layout .editor-toolbar").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(bar.x + bar.width - (box.x + box.width)).toBeLessThan(16);

  await hide.tap();
  await expect.poll(() => focusInEditor(page)).toBe(false);
  // The toolbar goes back onto the tab bar, the button with the keyboard.
  await expect(page.locator(".app-shell")).not.toHaveClass(/keyboard-open/);
  await expect(hide).toHaveCount(0);
  await expect(page.locator(".mobile-tab-bar")).toBeVisible();
  await expect(editor).toHaveText("Hinter der Tastatur");

  // A tap into the text brings the keyboard back, typing goes on.
  await editor.tap();
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expect(hide).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.type(" weiter");
  await expect(editor).toHaveText("Hinter der Tastatur weiter");
});

test("there is no hide-keyboard button on a desktop", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop layout.");
  test.setTimeout(120_000);
  const editor = await openNewPage(page);
  await editor.click();
  await page.keyboard.type("Am Schreibtisch");
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expect(page.getByRole("toolbar", { name: "Textformatierung" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tastatur ausblenden" })).toHaveCount(0);
});
