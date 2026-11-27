import { test, expect, type Page } from "@playwright/test";

// #619: a page with an emoji as its icon looked larger in the sidebar than
// the pages with a library icon. A colour emoji fills its whole box, a
// library icon draws inside it with room to spare; in the sidebar rows the
// emoji is a size smaller and keeps the icon slot of the symbols beside it.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setUp(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const create = async (name: string, icon: string) => {
    const title = `${name} ${Date.now()}`;
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
    await command({ action: "page.update", pageId: created.id, patch: { icon } });
    return title;
  };
  return { create };
}

test("an emoji page icon in the sidebar is as large as a library icon", async ({ page }, info) => {
  const { create } = await setUp(page);
  const emojiTitle = await create("Emoji icon", "📋");
  const symbolTitle = await create("Symbol icon", "rocket");
  await page.goto("/#home");
  if (info.project.name === "mobile")
    await page.getByRole("navigation", { name: "Schnellnavigation" }).getByRole("button", { name: /^Navigation/ }).tap();

  const row = (title: string) => page.locator(".app-shell > .sidebar .page-nav", { hasText: title });
  const emoji = row(emojiTitle).locator(".page-emoji");
  const symbol = row(symbolTitle).locator(".page-nav-title svg").first();
  await expect(emoji).toBeVisible();
  await expect(symbol).toBeVisible();

  const emojiBox = await emoji.boundingBox();
  const symbolBox = await symbol.boundingBox();
  // The same icon slot, so the titles line up.
  expect(emojiBox?.width).toBe(symbolBox?.width);
  expect(emojiBox?.height).toBe(symbolBox?.height);
  // The glyph a size smaller than the slot it sits in.
  const fontSize = parseFloat(await emoji.evaluate((el) => getComputedStyle(el).fontSize));
  expect(fontSize).toBeLessThan(emojiBox?.width ?? 0);
});
