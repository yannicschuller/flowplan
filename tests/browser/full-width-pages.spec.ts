import { test, expect, type Page } from "@playwright/test";

// "Seiten in voller Breite anzeigen" (#257, Settings → Appearance →
// Editor): every page at full width for this person, from the first paint
// on (no jump from the narrow column); the page's own "Volle Breite" in the
// ⋯ menu shows as on and locked, and the page is stored unchanged.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const newPage = (title: string) =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" }) as Promise<{ id: string }>;
  return { command, newPage };
}
async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: /Willkommen bei Flowplan/ });
  if (await welcome.isVisible().catch(() => false)) await page.keyboard.press("Escape");
}

test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.fullWidthPages", fullWidthPages: false } });
});

test("all pages at full width for this person, without a jump; the page's switch shows as locked", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the column is the whole screen on a phone");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  const { command, newPage } = await setup(page);
  const doc = await newPage(`Breit für mich ${Date.now()}`);
  await command({ action: "profile.fullWidthPages", fullWidthPages: false });

  // Off: the usual column.
  await page.goto(`/#page=${doc.id}`);
  await dismissWelcome(page);
  const content = page.locator(".split-primary .page-content").first();
  await expect(content).toBeVisible({ timeout: 30_000 });
  // The text column, measured at the title (it spans the column).
  const title = page.locator(".split-primary textarea.page-title");
  await expect(title).toBeVisible();
  await expect(content).not.toHaveClass(/full-width/);
  const narrow = (await title.boundingBox())!.width;
  expect(narrow).toBeLessThanOrEqual(820);

  // On: every width the column ever had, from its first frame on.
  await command({ action: "profile.fullWidthPages", fullWidthPages: true });
  await page.addInitScript(() => {
    const w = window as unknown as { __widths: number[] };
    w.__widths = [];
    const sample = () => {
      const el = document.querySelector(".split-primary textarea.page-title");
      if (el) w.__widths.push(Math.round(el.getBoundingClientRect().width));
      if (w.__widths.length < 400) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.reload();
  await dismissWelcome(page);
  await expect(content).toHaveClass(/full-width/, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const wide = (await title.boundingBox())!.width;
  expect(wide).toBeGreaterThan(narrow + 200);
  const widths = await page.evaluate(() => (window as unknown as { __widths: number[] }).__widths);
  expect(widths.length).toBeGreaterThan(0);
  expect(widths.filter((w) => Math.abs(w - wide) > 2), "the column never showed narrow first").toEqual([]);

  // The page's own switch: shown as on, locked, with the reason.
  await page.getByRole("button", { name: "Seitenaktionen" }).first().click();
  const item = page.getByRole("menuitem", { name: /Volle Breite/ });
  await expect(item).toContainText("✓");
  await expect(item).toContainText("Deine Einstellung");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  // The page itself is unchanged – it stays narrow for everyone else.
  expect((await (await page.request.get(`/api/pages/${doc.id}`)).json()).page.full_width).toBeFalsy();

  // Off again from the settings: back to the column, at once.
  await page.goto("/#settings/appearance");
  const toggle = page.getByRole("switch", { name: "Seiten in voller Breite anzeigen" });
  await expect(toggle).toBeChecked({ timeout: 30_000 });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).fullWidthPages).toBe(false);
  await page.goto(`/#page=${doc.id}`);
  await expect(content).not.toHaveClass(/full-width/, { timeout: 30_000 });
});
