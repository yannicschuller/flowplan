import { test, expect, type CDPSession, type Page } from "@playwright/test";

// #98: on a phone a database table whose first column was wider than the
// screen did not scroll sideways – the pinned column covered all of it, so
// the other columns slid by underneath. A swipe to the right near the left
// edge opened the sidebar instead of scrolling back. The timeline's bars
// took every swipe that started on them.

async function fixture(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const database = async (title: string, view: Record<string, unknown>) => {
    const p = await command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `${title} ${Date.now()}`,
      kind: "database",
    });
    const { database } = await (await page.request.get(`/api/pages/${p.id}`)).json();
    await command({
      action: "database.update",
      pageId: p.id,
      version: database.version,
      fields: [
        { id: "title", name: "Name", type: "text" },
        { id: "start", name: "Start", type: "date" },
        { id: "end", name: "Ende", type: "date" },
        { id: "a", name: "Spalte A", type: "text" },
        { id: "b", name: "Spalte B", type: "text" },
        { id: "c", name: "Spalte C", type: "text" },
      ],
      views: [{ filters: [], sorts: [], ...view }],
    });
    return p.id as string;
  };
  return { command, database };
}

// A one-finger swipe, as the touch screen sends it.
async function swipe(cdp: CDPSession, page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

test("a wide first column stays below 60 % of a phone and the table scrolls sideways by swiping on it", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Swipes are for touch screens.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, database } = await fixture(page);
  const id = await database("Breite Tabelle", {
    id: "table",
    name: "Tabelle",
    type: "table",
    columnWidths: { title: 600 },
  });
  for (let i = 1; i <= 12; i++)
    await command({
      action: "row.create",
      pageId: id,
      cells: { title: `Ein ziemlich langer Titel für Eintrag ${i}`, a: `A${i}`, b: `B${i}`, c: `C${i}` },
    });
  await page.goto(`/#page=${id}`);
  const scroller = page.locator(".data-table-scroll");
  const title = page.locator('th[data-field-id="title"]');
  await expect(page.locator("tbody tr")).toHaveCount(12);
  await page.locator("tbody tr").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  const viewport = page.viewportSize()!;
  // Pinned: the title column alone, at most 60 % of the screen; the
  // selection column scrolls with the rest.
  const pinned = (await title.boundingBox())!;
  expect(pinned.width).toBeLessThanOrEqual(viewport.width * 0.6 + 1);
  expect(await title.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  expect(await page.locator("th.selection-cell").evaluate((el) => getComputedStyle(el).position)).toBe("static");

  const cdp = await page.context().newCDPSession(page);
  const cell = (await page.locator("tbody tr").nth(2).locator('td').nth(1).boundingBox())!;
  const y = cell.y + cell.height / 2;
  const box = (await scroller.boundingBox())!;
  // Swipe to the left starting on the title column.
  await swipe(cdp, page, { x: pinned.x + pinned.width - 20, y }, { x: pinned.x + 10, y: y + 3 });
  const scrolled = await scroller.evaluate((el) => el.scrollLeft);
  expect(scrolled).toBeGreaterThan(100);
  // Other columns now show to the right of the pinned one.
  const shown = await page.evaluate(
    ({ x, y }) => {
      const td = document.elementFromPoint(x, y)?.closest("td");
      return td ? td.classList.contains("sticky-col-end") ? "pinned" : "other" : "none";
    },
    { x: Math.min(box.x + box.width, viewport.width) - 30, y },
  );
  expect(shown).toBe("other");
  // Up and down still scroll the page, not the table.
  const main = page.locator(".main-scroll");
  const top = await main.evaluate((el) => el.scrollTop);
  await swipe(cdp, page, { x: 150, y: y + 250 }, { x: 150, y: y - 50 });
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(top + 100);
  expect(Math.abs((await scroller.evaluate((el) => el.scrollLeft)) - scrolled)).toBeLessThan(20);
  // A swipe to the right from near the left edge scrolls the table back;
  // the sidebar stays closed.
  await page.locator("tbody tr").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  expect(await page.evaluate((y) => !!document.elementFromPoint(40, y)?.closest("tbody td"), y)).toBe(true);
  await swipe(cdp, page, { x: 40, y }, { x: 320, y: y + 3 });
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeLessThan(scrolled);
  await expect(page.locator(".app-shell.nav-open")).toHaveCount(0);
  // A tap on the cut-short title still opens the record.
  await scroller.evaluate((el) => (el.scrollLeft = 0));
  await page.locator(".row-title-link").nth(6).tap();
  await expect(page.getByRole("dialog", { name: "Eintrag", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a swipe on a timeline bar scrolls the timeline instead of moving the bar", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Swipes are for touch screens.");
  const { command, database } = await fixture(page);
  const id = await database("Breite Timeline", {
    id: "timeline",
    name: "Timeline",
    type: "timeline",
    dateField: "start",
    endDateField: "end",
    timeline: { scale: "week", showWeekends: true },
  });
  const row = await command({
    action: "row.create",
    pageId: id,
    cells: { title: "Lang", start: "2026-09-21", end: "2026-10-10" },
  });
  await page.goto(`/#page=${id}`);
  const timeline = page.getByRole("region", { name: "Timeline", exact: true });
  await timeline.getByLabel("Timeline: Datum", { exact: true }).fill("2026-09-23");
  const bar = timeline.locator(`[data-row-id="${row.id}"] .timeline-range-body`);
  await bar.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const scroller = timeline.locator(".timeline-scroll");
  // From the start of the period shown.
  await page.waitForTimeout(500);
  await scroller.evaluate((el) => (el.scrollLeft = 0));
  const before = await scroller.evaluate((el) => el.scrollLeft);
  const box = (await bar.boundingBox())!;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  // From a point on the bar, to the right of the pinned labels.
  const frame = (await scroller.boundingBox())!;
  const from = Math.min(box.x + box.width, frame.x + frame.width) - 15;
  expect(from - Math.max(box.x, 200)).toBeGreaterThan(40);
  await swipe(cdp, page, { x: from, y }, { x: from - 130, y: y + 2 });
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 50);
  await expect(bar).toHaveAttribute("aria-label", "Lang: 2026-09-21 bis 2026-10-10");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// #98, follow-up: on the table view the whole page could be pushed sideways
// into empty space. The screen-reader labels of the calculation row
// (.sr-only, position: absolute) hung on .scroll-fade outside the table's
// scroller, so they were not clipped by it and made .main-scroll as wide as
// the table. Now only the views' own scrollers move sideways.
test("on a phone the page never scrolls sideways, only the views' own scrollers do", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone layout.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, database } = await fixture(page);
  const views: Record<string, { view: Record<string, unknown>; scroller: string }> = {
    table: { view: { id: "table", name: "Tabelle", type: "table" }, scroller: ".data-table-scroll" },
    board: { view: { id: "board", name: "Board", type: "board", groupBy: "c" }, scroller: ".board" },
    calendar: {
      view: { id: "cal", name: "Kalender", type: "calendar", dateField: "start", calendar: { mode: "month", timeZone: "UTC" } },
      scroller: ".calendar-scroll",
    },
    timeline: {
      view: { id: "timeline", name: "Timeline", type: "timeline", dateField: "start", endDateField: "end" },
      scroller: ".timeline-scroll",
    },
  };
  const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  // What can scroll sideways: the document, .main-scroll and the panes in it.
  const pageOverflow = () =>
    page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".main-scroll")!;
      const doc = document.scrollingElement!;
      main.scrollLeft = 2000;
      doc.scrollLeft = 2000;
      const result = {
        doc: doc.scrollWidth - doc.clientWidth,
        main: main.scrollWidth - main.clientWidth,
        mainLeft: main.scrollLeft,
        docLeft: doc.scrollLeft,
      };
      main.scrollLeft = 0;
      return result;
    });
  for (const [kind, { view, scroller }] of Object.entries(views)) {
    const id = await database(`Breit ${kind}`, view);
    for (let i = 1; i <= 8; i++)
      await command({
        action: "row.create",
        pageId: id,
        cells: { title: `Eintrag mit längerem Titel ${i}`, start: day(i - 4), end: day(i), a: `A${i}`, b: `B${i}`, c: `Kunde ${i % 4}` },
      });
    await page.goto(`/#page=${id}`);
    const own = page.locator(scroller).first();
    await expect(own).toBeVisible();
    await page.waitForTimeout(300);
    expect(await pageOverflow(), kind).toEqual({ doc: 0, main: 0, mainLeft: 0, docLeft: 0 });
    // The view's own scroller is wider than the screen and still scrolls.
    if (kind !== "calendar" || (await own.evaluate((el) => el.scrollWidth > el.clientWidth))) {
      expect(await own.evaluate((el) => el.scrollWidth - el.clientWidth), kind).toBeGreaterThan(100);
      expect(await own.evaluate((el) => ((el.scrollLeft = 200), el.scrollLeft)), kind).toBeGreaterThan(100);
      expect(await pageOverflow(), `${kind}, scrolled`).toEqual({ doc: 0, main: 0, mainLeft: 0, docLeft: 0 });
      await own.evaluate((el) => (el.scrollLeft = 0));
    }
    if (kind === "table") {
      // The cause itself is gone, not only cut off: without the phone clip
      // on the panes the page is still no wider than the screen.
      await page.addStyleTag({ content: ".main-scroll > * { overflow-x: visible !important; }" });
      expect(await pageOverflow(), "table, unclipped").toEqual({ doc: 0, main: 0, mainLeft: 0, docLeft: 0 });
      // The pinned title column still sticks to the scroller's left edge
      // while the table scrolls (the selection column scrolls away).
      const title = page.locator('th[data-field-id="title"]');
      await own.evaluate((el) => (el.scrollLeft = 300));
      const left = (await own.boundingBox())!.x;
      expect(Math.abs((await title.boundingBox())!.x - left)).toBeLessThan(2);
      expect(await title.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
      await own.evaluate((el) => (el.scrollLeft = 0));
      // Inside a record opened from the table: neither the dialog nor the page.
      await page.locator(".row-title-link").first().tap();
      const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await pageOverflow(), "record").toEqual({ doc: 0, main: 0, mainLeft: 0, docLeft: 0 });
    }
  }
  expect(errors).toEqual([]);
});
