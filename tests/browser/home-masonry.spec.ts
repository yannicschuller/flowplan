import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

// The start page fills gaps (#218, lib/masonry.ts, components/use-masonry.ts):
// a tall "Meine Aktivität" next to short widgets no longer leaves a hole –
// each column stacks upward, the widgets keep their configured order in the
// DOM (keyboard and screen reader), phones keep one column, and editing
// shows the same arrangement.
const links = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Link ${i + 1}`, url: `https://example.com/${i + 1}` }));
const layout = {
  version: 1,
  widgets: [
    { id: "hello", kind: "greeting", size: "full", config: {} },
    { id: "mine", kind: "myActivity", size: "m", config: { period: "week" } },
    { id: "dates", kind: "calendar", size: "s", config: { range: "today" } },
    { id: "short", kind: "links", size: "s", config: { title: "Kurz", links: links(1) } },
    { id: "tall", kind: "links", size: "s", config: { title: "Lang", links: links(12) } },
    { id: "mid", kind: "links", size: "s", config: { title: "Mittel", links: links(4) } },
    { id: "wide", kind: "notes", size: "m", config: { text: "Breit" } },
    { id: "last", kind: "links", size: "s", config: { title: "Letzte", links: links(2) } },
  ],
  appearance: { header: { type: "none", value: "", position: 50 }, density: "comfortable", background: "none", icon: "", width: "normal" },
};
const ids = layout.widgets.map((w) => w.id);

type Box = { id: string; x: number; y: number; w: number; h: number };
async function boxes(page: Page, selector: string) {
  return await page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: (el as HTMLElement).dataset.widgetId || el.className, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
}
// No two items overlap, and above every item that is not at the top of the
// grid the nearest item in its columns ends one gutter higher – no bigger gap.
function expectPacked(items: Box[], gutter: number, top: number) {
  for (const a of items)
    for (const b of items) {
      if (a === b) continue;
      const across = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1;
      const down = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
      expect(across && down, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  for (const b of items) {
    if (b.y - top < 1) continue;
    const above = items.filter((a) => a !== b && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && a.y + a.h <= b.y + 1);
    expect(above.length, `something above ${b.id}`).toBeGreaterThan(0);
    const gap = b.y - Math.max(...above.map((a) => a.y + a.h));
    expect(gap, `gap above ${b.id}`).toBeLessThanOrEqual(gutter + 1);
  }
}

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const saved = await page.request.post("/api/command", { headers: { origin }, data: { action: "home.save", workspaceId: boot.workspace.id, layout } });
  expect(saved.ok(), await saved.text()).toBe(true);
});
// The development demo account is shared by all browser tests: leave its
// start page as it was.
test.afterEach(async ({ page }) => {
  const boot = await (await page.request.get("/api/bootstrap")).json();
  for (let i = 0; i < 2; i++)
    await page.request.post("/api/command", { headers: { origin }, data: { action: "home.reset", workspaceId: boot.workspace.id, scope: "personal" } });
});

test("widgets of different heights leave no gap larger than the gutter; the order stays", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#home");
  const grid = page.locator(".home-grid");
  await expect(page.locator('[data-widget-id="mine"]').getByRole("heading", { name: "Meine Aktivität" })).toBeVisible();
  await expect(page.locator('[data-widget-id="tall"]')).toContainText("Link 12");
  // Loaded: "Meine Aktivität" with its charts, the tallest widget.
  await expect(page.locator('[data-widget-id="mine"]').getByRole("region", { name: "Seiten erstellt" })).toBeVisible();
  await expect(page.locator('[data-widget-id="dates"]').getByText("Heute", { exact: false }).first()).toBeVisible();
  // DOM order (Tab, screen readers) = configured order.
  expect(await page.locator(".home-grid > .home-widget").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.widgetId))).toEqual(ids);
  const gutter = await grid.evaluate((el) => parseFloat(getComputedStyle(el).rowGap));
  const top = (await grid.boundingBox())!.y;

  if (info.project.name === "mobile") {
    // Phones: one column as before, nothing moved by the masonry.
    await expect(grid).not.toHaveAttribute("data-masonry");
    const items = await boxes(page, ".home-grid > .home-widget");
    for (let i = 1; i < items.length; i++) {
      expect(Math.abs(items[i].x - items[0].x)).toBeLessThan(1);
      expect(items[i].y - (items[i - 1].y + items[i - 1].h)).toBeCloseTo(gutter, 0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    return;
  }

  await expect(grid).toHaveAttribute("data-masonry", /^[2-4]$/);
  expectPacked(await boxes(page, ".home-grid > .home-widget"), gutter, top);
  // The first row reads left to right as configured.
  const rest = (await boxes(page, ".home-grid > .home-widget")).filter((b) => b.id !== "hello");
  const y0 = Math.min(...rest.map((b) => b.y));
  const row = rest.filter((b) => Math.abs(b.y - y0) < 1).sort((a, b) => a.x - b.x);
  expect(row.length).toBeGreaterThan(1);
  expect(row.map((b) => b.id)).toEqual(ids.slice(1, 1 + row.length));
  for (let i = 1; i < row.length; i++) expect(row[i].x).toBeGreaterThan(row[i - 1].x);

  // A widget growing (here: the window narrower, a tablet) re-packs at once.
  await page.setViewportSize({ width: 820, height: 1000 });
  await expect(grid).toHaveAttribute("data-masonry", /^[2-3]$/);
  await expect
    .poll(async () => {
      try {
        expectPacked(await boxes(page, ".home-grid > .home-widget"), gutter, (await grid.boundingBox())!.y);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);

  // Editing: the same arrangement with the tools; moving a widget re-packs.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Anpassen" }).click();
  await expect(page.getByRole("toolbar", { name: "Startseite anpassen" })).toBeVisible();
  const editGrid = page.locator(".home-grid");
  await expect(editGrid).toHaveAttribute("data-masonry", /^[2-4]$/);
  const editTop = (await editGrid.boundingBox())!.y;
  expectPacked(await boxes(page, ".home-grid > .home-widget, .home-grid > .home-add-tile"), gutter, editTop);
  const handle = page.getByRole("button", { name: "Kurz verschieben" });
  await handle.focus();
  await page.keyboard.press("End");
  await expect(handle).toBeFocused();
  expectPacked(await boxes(page, ".home-grid > .home-widget, .home-grid > .home-add-tile"), gutter, editTop);
  expect(errors).toEqual([]);
});
