import { test, expect, type CDPSession, type Page } from "@playwright/test";

// On phones the workspace scrolls its content pane, never the document
// (html.shell-document in app/globals.css, useShellDocument and
// guardChromeTouches in components/mobile-tab-bar.tsx). A swipe that started
// on the tab bar or the top bar went to the document in iOS web views, which
// rubber-banded under the fixed bars: the content slid up under the status
// bar and left an empty gap above the tab bar. Chromium does not rubber-band
// the document, so besides the layout this checks the means that stop iOS:
// the document cannot scroll and a swipe on the bars is cancelled.

async function signIn(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  // The demo account in development; a production build gets a first account.
  if (!(await page.request.post("/api/auth/demo", { headers: { origin } })).ok()) {
    const account = { name: "Mara Lindqvist", email: "mara-scroll@example.test", password: "ein-langes-passwort" };
    if (!(await page.request.post("/api/auth/register", { headers: { origin }, data: account })).ok())
      await page.request.post("/api/auth/password", { headers: { origin }, data: account });
  }
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Scrollen ${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).id as string;
}

// A one-finger swipe from (x, from) to (x, to), as the touch screen sends it.
async function swipe(cdp: CDPSession, page: Page, x: number, from: number, to: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / 12 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

// What a swipe may not change: the document stays put, the bar at the bottom.
const layout = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector(".mobile-tab-bar")!.getBoundingClientRect();
    const top = document.querySelector(".topbar")!.getBoundingClientRect();
    return {
      documentTop: document.scrollingElement!.scrollTop,
      windowY: window.scrollY,
      viewportTop: window.visualViewport?.offsetTop ?? 0,
      barBottom: Math.round(bar.bottom),
      topbarTop: Math.round(top.top),
      height: window.innerHeight,
      content: document.querySelector(".main-scroll")!.scrollTop,
    };
  });

// Counts the swipes' touchmoves that something cancelled (seen last, on window).
async function countCancelled(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __moves: { all: number; cancelled: number } };
    w.__moves = { all: 0, cancelled: 0 };
    window.addEventListener("touchmove", (e) => {
      w.__moves.all++;
      if (e.defaultPrevented) w.__moves.cancelled++;
    });
  });
  return async () => {
    const result = await page.evaluate(() => ({ ...(window as unknown as { __moves: { all: number; cancelled: number } }).__moves }));
    await page.evaluate(() => Object.assign((window as unknown as { __moves: object }).__moves, { all: 0, cancelled: 0 }));
    return result;
  };
}

test("a swipe on the tab bar or the top bar moves nothing; one on the content scrolls it", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The tab bar is shown on small screens.");
  const pageId = await signIn(page);
  await page.goto("/");
  const bar = page.locator(".mobile-tab-bar");
  await expect(bar).toBeVisible();
  // The document itself does not scroll or rubber-band while the workspace shows.
  await expect
    .poll(() =>
      page.evaluate(() => ({
        locked: document.documentElement.classList.contains("shell-document"),
        html: getComputedStyle(document.documentElement).overflowY,
        body: getComputedStyle(document.body).overflowY,
        overscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
      })),
    )
    .toEqual({ locked: true, html: "hidden", body: "hidden", overscroll: "none" });
  expect(await bar.evaluate((el) => getComputedStyle(el).touchAction)).toBe("none");

  // Content that scrolls: a page with many lines.
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  for (let i = 1; i <= 45; i++) {
    await page.keyboard.insertText(`Zeile ${i}`);
    await page.keyboard.press("Enter");
  }
  await expect(editor.locator("p", { hasText: "Zeile 45" })).toBeVisible();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.querySelector(".main-scroll")!.scrollTop = 0;
  });
  await expect(bar).toBeVisible();
  expect(await page.locator(".main-scroll").evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe("contain");
  expect(await page.locator(".main-scroll").evaluate((el) => el.scrollHeight > el.clientHeight + 300)).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  const cancelled = await countCancelled(page);
  const start = await layout(page);
  expect(start).toMatchObject({ documentTop: 0, windowY: 0, viewportTop: 0, barBottom: start.height, topbarTop: 0, content: 0 });

  // Up and down from the tab bar, then down from the top bar.
  const box = (await bar.boundingBox())!;
  await swipe(cdp, page, box.x + box.width / 2, box.y + box.height / 2, box.y - 420);
  expect(await layout(page)).toEqual(start);
  const up = await cancelled();
  expect(up.all).toBeGreaterThan(0);
  expect(up.cancelled).toBe(up.all);
  await swipe(cdp, page, box.x + 40, box.y + 10, box.y + box.height - 2);
  expect(await layout(page)).toEqual(start);
  const top = (await page.locator(".topbar").boundingBox())!;
  await swipe(cdp, page, top.x + top.width / 2, top.y + top.height / 2, top.y + 400);
  expect(await layout(page)).toEqual(start);
  const fromTop = await cancelled();
  expect(fromTop.cancelled).toBe(fromTop.all);

  // A swipe on the content scrolls the content pane – and only it.
  await swipe(cdp, page, 200, box.y - 80, box.y - 480);
  const scrolled = await layout(page);
  expect(scrolled.content).toBeGreaterThan(100);
  expect({ ...scrolled, content: 0 }).toEqual(start);
  expect((await cancelled()).cancelled).toBe(0);
  // At the end of the content, a further swipe still leaves the document alone.
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await swipe(cdp, page, 200, box.y - 80, box.y - 480);
  expect({ ...(await layout(page)), content: 0 }).toEqual(start);
});

test("with the keyboard open the layout stays at the top, and the tab bar comes back at the bottom", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The tab bar is shown on small screens.");
  const pageId = await signIn(page);
  await page.goto(`/#page=${pageId}`);
  const bar = page.locator(".mobile-tab-bar");
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  // The app's web view gets shorter by the keyboard's height.
  const full = page.viewportSize()!;
  await page.setViewportSize({ width: full.width, height: full.height - 336 });
  await page.keyboard.insertText("Mit Tastatur");
  await expect(bar).toBeHidden();
  const typing = await page.evaluate(() => ({
    documentTop: document.scrollingElement!.scrollTop,
    windowY: window.scrollY,
    topbarTop: Math.round(document.querySelector(".topbar")!.getBoundingClientRect().top),
    mainBottom: Math.round(document.querySelector(".main")!.getBoundingClientRect().bottom),
    height: window.innerHeight,
  }));
  expect(typing).toEqual({ documentTop: 0, windowY: 0, topbarTop: 0, mainBottom: typing.height, height: full.height - 336 });

  // Keyboard closed: the bar is back at the bottom edge, nothing shifted.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.setViewportSize(full);
  await expect(bar).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => ({
        documentTop: document.scrollingElement!.scrollTop,
        viewportTop: window.visualViewport?.offsetTop ?? 0,
        barBottom: Math.round(document.querySelector(".mobile-tab-bar")!.getBoundingClientRect().bottom),
        topbarTop: Math.round(document.querySelector(".topbar")!.getBoundingClientRect().top),
      })),
    )
    .toEqual({ documentTop: 0, viewportTop: 0, barBottom: full.height, topbarTop: 0 });
});

test("public pages keep scrolling the document", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Checked on small screens.");
  await page.goto("/login");
  expect(await page.evaluate(() => document.documentElement.classList.contains("shell-document"))).toBe(false);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe("hidden");
});
