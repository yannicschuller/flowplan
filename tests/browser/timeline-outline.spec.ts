import { test, expect, type Page, type Locator } from "@playwright/test";

// #394 and #395: calmer arrows (transparent over bars, orthogonal, focus on
// hover, removing a link with undo, hiding them), shift modes with one undo
// for everything moved along, and the hierarchy with summary bars that
// collapse and expand – in the app and, read-only, in the publication.

async function settings(scope: Page | Locator) {
  const button = scope.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).first();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  return scope.getByRole("group", { name: "Timeline-Einstellungen", exact: true });
}

async function fixture(page: Page, name: string, timeline: Record<string, unknown>) {
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
      { id: "parent", name: "Übergeordnet", type: "relation", relationPage: p.id },
      { id: "level", name: "Ebene", type: "select", options: ["Phase", "Aktivität"], optionColors: { Phase: "purple", Aktivität: "green" } },
    ],
    views: [
      {
        id: "timeline",
        name: "Plan",
        type: "timeline",
        filters: [],
        sorts: [],
        dateField: "start",
        endDateField: "end",
        timeline: { scale: "month", showWeekends: true, range: "fit", dependencyField: "after", ...timeline },
      },
    ],
  });
  const row = (title: string, start: string | null, end: string | null, more: Record<string, unknown> = {}) =>
    command({ action: "row.create", pageId: p.id, cells: { title, start, end, ...more } });
  const period = async (id: string) => {
    const r = (await read()).rows.find((x: { id: string }) => x.id === id);
    return `${r.cells.start}..${r.cells.end}`;
  };
  return { origin, command, read, row, period, page: p };
}
// The middle of an arrow in page coordinates (to hover it).
async function arrowMiddle(page: Page, key: string) {
  return page.locator(`.timeline-arrow-hits path`).evaluateAll((paths, key) => {
    const front = document.querySelector(`.timeline-dependencies path[data-link="${key}"]`);
    const index = [...document.querySelectorAll(".timeline-dependencies > path[data-link]")].indexOf(front!);
    const path = paths[index] as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: at.x, y: at.y };
  }, key);
}

test("arrows: transparent and orthogonal, focus on hover, × removes a link with undo; shift modes undo in one step", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Pfeile ${info.project.name} ${Date.now()}`, {
    arrowOverlap: "transparent",
    arrowRouting: "orthogonal",
    criticalPath: true,
    // An old view's checkbox: read as "Abstände halten".
    moveSuccessors: true,
  });
  try {
    const a = await f.row("Konzept", "2026-11-02", "2026-11-04");
    const b = await f.row("Umsetzung", "2026-11-09", "2026-11-10", { after: [a.id] });
    const c = await f.row("Test", "2026-11-12", "2026-11-13", { after: [b.id] });
    // Not linked, ends before the chain: the chain is the critical path.
    await f.row("Doku", "2026-11-03", "2026-11-05");
    await page.goto(`/#page=${f.page.id}`);
    const paths = page.locator(".timeline-dependencies > path[data-link]");
    await expect(paths).toHaveCount(2);
    // Transparent: masked where they cross other bars; orthogonal: no curves.
    for (const d of await paths.evaluateAll((list) => list.map((p) => [p.getAttribute("d") || "", p.getAttribute("mask") || ""])))
      expect(d[0]).not.toContain("C"), expect(d[1]).toMatch(/^url\(#timeline-mask-/);
    // The old checkbox shows as a shift mode.
    const card = await settings(page);
    await expect(card.getByLabel("Timeline: Nachfolger verschieben", { exact: true })).toHaveValue("keep");
    await page.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).click();

    // Hovering a bar: its arrows in front, the others faint, its days in the axis.
    await page.locator(`[data-row-id="${a.id}"] .timeline-range`).hover();
    await expect(page.locator(".timeline-dependencies > path.is-focus")).toHaveCount(1);
    await expect(page.locator(".timeline-dependencies > path.is-dimmed")).toHaveCount(1);
    await expect(page.locator(".timeline-axis-highlight")).toBeVisible();
    await expect(page.locator(".timeline-axis-highlight .timeline-axis-day")).toHaveCount(2);

    // Hovering an arrow offers × at its end; removing the link can be undone.
    await page.mouse.move(0, 0);
    const middle = await arrowMiddle(page, `${a.id}>${b.id}`);
    await page.mouse.move(middle.x, middle.y);
    const remove = page.getByRole("button", { name: "Abhängigkeit Konzept → Umsetzung entfernen", exact: true });
    await expect(remove).toBeVisible();
    await expect(page.locator(`[data-row-id="${a.id}"] .timeline-range`)).toHaveClass(/link-hover/);
    await expect(page.locator(`[data-row-id="${b.id}"] .timeline-range`)).toHaveClass(/link-hover/);
    await remove.click();
    await expect.poll(async () => (await f.read()).rows.find((r: { id: string }) => r.id === b.id).cells.after).toEqual([]);
    await expect(paths).toHaveCount(1);
    const toast = page.locator(".toast").filter({ hasText: "Abhängigkeit entfernt" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Rückgängig" }).click();
    await expect.poll(async () => (await f.read()).rows.find((r: { id: string }) => r.id === b.id).cells.after).toEqual([a.id]);
    await expect(paths).toHaveCount(2);

    // "Abstände halten": Alt+→ moves the chain; one undo puts all three back.
    const bar = page.getByRole("button", { name: "Konzept: 2026-11-02 bis 2026-11-04", exact: true });
    await bar.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => f.period(c.id)).toBe("2026-11-13..2026-11-14");
    expect(await f.period(b.id)).toBe("2026-11-10..2026-11-11");
    const moved = page.locator(".toast").filter({ hasText: "2 abhängige Einträge verschoben" });
    await expect(moved).toBeVisible();
    await moved.getByRole("button", { name: "Rückgängig" }).click();
    await expect.poll(() => Promise.all([f.period(a.id), f.period(b.id), f.period(c.id)])).toEqual(["2026-11-02..2026-11-04", "2026-11-09..2026-11-10", "2026-11-12..2026-11-13"]);

    // "Nur bei Überschneidung": a day later leaves the slack alone …
    await (await settings(page)).getByLabel("Timeline: Nachfolger verschieben", { exact: true }).selectOption({ label: "Nur bei Überschneidung" });
    await expect.poll(async () => (await f.read()).database.views[0].timeline).toMatchObject({ shiftMode: "overlap" });
    expect((await f.read()).database.views[0].timeline.moveSuccessors).toBeUndefined();
    await page.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).click();
    const again = page.getByRole("button", { name: "Konzept: 2026-11-02 bis 2026-11-04", exact: true });
    // The setting is saved (the bars take keys again).
    await expect(again).toHaveAttribute("aria-disabled", "false");
    await again.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(() => f.period(a.id)).toBe("2026-11-03..2026-11-05");
    expect(await f.period(b.id)).toBe("2026-11-09..2026-11-10");
    // … and a move into the successor pushes it just far enough.
    const db = (await f.read()).database;
    const rowA = (await f.read()).rows.find((r: { id: string }) => r.id === a.id);
    await f.command({ action: "row.schedule", pageId: f.page.id, viewId: "timeline", version: db.version, rowId: a.id, rowVersion: rowA.version, change: { operation: "move", days: 5 } });
    expect(await Promise.all([f.period(b.id), f.period(c.id)])).toEqual(["2026-11-11..2026-11-12", "2026-11-13..2026-11-14"]);

    // Hidden arrows keep the critical path.
    await page.reload();
    await (await settings(page)).getByLabel("Timeline: Pfeile zeigen", { exact: true }).selectOption({ label: "In dieser Ansicht ausblenden" });
    await expect(page.locator(".timeline-dependencies")).toHaveCount(0);
    await expect(page.locator(`[data-row-id="${b.id}"] .timeline-range`)).toHaveClass(/critical/);
    await (await settings(page)).getByLabel("Timeline: Pfeile zeigen", { exact: true }).selectOption({ label: "Nur für den gewählten Eintrag" });
    await page.getByRole("button", { name: "Timeline-Einstellungen", exact: true }).click();
    await expect(page.locator(".timeline-dependencies")).toHaveCount(0);
    await page.locator(`[data-row-id="${b.id}"] .timeline-range`).hover();
    await expect(paths).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    await f.command({ action: "page.delete", pageId: f.page.id });
  }
});

test("hierarchy: summary bars from the children, collapsing with arrows on the parent, colours, groups, published read-only", async ({ page, browser }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Hierarchie ${info.project.name} ${Date.now()}`, {
    hierarchyField: "parent",
    summaryBaseline: true,
    colorField: "level",
    milestoneOnlyField: true,
  });
  try {
    const p1 = await f.row("Phase 1", "2026-11-02", "2026-11-05", { level: "Phase" });
    const p2 = await f.row("Phase 2", null, null, { level: "Phase" });
    const a = await f.row("Konzept", "2026-11-02", "2026-11-06", { level: "Aktivität", parent: [p1.id] });
    const b = await f.row("Umsetzung", "2026-11-09", "2026-11-13", { level: "Aktivität", parent: [p1.id], after: [a.id] });
    const c = await f.row("Abnahme", "2026-11-16", "2026-11-16", { level: "Aktivität", parent: [p2.id], after: [b.id] });
    await page.goto(`/#page=${f.page.id}`);
    const timeline = page.locator(".timeline-view");
    // Children below their parents, indented.
    await expect(timeline.locator(".timeline-entry .timeline-name")).toHaveText(["Phase 1", "Konzept", "Umsetzung", "Phase 2", "Abnahme"]);
    await expect(timeline.locator(`[data-row-id="${a.id}"] .timeline-entry-label`)).toHaveCSS("padding-left", "17px");
    // Summary bars: from the earliest start to the latest end below.
    await expect(page.getByRole("button", { name: "Phase 1: 2026-11-02 bis 2026-11-13 (aus 2 Untereinträgen)", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Phase 2: 2026-11-16 bis 2026-11-16 (aus 1 Untereinträgen)", exact: true })).toBeVisible();
    await expect(timeline.locator(".timeline-baseline")).toHaveCount(1);
    // Colour by level; a one-day record stays a bar.
    await expect(timeline.locator(`[data-row-id="${a.id}"] .timeline-range`)).toHaveClass(/opt-green/);
    await expect(timeline.locator(`[data-row-id="${c.id}"] .timeline-range`)).not.toHaveClass(/milestone/);
    const paths = page.locator(".timeline-dependencies > path[data-link]");
    await expect(paths).toHaveCount(2);

    // Collapsing: the children fold away, their arrows attach to the summary bar.
    await page.getByRole("button", { name: "Phase 1 zuklappen", exact: true }).click();
    await expect(timeline.locator(".timeline-entry .timeline-name")).toHaveText(["Phase 1", "Phase 2", "Abnahme"]);
    await expect(paths).toHaveCount(1);
    await expect(paths.first()).toHaveAttribute("data-link", `${p1.id}>${c.id}`);
    // Kept on this device.
    await page.reload();
    await expect(page.getByRole("button", { name: "Phase 1 aufklappen", exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Alle zuklappen", exact: true }).click();
    await expect(timeline.locator(".timeline-entry .timeline-name")).toHaveText(["Phase 1", "Phase 2"]);
    await expect(paths.first()).toHaveAttribute("data-link", `${p1.id}>${p2.id}`);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `test-results/timeline-outline/${info.project.name}-collapsed-${scheme}.png`, animations: "disabled" });
    }
    // Reduced motion: instant.
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Alle aufklappen", exact: true }).click();
    expect(await page.locator("[data-folding]").count()).toBe(0);
    await expect(timeline.locator(".timeline-entry .timeline-name")).toHaveText(["Phase 1", "Konzept", "Umsetzung", "Phase 2", "Abnahme"]);
    await expect(paths).toHaveCount(2);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `test-results/timeline-outline/${info.project.name}-expanded-${scheme}.png`, animations: "disabled" });
    }
    await page.emulateMedia({ colorScheme: "light" });

    // Groups by a property.
    await (await settings(page)).getByLabel("Timeline: Gruppieren nach", { exact: true }).selectOption({ label: "Ebene" });
    await expect.poll(async () => (await f.read()).database.views[0].groupBy).toBe("level");
    await expect(timeline.locator(".timeline-group")).toHaveCount(2);
    await (await settings(page)).getByLabel("Timeline: Gruppieren nach", { exact: true }).selectOption({ label: "Keine Gruppierung" });
    await expect(timeline.locator(".timeline-group")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

    // The publication: the same outline, read-only.
    await f.command({ action: "page.publish", pageId: f.page.id, enabled: true });
    const token = (await f.read()).page.public_token;
    const context = await browser.newContext(info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
    const visitor = await context.newPage();
    visitor.on("pageerror", (e) => errors.push(e.message));
    await visitor.goto(`${f.origin}/share/${token}?view=timeline`);
    const shared = visitor.getByRole("region", { name: "Timeline" });
    await expect(shared.locator(".timeline-entry .timeline-name")).toHaveText(["Phase 1", "Konzept", "Umsetzung", "Phase 2", "Abnahme"]);
    await expect(shared.locator(".timeline-range.summary")).toHaveCount(2);
    await expect(shared.locator(".timeline-baseline")).toHaveCount(1);
    await expect(shared.locator(".timeline-dependencies > path[data-link]")).toHaveCount(2);
    await expect(shared.locator(".timeline-resize, .timeline-link-handle, .timeline-unlink")).toHaveCount(0);
    await shared.getByRole("button", { name: "Phase 1 zuklappen", exact: true }).click();
    await expect(shared.locator(".timeline-entry .timeline-name")).toHaveText(["Phase 1", "Phase 2", "Abnahme"]);
    await expect(shared.locator(".timeline-dependencies > path[data-link]")).toHaveCount(1);
    for (const scheme of ["light", "dark"] as const) {
      await visitor.emulateMedia({ colorScheme: scheme });
      await visitor.screenshot({ path: `test-results/timeline-outline/${info.project.name}-public-${scheme}.png`, fullPage: true, animations: "disabled" });
    }
    await context.close();
    expect(errors).toEqual([]);
  } finally {
    await f.command({ action: "page.delete", pageId: f.page.id });
  }
});
