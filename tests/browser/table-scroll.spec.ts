import { test, expect, type Page, type Locator } from "@playwright/test";

// #256: a document table wider than the page showed a horizontal scrollbar
// that could not be dragged or clicked (Edge on Windows, classic
// scrollbars). In 0.9.4 the table's caption line ("Add caption", pulled up
// by a negative margin) lay over the bottom 15 px of the table's scroll
// area – exactly the scrollbar. Since #240 the caption line of a table
// without caption is gone, but a table's caption and the touch screens'
// taller "+" bar still reached a few pixels into it. Published pages let
// a wide table push the whole page sideways.
//
// Playwright starts Chromium with --hide-scrollbars; without it Chromium on
// Linux paints classic 15 px scrollbars like Windows.
test.use({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  },
});

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const COLUMNS = 14;
const row = (tag: string, r: number) =>
  "<tr>" + Array.from({ length: COLUMNS }, (_, c) => `<${tag}><p>Zelle ${r}-${c} mit etwas längerem Inhalt</p></${tag}>`).join("") + "</tr>";
const wide = (caption = "") =>
  `<p>Vorher</p><table>${caption ? `<caption>${caption}</caption>` : ""}<tbody>${row("th", 0)}${row("td", 1)}${row("td", 2)}</tbody></table><p>Danach kommt Text.</p>`;

async function tablePage(page: Page, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Breite Tabelle ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, command };
}

// The height of the wrapper's horizontal scrollbar (0 for overlay scrollbars).
const scrollbarHeight = (wrapper: Locator) => wrapper.evaluate((w: HTMLElement) => w.offsetHeight - w.clientTop - w.clientHeight);
const scrollLeft = (wrapper: Locator) => wrapper.evaluate((w: HTMLElement) => w.scrollLeft);
// Everything that is not the wrapper itself on its scrollbar (a press there
// would not reach the scrollbar).
const overScrollbar = (wrapper: Locator) =>
  wrapper.evaluate((w: HTMLElement) => {
    const r = w.getBoundingClientRect();
    const found = new Set<string>();
    for (let y = Math.ceil(r.top + w.clientTop + w.clientHeight); y < Math.floor(r.bottom); y++)
      for (let x = r.left + 20; x < r.right - 20; x += 20) {
        const hit = document.elementFromPoint(x, y + 0.5);
        if (hit !== w) found.add(hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "none");
      }
    return [...found];
  });
// The middle of the scrollbar's track at a distance from its left end.
const onScrollbar = async (wrapper: Locator, x: number) => {
  const box = (await wrapper.boundingBox())!;
  const bar = await scrollbarHeight(wrapper);
  return { x: box.x + x, y: box.y + box.height - bar / 2 };
};

test("a wide table scrolls sideways: scrollbar thumb and track, shift+wheel, wheel, caret", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "scrollbars and a mouse");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { host } = await tablePage(page, wide("Eine breite Tabelle"));
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const wrapper = editor.locator(".tableWrapper");
  await expect(wrapper.locator("table")).toBeVisible({ timeout: 30_000 });
  expect(await wrapper.evaluate((w: HTMLElement) => w.scrollWidth - w.clientWidth)).toBeGreaterThan(500);
  expect(await scrollbarHeight(wrapper)).toBeGreaterThan(8);

  // Pointing at a cell shows the handles and the "+" bar: none of them,
  // and not the caption below, lies on the scrollbar.
  const cell = editor.locator("td", { hasText: "Zelle 2-1 mit" });
  await cell.click();
  await cell.hover();
  await expect(page.getByRole("button", { name: "Zeile hinzufügen" })).toBeVisible();
  await expect(editor.locator(".block-caption-field")).toHaveValue("Eine breite Tabelle");
  expect(await overScrollbar(wrapper)).toEqual([]);
  // The "+" bar is taller on touch screens (20 px): it still ends above it.
  await page.addStyleTag({ content: ".table-add.row { height: 20px; }" });
  await cell.hover({ position: { x: 20, y: 10 } });
  expect(await overScrollbar(wrapper)).toEqual([]);

  // Dragging the thumb.
  const start = await onScrollbar(wrapper, 30);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 200, start.y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(300);
  // No rectangle of blocks started on the scrollbar (#237).
  await expect(page.locator(".block-select-band")).toHaveCount(0);
  // The handles follow the scrolled table: the column handle is over
  // the column pointed at.
  const later = editor.locator("td", { hasText: "Zelle 1-6 mit" });
  await later.hover();
  const handle = page.getByRole("button", { name: "Spalte 7", exact: true });
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!,
    c = (await later.boundingBox())!;
  expect(Math.abs(h.x + h.width / 2 - (c.x + c.width / 2))).toBeLessThan(4);

  // A click on the track pages to the right.
  await wrapper.evaluate((w: HTMLElement) => (w.scrollLeft = 0));
  const track = await onScrollbar(wrapper, (await wrapper.boundingBox())!.width - 60);
  await page.mouse.click(track.x, track.y);
  await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(100);

  // Shift + wheel (a mouse) and a sideways wheel (a trackpad) over the cells.
  await wrapper.evaluate((w: HTMLElement) => (w.scrollLeft = 0));
  const box = (await cell.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 300);
  await page.keyboard.up("Shift");
  await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(100);
  await wrapper.evaluate((w: HTMLElement) => (w.scrollLeft = 0));
  await page.mouse.wheel(300, 0);
  await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(100);

  // The caret into a cell off screen scrolls it into view (arrow keys, Tab).
  await wrapper.evaluate((w: HTMLElement) => (w.scrollLeft = 0));
  await editor.locator("td", { hasText: "Zelle 1-0 mit" }).click();
  for (let i = 0; i < 330; i++) await page.keyboard.press("ArrowRight");
  const caretInView = () =>
    page.evaluate(() => {
      // Where the caret (the selection's head) is.
      const selection = window.getSelection()!;
      const head = document.createRange();
      head.setStart(selection.focusNode!, selection.focusOffset);
      const range = head.getBoundingClientRect();
      const frame = document.querySelector(".ProseMirror .tableWrapper")!.getBoundingClientRect();
      return range.left >= frame.left - 1 && range.right <= frame.right + 1;
    });
  expect(await scrollLeft(wrapper)).toBeGreaterThan(200);
  expect(await caretInView()).toBe(true);
  await editor.locator("td", { hasText: "Zelle 2-0 mit" }).click();
  await wrapper.evaluate((w: HTMLElement) => (w.scrollLeft = 0));
  for (let i = 0; i < COLUMNS - 1; i++) await page.keyboard.press("Tab");
  await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(500);
  expect(await caretInView()).toBe(true);
  expect(errors).toEqual([]);
});

test("published: a wide table scrolls in its own box, not the whole page", async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  const { host, command } = await tablePage(page, wide("Veröffentlicht"));
  await command({ action: "page.publish", pageId: host.id, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${host.id}`)).json()).page.public_token;
  const mobile = info.project.name === "mobile";
  const context = await browser.newContext({ viewport: page.viewportSize()!, isMobile: mobile, hasTouch: mobile, locale: "de-DE" });
  const visitor = await context.newPage();
  await visitor.goto(`${origin}/share/${token}`);
  const wrapper = visitor.locator(".document-editor .tableWrapper");
  await expect(wrapper.locator("table")).toBeVisible();
  await expect(wrapper.locator("table > caption")).toHaveText("Veröffentlicht");
  expect(await wrapper.evaluate((w: HTMLElement) => w.scrollWidth - w.clientWidth)).toBeGreaterThan(300);
  expect(await visitor.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth)).toBeLessThanOrEqual(0);
  if (mobile) {
    // A swipe over the cells.
    const cdp = await context.newCDPSession(visitor);
    const cell = (await wrapper.locator("td").nth(1).boundingBox())!;
    const from = { x: cell.x + cell.width - 10, y: cell.y + cell.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x - (from.x - 20) * (i / 12), y: from.y + i / 4 }] });
      await visitor.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(100);
  } else {
    expect(await overScrollbar(wrapper)).toEqual([]);
    const start = await onScrollbar(wrapper, 30);
    await visitor.mouse.move(start.x, start.y);
    await visitor.mouse.down();
    await visitor.mouse.move(start.x + 200, start.y, { steps: 10 });
    await visitor.mouse.up();
    await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(200);
  }
  await context.close();
  await command({ action: "page.delete", pageId: host.id });
});

test("on a phone a swipe over a wide table in the editor scrolls it", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "touch");
  const { host } = await tablePage(page, wide());
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const wrapper = editor.locator(".tableWrapper");
  await expect(wrapper.locator("table")).toBeVisible({ timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const cell = (await editor.locator("td").nth(1).boundingBox())!;
  const from = { x: cell.x + cell.width - 10, y: cell.y + cell.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x - (from.x - 20) * (i / 12), y: from.y + i / 4 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => scrollLeft(wrapper)).toBeGreaterThan(100);
  // The page itself does not move sideways.
  expect(await page.locator(".main-scroll").evaluate((m) => m.scrollLeft)).toBe(0);
});
