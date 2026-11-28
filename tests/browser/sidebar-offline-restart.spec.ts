import { test, expect, type Page } from "@playwright/test";

// #641: offline, the app's page comes from the service worker's copy of "/"
// – stored on the last navigation online, rendered with the layout cookie
// of that time. A sidebar hidden (or resized) after that came back on every
// start offline, and the app then wrote the copy's layout back over the
// device's choice. Now the device's own layout (localStorage, else its
// cookie) wins once the app runs, and the choice is kept. The iOS app runs
// no service worker but loads its own stored copy of the same page with the
// instance's origin (flowplan-app src/offline/document.ts): the same case.
//
// Loading while offline needs the production build (TEST_BASE_URL, see
// tests/browser/offline-app.spec.ts).

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const layoutCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "flowplan-layout")?.value;
const shell = (page: Page) => page.locator(".app-shell");
const sidebar = (page: Page) => page.locator(".app-shell > .sidebar");

test("a sidebar hidden and resized online stays so after a restart offline (#641)", async ({ page, context }, info) => {
  test.setTimeout(300_000);
  test.skip(info.project.name !== "desktop", "One service-worker run covers the shared code path.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const assets = await (await page.request.get("/api/offline/assets")).json();
  test.skip(!assets.files?.length, "Needs a production build (no client build files listed).");
  // The app shell's classes and width as the browser parses it, before any
  // script of the app ran.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const seen = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(".app-shell");
      if (!el) return;
      seen.disconnect();
      w.__firstShell = { className: el.className, width: el.style.getPropertyValue("--sidebar-width") };
    });
    seen.observe(document, { childList: true, subtree: true });
  });
  const firstShell = () => page.evaluate(() => (window as unknown as { __firstShell?: { className: string; width: string } }).__firstShell);

  await page.goto("/#settings/devices");
  await page.getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" }).click();
  await expect(page.getByText(/offline verfügbar\./)).toBeVisible({ timeout: 180_000 });
  // Arrow keys move the sidebar's edge in steps of 16 px (Shift: 48 px);
  // pressed again until the app listens.
  const handle = page.getByRole("separator", { name: "Breite der Seitenleiste" });
  const widen = async (above: number) => {
    await expect(async () => {
      await handle.focus();
      await page.keyboard.press("Shift+ArrowRight");
      expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(above);
    }).toPass();
    return Number(await handle.getAttribute("aria-valuenow"));
  };
  // A device that has a layout cookie already (here: a dragged width) …
  await page.goto("/?start=0#home");
  const before = await widen(260);
  await expect.poll(() => layoutCookie(page)).toBe(`${before}.0.0.0`);
  // … started online with the sidebar shown: the service worker keeps this
  // page, rendered with that cookie, as its copy of "/".
  await page.goto("/?start=1#home");
  await expect(sidebar(page)).toBeVisible();
  const storedPage = () =>
    page.evaluate(async () => (await (await caches.open("flowplan-data-v1")).match("/"))?.text() ?? "");
  await expect.poll(async () => await storedPage()).toContain(`--sidebar-width:${before}px`);

  // Then resized again and hidden.
  const width = await widen(before + 40);
  await page.locator(".sidebar-hide").click();
  await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
  await expect.poll(() => layoutCookie(page)).toBe(`${width}.0.0.1`);
  // The stored copy still has the sidebar shown at the earlier width.
  const stored = await storedPage();
  expect(stored).not.toMatch(/class="app-shell [^"]*\bdesktop-collapsed\b/);
  expect(stored).toContain(`--sidebar-width:${before}px`);

  // The app closed and started again offline. setOffline alone leaves the
  // service worker's own requests online in Chromium; aborting every
  // request cuts those as well.
  await context.setOffline(true);
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  await page.goto("about:blank");
  await page.goto("/?start=2#home");
  await expect(page.locator(".offline-status-button")).toBeVisible({ timeout: 15_000 });
  // The page is the stored copy (the cause of #641) …
  expect((await firstShell())?.className).not.toMatch(/\bdesktop-collapsed\b/);
  expect((await firstShell())?.width).toBe(`${before}px`);
  // … and the app takes the device's layout: hidden, the dragged width.
  await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
  await expect(sidebar(page)).toBeHidden();
  await expect(shell(page)).toHaveCSS("--sidebar-width", `${width}px`);
  await page.waitForTimeout(500);
  await expect(sidebar(page)).toBeHidden();
  // Nothing wrote the copy's layout back.
  expect(await layoutCookie(page)).toBe(`${width}.0.0.1`);
  expect(
    await page.evaluate(() => ["flowplan-layout", "flowplan-sidebar-collapsed", "flowplan-sidebar-width"].map((key) => localStorage.getItem(key))),
  ).toEqual([`${width}.0.0.1`, "1", String(width)]);

  // Another start offline, with the cookie of the copy's time (WebKit may
  // not keep the latest cookie when the app is closed): still hidden.
  await page.evaluate((before) => (document.cookie = `flowplan-layout=${before}.0.0.0; path=/; max-age=31536000; samesite=lax`), before);
  await page.goto("/?start=3#home");
  await expect(page.locator(".offline-status-button")).toBeVisible({ timeout: 15_000 });
  await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
  await page.waitForTimeout(500);
  await expect(sidebar(page)).toBeHidden();
  // … and the cookie follows the device again.
  await expect.poll(() => layoutCookie(page)).toBe(`${width}.0.0.1`);

  // Shown again offline: at the dragged width, and kept.
  await page.locator(".topbar .mobile-menu").click();
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page)).toHaveJSProperty("offsetWidth", width);
  await expect.poll(() => layoutCookie(page)).toBe(`${width}.0.0.0`);

  // Back online, a start renders the device's layout from the first paint.
  await context.unrouteAll();
  await context.setOffline(false);
  await page.locator(".sidebar-hide").click();
  await expect.poll(() => layoutCookie(page)).toBe(`${width}.0.0.1`);
  await page.goto("/?start=4#home");
  expect((await firstShell())?.className).toMatch(/\bdesktop-collapsed\b/);
  expect((await firstShell())?.width).toBe(`${width}px`);
  await page.waitForTimeout(500);
  await expect(sidebar(page)).toBeHidden();
});
