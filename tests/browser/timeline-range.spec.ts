import { test, expect, type Page, type Locator } from "@playwright/test";

// The timeline's settings card (#390): opened when it is closed.
async function settings(scope: Page | Locator) {
  const button = scope.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).first();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  return scope.getByRole("group", { name: "Timeline-Einstellungen", exact: true });
}

// #390: the timeline shows a range (or all records) as one continuous grid,
// zooms continuously and scrolls across month and year ends; the
// publication shows the same layout read-only.
async function fixture(page: Page, name: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: name });
  const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
      { id: "after", name: "Nach", type: "relation", relationPage: p.id },
      { id: "no", name: "Nr.", type: "text" },
      { id: "goal", name: "Ziel", type: "checkbox" },
    ],
    views: [
      {
        id: "timeline",
        name: "Zeitplan",
        type: "timeline",
        filters: [],
        sorts: [],
        dateField: "start",
        endDateField: "end",
        timeline: { scale: "month", showWeekends: true, dependencyField: "after", criticalPath: true },
      },
    ],
  });
  const row = (title: string, start: string, end: string, after: string[] = [], more: Record<string, unknown> = {}) =>
    command({ action: "row.create", pageId: p.id, cells: { title, start, end, after, ...more } });
  const plan = await row("Planung", "2026-11-10", "2026-12-04", [], { no: "A-1" });
  const build = await row("Rohbau", "2026-12-07", "2027-01-22", [plan.id], { no: "A-2" });
  const finish = await row("Abnahme", "2027-02-01", "2027-03-19", [build.id], { no: "A-3", goal: true });
  const early = await row("Vorlauf", "2026-10-20", "2026-11-12");
  const later = await row("Später", "2027-06-01", "2027-06-12");
  // One day: a milestone (◆).
  const topping = await row("Richtfest", "2027-01-25", "2027-01-25", [build.id]);
  return { origin, command, read, page: p, rows: { plan, build, finish, early, later, topping } };
}
const dayWidth = (grid: Locator) => grid.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--timeline-day")));
const view = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.read()).database.views[0].timeline;

test("a range is one grid, All records fits, zoom with buttons and Ctrl+wheel, scrolling across the year, reopening keeps it", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Zeitraum ${info.project.name} ${Date.now()}`);
  try {
    await page.goto(`/#page=${f.page.id}`);
    const timeline = page.getByRole("region", { name: "Timeline", exact: true });
    const scroller = timeline.locator(".timeline-scroll"),
      grid = timeline.locator(".timeline-grid");
    await expect(timeline.locator(".timeline-entry")).toHaveCount(6);
    // Existing views open as before: today's period at the month's zoom.
    expect(await dayWidth(grid)).toBe(32);
    await expect(timeline.getByLabel("Timeline: Zeitraum")).toHaveValue("auto");

    // Nov 2026 – Mar 2027 as one grid, fitted to the width.
    await timeline.getByLabel("Timeline: Zeitraum").selectOption("custom");
    await timeline.getByLabel("Timeline: von", { exact: true }).fill("2026-11-01");
    await timeline.getByLabel("Timeline: bis", { exact: true }).fill("2027-03-31");
    await expect.poll(async () => (await view(f)).range).toEqual({ from: "2026-11-01", to: "2027-03-31" });
    await expect(grid).toHaveCSS("--timeline-width", /px/);
    const lanes = await scroller.evaluate((el) => el.clientWidth - parseFloat(getComputedStyle(el.firstElementChild!).getPropertyValue("--timeline-label")));
    const fitted = await dayWidth(grid);
    expect(fitted).toBeCloseTo(Math.max(0.5, lanes / 151), 1);
    expect(await grid.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--timeline-width")))).toBeCloseTo(151 * fitted, 0);
    const axis = timeline.locator(".timeline-axis");
    await expect(axis).toContainText(mobile ? "Q4" : "Nov");
    if (!mobile) {
      // Everything at once: Planung to Abnahme without scrolling.
      expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await expect(axis).toHaveAttribute("data-units", "quarter-month");
      await expect(axis).toContainText("Q4 2026");
      await expect(axis).toContainText("Q1 2027");
      await expect(axis.locator(".timeline-axis-bottom")).toHaveText(["November", "Dezember", "Januar", "Februar", "März"]);
    }
    // Cut at the window: open edges; outside it an empty row to jump from.
    await expect(timeline.locator(`[data-row-id="${f.rows.early.id}"] .timeline-range`)).toHaveClass(/clipped-start/);
    await expect(timeline.locator(`[data-row-id="${f.rows.later.id}"]`).getByRole("button", { name: "Zum Zeitraum springen" })).toBeVisible();
    // Arrows between the bars, the chain is the critical path.
    await expect(timeline.locator(".timeline-dependencies > path")).toHaveCount(3);

    // All records: from Vorlauf (20 Oct) to Später (12 Jun) with a margin.
    await timeline.getByLabel("Timeline: Zeitraum").selectOption("fit");
    await expect.poll(async () => (await view(f)).range).toBe("fit");
    expect((await view(f)).dayWidth).toBeUndefined();
    const all = 236 + 2 * Math.ceil(236 * 0.04);
    await expect.poll(async () => grid.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--timeline-width")))).toBeCloseTo(all * Math.max(0.5, lanes / all), 0);
    await expect(timeline.locator(`[data-row-id="${f.rows.later.id}"] .timeline-range`)).toBeVisible();
    await expect(timeline.locator(".timeline-range.clipped-start")).toHaveCount(0);

    // Zoom with the buttons: saved (debounced) as px per day.
    const before = await dayWidth(grid);
    await timeline.getByRole("button", { name: "Timeline: vergrößern", exact: true }).click();
    await timeline.getByRole("button", { name: "Timeline: vergrößern", exact: true }).click();
    const zoomed = await dayWidth(grid);
    expect(zoomed).toBeGreaterThan(before * 1.5);
    await expect.poll(async () => (await view(f)).dayWidth).toBeCloseTo(zoomed, 1);
    await expect(timeline.getByLabel("Timeline: Maßstab")).toHaveValue("");

    if (!mobile) {
      // Ctrl + wheel zooms around the pointer: the day under it stays.
      await scroller.evaluate((el) => (el.scrollLeft = 300));
      const box = (await scroller.boundingBox())!;
      const x = box.x + 200 + 400;
      await page.mouse.move(x, box.y + 120);
      const at = async () =>
        scroller.evaluate((el, x) => {
          const grid = el.firstElementChild as HTMLElement;
          const dw = parseFloat(grid.style.getPropertyValue("--timeline-day"));
          return (el.scrollLeft + x - el.getBoundingClientRect().left - 200) / dw;
        }, x);
      const dayBefore = await at();
      const w0 = await dayWidth(grid);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      await expect.poll(() => dayWidth(grid)).toBeGreaterThan(w0 * 1.5);
      expect(Math.abs((await at()) - dayBefore)).toBeLessThan(0.2);
    } else {
      // Two fingers (CDP touch) zoom out.
      const box = (await scroller.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const y = box.y + 100,
        mid = box.x + 140 + (box.width - 140) / 2;
      const w0 = await dayWidth(grid);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mid - 60, y, id: 1 }, { x: mid + 60, y, id: 2 }] });
      for (let i = 1; i <= 5; i++)
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: mid - 60 + i * 10, y, id: 1 }, { x: mid + 60 - i * 10, y, id: 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await expect.poll(() => dayWidth(grid)).toBeLessThan(w0 * 0.7);
    }

    // Day by day across the year's end: the week preset, scrolling on
    // from 28 Dec into January without a stop.
    await timeline.getByLabel("Timeline: Maßstab").selectOption("week");
    await expect.poll(() => dayWidth(grid)).toBe(80);
    await expect.poll(async () => (await view(f)).dayWidth).toBe(80);
    await (await settings(timeline)).getByLabel("Timeline: Datum", { exact: true }).fill("2026-12-28");
    await expect(axis).toHaveAttribute("data-units", "month-day");
    const left = await scroller.evaluate((el) => el.scrollLeft);
    await scroller.evaluate((el) => (el.scrollLeft += 480));
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(left + 480);
    await expect((await settings(timeline)).getByLabel("Timeline: Datum", { exact: true })).toHaveValue("2027-01-03");
    await expect(axis.locator(".timeline-axis-top")).toContainText(["Januar 2027"]);
    // ‹ goes back by 80 % of the lanes.
    await timeline.getByRole("button", { name: "Timeline: vorheriger Zeitraum", exact: true }).click();
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBeCloseTo(left + 480 - Math.round((await scroller.evaluate((el) => el.clientWidth - parseFloat(getComputedStyle(el.firstElementChild!).getPropertyValue("--timeline-label")))) * 0.8), 0);
    const kept = await (await settings(timeline)).getByLabel("Timeline: Datum", { exact: true }).inputValue();

    // Reopening: range, zoom and scroll position as left.
    await page.waitForTimeout(400);
    await page.reload();
    await expect(timeline.locator(".timeline-entry")).toHaveCount(6);
    await expect(timeline.getByLabel("Timeline: Zeitraum")).toHaveValue("fit");
    await expect(timeline.getByLabel("Timeline: Maßstab")).toHaveValue("week");
    await expect((await settings(timeline)).getByLabel("Timeline: Datum", { exact: true })).toHaveValue(kept);

    // Keys while the timeline has the focus: F fits, T goes to today.
    await scroller.focus();
    await page.keyboard.press("f");
    await expect.poll(() => dayWidth(grid)).toBeLessThan(80);
    await page.keyboard.press("t");
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await expect
      .poll(async () => {
        const v = await (await settings(timeline)).getByLabel("Timeline: Datum", { exact: true }).inputValue();
        return v <= todayKey && Date.parse(todayKey) - Date.parse(v) < 70 * 86400000;
      })
      .toBe(true);

    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await timeline.getByLabel("Timeline: Zeitraum").selectOption("custom");
      await timeline.getByLabel("Timeline: von", { exact: true }).fill("2026-11-01");
      await timeline.getByLabel("Timeline: bis", { exact: true }).fill("2027-03-31");
      await expect.poll(async () => (await view(f)).range).toEqual({ from: "2026-11-01", to: "2027-03-31" });
      await page.screenshot({ path: `test-results/timeline-range/${info.project.name}-${scheme}.png`, fullPage: true, animations: "disabled" });
    }
    expect(errors).toEqual([]);
  } finally {
    await f.command({ action: "page.delete", pageId: f.page.id });
  }
});

test("the published timeline shows the app's layout read-only with the view's window and zoom", async ({ page, browser }, info) => {
  const errors: string[] = [];
  const f = await fixture(page, `Zeitraum öffentlich ${info.project.name} ${Date.now()}`);
  try {
    const current = (await f.read()).database;
    await f.command({
      action: "database.update",
      pageId: f.page.id,
      version: current.version,
      fields: current.fields,
      views: [{ ...current.views[0], timeline: { ...current.views[0].timeline, range: { from: "2026-11-01", to: "2027-03-31" }, dayWidth: 6, milestoneField: "goal", labelFields: ["no"] } }],
    });
    await f.command({ action: "page.publish", pageId: f.page.id, enabled: true });
    const token = (await f.read()).page.public_token;
    const context = await browser.newContext(info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
    const visitor = await context.newPage();
    visitor.on("pageerror", (e) => errors.push(e.message));
    await visitor.goto(`${f.origin}/share/${token}?view=timeline`);
    const timeline = visitor.getByRole("region", { name: "Timeline" });
    const grid = timeline.locator(".timeline-grid");
    // The stored window and zoom: 151 days at 6 px.
    await expect(grid).toBeVisible();
    expect(await dayWidth(grid)).toBe(6);
    expect(await grid.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--timeline-width")))).toBe(906);
    await expect(timeline.locator(".timeline-axis")).toHaveAttribute("data-units", "quarter-month");
    // Every record in the view's order, also outside the window.
    await expect(timeline.locator(".timeline-entry .timeline-name")).toHaveText(["Planung", "Rohbau", "Abnahme", "Vorlauf", "Später", "Richtfest"]);
    await expect(timeline.locator(`[data-row-id="${f.rows.early.id}"] .timeline-range`)).toHaveClass(/clipped-start/);
    await expect(timeline.getByRole("button", { name: "Zum Zeitraum springen" })).toHaveCount(1);
    await expect(timeline.getByRole("link", { name: "Rohbau: 2026-12-07 – 2027-01-22" })).toBeVisible();
    // Arrows and the critical path as configured; no editing. On a phone
    // only the first weeks are in sight: arrows with both ends out of
    // sight are not drawn (#395).
    if (info.project.name === "mobile") await expect.poll(() => timeline.locator(".timeline-dependencies > path").count()).toBeGreaterThanOrEqual(1);
    else await expect(timeline.locator(".timeline-dependencies > path")).toHaveCount(3);
    // Milestones: one day and marked by the checkbox; public properties
    // beside the title.
    await expect(timeline.locator(`[data-row-id="${f.rows.topping.id}"] .timeline-range`)).toHaveClass(/milestone/);
    await expect(timeline.locator(`[data-row-id="${f.rows.finish.id}"] .timeline-range`)).toHaveClass(/milestone/);
    await expect(timeline.locator(`[data-row-id="${f.rows.plan.id}"] .timeline-range`)).toContainText("Planung · A-1");
    await expect(timeline.locator(".timeline-resize, .timeline-link-handle")).toHaveCount(0);
    // Readers zoom; nothing is saved.
    await timeline.getByRole("button", { name: "Timeline: vergrößern", exact: true }).click();
    await expect.poll(() => dayWidth(grid)).toBe(7.5);
    await visitor.waitForTimeout(900);
    expect((await view(f)).dayWidth).toBe(6);
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    for (const scheme of ["light", "dark"] as const) {
      await visitor.emulateMedia({ colorScheme: scheme });
      await visitor.screenshot({ path: `test-results/timeline-range/${info.project.name}-public-${scheme}.png`, fullPage: true, animations: "disabled" });
    }
    await timeline.getByRole("link", { name: "Rohbau: 2026-12-07 – 2027-01-22" }).click();
    await expect(visitor.getByRole("heading", { name: "Rohbau", exact: true })).toBeVisible();
    await context.close();
    expect(errors).toEqual([]);
  } finally {
    await f.command({ action: "page.delete", pageId: f.page.id });
  }
});

test("milestones as diamonds, titles that stay in sight with their properties, a compact header", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Meilensteine ${info.project.name} ${Date.now()}`);
  try {
    await page.goto(`/#page=${f.page.id}`);
    const timeline = page.getByRole("region", { name: "Timeline", exact: true });
    const scroller = timeline.locator(".timeline-scroll"),
      controls = timeline.locator(".timeline-controls");
    await expect(timeline.locator(".timeline-entry")).toHaveCount(6);
    // The header: one line on a desktop, the help as a tooltip.
    const header = (await controls.boundingBox())!;
    expect(header.height).toBeLessThan(mobile ? 140 : 60);
    await expect(timeline.locator(".timeline-help")).toHaveCount(0);
    const help = timeline.getByRole("button", { name: "Hilfe zur Timeline", exact: true });
    await expect(help).toHaveAttribute("title", /Alt \+ Pfeiltaste/);
    await help.click();
    await expect(timeline.locator(".timeline-help")).toContainText("Vorhandene Uhrzeiten bleiben erhalten.");
    await help.click();
    // Scale presets from a day to five years.
    await expect(timeline.getByLabel("Timeline: Maßstab").locator("option")).toHaveText(["Tag", "Woche", "2 Wochen", "Monat", "Quartal", "Jahr", "5 Jahre"]);
    // A one-day record is a diamond, its arrow ends at it.
    const topping = timeline.locator(`[data-row-id="${f.rows.topping.id}"] .timeline-range`);
    await (await settings(timeline)).getByLabel("Timeline: Datum", { exact: true }).fill("2027-01-10");
    await expect(topping).toHaveClass(/milestone/);
    const diamond = (await topping.boundingBox())!;
    expect(Math.round(diamond.width)).toBe(18);
    await expect(timeline.locator(`[data-row-id="${f.rows.topping.id}"] .timeline-range-label`)).toHaveText("Richtfest");
    // The checkbox property makes Abnahme a milestone; Nr. beside titles.
    const panel = await settings(timeline);
    await panel.getByLabel("Timeline: Meilensteine").selectOption({ label: "Ziel" });
    await panel.getByRole("checkbox", { name: "Nr.", exact: true }).check();
    await expect.poll(async () => [(await view(f)).milestoneField, (await view(f)).labelFields]).toEqual(["goal", ["no"]]);
    await expect(timeline.locator(`[data-row-id="${f.rows.finish.id}"] .timeline-range`)).toHaveClass(/milestone/);
    await timeline.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).click();
    await expect(timeline.getByRole("group", { name: "Timeline-Einstellungen" })).toHaveCount(0);
    // Rohbau (7 Dec – 22 Jan) with its start scrolled away: the title sits
    // at the left edge of the lanes, followed by its number.
    await timeline.getByLabel("Timeline: Maßstab").selectOption("week");
    await expect.poll(() => dayWidth(timeline.locator(".timeline-grid"))).toBe(80);
    await (await settings(timeline)).getByLabel("Timeline: Datum", { exact: true }).fill("2026-12-20");
    await timeline.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).click();
    const text = timeline.locator(`[data-row-id="${f.rows.build.id}"] .timeline-range-text`);
    await expect(text).toHaveText("Rohbau · A-2");
    const label = await scroller.evaluate((el) => parseFloat(getComputedStyle(el.firstElementChild!).getPropertyValue("--timeline-label")));
    const box = (await scroller.boundingBox())!;
    await expect.poll(async () => (await text.boundingBox())!.x).toBeGreaterThanOrEqual(box.x + label);
    expect((await text.boundingBox())!.x).toBeLessThan(box.x + label + 40);
    await scroller.evaluate((el) => (el.scrollLeft += 640));
    await expect.poll(async () => (await text.boundingBox())!.x).toBeGreaterThanOrEqual(box.x + label);
    expect((await text.boundingBox())!.x).toBeLessThan(box.x + label + 40);
    // A bar scrolled away entirely keeps its title inside itself (out of sight).
    for (const id of [f.rows.plan.id, f.rows.early.id]) {
      const bar = timeline.locator(`[data-row-id="${id}"] .timeline-range`);
      const outer = (await bar.boundingBox())!,
        inner = (await bar.locator(".timeline-range-body").boundingBox())!;
      expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `test-results/timeline-range/${info.project.name}-milestones-${scheme}.png`, fullPage: true, animations: "disabled" });
    }
    await settings(timeline);
    await page.screenshot({ path: `test-results/timeline-range/${info.project.name}-settings.png`, fullPage: true, animations: "disabled" });
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  } finally {
    await f.command({ action: "page.delete", pageId: f.page.id });
  }
});
