import { test, expect, type CDPSession, type Page } from "@playwright/test";

// #100: dragging a database record showed the grab cursor until it moved,
// then the browser's arrow (Safari): records were dragged with the browser's
// own drag and drop, which owns the cursor. They are now dragged with
// pointer events (components/pointer-drag.ts): the closed hand stays the
// whole time, a copy follows the pointer, Escape cancels, a long press lifts
// a record by touch and Space lifts it with the keyboard.

const shots = process.env.POINTER_DRAG_SHOTS;
// The calendar opens on the current month.
const month = new Date().toISOString().slice(0, 7);

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
  const database = async (title: string, views: Record<string, unknown>[]) => {
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
        { id: "status", name: "Status", type: "select", options: ["Todo", "Done"] },
        { id: "date", name: "Datum", type: "date" },
      ],
      views: views.map((v) => ({ filters: [], sorts: [], ...v })),
    });
    const rows: string[] = [];
    for (const [i, name] of ["Alpha", "Beta", "Gamma", "Delta"].entries())
      rows.push(
        (
          await command({
            action: "row.create",
            pageId: p.id,
            cells: { title: name, status: i < 2 ? "Todo" : "Done", date: `${month}-${10 + i}` },
          })
        ).id,
      );
    const read = async () => (await (await page.request.get(`/api/pages/${p.id}`)).json()) as {
      rows: { id: string; cells: Record<string, unknown> }[];
    };
    return { id: p.id as string, rows, read };
  };
  return { command, database };
}

const order = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((items) => items.map((i) => (i as HTMLElement).dataset.rowId));
// The cursor the page shows at a point, and the cursor of the html element.
const cursorAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ({ x, y }) => ({
      at: getComputedStyle(document.elementFromPoint(x, y) || document.body).cursor,
      root: getComputedStyle(document.documentElement).cursor,
    }),
    { x, y },
  );
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
// After the views' cross-fade (a view transition takes the pointer meanwhile).
async function settled(page: Page) {
  await page.waitForTimeout(300);
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some((a) => ((a.effect as KeyframeEffect | null)?.pseudoElement || "").startsWith("::view-transition")),
  );
  await page.waitForTimeout(200);
}
async function shot(page: Page, name: string, info: { project: { name: string } }) {
  if (shots) await page.screenshot({ path: `${shots}/${info.project.name}-${name}.png` });
}

test("table rows: the closed hand and a lifted copy for the whole drag, Escape cancels", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse dragging.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { database } = await fixture(page);
  const db = await database("Ziehen", [{ id: "table", name: "Tabelle", type: "table" }]);
  await page.goto(`/#page=${db.id}`);
  const rows = ".data-table tbody tr[data-row-id]";
  await expect(page.locator(rows)).toHaveCount(4);
  const handle = (name: string) => page.getByRole("button", { name: `Eintrag verschieben: ${name}`, exact: true });
  // The open hand on the handle.
  expect(await handle("Gamma").evaluate((el) => getComputedStyle(el).cursor)).toBe("grab");
  const from = (await handle("Gamma").boundingBox())!;
  const target = await center(page, `tr[data-row-id="${db.rows[0]}"]`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // Below the threshold nothing happens yet.
  await page.mouse.move(from.x + from.width / 2 + 2, from.y + from.height / 2);
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(0);
  await page.mouse.move(target.x, target.box.y + 4, { steps: 8 });
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(1);
  await expect(page.locator(`tr[data-row-id="${db.rows[0]}"]`)).toHaveClass(/order-drop-before/);
  // Over a cell, over the page header: the closed hand everywhere.
  expect(await cursorAt(page, target.x, target.box.y + 4)).toEqual({ at: "grabbing", root: "grabbing" });
  await page.mouse.move(target.x, 30, { steps: 4 });
  expect((await cursorAt(page, target.x, 30)).at).toBe("grabbing");
  await page.mouse.move(target.x, target.box.y + 4, { steps: 4 });
  await shot(page, "table-drag-light", info);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await shot(page, "table-drag-dark", info);
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  // Escape: nothing moves and everything is put back.
  await page.keyboard.press("Escape");
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(0);
  await page.mouse.up();
  expect(await page.evaluate(() => document.documentElement.classList.contains("pointer-dragging"))).toBe(false);
  await expect(page.locator(".order-drop-before, .order-drop-after")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await order(page, rows)).toEqual(db.rows);
  // Dropped: before the first row.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.box.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => order(page, rows)).toEqual([db.rows[2], db.rows[0], db.rows[1], db.rows[3]]);
  await page.reload();
  await expect.poll(() => order(page, rows)).toEqual([db.rows[2], db.rows[0], db.rows[1], db.rows[3]]);
  // A click without movement still opens the position dialog.
  await handle("Delta").click();
  await expect(page.getByRole("dialog", { name: "Eintrag verschieben", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Keyboard: Space lifts, arrows move, Space drops – announced.
  await handle("Delta").focus();
  await page.keyboard.press("Space");
  const status = page.locator("p[role=status].sr-only").filter({ hasText: "angehoben" });
  await expect(status).toContainText("Delta angehoben. Position 4 von 4");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("p[role=status].sr-only").filter({ hasText: "Position 2 von 4" })).toHaveCount(1);
  await expect(page.locator(`tr[data-row-id="${db.rows[0]}"]`)).toHaveClass(/order-drop-before/);
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => order(page, rows)).toEqual([db.rows[2], db.rows[3], db.rows[0], db.rows[1]]);
  await expect(handle("Delta")).toBeFocused();
  // Escape puts a lifted record back.
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.locator("p[role=status].sr-only").filter({ hasText: "abgebrochen" })).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await order(page, rows)).toEqual([db.rows[2], db.rows[3], db.rows[0], db.rows[1]]);
  expect(errors).toEqual([]);
});

test("board cards move between columns, gallery cards reorder, the calendar moves dates", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse dragging.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { database } = await fixture(page);
  const db = await database("Karten", [
    { id: "board", name: "Board", type: "board", groupBy: "status" },
    { id: "gallery", name: "Galerie", type: "gallery" },
    { id: "calendar", name: "Kalender", type: "calendar", dateField: "date" },
  ]);
  await page.goto(`/#page=${db.id}`);
  const card = (id: string) => `.record-card-wrap[data-row-id="${id}"] .record-card`;
  const from = await center(page, card(db.rows[0]));
  const done = await center(page, '.board-column[aria-label="Gruppe Done"] header');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(done.x, done.y + 60, { steps: 10 });
  expect(await cursorAt(page, done.x, done.y + 60)).toEqual({ at: "grabbing", root: "grabbing" });
  await shot(page, "board-drag", info);
  await page.mouse.up();
  await expect
    .poll(async () => (await db.read()).rows.find((r) => r.id === db.rows[0])?.cells.status)
    .toBe("Done");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A click on a card still opens it.
  await page.locator(card(db.rows[1])).click();
  await expect(page.getByRole("dialog", { name: "Eintrag", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Galerie", exact: true }).click();
  const gallery = ".gallery .record-card-wrap[data-row-id]";
  await expect(page.locator(gallery)).toHaveCount(4);
  await settled(page);
  const before = await order(page, gallery);
  const last = await center(page, card(before[3]!));
  const first = await center(page, card(before[0]!));
  await page.mouse.move(last.x, last.y);
  await page.mouse.down();
  await page.mouse.move(first.x, first.box.y + 8, { steps: 10 });
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(1);
  await shot(page, "gallery-drag", info);
  await page.mouse.up();
  await expect.poll(() => order(page, gallery)).toEqual([before[3], before[0], before[1], before[2]]);

  await page.getByRole("button", { name: "Kalender", exact: true }).click();
  await settled(page);
  const chip = page.locator(`.calendar-day[data-day="${month}-11"] .calendar-event`, { hasText: "Beta" });
  await expect(chip).toBeVisible();
  // The target day in the middle of the window: near its edge the drag
  // scrolls the page (and the pointer would be over another day).
  await page
    .locator(`.calendar-day[data-day="${month}-18"]`)
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  const c = (await chip.boundingBox())!;
  const day = await center(page, `.calendar-day[data-day="${month}-18"]`);
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(day.x, day.y, { steps: 10 });
  await expect(page.locator(`.calendar-day[data-day="${month}-18"]`)).toHaveClass(/touch-target/);
  expect((await cursorAt(page, day.x, day.y)).root).toBe("grabbing");
  await shot(page, "calendar-drag", info);
  await page.mouse.up();
  await expect
    .poll(async () => (await db.read()).rows.find((r) => r.id === db.rows[1])?.cells.date)
    .toBe(`${month}-18`);
  expect(errors).toEqual([]);
});

// A finger: down, held, moved in steps, up.
async function touchDrag(
  cdp: CDPSession,
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hold: number,
) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  await page.waitForTimeout(hold);
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 12, y: from.y + ((to.y - from.y) * i) / 12 }],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
}

test("by touch a long press on the handle lifts a row; a swipe still scrolls", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch screens.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { database } = await fixture(page);
  const db = await database("Halten", [{ id: "list", name: "Liste", type: "list" }]);
  await page.goto(`/#page=${db.id}`);
  const rows = ".record-list-item[data-row-id]";
  await expect(page.locator(rows)).toHaveCount(4);
  const cdp = await page.context().newCDPSession(page);
  const handle = await center(page, `.record-list-item[data-row-id="${db.rows[3]}"] .row-order-handle`);
  // A quick swipe over the handle is no drag.
  const main = page.locator(".main-scroll");
  await touchDrag(cdp, page, handle, { x: handle.x, y: handle.y - 150 }, 0);
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(0);
  expect(await order(page, rows)).toEqual(db.rows);
  // (After the fling of the swipe.)
  await page.waitForTimeout(1200);
  await main.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
  // Held, then moved: dropped before the first record.
  const h = await center(page, `.record-list-item[data-row-id="${db.rows[3]}"] .row-order-handle`);
  const t = await center(page, `.record-list-item[data-row-id="${db.rows[0]}"]`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [h] });
  await page.waitForTimeout(450);
  await expect(page.locator(".pointer-drag-preview")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.classList.contains("pointer-dragging"))).toBe(true);
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: h.x, y: h.y + ((t.box.y + 6 - h.y) * i) / 10 }],
    });
    await page.waitForTimeout(20);
  }
  await expect(page.locator(`.record-list-item[data-row-id="${db.rows[0]}"]`)).toHaveClass(/order-drop-before/);
  await shot(page, "list-touch-drag", info);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => order(page, rows)).toEqual([db.rows[3], db.rows[0], db.rows[1], db.rows[2]]);
  // A tap on the handle still opens the position dialog.
  await page.locator(`.record-list-item[data-row-id="${db.rows[1]}"] .row-order-handle`).tap();
  await expect(page.getByRole("dialog", { name: "Eintrag verschieben", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("sprints, the sidebar and the board keyboard use the same dragging", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, database } = await fixture(page);
  const db = await database("Sprints", [{ id: "board", name: "Board", type: "board", groupBy: "status" }]);
  const target = await database("Ziel", [{ id: "table", name: "Tabelle", type: "table" }]);
  // Board, keyboard: Space lifts Alpha, → moves it to "Done", Space drops.
  await page.goto(`/#page=${db.id}`);
  const handle = page.getByRole("button", { name: "Eintrag verschieben: Alpha", exact: true });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(`.record-card-wrap[data-row-id="${db.rows[0]}"]`)).toHaveClass(/row-lifted/);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("p[role=status].sr-only").filter({ hasText: "„Done“" })).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect
    .poll(async () => (await db.read()).rows.find((r) => r.id === db.rows[0])?.cells.status)
    .toBe("Done");
  // Sprints: a record from the backlog into the sprint, with the mouse.
  await command({ action: "sprint.setup", pageId: db.id });
  await page.reload();
  await page.getByRole("button", { name: "Sprints", exact: true }).click();
  await settled(page);
  const backlogRow = page.locator(".sprint-backlog .sprint-rows li", { hasText: "Beta" });
  const sprint = page.locator(".sprint-section:not(.sprint-backlog)").first();
  await expect(backlogRow).toBeVisible();
  const from = (await backlogRow.locator(".sprint-row-title").boundingBox())!;
  const to = (await sprint.locator("header").boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(sprint).toHaveClass(/ drop/);
  expect((await cursorAt(page, to.x + to.width / 2, to.y + to.height / 2)).at).toBe("grabbing");
  await shot(page, "sprint-drag", info);
  await page.mouse.up();
  await expect(sprint.locator(".sprint-rows li", { hasText: "Beta" })).toBeVisible();
  // Keyboard: back to the backlog.
  const betaHandle = sprint.getByRole("button", { name: "Beta verschieben", exact: true });
  await expect(betaHandle).toBeEnabled();
  await betaHandle.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("p[role=status].sr-only").filter({ hasText: "Beta angehoben" })).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".sprint-backlog .sprint-rows li", { hasText: "Beta" })).toBeVisible();
  // A record onto another database in the sidebar.
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await settled(page);
  const gamma = page.locator(`.record-card-wrap[data-row-id="${db.rows[2]}"] .record-card`);
  const card = (await gamma.boundingBox())!;
  const nav = page.locator(`.page-nav[data-page-id="${target.id}"]`);
  await nav.scrollIntoViewIfNeeded();
  const n = (await nav.boundingBox())!;
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(n.x + n.width / 2, n.y + n.height / 2, { steps: 12 });
  await expect(nav).toHaveClass(/drop/);
  await page.mouse.up();
  await expect.poll(async () => (await target.read()).rows.length).toBe(5);
  await expect.poll(async () => (await db.read()).rows.some((r) => r.id === db.rows[2])).toBe(false);
  // And a table row by its handle, back again; with Alt held it is copied.
  await page.goto(`/#page=${target.id}`);
  await expect(page.locator(".data-table tbody tr[data-row-id]")).toHaveCount(5);
  await settled(page);
  const rowHandle = page.getByRole("button", { name: "Eintrag verschieben: Delta", exact: true }).first();
  const back = page.locator(`.page-nav[data-page-id="${db.id}"]`);
  await back.scrollIntoViewIfNeeded();
  const h = (await rowHandle.boundingBox())!;
  const b = (await back.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(back).toHaveClass(/drop-records/);
  await page.keyboard.down("Alt");
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect.poll(async () => (await db.read()).rows.length).toBe(4);
  expect((await target.read()).rows.length).toBe(5);
  expect(errors).toEqual([]);
});

test("a row dropped on a group header joins that group, after its last record", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse dragging.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { database } = await fixture(page);
  const db = await database("Gruppen", [{ id: "table", name: "Tabelle", type: "table", groupBy: "status" }]);
  await page.goto(`/#page=${db.id}`);
  await expect(page.locator(".data-table tbody tr[data-row-id]")).toHaveCount(4);
  await settled(page);
  const handle = (await page.getByRole("button", { name: "Eintrag verschieben: Alpha", exact: true }).boundingBox())!;
  const header = page.locator(".data-table tbody[aria-label='Gruppe Done'] .database-group-header");
  const to = (await header.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 200, to.y + to.height / 2, { steps: 10 });
  await expect(header).toHaveAttribute("data-zone-hint", "");
  await expect(page.locator(`tr[data-row-id="${db.rows[3]}"]`)).toHaveClass(/order-drop-after/);
  await page.mouse.up();
  await expect
    .poll(async () => (await db.read()).rows.find((r) => r.id === db.rows[0])?.cells.status)
    .toBe("Done");
  await expect
    .poll(() => page.locator(".data-table tbody[aria-label='Gruppe Done'] tr[data-row-id]").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.rowId)))
    .toEqual([db.rows[2], db.rows[3], db.rows[0]]);
  expect(errors).toEqual([]);
});
