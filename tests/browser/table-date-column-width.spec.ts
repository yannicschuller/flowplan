import { test, expect, type Page } from "@playwright/test";

// #523: a date property's column in a table was wider than it needed and
// could not be dragged narrower. It now goes down to the same 80 px as any
// column (the date, its time and icons cut off with an ellipsis), and a date
// column without a saved width starts as wide as its format needs.
test.use({ timezoneId: "UTC" });

async function setup(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Fällig", type: "date" },
      { id: "day", name: "Tag", type: "date", noTime: true },
      { id: "iso", name: "Iso", type: "date", noTime: true, format: "iso" },
      { id: "note", name: "Notiz", type: "text" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Mit Zeit", due: "2026-09-24T14:05:00Z", day: "2026-09-24", iso: "2026-09-24", note: "x" } });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Ganztags", due: "2026-09-24", day: "2026-09-24", iso: "2026-09-24" } });
  return { db, read, command };
}

const headerWidth = (page: Page, id: string) =>
  page.locator(`.data-table thead th[data-field-id="${id}"]`).evaluate((th) => Math.round(th.getBoundingClientRect().width));
const cellWidths = (page: Page, index: number) =>
  page.locator(".data-table tbody tr").evaluateAll(
    (rows, index) => rows.map((row) => Math.round((row.children[index] as HTMLElement | undefined)?.getBoundingClientRect().width ?? -1)),
    index,
  );

test("a date column starts as wide as its format and can be dragged to 80 px", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "dragging with a mouse");
  test.setTimeout(120_000);
  const { db, read, command } = await setup(page, `Datumsspalte ${Date.now()}`);
  await page.goto(`/#page=${db.id}`);
  const table = page.locator(".data-table");
  await expect(table.locator("tbody tr")).toHaveCount(2, { timeout: 30_000 });

  // Default widths: below 180 for every date format, the others unchanged.
  const due = await headerWidth(page, "due");
  const day = await headerWidth(page, "day");
  const iso = await headerWidth(page, "iso");
  expect(due).toBeLessThan(180);
  expect(day).toBeLessThan(due);
  expect(iso).toBeLessThanOrEqual(day);
  expect(await headerWidth(page, "note")).toBe(180);
  expect(await headerWidth(page, "title")).toBe(280);
  // The default width fits the date: nothing is cut off in the all-day cells.
  for (const id of ["day", "iso"]) {
    const clipped = await table.locator(`tbody td:nth-child(${id === "day" ? 4 : 5}) .date-cell`).evaluateAll((spans) =>
      spans.map((s) => s.scrollWidth > s.clientWidth + 1 || s.getBoundingClientRect().right > s.closest("td")!.getBoundingClientRect().right + 1),
    );
    expect(clipped, id).toEqual([false, false]);
  }
  // With time: the date and time show in full; only the time zone after
  // them may be cut off.
  const timed = await table.locator("tbody tr").first().locator("td:nth-child(3) .date-cell-text").evaluate((span) => {
    const node = span.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent!.indexOf(" ("));
    return { text: range.toString(), needed: range.getBoundingClientRect().width, shown: span.getBoundingClientRect().width };
  });
  expect(timed.text).toBe("24. Sept. 2026, 14:05");
  expect(timed.shown).toBeGreaterThan(timed.needed);

  // Drag the timed date column well below 120 px.
  const handle = page.getByRole("separator", { name: "Fällig: Spaltenbreite" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - (due - 90), box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => headerWidth(page, "due")).toBe(90);
  expect(await cellWidths(page, 2)).toEqual([90, 90]);
  // The date is cut off with an ellipsis inside the cell, not beyond it.
  const overflow = await table.locator("tbody td:nth-child(3)").evaluateAll((cells) =>
    cells.map((td) => {
      const span = td.querySelector(".date-cell")!;
      const text = span.querySelector(".date-cell-text")!;
      return {
        inside: span.getBoundingClientRect().right <= td.getBoundingClientRect().right + 0.5,
        ellipsis: getComputedStyle(text).textOverflow,
        cut: text.scrollWidth > text.clientWidth,
      };
    }),
  );
  expect(overflow).toEqual([
    { inside: true, ellipsis: "ellipsis", cut: true },
    { inside: true, ellipsis: "ellipsis", cut: true },
  ]);
  await expect.poll(async () => (await read()).database.views[0].columnWidths?.due, { timeout: 15_000 }).toBe(90);

  // Down to the minimum of 80 px, like any column.
  const box2 = (await handle.boundingBox())!;
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x - 100, box2.y + box2.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => headerWidth(page, "due")).toBe(80);
  await expect.poll(async () => (await read()).database.views[0].columnWidths?.due, { timeout: 15_000 }).toBe(80);

  // After a reload the saved width stays.
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(2, { timeout: 30_000 });
  expect(await headerWidth(page, "due")).toBe(80);
  expect(await cellWidths(page, 2)).toEqual([80, 80]);
  await page.screenshot({ path: "test-results/table-date-column-width.png" });
  await page.goto("/#home");
  await command({ action: "page.delete", pageId: db.id });
});
