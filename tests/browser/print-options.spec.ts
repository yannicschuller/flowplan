import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// "Drucken / PDF" with options (#215, components/print-dialog.tsx) and the
// page break block (#216). Nothing is really printed: the print frame's
// print() is replaced as soon as the frame is there, and the test reads the
// copy inside it.
async function openPage(page: Page, patch: Record<string, unknown> = {}) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  // A fresh start: no remembered choice.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.print", options: null } });
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Druck ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  if (Object.keys(patch).length) {
    const updated = await page.request.post("/api/command", { headers: { origin }, data: { action: "page.update", pageId, patch } });
    expect(updated.ok(), await updated.text()).toBe(true);
  }
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  // Every print frame prints into a counter instead of the printer.
  await page.evaluate(() => {
    const w = window as unknown as { __printed: number };
    w.__printed = 0;
    new MutationObserver(() => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.print-frame");
      if (frame?.contentWindow && !(frame as unknown as { stubbed?: boolean }).stubbed) {
        (frame as unknown as { stubbed?: boolean }).stubbed = true;
        frame.contentWindow.print = () => void w.__printed++;
      }
    }).observe(document.body, { childList: true });
    window.print = () => void w.__printed++;
  });
  return pageId;
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: number }).__printed);
const frame = (page: Page) => page.frameLocator("iframe.print-frame");

test("the print dialog: options leave cover and icon out of the copy, page numbers and paper go into its style", async ({ page }) => {
  await openPage(page, { icon: "🚀", cover: "#5b7bd5" });
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Drucken / PDF" }).click();
  const dialog = page.getByRole("dialog", { name: "Drucken / PDF" });
  await expect(dialog).toBeVisible();
  // As before: everything on.
  for (const name of ["Titelbild", "Icon", "Tags", "Eigenschaften", "Seitenzahlen"]) await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Titelseite" })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: "Titelbild" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Icon" }).uncheck();
  await dialog.getByRole("button", { name: "Drucken", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => printed(page)).toBe(1);
  const copy = frame(page).locator(".print-options");
  await expect(copy).toHaveCount(1);
  await expect(copy.locator(".page-cover")).toHaveCount(0);
  await expect(copy.locator(".large-page-icon")).toHaveCount(0);
  await expect(copy.locator(".page-title")).toHaveCount(1);
  expect(await frame(page).locator("style[data-print-options]").textContent()).toContain("counter(page)");
  // The page itself keeps them.
  await expect(page.locator(".page-content .page-cover")).toHaveCount(1);

  // The last choice is remembered; Ctrl/⌘+P opens the dialog, Enter prints.
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+p");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Titelbild" })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "Seitenzahlen" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Titelbild" }).check();
  await dialog.getByRole("checkbox", { name: "Titelbild" }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(() => printed(page)).toBe(2);
  await expect(frame(page).locator(".print-options .page-cover")).toHaveCount(1);
  await expect(frame(page).locator(".print-options .large-page-icon")).toHaveCount(0);
  await expect(frame(page).locator("style[data-print-options]")).toHaveCount(0);
  const stored = await (await page.request.get("/api/bootstrap")).json();
  expect(stored.print.last).toMatchObject({ cover: true, icon: false, pageNumbers: false });
});

test("a preset saved in the dialog is offered again", async ({ page }) => {
  await openPage(page);
  await page.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+p");
  const dialog = page.getByRole("dialog", { name: "Drucken / PDF" });
  await dialog.getByRole("checkbox", { name: "Tags" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Eigenschaften" }).uncheck();
  await dialog.getByRole("button", { name: "Als Vorlage speichern …" }).click();
  const name = `Sauber ${Date.now()}`;
  await dialog.getByRole("textbox", { name: "Name der Vorlage" }).fill(name);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Vorlage löschen" })).toBeVisible();
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const saved = boot.print.presets.find((p: { name: string }) => p.name === name);
  expect(saved.options).toMatchObject({ tags: false, properties: false, cover: true });
  // Clean up.
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.print", presets: boot.print.presets.filter((p: { name: string }) => p.name !== name), options: null } });
});

test("the page break block: inserted with /seitenumbruch, shown as a dashed line, a break in print", async ({ page }) => {
  await openPage(page);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Erste Seite");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/seitenumbruch");
  await expect(page.getByRole("option", { name: /Seitenumbruch/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Zweite Seite");
  const block = editor.locator(".page-break");
  await expect(block).toHaveCount(1);
  expect(await block.evaluate((el) => getComputedStyle(el, "::after").content)).toBe('"Seitenumbruch"');
  expect(await block.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
  await expect(editor.locator(".page-break + p")).toHaveText("Zweite Seite");
  // In the print copy: no line, a break after it.
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "Drucken / PDF" }).getByRole("button", { name: "Drucken", exact: true }).click();
  await expect.poll(() => printed(page)).toBe(1);
  const copied = frame(page).locator(".print-options .page-break");
  await expect(copied).toHaveCount(1);
  const style = await copied.evaluate((el) => ({ after: getComputedStyle(el).breakAfter, border: getComputedStyle(el).borderTopStyle, label: getComputedStyle(el, "::after").content }));
  expect(style).toEqual({ after: "page", border: "none", label: "none" });
});
