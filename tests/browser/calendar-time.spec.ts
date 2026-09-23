import {
  test,
  expect,
  type Page,
  type Locator,
  type APIRequestContext,
  type Route,
} from "@playwright/test";
test.use({ timezoneId: "UTC" });
const pendingAreas = new Map<string, { id: string; name: string }>();
async function removeArea(
  request: APIRequestContext,
  area: { id: string; name: string },
) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const boot = await (await request.get("/api/bootstrap")).json();
  const space = [...boot.managedSpaces, ...(boot.trashedSpaces || [])].find(
    (s: any) => s.id === area.id,
  );
  if (!space) return;
  expect(space.name).toBe(area.name);
  let version = space.version;
  for (const action of space.deleted_at
    ? ["space.purge"]
    : ["space.delete", "space.purge"]) {
    const response = await request.post("/api/command", {
      headers: { origin },
      data: { action, spaceId: area.id, version, confirmName: area.name },
    });
    expect(response.ok(), await response.text()).toBe(true);
    version++;
  }
}
test.afterEach(async ({ request }, info) => {
  const area = pendingAreas.get(info.testId);
  if (!area) return;
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await request.post("/api/auth/demo", { headers: { origin } });
  await removeArea(request, area);
  pendingAreas.delete(info.testId);
});

async function fixture(page: Page, name: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const area = await command({
    action: "space.create",
    workspaceId: boot.workspace.id,
    name,
    private: true,
  });
  pendingAreas.set(test.info().testId, { id: area.id, name });
  const source = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: area.id,
    kind: "database",
    title: name,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${source.id}`)).json();
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "start", name: "Beginn", type: "date" },
    { id: "end", name: "Ende", type: "date" },
  ];
  const views = [
    {
      id: "calendar",
      name: "Kalender",
      type: "calendar",
      filters: [],
      sorts: [],
      dateField: "start",
      endDateField: "end",
      calendar: { mode: "day", timeZone: "Europe/Berlin" },
    },
    { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
  ];
  await command({
    action: "database.update",
    pageId: source.id,
    version: 1,
    fields,
    views,
  });
  const meeting = await command({
    action: "row.create",
    pageId: source.id,
    cells: {
      title: "Besprechung",
      start: "2026-09-23T07:00:00Z",
      end: "2026-09-23T08:00:00Z",
    },
  });
  const full = await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Ganztagsplan", start: "2026-09-23", end: "2026-09-24" },
  });
  const unscheduled = await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Ungeplant" },
  });
  const row = async () =>
    (await read()).rows.find((r: any) => r.id === meeting.id);
  const cleanup = async () => {
    await removeArea(page.request, { id: area.id, name });
    pendingAreas.delete(test.info().testId);
  };
  await page.goto(`/#page=${source.id}`);
  const calendar = page.getByRole("region", { name: "Kalender", exact: true });
  await calendar
    .getByLabel("Kalender: Datum", { exact: true })
    .fill("2026-09-23");
  return {
    errors,
    source,
    meeting,
    full,
    unscheduled,
    read,
    row,
    command,
    calendar,
    cleanup,
  };
}
async function drag(
  page: Page,
  locator: Locator,
  dx: number,
  dy: number,
  mobile: boolean,
) {
  await expect(locator).toBeEnabled();
  await locator.scrollIntoViewIfNeeded();
  const b = (await locator.boundingBox())!,
    x = b.x + Math.min(25, b.width / 2),
    y = b.y + b.height / 2;
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/command") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.action === "row.schedule",
  );
  if (mobile) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    for (let i = 1; i <= 6; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6, id: 1 }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  }
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
}
test("timed calendars move and resize with mouse, touch and keyboard and persist view preferences", async ({
  page,
}, info) => {
  const f = await fixture(
      page,
      `Calendar gestures ${info.project.name} ${Date.now()}`,
    ),
    mobile = info.project.name === "mobile";
  const errors = f.errors;
  try {
    const event = f.calendar.locator(`[data-row-id="${f.meeting.id}"]`),
      body = event.locator(".calendar-time-body");
    await expect(body).toContainText("09:00–10:00");
    await drag(page, body, 0, 30, mobile);
    await expect
      .poll(async () => (await f.row()).cells)
      .toMatchObject({
        start: "2026-09-23T07:30:00Z",
        end: "2026-09-23T08:30:00Z",
      });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await drag(
      page,
      event.getByLabel("Ende von Besprechung ziehen", { exact: true }),
      0,
      15,
      mobile,
    );
    await expect(body).toContainText("09:30–10:45");
    await drag(
      page,
      event.getByLabel("Beginn von Besprechung ziehen", { exact: true }),
      0,
      -15,
      mobile,
    );
    await expect(body).toContainText("09:15–10:45");
    await expect(body).toBeEnabled();
    await body.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(body).toContainText("09:00–10:30");
    await expect(body).toBeFocused();
    await expect(body).toBeEnabled();
    await page.keyboard.press("Alt+Shift+ArrowDown");
    await expect(body).toContainText("09:00–10:45");
    const grip = event.getByLabel("Ende von Besprechung ziehen", {
      exact: true,
    });
    await expect(grip).toBeEnabled();
    await grip.focus();
    await page.keyboard.press("ArrowDown");
    await expect(body).toContainText("09:00–11:00");
    await expect(grip).toBeFocused();
    await expect(grip).toBeEnabled();
    await page.keyboard.press("ArrowUp");
    await expect(body).toContainText("09:00–10:45");
    await f.calendar
      .getByLabel("Kalender: Ansicht", { exact: true })
      .selectOption("week");
    await expect
      .poll(async () => (await f.read()).database.views[0].calendar.mode)
      .toBe("week");
    // Moving across a day boundary retains pointer capture on the original event element.
    const column = f.calendar.locator(
        '.calendar-hours-day[data-day="2026-09-23"]',
      ),
      width = (await column.boundingBox())!.width;
    await drag(page, body, width, 0, mobile);
    await expect
      .poll(async () => (await f.row()).cells)
      .toMatchObject({
        start: "2026-09-24T07:00:00Z",
        end: "2026-09-24T08:45:00Z",
      });
    await page.reload();
    await expect(
      f.calendar.getByLabel("Kalender: Ansicht", { exact: true }),
    ).toHaveValue("week");
    await f.calendar
      .getByLabel("Kalender: Datum", { exact: true })
      .fill("2026-09-24");
    await f.calendar
      .getByLabel("Kalender: Ansicht", { exact: true })
      .selectOption("day");
    await expect(body).toContainText("09:00–10:45");
    await f.calendar
      .getByLabel("Kalender: Zeitzone", { exact: true })
      .fill("America/New_York");
    await f.calendar
      .getByRole("button", { name: "Übernehmen", exact: true })
      .click();
    await expect(body).toContainText("03:00–04:45");
    await f.calendar
      .getByLabel("Kalender: Zeitzone", { exact: true })
      .fill("Europe/Berlin");
    await f.calendar
      .getByRole("button", { name: "Übernehmen", exact: true })
      .click();
    await expect(body).toContainText("09:00–10:45");
    await f.calendar.locator(".calendar-hours-scroll").evaluate((el) => {
      el.scrollTop = 450;
      el.scrollLeft = 0;
    });
    await body.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/${info.project.name}-timed-calendar.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    test.setTimeout(Math.max(info.timeout, 90_000));
    await f.cleanup();
  }
});
test("date and time editors reject DST gaps, select fold occurrences and save both dates atomically", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Calendar dates ${info.project.name} ${Date.now()}`,
  );
  try {
    await f.calendar
      .getByRole("button", {
        name: "Termin für Besprechung bearbeiten",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Termin bearbeiten",
      exact: true,
    });
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-03-29T02:30");
    await expect(dialog.getByRole("alert")).toContainText("existiert");
    await dialog
      .getByRole("button", { name: "Termin speichern", exact: true })
      .click();
    expect((await f.row()).cells.start).toBe("2026-09-23T07:00:00Z");
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-10-25T02:30");
    await expect(dialog.getByRole("alert")).toContainText("zweimal");
    await dialog
      .getByLabel("Beginn: Zeitumstellung", { exact: true })
      .selectOption("later");
    await dialog.getByLabel("Ende", { exact: true }).fill("2026-10-25T03:30");
    await dialog
      .getByRole("button", { name: "Termin speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect((await f.row()).cells).toMatchObject({
      start: "2026-10-25T01:30:00Z",
      end: "2026-10-25T02:30:00Z",
    });
    await f.calendar
      .getByLabel("Kalender: Datum", { exact: true })
      .fill("2026-10-25");
    await expect(f.calendar.locator(".calendar-hours-heading")).toContainText(
      "25 Stunden",
    );
    await expect(
      f.calendar.getByRole("button", { name: /Termin am 2026-10-25 um 02:00/ }),
    ).toHaveCount(2);
    await f.calendar
      .getByRole("button", {
        name: "Termin für Besprechung bearbeiten",
        exact: true,
      })
      .click();
    // Editing nothing must retain the selected second fold occurrence.
    await dialog
      .getByRole("button", { name: "Termin speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect((await f.row()).cells.start).toBe("2026-10-25T01:30:00Z");
    await f.calendar
      .getByRole("button", {
        name: "Termin für Ungeplant bearbeiten",
        exact: true,
      })
      .click();
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-10-25");
    await dialog
      .getByRole("checkbox", { name: "Beginn: Uhrzeit", exact: true })
      .check();
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-10-25T09:15");
    await dialog
      .getByRole("button", { name: "Termin speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(
      (await f.read()).rows.find((r: any) => r.id === f.unscheduled.id).cells
        .start,
    ).toBe("2026-10-25T08:15:00Z");
    await page.getByRole("button", { name: "Tabelle", exact: true }).click();
    const tableRow = page.locator(`tr[data-row-id="${f.meeting.id}"]`);
    await expect(tableRow.locator(".date-cell").first()).toContainText("01:30"); // Browser timezone is UTC.
    await tableRow.locator("td").nth(2).click();
    const input = tableRow.getByLabel("Beginn", { exact: true });
    await expect(input).toHaveAttribute("type", "datetime-local");
    await input.fill("2026-10-25T01:45");
    await page.getByLabel("Datenbank durchsuchen", { exact: true }).click();
    await expect
      .poll(async () => (await f.row()).cells.start)
      .toBe("2026-10-25T01:45:00Z");
  } finally {
    test.setTimeout(Math.max(info.timeout, 90_000));
    await f.cleanup();
  }
});
test("calendar conflicts preserve drafts, remote edits cancel gestures and locked readers can navigate locally", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Calendar conflicts ${info.project.name} ${Date.now()}`,
  );
  try {
    await f.calendar
      .getByRole("button", {
        name: "Termin für Besprechung bearbeiten",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Termin bearbeiten",
      exact: true,
    });
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-09-23T08:30");
    await f.command({
      action: "row.update",
      pageId: f.source.id,
      rowId: f.meeting.id,
      version: (await f.row()).version,
      cells: { title: "Remote Besprechung" },
    });
    await dialog
      .getByRole("button", { name: "Termin speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert",
    );
    await expect(dialog.getByLabel("Beginn", { exact: true })).toHaveValue(
      "2026-09-23T08:30",
    );
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await page.reload();
    await f.calendar
      .getByLabel("Kalender: Datum", { exact: true })
      .fill("2026-09-23");
    const body = f.calendar.locator(
      `[data-row-id="${f.meeting.id}"] .calendar-time-body`,
    );
    await expect(body).toBeEnabled();
    await body.scrollIntoViewIfNeeded();
    const b = (await body.boundingBox())!;
    await page.mouse.move(b.x + 25, b.y + 25);
    await page.mouse.down();
    await page.mouse.move(b.x + 25, b.y + 55);
    await f.command({
      action: "row.update",
      pageId: f.source.id,
      rowId: f.meeting.id,
      version: (await f.row()).version,
      cells: { title: "Remote 2" },
    });
    await expect(f.calendar.getByRole("alert")).toContainText(
      "während des Ziehens",
      {
        timeout: Math.max(
          15000,
          Number(process.env.TEST_EXPECT_TIMEOUT_MS || 0),
        ),
      },
    );
    await page.mouse.up();
    expect((await f.row()).cells.start).toBe("2026-09-23T07:00:00Z");
    await f.command({
      action: "page.update",
      pageId: f.source.id,
      patch: { locked: true },
    });
    await page.reload();
    const before = (await f.read()).database;
    await expect(f.calendar.locator(".calendar-edit")).toHaveCount(0);
    await expect(f.calendar.locator(".calendar-time-resize")).toHaveCount(0);
    await f.calendar
      .getByLabel("Kalender: Ansicht", { exact: true })
      .selectOption("week");
    await expect(f.calendar.locator(".calendar-hours-column")).toHaveCount(7);
    expect((await f.read()).database.version).toBe(before.version);
    expect((await f.read()).database.views[0].calendar.mode).toBe("day");
  } finally {
    await page.mouse.up();
    test.setTimeout(Math.max(info.timeout, 90_000));
    await f.cleanup();
  }
});

test("public date forms never submit a stale valid value after an invalid time edit", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(
    page,
    `Calendar form ${info.project.name} ${Date.now()}`,
  );
  const context = await browser.newContext({
    timezoneId: "Europe/Berlin",
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
    hasTouch: info.project.name === "mobile",
  });
  try {
    await f.command({
      action: "form.update",
      pageId: f.source.id,
      enabled: true,
      internal: false,
      anonymous: true,
      config: { requiredFields: ["title", "start"] },
    });
    const token = (await f.read()).form.token,
      guest = await context.newPage();
    await guest.goto(
      `${process.env.TEST_BASE_URL || "http://127.0.0.1:3000"}/forms/${token}`,
    );
    await guest.getByLabel("Name", { exact: true }).fill("Gasttermin");
    await guest.getByLabel("Beginn", { exact: true }).fill("2026-09-23");
    await guest
      .getByRole("checkbox", { name: "Beginn: Uhrzeit", exact: true })
      .check();
    await guest.getByLabel("Beginn", { exact: true }).fill("2026-03-29T02:30");
    await expect(
      guest.locator(".form-preview").getByRole("alert"),
    ).toContainText("existiert");
    await guest
      .getByRole("button", { name: "Antwort senden", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Antwort senden", exact: true }),
    ).toBeVisible();
    expect((await f.read()).rows).toHaveLength(3);
    await guest.getByLabel("Beginn", { exact: true }).fill("2026-10-25T02:30");
    await guest
      .getByLabel("Beginn: Zeitumstellung", { exact: true })
      .selectOption("earlier");
    const submitted = guest.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/forms/${token}`) &&
        response.request().method() === "POST",
    );
    await guest
      .getByRole("button", { name: "Antwort senden", exact: true })
      .click();
    expect((await submitted).ok()).toBeTruthy();
    await expect(
      guest.getByRole("heading", { name: "Vielen Dank!", exact: true }),
    ).toBeVisible();
    expect(
      (await f.read()).rows.find((r: any) => r.cells.title === "Gasttermin")
        .cells.start,
    ).toBe("2026-10-25T00:30:00Z");
  } finally {
    await context.close();
    test.setTimeout(Math.max(info.timeout, 90_000));
    await f.cleanup();
  }
});

test("home hydration remains stable with a different browser date and greeting hour", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.clock.setFixedTime(new Date("2030-05-01T01:30:00Z"));
  await page.goto("/");
  await expect(page.locator(".home-greeting h1")).toContainText("Guten Morgen");
  await expect(page.locator(".recent-card").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("background refresh waits for a slow request and resumes after failure", async ({
  page,
}) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const time = new Date("2026-09-23T08:00:00Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 60_000));
  let requests = 0;
  let pending: Route | undefined;
  await page.route("**/api/bootstrap?workspace=*", async (route) => {
    requests++;
    if (requests === 1) pending = route;
    else await route.fulfill({ status: 503, json: { error: "Test failure" } });
  });
  try {
    await page.goto("/");
    await expect(page.locator(".home-greeting h1")).toContainText("Guten Morgen");
    await page.clock.fastForward(10_001);
    await expect.poll(() => requests).toBe(1);
    for (let i = 0; i < 3; i++) await page.clock.fastForward(10_001);
    expect(requests).toBe(1);
    const failed = page.waitForResponse((response) =>
      response.url().includes("/api/bootstrap?workspace="),
    );
    await pending!.fulfill({ status: 503, json: { error: "Test failure" } });
    pending = undefined;
    await failed;
    await page.clock.runFor(1);
    await page.clock.fastForward(10_001);
    await expect.poll(() => requests).toBe(2);
  } finally {
    await pending?.abort();
    await page.unrouteAll({ behavior: "wait" });
  }
});
