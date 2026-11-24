import { test, expect, type Page } from "@playwright/test";

// #510: Flowplan in half of a Windows screen. With 125 % display scaling the
// window is about 767.2 CSS px wide – neither the phone layout (up to
// 767 px) nor the docked sidebar (from 768 px) applied: the sidebar stayed
// docked, its hide button did nothing and there was no button to open it.
// Now such a window gets the phone layout (drawer), and at every width
// there is a working way to hide the sidebar and bring it back; the
// shortcut opens and closes the drawer where the sidebar is one.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
      localStorage.setItem("flowplan-offline-offer", "never");
    } catch {}
  });
}

const shell = (page: Page) => page.locator(".app-shell");
const sidebar = (page: Page) => page.locator(".app-shell > .sidebar");
const openButton = (page: Page) => page.locator(".topbar .mobile-menu");
const hideButton = (page: Page) => page.locator(".sidebar-hide");
// The closed drawer waits beside the window (moved out, not hidden).
const drawerOpen = (page: Page, timeout?: number) => expect(sidebar(page)).toBeInViewport({ ratio: 0.5, timeout });
const drawerClosed = (page: Page, timeout?: number) => expect(sidebar(page)).not.toBeInViewport({ timeout });

// The server's page is there before the app listens for keys: pressed
// again until it took effect.
async function shortcut(page: Page, check: () => Promise<void>) {
  await expect(async () => {
    await page.keyboard.press("Control+Alt+B");
    await check();
  }).toPass();
}

test("a window of 767.2 px (half a screen at 125 %) gets the drawer", async ({ playwright }, info) => {
  test.skip(info.project.name === "mobile", "a desktop window");
  // Display scaling as on Windows (125 %): a window whose width in CSS
  // pixels lies just below 768, e.g. 767.2.
  const browser = await playwright.chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--force-device-scale-factor=1.25", "--window-size=766,900"],
  });
  try {
    const context = await browser.newContext({
      baseURL: origin,
      viewport: null,
      locale: "de-DE",
      extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" },
    });
    const page = await context.newPage();
    await signIn(page);
    await page.goto("/#home");
    const cssWidth = () => page.evaluate(() => document.documentElement.getBoundingClientRect().width);
    // The window's size as the window manager sets it: tried until the page
    // gets a fractional width just below 768 px.
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    let width = await cssWidth();
    for (let size = 750; size <= 790 && !(width > 767 && width < 768); size++) {
      // The next resize of the page, or none within half a second (the
      // same width as before).
      const resized = page.evaluate(
        () => new Promise<void>((done) => {
          addEventListener("resize", () => done(), { once: true });
          setTimeout(done, 500);
        }),
      );
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: size } });
      await resized;
      width = await cssWidth();
    }
    test.skip(!(width > 767 && width < 768), `no window of this Chromium is between 767 and 768 px (${width})`);

    // Closed drawer: the page has the whole width, the button opens it.
    await expect(openButton(page)).toBeVisible();
    await drawerClosed(page);
    await openButton(page).click();
    await expect(shell(page)).toHaveClass(/\bnav-open\b/, { timeout: 15000 });
    await drawerOpen(page);
    await hideButton(page).click();
    await expect(shell(page)).not.toHaveClass(/\bnav-open\b/);
    await drawerClosed(page);

    // The shortcut opens and closes the drawer.
    await shortcut(page, () => drawerOpen(page, 1000));
    await shortcut(page, () => drawerClosed(page, 1000));
    await expect(shell(page)).not.toHaveClass(/\bdesktop-collapsed\b/);
  } finally {
    await browser.close();
  }
});

for (const width of [683, 768, 960]) {
  test(`at ${width} px the sidebar can be hidden and brought back`, async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "a desktop window");
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await page.goto("/#home");
    if (width < 768) {
      // The drawer: closed at first; the shortcut must not collapse the
      // sidebar for later, wider windows.
      await drawerClosed(page);
      await shortcut(page, () => drawerOpen(page, 1000));
      await hideButton(page).click();
      await drawerClosed(page);
      await expect(shell(page)).not.toHaveClass(/\bdesktop-collapsed\b/);
      await page.setViewportSize({ width: 1100, height: 800 });
      await expect(sidebar(page)).toBeVisible();
      return;
    }
    await expect(sidebar(page)).toBeVisible();
    // A click before the app hydrated is replayed once it has.
    await hideButton(page).click();
    await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/, { timeout: 15000 });
    await expect(sidebar(page)).toBeHidden();
    await expect(openButton(page)).toBeVisible();
    await openButton(page).click();
    await expect(sidebar(page)).toBeVisible();
    await shortcut(page, () => expect(sidebar(page)).toBeHidden({ timeout: 1000 }));
    await shortcut(page, () => expect(sidebar(page)).toBeVisible({ timeout: 1000 }));
  });
}
