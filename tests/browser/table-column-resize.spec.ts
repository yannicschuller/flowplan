import { test, expect, type Page, type Locator } from "@playwright/test";

// #258: pointing at a column border of a document table made every row about
// 6 px taller (and smaller again on leaving). prosemirror-tables' column
// resizing puts a <div class="column-resize-handle"> at the end of every cell
// of that column; without a style of its own it was a block in the cell's
// flow and got the gap between a cell's blocks. Now it is the visible line on
// the border, the editor shows the col-resize cursor, and dragging the
// border still changes the column's width – in documents and in records.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const TABLE =
  "<p>Vorher</p><table><tbody>" +
  "<tr><th><p>Aufgabe</p></th><th><p>Wer</p></th><th><p>Wann</p></th></tr>" +
  "<tr><td><p>Planen</p></td><td><p>Anna</p></td><td><p>Mo</p></td></tr>" +
  "<tr><td><p>Bauen</p></td><td><p>Ben</p></td><td><p>Di</p></td></tr>" +
  "</tbody></table><p>Danach kommt Text.</p>";

async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  return { command, boot };
}

const rowHeights = (table: Locator) => table.locator("tr").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
const tableBox = (table: Locator) => table.evaluate((t) => JSON.stringify(t.getBoundingClientRect()));

// Points at the border between the first and second column, checks the
// layout and the line, and drags the border 80 px to the right.
async function hoverAndResize(page: Page, editor: Locator, label: string) {
  const table = editor.locator("table").first();
  const first = table.locator("tr").nth(1).locator("td, th").first();
  const heights = await rowHeights(table);
  const before = await tableBox(table);
  const box = (await first.boundingBox())!;
  const width = box.width;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 4 });

  const handles = table.locator(".column-resize-handle");
  await expect(handles.first(), label).toBeAttached();
  await expect(handles).toHaveCount(await table.locator("tr").count());
  // Nothing moved: the rows and the table keep their size.
  expect(await rowHeights(table), label).toEqual(heights);
  expect(await tableBox(table), label).toBe(before);
  // The line: on the border, as tall as the cell, in the accent colour.
  const line = (await handles.nth(1).boundingBox())!;
  expect(line.width, label).toBeGreaterThanOrEqual(3);
  expect(Math.abs(line.x + line.width / 2 - (box.x + box.width)), label).toBeLessThanOrEqual(2);
  expect(line.height, label).toBeGreaterThanOrEqual(box.height - 1);
  const style = await handles.first().evaluate((h) => {
    const s = getComputedStyle(h);
    return { position: s.position, background: s.backgroundColor, pointer: s.pointerEvents };
  });
  expect(style.position).toBe("absolute");
  expect(style.pointer).toBe("none");
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(await editor.evaluate((e) => getComputedStyle(e).cursor), label).toBe("col-resize");
  // The page around does not move either (the text below the table).
  await page.screenshot({ path: `test-results/table-column-resize-${label}.png` });

  // Away from the border: the line goes, the rows stay as they are.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await expect(handles).toHaveCount(0);
  expect(await rowHeights(table), label).toEqual(heights);

  // Dragging the border still resizes the column.
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 4 });
  await expect(handles.first()).toBeAttached();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await first.boundingBox())!.width, label).toBeGreaterThan(width + 60);
}

test("pointing at a column border changes no row, shows the resize line; dragging resizes (document, dark)", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointing with a mouse");
  const { command, boot } = await signIn(page);
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Spaltenbreite ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(TABLE)).toString("base64") });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/#page=${host.id}`);
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor.locator("table")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("article[data-revalidating]")).toHaveCount(0);
    await hoverAndResize(page, editor, `document-${scheme}`);
    if (scheme === "light") await page.goto("/#home");
  }
  await page.goto("/#home");
  await command({ action: "page.delete", pageId: host.id });
});

test("the same in a record's text", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointing with a mouse");
  const { command, boot } = await signIn(page);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einträge ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Mit Tabelle" } });
  await page.goto(`/#page=${db.id}&row=${row.id}&full=1`);
  const record = page.locator(".record-page");
  await expect(record).toBeVisible({ timeout: 30_000 });
  const editor = record.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("/Tabelle");
  await page.keyboard.press("Enter");
  await expect(editor.locator("table")).toBeVisible();
  await editor.locator("table tr").nth(1).locator("td").first().click();
  await page.keyboard.type("Planen");
  await hoverAndResize(page, editor, "record");
  await page.goto("/#home");
  await command({ action: "page.delete", pageId: db.id });
});
