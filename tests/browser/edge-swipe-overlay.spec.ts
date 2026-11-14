import { test, expect, type Page } from "@playwright/test";

// #285: on iPhone and iPad a swipe from the left edge opens the sidebar over
// the current page – nothing navigates, the page stays visible beside it and
// a tap beside it closes it. Over the page the sidebar has a width of its
// own, kept per device apart from the docked width. In the app the person
// may choose "Zurück" instead ("Wischen vom linken Rand", Settings →
// Darstellung & Sprache): the very edge is then the app's back swipe again
// and the sidebar opens a little further in, as before.

const IPHONE_APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";
const IPAD_APP_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";

// The app's web view has no back swipe of its own (the app's is native and
// not emulated here); Chromium's – overscroll history navigation – would go
// back wherever the page leaves a sideways swipe alone.
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ["--overscroll-history-navigation=0", "--disable-features=OverscrollHistoryNavigation"],
  },
});

const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setUp(page: Page, inApp: boolean) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  await page.request.post("/api/command", { headers: { origin: origin() }, data: { action: "profile.onboarded" } });
  await page.addInitScript((inApp) => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
    const w = window as unknown as Record<string, unknown>;
    // What the page told the app (src/bridge-script.ts in flowplan-app).
    const edge: string[] = [];
    w.__edge = edge;
    if (inApp) {
      w.ReactNativeWebView = { postMessage: () => {} };
      w.FlowplanApp = {
        platform: "ios",
        version: "1.1.0",
        refresh: () => {},
        haptic: () => {},
        backState: () => {},
        openSettings: () => {},
        edgeSwipe: (mode: string) => edge.push(mode),
      };
    }
    const hideDevBadge = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    };
    if (document.head) hideDevBadge();
    else document.addEventListener("DOMContentLoaded", hideDevBadge);
  }, inApp);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin: origin() },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Edge page ${Date.now()}`, kind: "document" },
    })
  ).json();
  return { pageId: created.id as string };
}

// A swipe with one finger, from (x0, y) to (x1, y), as touch events.
async function swipe(page: Page, x0: number, x1: number, y = 420) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 8;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

const sidebar = (page: Page) => page.locator(".app-shell > .sidebar");
const shell = (page: Page) => page.locator(".app-shell");
const sidebarWidth = async (page: Page) => Math.round((await sidebar(page).boundingBox())?.width ?? 0);

async function expectOverlay(page: Page, open: boolean) {
  if (open) await expect(shell(page)).toHaveClass(/\bnav-open\b/);
  else await expect(shell(page)).not.toHaveClass(/\bnav-open\b/);
  await expect
    .poll(async () => {
      const box = await sidebar(page).boundingBox();
      return box ? Math.round(open ? box.x : box.x + box.width) : 0;
    })
    .toBe(0);
  if (open) await expect(page.locator(".mobile-scrim")).toBeVisible();
  else await expect(page.locator(".mobile-scrim")).toBeHidden();
}

// A page of the workspace, loaded fresh (it has a step back: the start page).
async function openPage(page: Page, pageId: string) {
  await page.goto(`/#page=${pageId}`);
  await expect(page.locator(".page-content, .ProseMirror").first()).toBeVisible({ timeout: 15000 });
}

// Where the page is, and how much history it has – the swipe changes neither.
const place = (page: Page) => page.evaluate(() => ({ hash: location.hash, length: history.length }));

test.describe("iPhone (app)", () => {
  test.use({ userAgent: IPHONE_APP_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a swipe from the very edge opens the sidebar over the page; nothing navigates; a tap beside it closes it", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    const { pageId } = await setUp(page, true);
    await openPage(page, pageId);
    // The app is told to leave the edge to the sidebar (the default).
    await expect.poll(() => page.evaluate(() => (window as unknown as { __edge: string[] }).__edge.at(-1))).toBe("drawer");
    const before = await place(page);

    await swipe(page, 3, 300);
    await expectOverlay(page, true);
    expect(await place(page)).toEqual(before);
    // Its own width: min(360px, 85vw), the page visible beside it.
    const width = await sidebarWidth(page);
    expect(width).toBe(Math.round(390 * 0.85));
    expect(width).toBeLessThanOrEqual(390 - 48);
    // The page beside it is out of reach while it is open.
    await expect(page.locator("main.main")).toHaveAttribute("inert", "");

    await page.locator(".mobile-scrim").tap({ position: { x: 370, y: 300 } });
    await expectOverlay(page, false);
    expect(await place(page)).toEqual(before);

    // A swipe to the left on the open sidebar closes it too.
    await swipe(page, 3, 300);
    await expectOverlay(page, true);
    await swipe(page, 300, 20);
    await expectOverlay(page, false);
    expect(await place(page)).toEqual(before);
  });

  test("its width is dragged at its right edge and remembered on this device", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    await setUp(page, true);
    await page.goto("/#home");
    await swipe(page, 3, 300);
    await expectOverlay(page, true);
    const handle = sidebar(page).locator(".sidebar-resize");
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await swipe(page, box.x + box.width / 2, 260);
    await expect.poll(() => sidebarWidth(page)).toBe(260);
    // Dragging the handle does not close the sidebar.
    await expectOverlay(page, true);
    expect(await page.evaluate(() => localStorage.getItem("flowplan-sidebar-overlay-width"))).toBe("260");
    expect(await page.evaluate(() => localStorage.getItem("flowplan-sidebar-width"))).toBeNull();

    await page.reload();
    await swipe(page, 3, 300);
    await expectOverlay(page, true);
    expect(await sidebarWidth(page)).toBe(260);
  });

  test("“Zurück”: the very edge is back again, the sidebar opens a little further in", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    const { pageId } = await setUp(page, true);
    await page.goto("/#settings/appearance");
    const row = page.getByRole("radiogroup", { name: "Wischen vom linken Rand" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("radio", { name: "Seitenleiste öffnen" })).toBeChecked();
    await row.getByText("Zurück", { exact: true }).tap();
    await expect(row.getByRole("radio", { name: "Zurück" })).toBeChecked();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __edge: string[] }).__edge.at(-1))).toBe("back");

    // A page with a step back: the edge belongs to the app's back swipe
    // (the app's own, not emulated here) – the page stays out of it.
    await page.goto(`/#page=${pageId}`);
    await expect(page.locator(".page-content, .ProseMirror").first()).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { FlowplanNavigation?: { canGoBack: () => boolean } }).FlowplanNavigation?.canGoBack())).toBe(true);
    await swipe(page, 6, 300);
    await page.waitForTimeout(400);
    await expectOverlay(page, false);
    // A little further in it opens, as before.
    await swipe(page, 40, 330);
    await expectOverlay(page, true);

    // After a reload the app hears "back" again.
    await page.reload();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __edge: string[] }).__edge.at(-1))).toBe("back");
  });

  test("in the browser the choice is not offered (Safari keeps its own back swipe)", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    await setUp(page, false);
    await page.goto("/#settings/appearance");
    await expect(page.getByRole("radiogroup", { name: "Animationen" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Wischen vom linken Rand" })).toHaveCount(0);
  });
});

test.describe("iPad (app)", () => {
  test.use({
    userAgent: IPAD_APP_UA,
    viewport: { width: 820, height: 1180 },
    isMobile: true,
    hasTouch: true,
  });

  test("docked: the swipe does nothing; collapsed: it opens the sidebar over the page with its own width", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "Touch emulation runs in the mobile project.");
    const { pageId } = await setUp(page, true);
    await page.addInitScript(() => {
      // A docked width of this device, before the page reads it.
      if (!localStorage.getItem("flowplan-sidebar-width")) localStorage.setItem("flowplan-sidebar-width", "280");
    });
    await openPage(page, pageId);
    await expect.poll(() => sidebarWidth(page)).toBe(280);
    const before = await place(page);

    // Docked and visible: already there, nothing happens. (On a quiet spot
    // of the sidebar – a page of the tree would start its own drag.)
    const quiet = await page.evaluate(() => {
      for (let y = 120; y < innerHeight - 40; y += 20) {
        const el = document.elementFromPoint(3, y);
        if (el?.closest(".app-shell > .sidebar") && !el.closest("[draggable=true], a, button, input")) return y;
      }
      return null;
    });
    expect(quiet).not.toBeNull();
    await swipe(page, 3, 400, quiet!);
    await page.waitForTimeout(300);
    await expect(shell(page)).not.toHaveClass(/\bnav-open\b/);
    expect(await place(page)).toEqual(before);

    // Collapsed: the swipe pulls it in over the page, 400 px by default.
    await page.locator(".sidebar-hide").tap();
    await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
    await expect(sidebar(page)).toBeHidden();
    await swipe(page, 3, 420);
    await expectOverlay(page, true);
    expect(await sidebarWidth(page)).toBe(400);
    expect(await place(page)).toEqual(before);
    // The page did not move under it.
    const main = (await page.locator("main.main").boundingBox())!;
    expect(Math.round(main.x)).toBe(0);

    // Wider at its right edge – the docked width stays.
    const handle = (await sidebar(page).locator(".sidebar-resize").boundingBox())!;
    await swipe(page, handle.x + handle.width / 2, 480);
    await expect.poll(() => sidebarWidth(page)).toBe(480);
    expect(await page.evaluate(() => localStorage.getItem("flowplan-sidebar-overlay-width"))).toBe("480");
    expect(await page.evaluate(() => localStorage.getItem("flowplan-sidebar-width"))).toBe("280");

    // A tap beside it closes it; still collapsed, still the same page.
    await page.touchscreen.tap(700, 600);
    await expect(shell(page)).not.toHaveClass(/\bnav-open\b/);
    await expect(shell(page)).toHaveClass(/\bdesktop-collapsed\b/);
    await expect(sidebar(page)).toBeHidden();
    expect(await place(page)).toEqual(before);

    // Docked again: its own width.
    await page.reload();
    await expect.poll(() => sidebarWidth(page)).toBe(280);
    await page.locator(".sidebar-hide").tap();
    await swipe(page, 3, 420);
    await expectOverlay(page, true);
    expect(await sidebarWidth(page)).toBe(480);
  });
});
