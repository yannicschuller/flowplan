import { test, expect, type CDPSession, type Page } from "@playwright/test";

// #166: on phones the drag handles (the sidebar's pages, the editor's
// blocks, the home widgets, database records, cards, columns and calendar
// entries) reacted at once, so a swipe over the page tree moved pages by
// accident. By touch a handle now lifts what it moves only after a long
// press (components/pointer-drag.ts, touchHold and startPointerDrag): a
// quick swipe scrolls, a held finger lifts (data-drag-lifted) and then
// drags. Mouse and pen drag at once, as before.

const shots = process.env.TOUCH_HOLD_SHOTS;
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function fixture(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = async (title: string) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).id as string;
  };
  const parentOf = async (id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()).page.parent_id as string | null;
  return { create, parentOf };
}

async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
}
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("sidebar by touch: a swipe over a handle scrolls the tree, a long press lifts the page and drags it", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch screens.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create, parentOf } = await fixture(page);
  const stamp = Date.now();
  const target = await create(`Ziel ${stamp}`);
  const source = await create(`Quelle ${stamp}`);
  // Enough pages for the tree to scroll.
  for (let i = 0; i < 24; i++) await create(`Füller ${stamp} ${i}`);
  await page.goto(`/#page=${target}`);
  await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
  const scroller = page.locator(".sidebar-scroll");
  const handleOf = (id: string) => `.page-nav[data-page-id="${id}"] .nav-drag`;
  const centred = async (id: string) => {
    await page.locator(`.page-nav[data-page-id="${id}"]`).evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(200);
    await expect(page.locator(handleOf(id))).toBeVisible();
    return center(page, handleOf(id));
  };
  const cdp = await page.context().newCDPSession(page);

  // A quick swipe down that starts on the handle: the tree scrolls, nothing
  // moves.
  const start = await centred(source);
  const before = await scroller.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await touch(cdp, "touchStart", start.x, start.y);
  for (let i = 1; i <= 10; i++) {
    await touch(cdp, "touchMove", start.x, start.y + i * 20);
    await page.waitForTimeout(16);
  }
  await touch(cdp, "touchEnd");
  await page.waitForTimeout(800);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  await expect(page.locator(".page-nav[data-drag-lifted], .page-nav.drop-inside, .page-nav.drop-before, .page-nav.drop-after")).toHaveCount(0);
  expect(await parentOf(source)).toBeNull();

  // Held for a moment: the row lifts; then dragged onto the target.
  const from = await centred(source);
  const to = await center(page, `.page-nav[data-page-id="${target}"]`);
  await touch(cdp, "touchStart", from.x, from.y);
  await page.waitForTimeout(150);
  // Not yet: a short rest is no drag.
  await expect(page.locator(`.page-nav[data-page-id="${source}"][data-drag-lifted]`)).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.locator(`.page-nav[data-page-id="${source}"][data-drag-lifted]`)).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/sidebar-lifted.png` });
  for (let i = 1; i <= 10; i++) {
    await touch(cdp, "touchMove", from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
    await page.waitForTimeout(20);
  }
  await expect(page.locator(`.page-nav[data-page-id="${target}"]`)).toHaveClass(/drop-inside/);
  if (shots) await page.screenshot({ path: `${shots}/sidebar-drag.png` });
  await touch(cdp, "touchEnd");
  await expect.poll(() => parentOf(source)).toBe(target);
  await expect(page.locator("[data-drag-lifted]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("desktop: the mouse drags pages in the sidebar at once, the touch handle stays hidden", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse.");
  const { create, parentOf } = await fixture(page);
  const stamp = Date.now();
  const target = await create(`Ziel ${stamp}`);
  const source = await create(`Quelle ${stamp}`);
  await page.goto(`/#page=${target}`);
  await expect(page.locator(`.page-nav[data-page-id="${source}"]`)).toBeVisible();
  await expect(page.locator(`.page-nav[data-page-id="${source}"] .nav-drag`)).toBeHidden();
  await page.locator(`.page-nav[data-page-id="${source}"]`).dragTo(page.locator(`.page-nav[data-page-id="${target}"]`));
  await expect.poll(() => parentOf(source)).toBe(target);
});
