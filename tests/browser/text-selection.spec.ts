import { test, expect, type Page } from "@playwright/test";

// Only meaningful text is selectable (app/globals.css, "Text selection";
// tests/text-selection.test.ts checks the rules themselves): dragging over
// the tab bar selects nothing, while the text of a document can be selected
// as before.
const selected = (page: Page) => page.evaluate(() => String(window.getSelection() || "").trim());

test("the tab bar's labels cannot be selected, the editor's text can", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The tab bar is shown on small screens.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // The demo account in development; a production build gets a first account.
  if (!(await page.request.post("/api/auth/demo", { headers: { origin } })).ok()) {
    const account = { name: "Mara Lindqvist", email: "mara-selection@example.test", password: "ein-langes-passwort" };
    if (!(await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok())
      await page.request.post("/api/auth/password", { headers: { origin }, data: account });
  }
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  // A new account skips the welcome dialog.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Auswahl ${Date.now()}` });

  await page.goto("/");
  await expect(page.locator(".mobile-tab-bar")).toBeVisible();
  await page.evaluate((id) => (location.hash = `page=${id}`), doc.id);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Kopierbarer Inhalt");
  await expect(editor.locator("p", { hasText: "Kopierbarer Inhalt" })).toBeVisible();
  // Out of the editor, so the tab bar is back (it hides for the keyboard).
  await page.locator(".topbar").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const bar = page.locator(".mobile-tab-bar");
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  expect(await bar.getByRole("button", { name: "Suchen" }).evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");

  // A drag across the whole bar selects nothing.
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height - 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 12, { steps: 8 });
  await page.mouse.up();
  expect(await selected(page)).toBe("");

  // A double click in the document selects a word.
  expect(await editor.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  const paragraph = editor.locator("p", { hasText: "Kopierbarer Inhalt" });
  expect(await paragraph.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  await paragraph.dblclick({ position: { x: 12, y: 8 } });
  await expect.poll(() => selected(page)).toMatch(/^(Kopierbarer|Inhalt)/);
});
