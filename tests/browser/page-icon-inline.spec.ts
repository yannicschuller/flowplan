import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// "Seitensymbol: Neben dem Titel" (#214, lib/page-icon-pref.ts,
// app/page-icon-inline.css): the page icon small on the title's first line
// instead of large above it; a cover stays above. A new account has the
// icon above the title (tests/page-icon-pref.test.ts); a test server may sign
// every test in as the same person, so each test sets it and the last one
// puts the default back.
async function pageWith(page: Page, place: "above" | "inline", patch: Record<string, unknown>, title = `Symbol ${Date.now()}`) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const saved = await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.pageIcon", pageIcon: place } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const pageId = (await created.json()).id;
  const updated = await page.request.post("/api/command", { headers: { origin }, data: { action: "page.update", pageId, patch } });
  expect(updated.ok(), await updated.text()).toBe(true);
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
  return { pageId, title };
}

test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.pageIcon", pageIcon: "above" } });
});

const header = (page: Page) => page.locator(".split-primary .document-header");

test("next to the title: the icon sits small on the title's first line, the cover stays above", async ({ page }) => {
  const { title } = await pageWith(page, "inline", { icon: "🚀", cover: "#5b7bd5" });
  await expect(header(page)).toHaveClass(/icon-inline/);
  const icon = (await header(page).locator(".large-page-icon").boundingBox())!;
  const field = page.getByRole("textbox", { name: "Seitentitel", exact: true });
  await expect(field).toHaveValue(title);
  const titleBox = (await field.boundingBox())!;
  const cover = (await page.locator(".page-cover").boundingBox())!;
  // Left of the title, on the same line, about as high as that line.
  expect(icon.x + icon.width).toBeLessThanOrEqual(titleBox.x + 1);
  expect(Math.abs(icon.y - titleBox.y)).toBeLessThan(4);
  const fontSize = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(icon.height).toBeGreaterThan(fontSize);
  expect(icon.height).toBeLessThan(fontSize * 1.5);
  // The cover above, not overlapped by the icon.
  expect(cover.y + cover.height).toBeLessThanOrEqual(icon.y);
  // The title is untouched: no emoji put into it.
  expect(await field.inputValue()).not.toContain("🚀");
  // Clicking the icon opens the icon picker as before.
  await header(page).locator(".large-page-icon").click();
  await expect(page.getByRole("tablist", { name: "Art des Seitensymbols" })).toBeVisible();
});

test("a long title that wraps keeps the icon on its first line; without a cover only a small row for adding one is above", async ({ page }, info) => {
  const long = "Ein sehr langer Seitentitel, der auf dem Telefon über mehrere Zeilen umbricht und trotzdem lesbar bleibt";
  await pageWith(page, "inline", { icon: "icon:Star:#cb912f" }, long);
  const title = page.getByRole("textbox", { name: "Seitentitel", exact: true });
  await title.hover();
  const icon = (await header(page).locator(".large-page-icon").boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  expect(Math.abs(icon.y - titleBox.y)).toBeLessThan(4);
  if (info.project.name === "mobile") expect(titleBox.height).toBeGreaterThan(icon.height * 1.5);
  // "Cover hinzufügen" above the title line, not over the title.
  const add = header(page).getByRole("button", { name: "Cover hinzufügen" });
  await expect(add).toBeVisible();
  const addBox = (await add.boundingBox())!;
  expect(addBox.y + addBox.height).toBeLessThanOrEqual(titleBox.y + 1);
  expect(addBox.height).toBeLessThan(40);
  expect(await title.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  })).toBe(true);
  // No page wider than the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("above the title (the default): the large icon above the title as before", async ({ page }) => {
  await pageWith(page, "above", { icon: "🚀" });
  await expect(header(page)).not.toHaveClass(/icon-inline/);
  const icon = (await header(page).locator(".large-page-icon").boundingBox())!;
  const titleBox = (await page.getByRole("textbox", { name: "Seitentitel", exact: true }).boundingBox())!;
  expect(icon.y + icon.height).toBeLessThanOrEqual(titleBox.y);
});

test("the setting under Darstellung & Sprache switches the header right away", async ({ page }) => {
  const { pageId } = await pageWith(page, "above", { icon: "🚀" });
  await page.goto("/#settings/appearance");
  const choice = page.getByRole("radiogroup", { name: "Seitensymbol" });
  await expect(choice).toBeVisible();
  await choice.getByText("Neben dem Titel").click();
  await expect(choice.getByRole("radio", { name: "Neben dem Titel" })).toBeChecked();
  await expect
    .poll(async () => (await (await page.request.get("/api/bootstrap")).json()).pageIcon)
    .toBe("inline");
  await page.goto(`/#page=${pageId}`);
  await expect(header(page)).toHaveClass(/icon-inline/);
});
