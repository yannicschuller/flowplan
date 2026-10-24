import { test, expect, type Page } from "@playwright/test";

// Phones in the app: the page draws under the status bar, the notch and the
// home indicator (viewport-fit=cover) and keeps out of them with
// --safe-top … --safe-left. Chromium has no such insets, so the test sets
// them like an iPhone has them.
const insets = (page: Page, css: string) =>
  page.addInitScript((text) => {
    const add = () => {
      const style = document.createElement("style");
      style.textContent = text;
      document.head.appendChild(style);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  }, css);

async function setup(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Ränder ${Date.now()}` });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Email bei Rechnung" } });
  return { db, row };
}
const box = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { top: r.top, left: r.left, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
  }, selector);

test("dialogs stay clear of the status bar and home indicator; related pages fit", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Safe areas are a phone matter.");
  await insets(page, ":root{--safe-top:47px!important;--safe-bottom:34px!important}");
  const { db, row } = await setup(page);
  // A long related title must not widen the dialog.
  await page.route("**/api/related?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        semantic: false,
        items: [{ pageId: db.id, title: "Bei automatischer Zuordnung der Rechnung eine Email an die Buchhaltung senden", pageTitle: "Teamspace", icon: "file", reasons: ["title"] }],
      }),
    }),
  );
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry.locator(".related-page")).toBeVisible();
  await page.waitForTimeout(400); // the dialog rises in
  const dialog = await box(page, ".modal");
  expect(dialog.top).toBeGreaterThanOrEqual(47 + 8);
  expect(dialog.bottom).toBeGreaterThanOrEqual(34 + 8);
  expect(await entry.evaluate((d) => d.scrollWidth - d.clientWidth)).toBeLessThanOrEqual(1);
  const title = entry.locator(".related-title");
  expect(await title.evaluate((t) => getComputedStyle(t).fontSize)).toBe("13px");
  expect(await title.evaluate((t) => t.scrollWidth > t.clientWidth)).toBe(true); // ends in "…"
  // The empty date field says what it is for.
  const empty = entry.locator(".date-input[data-placeholder]").first();
  await expect(empty).toHaveAttribute("data-placeholder", "Datum wählen");
  expect(await empty.evaluate((d) => getComputedStyle(d, "::before").content)).toBe('"Datum wählen"');

  // As a page of its own the record pads its content instead.
  await page.evaluate(() => document.querySelector(".modal")!.classList.add("modal-full"));
  await page.waitForTimeout(300);
  expect((await box(page, ".modal-heading")).top).toBeGreaterThanOrEqual(47 + 12);
});

test("in landscape nothing sits under the notch, also without the sidebar", async ({ browser }, info) => {
  test.skip(info.project.name !== "mobile", "Once is enough; the test sets its own viewport.");
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, locale: "de-DE" });
  const page = await context.newPage();
  await insets(page, ":root{--safe-left:47px!important;--safe-right:47px!important;--safe-bottom:21px!important}");
  const { db, row } = await setup(page);
  await page.goto(`/#page=${db.id}`);
  await page.locator(".sidebar-hide").click();
  await expect(page.locator(".app-shell.desktop-collapsed")).toBeVisible();
  expect((await box(page, ".topbar")).left).toBeGreaterThanOrEqual(47);
  expect((await box(page, ".main-scroll")).left).toBeGreaterThanOrEqual(47);
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  await expect(page.getByRole("dialog", { name: "Eintrag", exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  const dialog = await box(page, ".modal");
  expect(dialog.left).toBeGreaterThanOrEqual(47);
  expect(dialog.right).toBeGreaterThanOrEqual(47);
  expect(dialog.bottom).toBeGreaterThanOrEqual(21);
  await context.close();
});
