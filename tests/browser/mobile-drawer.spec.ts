import { test, expect, type Page } from "@playwright/test";
import { openSidebarTool } from "./sidebar-tools";

// The navigation drawer on phones, as the iOS app shows it: "Navigation" in
// the bottom bar, then "Einstellungen" in the drawer, then "Navigation"
// again showed the dimmed settings with the drawer still off screen, while
// the tab said it was open. A view transition that captured the page while
// the drawer slid out of it left WebKit with a stale picture of the drawer.
// Now nothing in the shell starts a view transition while the drawer is
// open or sliding, and the drawer and the tab always agree.

const IOS_APP_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.4.0";
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function setUp(page: Page, inApp: boolean) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript((inApp) => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
    if (inApp) {
      // The app's web view (flowplan-app, src/bridge-script.ts).
      (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage: () => {} };
      (window as unknown as { FlowplanApp: unknown }).FlowplanApp = {
        platform: "ios",
        version: "1.4.0",
        refresh: () => {},
        haptic: () => {},
        backState: () => {},
        openSettings: () => {},
      };
    }
    // The dev server's badge sits on "Start" in the bar.
    const hideDevBadge = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    };
    if (document.head) hideDevBadge();
    else document.addEventListener("DOMContentLoaded", hideDevBadge);
    // Every view transition the page starts, and whether the drawer was open
    // or still sliding at that moment.
    const log: { drawer: boolean }[] = [];
    (window as unknown as { __transitions: typeof log }).__transitions = log;
    const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
    const start = doc.startViewTransition?.bind(document);
    if (start)
      doc.startViewTransition = (update: () => void) => {
        const sidebar = document.querySelector(".app-shell > .sidebar");
        const sliding = !!sidebar?.getAnimations().some((a) => a.playState === "running");
        log.push({ drawer: !!document.querySelector(".app-shell.nav-open") || sliding });
        return start(update);
      };
  }, inApp);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const create = async (kind: string, name: string) => {
    const title = `${name} ${Date.now()}`;
    const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind });
    return { id: created.id as string, title };
  };
  return { create, command };
}

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Schnellnavigation" });
const menuTab = (page: Page) => tabBar(page).getByRole("button", { name: /^Navigation (öffnen|schließen)$/ });
const drawer = (page: Page) => page.locator(".app-shell > .sidebar");

// The tab and what is on screen agree: open, the drawer stands at the left
// edge over the dimmed page; closed, it is out of view and nothing is dimmed.
async function expectDrawer(page: Page, open: boolean) {
  await expect(menuTab(page)).toHaveAttribute("aria-expanded", String(open));
  await expect
    .poll(async () => {
      const box = await drawer(page).boundingBox();
      return box ? Math.round(box.x + (open ? 0 : box.width)) : null;
    })
    .toBe(0);
  if (open) await expect(page.locator(".mobile-scrim")).toBeVisible();
  else await expect(page.locator(".mobile-scrim")).toBeHidden();
}

const transitionsWithDrawer = (page: Page) =>
  page.evaluate(() => (window as unknown as { __transitions: { drawer: boolean }[] }).__transitions.filter((t) => t.drawer).length);

for (const inApp of [true, false]) {
  test.describe(inApp ? "in the iOS app" : "in the phone's browser", () => {
    test.use({ userAgent: inApp ? IOS_APP_UA : IOS_SAFARI_UA });

    test("Navigation, Einstellungen, Navigation: the drawer opens over the settings", async ({ page }, info) => {
      test.skip(info.project.name !== "mobile", "The drawer is the phone layout's.");
      await setUp(page, inApp);
      await page.goto("/#home");
      await expectDrawer(page, false);

      await menuTab(page).tap();
      await expectDrawer(page, true);
      await openSidebarTool(page, "Einstellungen", { tap: true });
      await expect(page.getByRole("heading", { name: "Einstellungen", level: 1 })).toBeVisible();
      await expectDrawer(page, false);

      await menuTab(page).tap();
      await expectDrawer(page, true);
      // It stays open.
      await page.waitForTimeout(500);
      await expectDrawer(page, true);
      // A settings section, and the drawer again.
      await menuTab(page).tap();
      await expectDrawer(page, false);
      await page.locator('.settings-tile[data-section="appearance"]').tap();
      await expect(page).toHaveURL(/#settings\/appearance$/);
      await menuTab(page).tap();
      await expectDrawer(page, true);
      await page.locator(".mobile-scrim").tap({ position: { x: 370, y: 300 } });
      await expectDrawer(page, false);

      expect(await transitionsWithDrawer(page)).toBe(0);
    });

    test("every destination of the drawer and the bar: the tab matches the drawer", async ({ page }, info) => {
      test.skip(info.project.name !== "mobile", "The drawer is the phone layout's.");
      test.setTimeout(150000);
      const { create, command } = await setUp(page, inApp);
      const doc = await create("document", "Drawer page");
      const db = await create("database", "Drawer database");
      const board = await create("whiteboard", "Drawer board");
      const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Drawer record" } });
      await page.goto("/#home");

      // From the drawer: screens and pages of the tree.
      const fromDrawer: [string, () => Promise<void>][] = [
        ["Posteingang", () => drawer(page).getByRole("button", { name: /^Posteingang/ }).first().tap()],
        ["Startseite", () => drawer(page).getByRole("button", { name: /^Startseite/ }).first().tap()],
        ["document", () => drawer(page).getByText(doc.title, { exact: true }).tap()],
        ["database", () => drawer(page).getByText(db.title, { exact: true }).tap()],
        ["whiteboard", () => drawer(page).getByText(board.title, { exact: true }).tap()],
        ["Einstellungen", () => openSidebarTool(page, "Einstellungen", { tap: true })],
      ];
      for (const [, go] of fromDrawer) {
        await menuTab(page).tap();
        await expectDrawer(page, true);
        await go();
        await expectDrawer(page, false);
        await menuTab(page).tap();
        await expectDrawer(page, true);
        await menuTab(page).tap();
        await expectDrawer(page, false);
      }

      // From the bar while the drawer is open: Start and Posteingang close it.
      for (const name of ["Start", /^Posteingang/]) {
        await menuTab(page).tap();
        await expectDrawer(page, true);
        await tabBar(page).getByRole("button", { name }).tap();
        await expectDrawer(page, false);
        await menuTab(page).tap();
        await expectDrawer(page, true);
        await menuTab(page).tap();
        await expectDrawer(page, false);
      }

      // Search: the drawer closes for the dialog and opens again after it.
      await menuTab(page).tap();
      await expectDrawer(page, true);
      await tabBar(page).getByRole("button", { name: "Suchen" }).tap();
      await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toBeVisible();
      // (The bar steps aside for the keyboard of the search field.)
      await expect.poll(async () => ((b) => (b ? Math.round(b.x + b.width) : null))(await drawer(page).boundingBox())).toBe(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toBeHidden();
      await menuTab(page).tap();
      await expectDrawer(page, true);
      await menuTab(page).tap();

      // A record open in its dialog: the drawer opens over the database.
      await page.goto(`/#page=${db.id}&row=${row.id}`);
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await menuTab(page).tap();
      await expectDrawer(page, true);
      await menuTab(page).tap();
      await expectDrawer(page, false);

      expect(await transitionsWithDrawer(page)).toBe(0);
    });
  });
}
