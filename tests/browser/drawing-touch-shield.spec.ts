import { test, expect, type CDPSession, type Page } from "@playwright/test";

// The touch shield of a drawing block (#311, components/ink/touch-shield.tsx):
// on an iPad the hand rests beside the block while the pen draws. Entered by
// pen or finger, everything outside the block swallows touches – no taps on
// the top bar or sidebar, no scrolling – until Done (the toolbar's, the
// pill's on the shield, or Escape). A mouse user is not shielded.
test.use({ viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Point = { x: number; y: number };

async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.4, ...base });
  for (const p of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.4, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const line = (from: Point, to: Point, steps = 12) => Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 4 }));

async function swipe(cdp: CDPSession, page: Page, x: number, from: number, to: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / 12 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Skizzen ${Date.now()}`, kind: "document" })).id as string;
  return id;
}

// A document with a drawing block near the top and enough text below it to scroll.
async function documentWithBlock(page: Page, id: string, typeWith: "touch" | "mouse") {
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  if (typeWith === "touch") await editor.tap();
  else await editor.click();
  await page.keyboard.type("Skizze:");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/zeichnen");
  await expect(page.getByRole("option", { name: /Zeichnen/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  const block = page.locator(".ink-block");
  await expect(block.locator(".ink-layer")).toHaveCount(1, { timeout: 15_000 });
  for (let i = 0; i < 45; i++) {
    await page.keyboard.type(`Zeile ${i}`);
    await page.keyboard.press("Enter");
  }
  await page.locator(".main-scroll").evaluate((el) => (el.scrollTop = 0));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return block;
}

const strokes = (scope: ReturnType<Page["locator"]>) => scope.locator(".ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)");

test("touches outside an active drawing block are ignored until Done", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The tablet is set up by this file; one run is enough.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = await setup(page);
  const block = await documentWithBlock(page, id, "touch");
  const surface = block.locator(".ink-block-surface");
  const box = (await surface.boundingBox())!;

  // A pen inside enters drawing mode, draws, and puts the shield up.
  const cdp = await page.context().newCDPSession(page);
  await pen(cdp, line({ x: box.x + 60, y: box.y + 60 }, { x: box.x + 300, y: box.y + 110 }));
  await expect(block).toHaveClass(/is-active/);
  await expect(strokes(block)).toHaveCount(1);
  const shield = page.locator(".ink-shield");
  await expect(shield).toBeAttached();
  await expect(shield).toHaveAttribute("aria-hidden", "true");
  await expect(shield.locator(".ink-shield-hint")).toHaveText("Berührungen außerhalb der Zeichnung werden ignoriert");

  // A tap on the top bar's workspace link and on the sidebar does nothing.
  const home = page.locator(".topbar .breadcrumb-workspace");
  const homeBox = (await home.boundingBox())!;
  const hash = await page.evaluate(() => location.hash);
  await page.evaluate(() => {
    const w = window as unknown as { __hits: string[] };
    w.__hits = [];
    for (const type of ["click", "focusin"]) document.addEventListener(type, (e) => w.__hits.push(`${type}:${(e.target as Element).className}`), true);
  });
  await page.touchscreen.tap(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2);
  const sidebar = (await page.locator(".sidebar .sidebar-scroll").boundingBox())!;
  await page.touchscreen.tap(sidebar.x + 40, sidebar.y + 30);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await expect(block).toHaveClass(/is-active/);
  const hits = await page.evaluate(() => (window as unknown as { __hits: string[] }).__hits);
  expect(hits.filter((h) => !h.includes("ink-shield-panel"))).toEqual([]);

  // A swipe outside the block (below it, and on the sidebar) does not scroll the document.
  const scroller = page.locator(".main-scroll");
  expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  const before = await scroller.evaluate((el) => el.scrollTop);
  const below = box.y + box.height + 120;
  await swipe(cdp, page, box.x + box.width / 2, below + 300, below);
  await swipe(cdp, page, sidebar.x + 60, sidebar.y + 500, sidebar.y + 100);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);

  // Drawing inside still works.
  await pen(cdp, line({ x: box.x + 80, y: box.y + 160 }, { x: box.x + 320, y: box.y + 200 }));
  await expect(strokes(block)).toHaveCount(2);

  // Done in the block's toolbar ends it; taps outside work again.
  await page.getByRole("toolbar", { name: "Zeichenwerkzeuge" }).getByRole("button", { name: "Fertig" }).tap();
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);
  await swipe(cdp, page, box.x + box.width / 2, below + 300, below);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  await scroller.evaluate((el) => (el.scrollTop = 0));

  // Again with the pen; the shield's own Done pill ends it (no hint the second time).
  await pen(cdp, line({ x: box.x + 400, y: box.y + 140 }, { x: box.x + 560, y: box.y + 170 }));
  await expect(shield).toBeAttached();
  await expect(shield.locator(".ink-shield-hint")).toHaveCount(0);
  await shield.getByRole("button", { name: "Fertig", includeHidden: true }).tap();
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);

  // And once more; Escape ends it.
  await pen(cdp, line({ x: box.x + 400, y: box.y + 60 }, { x: box.x + 560, y: box.y + 90 }));
  await expect(shield).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(shield).toHaveCount(0);
  await expect(block).not.toHaveClass(/is-active/);

  // Now the top bar link works.
  await page.touchscreen.tap(homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#home");
  expect(errors).toEqual([]);
});

test("mouse users are not shielded: a click outside leaves drawing and does its work", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough.");
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-DE", storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: "flowplan-offline-offer", value: "never" }] }] } });
  const page = await context.newPage();
  const id = await setup(page);
  const block = await documentWithBlock(page, id, "mouse");
  const box = (await block.locator(".ink-block-surface").boundingBox())!;
  await page.mouse.click(box.x + 100, box.y + 100);
  await expect(block).toHaveClass(/is-active/);
  await expect(page.getByRole("toolbar", { name: "Zeichenwerkzeuge" })).toBeVisible();
  await expect(page.locator(".ink-shield")).toHaveCount(0);
  await page.locator(".topbar .breadcrumb-workspace").click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#home");
  await context.close();
});
