import { test, expect } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// A selected calculation in the text menu: the row inserts the result after
// the selection, the button at its end copies the result as shown.
test("a calculation's result is copied with the button at the end of its row; the row still inserts", async ({ page, context, baseURL }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === "mobile";
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  // Shift + arrows count as a computer's selection in the default (#200).
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.textMenu", textMenu: "computer" } });
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Rechnen ${Date.now()}`, kind: "document" },
  });
  await page.goto(`/#page=${(await created.json()).id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  await editor.click();
  await page.keyboard.type("(y-8)^2");
  // "^2" turns into "²" while typing.
  await expect(editor).toHaveText("(y-8)²");
  // Shift + arrows select the expression.
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowLeft");
  const menu = page.locator(".text-menu.selection");
  await expect(menu).toBeVisible();
  const row = menu.getByRole("menuitem", { name: /Ausmultiplizieren/ });
  await expect(row).toContainText("y² − 16y + 64");
  const copy = menu.getByRole("menuitem", { name: "Ergebnis kopieren" });
  await expect(copy).toHaveCount(1);
  const box = (await copy.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(phone ? 44 : 32);
  expect(box.height).toBeGreaterThanOrEqual(phone ? 44 : 32);
  // At the right end of the row.
  const rowBox = (await row.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 1);

  // Keyboard: Tab goes from the row to its copy button; Enter there copies.
  await row.focus();
  await page.keyboard.press("Tab");
  await expect(copy).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Kopiert", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("y² − 16y + 64");
  // Copying changed nothing in the text, and the menu stays.
  await expect(editor).toHaveText("(y-8)²");
  await expect(menu).toBeVisible();

  // The row itself inserts the result after the selection, as before.
  await row.click();
  await expect(editor).toHaveText("(y-8)² = y² − 16y + 64");
});
