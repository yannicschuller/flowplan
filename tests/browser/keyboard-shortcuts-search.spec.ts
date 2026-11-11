import { expect, test, type Page } from "@playwright/test";

// The keyboard shortcut overview: a search field under the title filters
// the rows by name or keys (#204), and the dialog keeps all four corners
// rounded – the list scrolls inside it, not the dialog itself (#205).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function openShortcuts(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.goto(`${origin}/#home`);
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("ControlOrMeta+/");
  const dialog = page.getByRole("dialog", { name: "Tastenkürzel" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the search field filters the shortcuts by name and keys; Escape clears it first", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop layout.");
  const dialog = await openShortcuts(page);
  const search = dialog.getByRole("searchbox", { name: "Tastenkürzel durchsuchen" });
  await expect(search).toBeFocused();

  // Keys, in any spelling: Ctrl/Cmd+L (#201) is the task status.
  await search.fill("⌘L");
  const rows = dialog.locator(".shortcut-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Zeile zur Aufgabe machen");
  await search.fill("mod+shift+z");
  await expect(rows.first()).toContainText("Rückgängig / Wiederholen");
  // By name, German or English; sections without a match disappear.
  await search.fill("journal");
  await expect(rows).toHaveCount(1);
  await expect(dialog.locator(".shortcut-group")).toHaveCount(1);
  await search.fill("next slide");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Nächste Folie");

  await search.fill("xyzzy");
  await expect(rows).toHaveCount(0);
  await expect(dialog.getByText("Keine Tastenkürzel gefunden")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(search).toHaveValue("");
  await expect(dialog.locator(".shortcut-group").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("own combinations are found by their keys", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop layout.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "shortcuts.save", bindings: { theme: ["Mod+Alt+G"] } } });
  try {
    const dialog = await openShortcuts(page);
    const search = dialog.getByRole("searchbox", { name: "Tastenkürzel durchsuchen" });
    await search.fill("ctrl alt g");
    const rows = dialog.locator(".shortcut-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-action", "theme");
    await search.fill("eigene");
    await expect(rows).toHaveCount(1);
  } finally {
    await page.request.post("/api/command", { headers: { origin }, data: { action: "shortcuts.save", bindings: {} } });
  }
});

test("the dialog itself does not scroll: its list does, inside the rounded box", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop layout.");
  await page.setViewportSize({ width: 1000, height: 600 });
  const dialog = await openShortcuts(page);
  const boxes = await dialog.evaluate((el) => {
    const body = el.querySelector(".shortcuts-body") as HTMLElement;
    const style = getComputedStyle(el);
    return {
      overflow: style.overflowY,
      radius: style.borderTopRightRadius,
      dialogScrolls: el.scrollHeight > el.clientHeight + 1,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    };
  });
  expect(boxes.overflow).toBe("hidden");
  expect(boxes.radius).not.toBe("0px");
  expect(boxes.dialogScrolls).toBe(false);
  expect(boxes.bodyScrolls).toBe(true);
});
