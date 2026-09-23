import { test, expect, type Page, type Locator } from "@playwright/test";
async function fixture(page: Page, name: string) {
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
  const create = async (kind: string, title: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: area.id,
      kind,
      title,
    });
  const source = await create("database", name),
    read = async () =>
      (await page.request.get(`/api/pages/${source.id}`)).json();
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "start", name: "Beginn", type: "date" },
    { id: "end", name: "Ende", type: "date" },
  ];
  const views = [
    {
      id: "timeline",
      name: "Timeline",
      type: "timeline",
      filters: [],
      sorts: [],
      dateField: "start",
      endDateField: "end",
      timeline: { scale: "month", showWeekends: true },
    },
    {
      id: "calendar",
      name: "Kalender",
      type: "calendar",
      filters: [],
      sorts: [],
      dateField: "start",
      endDateField: "end",
    },
  ];
  await command({
    action: "database.update",
    pageId: source.id,
    version: 1,
    fields,
    views,
  });
  const a = await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Plan", start: "2026-09-22", end: "2026-09-23" },
  });
  const b = await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Ohne Termin", start: "", end: "" },
  });
  const cleanup = async () => {
    const boot = await (await page.request.get("/api/bootstrap")).json(),
      space = boot.managedSpaces.find((s: any) => s.id === area.id);
    if (space) {
      await command({
        action: "space.delete",
        spaceId: area.id,
        version: space.version,
        confirmName: name,
      });
      await command({
        action: "space.purge",
        spaceId: area.id,
        version: space.version + 1,
        confirmName: name,
      });
    }
  };
  return {
    origin,
    command,
    create,
    source,
    read,
    a,
    b,
    fields,
    views,
    cleanup,
  };
}
async function drag(page: Page, locator: Locator, dx: number, mobile: boolean) {
  await expect(locator).toBeEnabled();
  const box = (await locator.boundingBox())!,
    x = box.x + Math.min(20, box.width / 2),
    y = box.y + box.height / 2;
  if (mobile) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 1 }],
    });
    for (let i = 1; i <= 6; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (dx * i) / 6, y, id: 1 }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
  }
}
test("timeline scales persist, mouse and touch shift and resize ranges, keyboard and date dialog schedule records", async ({
  page,
}, info) => {
  const f = await fixture(
      page,
      `Timeline gestures ${info.project.name} ${Date.now()}`,
    ),
    mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(`/#page=${f.source.id}`);
    const timeline = page.getByRole("region", {
      name: "Timeline",
      exact: true,
    });
    await timeline
      .getByLabel("Timeline: Datum", { exact: true })
      .fill("2026-09-21");
    if (mobile)
      await timeline
        .locator(".timeline-scroll")
        .evaluate((el) => (el.scrollLeft = 652));
    const row = timeline.locator(`[data-row-id="${f.a.id}"]`),
      body = row.locator(".timeline-range-body");
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-22 bis 2026-09-23",
    );
    await drag(page, body, 32, mobile);
    await expect
      .poll(
        async () =>
          (await f.read()).rows.find((r: any) => r.id === f.a.id).cells,
      )
      .toMatchObject({ start: "2026-09-23", end: "2026-09-24" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await drag(
      page,
      row.getByRole("button", { name: "Ende von Plan ziehen", exact: true }),
      32,
      mobile,
    );
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-23 bis 2026-09-25",
    );
    await drag(
      page,
      row.getByRole("button", { name: "Beginn von Plan ziehen", exact: true }),
      -32,
      mobile,
    );
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-22 bis 2026-09-25",
    );
    await body.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-23 bis 2026-09-26",
    );
    await expect(body).toBeEnabled();
    await expect(body).toBeFocused();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-23 bis 2026-09-27",
    );
    const grip = row.getByRole("button", {
      name: "Ende von Plan ziehen",
      exact: true,
    });
    await expect(grip).toBeEnabled();
    await grip.focus();
    await page.keyboard.press("ArrowRight");
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-23 bis 2026-09-28",
    );
    await expect(grip).toBeEnabled();
    await expect(grip).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(body).toHaveAttribute(
      "aria-label",
      "Plan: 2026-09-23 bis 2026-09-27",
    );
    await timeline
      .getByRole("button", {
        name: "Zeitraum für Ohne Termin bearbeiten",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Zeitraum bearbeiten",
      exact: true,
    });
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-09-21");
    await dialog.getByLabel("Ende", { exact: true }).fill("2026-09-24");
    await dialog
      .getByRole("button", { name: "Zeitraum speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await f.read()).rows.find((r: any) => r.id === f.b.id).cells,
      )
      .toMatchObject({ start: "2026-09-21", end: "2026-09-24" });
    for (const scale of ["week", "quarter", "year", "month"]) {
      await timeline.getByLabel("Timeline: Maßstab").selectOption(scale);
      await expect
        .poll(async () => (await f.read()).database.views[0].timeline.scale)
        .toBe(scale);
    }
    await timeline
      .getByRole("checkbox", { name: "Wochenenden markieren", exact: true })
      .uncheck();
    await expect
      .poll(
        async () => (await f.read()).database.views[0].timeline.showWeekends,
      )
      .toBe(false);
    await page.reload();
    await expect(timeline.getByLabel("Timeline: Maßstab")).toHaveValue("month");
    await expect(
      timeline.getByRole("checkbox", {
        name: "Wochenenden markieren",
        exact: true,
      }),
    ).not.toBeChecked();
    await timeline
      .getByLabel("Timeline: Datum", { exact: true })
      .fill("2026-09-21");
    await timeline
      .getByRole("button", { name: "Timeline: nächster Zeitraum", exact: true })
      .click();
    await expect(
      timeline.getByLabel("Timeline: Datum", { exact: true }),
    ).toHaveValue("2026-10-01");
    await row
      .getByRole("button", { name: "Zum Zeitraum springen", exact: true })
      .click();
    await expect(
      timeline.getByLabel("Timeline: Datum", { exact: true }),
    ).toHaveValue("2026-09-23");
    await page
      .getByLabel("Datenbank durchsuchen", { exact: true })
      .fill("Ohne Termin");
    await expect(timeline.locator(".timeline-entry")).toHaveCount(1);
    await page.getByLabel("Datenbank durchsuchen", { exact: true }).fill("");
    if (mobile)
      await timeline
        .locator(".timeline-scroll")
        .evaluate((el) => (el.scrollLeft = 652));
    await page.screenshot({
      path: `test-results/${info.project.name}-timeline.png`,
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
    test.setTimeout(90_000);
    await f.cleanup();
  }
});
test("timeline conflicts retain date drafts, remote changes cancel active gestures and locked views remain locally navigable", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Timeline conflicts ${info.project.name} ${Date.now()}`,
  );
  try {
    await page.goto(`/#page=${f.source.id}`);
    const timeline = page.getByRole("region", {
      name: "Timeline",
      exact: true,
    });
    await timeline
      .getByRole("button", {
        name: "Zeitraum für Plan bearbeiten",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Zeitraum bearbeiten",
      exact: true,
    });
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-09-27");
    await dialog.getByLabel("Ende", { exact: true }).fill("2026-09-29");
    const row = (await f.read()).rows.find((r: any) => r.id === f.a.id);
    await f.command({
      action: "row.update",
      pageId: f.source.id,
      rowId: f.a.id,
      version: row.version,
      cells: { start: "2026-09-24", end: "2026-09-25" },
    });
    await dialog
      .getByRole("button", { name: "Zeitraum speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert",
    );
    await expect(dialog.getByLabel("Beginn", { exact: true })).toHaveValue(
      "2026-09-27",
    );
    await expect(dialog.getByLabel("Ende", { exact: true })).toHaveValue(
      "2026-09-29",
    );
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await page.reload();
    await timeline
      .getByLabel("Timeline: Datum", { exact: true })
      .fill("2026-09-21");
    if (info.project.name === "mobile")
      await timeline
        .locator(".timeline-scroll")
        .evaluate((el) => (el.scrollLeft = 710));
    const bar = timeline.locator(
        `[data-row-id="${f.a.id}"] .timeline-range-body`,
      ),
      box = (await bar.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 12);
    const current = (await f.read()).rows.find((r: any) => r.id === f.a.id);
    await f.command({
      action: "row.update",
      pageId: f.source.id,
      rowId: f.a.id,
      version: current.version,
      cells: { title: "Remote Plan" },
    });
    await expect(timeline.getByRole("alert")).toContainText(
      "während des Ziehens",
      { timeout: 15000 },
    );
    await page.mouse.up();
    expect(
      (await f.read()).rows.find((r: any) => r.id === f.a.id).cells.start,
    ).toBe("2026-09-24");
    await f.command({
      action: "page.update",
      pageId: f.source.id,
      patch: { locked: true },
    });
    await page.reload();
    await expect(
      timeline.getByRole("button", { name: /Zeitraum für/ }),
    ).toHaveCount(0);
    await expect(timeline.locator(".timeline-resize")).toHaveCount(0);
    const before = (await f.read()).database;
    await timeline.getByLabel("Timeline: Maßstab").selectOption("year");
    await expect(timeline.getByLabel("Timeline: Maßstab")).toHaveValue("year");
    expect((await f.read()).database.version).toBe(before.version);
    expect((await f.read()).database.views[0].timeline.scale).toBe("month");
  } finally {
    await page.mouse.up();
    test.setTimeout(90_000);
    await f.cleanup();
  }
});
test("linked timelines keep independent zoom and update source dates while calendar drag preserves range duration", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Timeline linked ${info.project.name} ${Date.now()}`,
  );
  try {
    const host = await f.create("document", "Timeline host"),
      block = crypto.randomUUID();
    const { htmlState, escaped } = await import("../../lib/document-server");
    const hostData = await (
      await page.request.get(`/api/pages/${host.id}`)
    ).json();
    await f.command({
      action: "document.sync",
      pageId: host.id,
      generation: hostData.generation,
      update: Buffer.from(
        htmlState(
          `<div data-linked-database="${block}" data-linked-source="${f.source.id}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify([f.views[0]]))}">Linked</div>`,
        ),
      ).toString("base64"),
    });
    await page.goto(`/#page=${host.id}`);
    const timeline = page.getByRole("region", {
      name: "Timeline",
      exact: true,
    });
    await timeline.getByLabel("Timeline: Maßstab").selectOption("week");
    await expect(timeline.getByLabel("Timeline: Maßstab")).toHaveValue("week");
    expect((await f.read()).database.views[0].timeline.scale).toBe("month");
    await timeline
      .getByRole("button", {
        name: "Zeitraum für Plan bearbeiten",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Zeitraum bearbeiten",
      exact: true,
    });
    await dialog.getByLabel("Beginn", { exact: true }).fill("2026-09-23");
    await dialog.getByLabel("Ende", { exact: true }).fill("2026-09-25");
    await dialog
      .getByRole("button", { name: "Zeitraum speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(timeline.getByLabel("Timeline: Maßstab")).toHaveValue("week");
    expect(
      (await f.read()).rows.find((r: any) => r.id === f.a.id).cells,
    ).toMatchObject({ start: "2026-09-23", end: "2026-09-25" });
    await page.goto(`/#page=${f.source.id}`);
    await page.getByRole("button", { name: "Kalender", exact: true }).click();
    // Use calendar cells for the current month; each drag carries the date actually grabbed.
    const current = (await f.read()).rows.find((r: any) => r.id === f.a.id),
      now = new Date(),
      month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    await f.command({
      action: "row.update",
      pageId: f.source.id,
      rowId: f.a.id,
      version: current.version,
      cells: { start: `${month}-10`, end: `${month}-12` },
    });
    await expect(
      page.locator(".calendar-event").filter({ hasText: "Plan" }),
    ).toHaveCount(3, { timeout: 15000 });
    const source = page
        .locator(".calendar-day")
        .filter({ has: page.getByRole("button", { name: "11", exact: true }) })
        .locator(".calendar-event"),
      target = page
        .locator(".calendar-day")
        .filter({ has: page.getByRole("button", { name: "14", exact: true }) });
    if (info.project.name === "mobile") return;
    await source.dragTo(target);
    await expect
      .poll(
        async () =>
          (await f.read()).rows.find((r: any) => r.id === f.a.id).cells,
      )
      .toMatchObject({ start: `${month}-13`, end: `${month}-15` });
  } finally {
    test.setTimeout(90_000);
    await f.cleanup();
  }
});
