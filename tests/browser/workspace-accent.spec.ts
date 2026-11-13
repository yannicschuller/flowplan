import { test, expect, type Page } from "@playwright/test";

// A workspace's accent beyond text (#277): the mark in the sidebar, the
// browser tab's icon, default avatars, the info badge of the account
// ("E-Mail-Konto", "SSO") and the controls in the accent follow it, in
// light and dark; Flowplan's own look keeps its colours.
const ACCENT = "#c2410c";

const css = (page: Page, selector: string, property: string) =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p).trim(), property);
// A colour as #rrggbb (computed styles are rgb()).
const hex = (rgb: string) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  return m ? `#${m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : rgb;
};
const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
// A fresh load (a hash alone would not reload the workspace's look).
const open = async (page: Page, hash: string) => {
  await page.goto(`/#${hash}`);
  await page.reload();
};
const favicons = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map((l) => l.getAttribute("href") || ""));

test("the accent colours the mark, the tab's icon, default avatars, the info badge and controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.emulateMedia({ colorScheme: "light" });
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const workspaceId = boot.workspace.id;
  await command({ action: "workspace.theme", workspaceId, theme: null });

  // Flowplan's own look: its mark, its icon, the pastel avatars.
  await open(page, "settings/account");
  const badge = page.locator(".account-identity .status-badge.info, .status-badge.info").first();
  await expect(badge).toBeVisible();
  expect(hex(await css(page, ".brand-mark .brand-mark-from", "stop-color"))).toBe("#4146e6");
  expect(hex(await css(page, ".status-badge.info", "color"))).toBe("#3f6aa8");
  expect(hex(await css(page, ".avatar:not(.has-picture)", "color"))).toBe("#5d6478");
  expect(hex(await css(page, ".workspace-switch .workspace-letter", "background-color"))).toBe("#ece9f5");
  expect((await favicons(page)).some((h) => h.startsWith("data:"))).toBe(false);

  await command({ action: "workspace.theme", workspaceId, theme: { accent: ACCENT } });
  const { derivePalette, logoColors, readableOn, faviconHref } = await import("../../lib/workspace-theme");
  const logo = logoColors(ACCENT);
  const avatar = readableOn(ACCENT);

  for (const mode of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await open(page, "settings/account");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(mode);
    const p = derivePalette(ACCENT, mode);
    await expect.poll(() => rootVar(page, "--blue")).toBe(p.blue);
    // The mark in the sidebar.
    expect(hex(await css(page, ".brand-mark .brand-mark-from", "stop-color"))).toBe(logo.from);
    expect(hex(await css(page, ".brand-mark .brand-mark-to", "stop-color"))).toBe(logo.to);
    expect(hex(await css(page, ".brand-mark path.brand-mark-ink", "fill"))).toBe(logo.ink);
    // The tab's icon.
    await expect.poll(() => favicons(page)).toContain(faviconHref({ accent: ACCENT })!);
    expect(await page.evaluate(() => document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ?? "")).not.toMatch(/^data:/);
    // A default avatar (the account in the sidebar).
    expect(hex(await css(page, ".avatar:not(.has-picture)", "background-color"))).toBe(avatar.bg);
    expect(hex(await css(page, ".avatar:not(.has-picture)", "color"))).toBe(avatar.ink);
    // The workspace's letter tile.
    expect(hex(await css(page, ".workspace-switch .workspace-letter", "color"))).toBe(p.blue);
    // "E-Mail-Konto" / "SSO".
    expect(hex(await css(page, ".status-badge.info", "color"))).toBe(p.blue);
    expect(hex(await css(page, ".status-badge.info", "background-color"))).toBe(p.blueLight);
    // A primary button.
    const primary = page.locator(".button.primary:visible, button.primary:visible").first();
    if (await primary.count()) expect(hex(await primary.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(p.blue);
    await page.screenshot({ path: testInfo.outputPath(`accent-account-${mode}.png`) });

    // A switch, on.
    await open(page, "settings/notifications");
    const on = page.locator('.switch[aria-checked="true"]').first();
    await expect(on).toBeVisible();
    expect(hex(await on.evaluate((el) => getComputedStyle(el).backgroundColor))).toBe(p.blue);
  }

  // Back to Flowplan's own look: its icon again.
  await command({ action: "workspace.theme", workspaceId, theme: null });
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, "settings/account");
  await expect(page.locator(".status-badge.info").first()).toBeVisible();
  expect(hex(await css(page, ".brand-mark .brand-mark-from", "stop-color"))).toBe("#4146e6");
  expect((await favicons(page)).some((h) => h.startsWith("data:"))).toBe(false);
});
