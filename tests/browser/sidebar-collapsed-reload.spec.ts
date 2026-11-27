import { test, expect, type Page } from "@playwright/test";

// #331: the sidebar the person hid stays hidden after the app restarts or
// the page reloads (after a server update) – kept per device in the layout
// cookie (lib/layout-cookie.ts), so the server's first paint already has it
// hidden, no flash of the sidebar. Shown again, it stays shown. Phones have
// the drawer instead: closing it is not a choice to keep.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const IPAD_APP_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";

async function setUp(page: Page, inApp = false) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript((inApp) => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
    const w = window as unknown as Record<string, unknown>;
    if (inApp) {
      w.ReactNativeWebView = { postMessage: () => {} };
      w.FlowplanApp = { platform: "ios", version: "1.1.0", refresh: () => {}, haptic: () => {}, backState: () => {}, edgeSwipe: () => {} };
    }
    // The app shell's classes as the browser parses it, before any script
    // of the app ran.
    const seen = new MutationObserver(() => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      if (!shell) return;
      seen.disconnect();
      w.__firstShell = shell.className;
    });
    seen.observe(document, { childList: true, subtree: true });
  }, inApp);
}

const layoutCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "flowplan-layout")?.value;
const firstShell = (page: Page) => page.evaluate(() => (window as unknown as { __firstShell?: string }).__firstShell ?? "");
const shell = (page: Page) => page.locator(".app-shell");
const sidebar = (page: Page) => page.locator(".app-shell > .sidebar");

async function hideReloadShow(page: Page, press: (locator: ReturnType<Page["locator"]>) => Promise<void>) {
  await page.goto("/#home");
  await expect(sidebar(page)).toBeVisible();
  expect(await firstShell(page)).not.toMatch(/\bdesktop-collapsed\b/);

  await press(page.locator(".sidebar-hide"));
  await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
  await expect.poll(() => layoutCookie(page)).toMatch(/^\d+\.\d+\.[01]\.1$/);

  // The server's HTML already has it hidden …
  const html = await (await page.request.get("/")).text();
  expect(html).toMatch(/class="app-shell [^"]*\bdesktop-collapsed\b/);
  // … and so does the first paint after a reload (a restart of the app).
  await page.reload();
  expect(await firstShell(page)).toMatch(/\bdesktop-collapsed\b/);
  await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
  await expect(sidebar(page)).toBeHidden();
  // Still hidden once the app is running (nothing shows it again).
  await page.waitForTimeout(500);
  await expect(sidebar(page)).toBeHidden();

  // Shown again: shown after the next reload too.
  await press(page.locator(".topbar .mobile-menu"));
  await expect(shell(page)).not.toHaveClass(/\bdesktop-collapsed\b/);
  await expect(sidebar(page)).toBeVisible();
  await expect.poll(() => layoutCookie(page)).toMatch(/\.0$/);
  await page.reload();
  expect(await firstShell(page)).not.toMatch(/\bdesktop-collapsed\b/);
  await expect(sidebar(page)).toBeVisible();
}

test("a hidden sidebar stays hidden after a reload, from the first paint", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the sidebar is a drawer on phones");
  await setUp(page);
  await hideReloadShow(page, (button) => button.click());
});

test("the shortcut's choice is kept as well", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the sidebar is a drawer on phones");
  await setUp(page);
  // The server's page is there before the app has hydrated and listens
  // for keys: pressed again until it took effect.
  const press = (collapsed: boolean) =>
    expect(async () => {
      await page.keyboard.press("Control+Alt+B");
      if (collapsed) await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/, { timeout: 1000 });
      else await expect(shell(page)).not.toHaveClass(/\bdesktop-collapsed\b/, { timeout: 1000 });
    }).toPass();
  await page.goto("/#home");
  await expect(sidebar(page)).toBeVisible();
  await press(true);
  await expect.poll(() => layoutCookie(page)).toMatch(/\.1$/);
  await page.reload();
  expect(await firstShell(page)).toMatch(/\bdesktop-collapsed\b/);
  await press(false);
  await expect(sidebar(page)).toBeVisible();
  await expect.poll(() => layoutCookie(page)).toMatch(/\.0$/);
});

test.describe("iPad (app)", () => {
  test.use({ userAgent: IPAD_APP_UA, viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });

  test("a hidden sidebar stays hidden after the app restarts", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    await setUp(page, true);
    await hideReloadShow(page, (button) => button.tap());
  });
});

test.describe("iPhone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("closing the drawer is not kept as a hidden sidebar", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    await setUp(page);
    await page.goto("/#home");
    await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).tap();
    await expect(shell(page)).toHaveClass(/\bnav-open\b/);
    // With the bottom bar's "× Navigation" there, the sidebar has no close
    // button of its own (#617).
    await expect(page.locator(".sidebar-hide")).toBeHidden();
    await page.getByRole("navigation", { name: "Schnellnavigation" }).getByRole("button", { name: "Navigation schließen" }).tap();
    await expect(shell(page)).not.toHaveClass(/\bnav-open\b/);
    await page.waitForTimeout(300);
    // No cookie yet (nothing to keep) or one with the sidebar shown.
    expect((await layoutCookie(page)) ?? "").not.toMatch(/\.1$/);
    await page.reload();
    expect(await firstShell(page)).not.toMatch(/\bdesktop-collapsed\b/);
  });
});
