import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function tablePage(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator("table")).toBeVisible({ timeout: 30_000 });
  return { editor, host, command };
}
const TABLE =
  "<table><tbody>" +
  "<tr><th><p>Aufgabe</p></th><th><p>Wer</p></th><th><p>Wann</p></th></tr>" +
  "<tr><td><p>Planen</p></td><td><p>Anna</p></td><td><p>Mo</p></td></tr>" +
  "<tr><td><p>Bauen</p></td><td><p>Ben</p></td><td><p>Di</p></td></tr>" +
  "<tr><td><p>Prüfen</p></td><td><p>Cem</p></td><td><p>Mi</p></td></tr>" +
  "</tbody></table><p>Danach kommt Text.</p>";
const texts = (page: Page) => page.getByLabel("Dokumentinhalt", { exact: true }).locator("table tr").evaluateAll((rows) => rows.map((r) => [...(r as HTMLTableRowElement).cells].map((c) => c.textContent?.trim()).join(" ")));
const column = (page: Page) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).locator("table tr").evaluateAll((rows) => rows.map((r) => (r as HTMLTableRowElement).cells[0]?.textContent));

// #240: compact rows, handles for rows and columns with menus, dragging,
// "+" bars – and nothing over the next block.
test("table rows and columns: handles, menus, colours, dragging, + bars", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointing with a mouse");
  test.setTimeout(150_000);
  const { editor } = await tablePage(page, "Tabellengriffe", TABLE);
  const cell = (text: string) => editor.locator("td, th", { hasText: text });

  // Compact like Notion: rows of about 35 px, header left-aligned, only as wide as needed.
  const rowHeight = await editor.locator("table tr").nth(1).evaluate((r) => r.getBoundingClientRect().height);
  expect(rowHeight).toBeGreaterThan(30);
  expect(rowHeight).toBeLessThan(40);
  expect(await cell("Aufgabe").evaluate((c) => getComputedStyle(c).textAlign)).toMatch(/start|left/);
  const widths = await editor.evaluate((e) => ({ table: e.querySelector("table")!.getBoundingClientRect().width, text: e.getBoundingClientRect().width }));
  expect(widths.table).toBeLessThan(widths.text - 50);

  // Pointing at a cell: a handle for its row and one for its column.
  await cell("Ben").hover();
  const rowHandle = page.getByRole("button", { name: "Zeile 3", exact: true });
  const columnHandle = page.getByRole("button", { name: "Spalte 2", exact: true });
  await expect(rowHandle).toBeVisible();
  await expect(columnHandle).toBeVisible();
  const r = (await rowHandle.boundingBox())!,
    c = (await columnHandle.boundingBox())!,
    t = (await editor.locator("table").boundingBox())!,
    benBox = (await cell("Ben").boundingBox())!;
  expect(Math.abs(r.x + r.width / 2 - t.x)).toBeLessThan(4);
  expect(Math.abs(c.y + c.height / 2 - t.y)).toBeLessThan(4);
  expect(Math.abs(c.x + c.width / 2 - (benBox.x + benBox.width / 2))).toBeLessThan(4);
  await page.screenshot({ path: `test-results/table-handles-hover-${info.project.name}.png` });

  // A click selects the row and opens its menu.
  await rowHandle.click();
  const menu = page.getByRole("menu", { name: "Zeile" });
  await expect(menu).toBeVisible();
  await expect(page.locator(".table-selection-outline")).toBeVisible();
  for (const name of ["Farbe", "Zeile darüber einfügen", "Zeile darunter einfügen", "Duplizieren", "Inhalt löschen", "Zeile löschen", "Kopfzeile", "Beschriftung", "In Datenbank umwandeln"])
    await expect(menu.getByRole("menuitem", { name }).or(menu.getByRole("menuitemcheckbox", { name })), name).toHaveCount(1);
  await expect(menu.getByRole("searchbox")).toBeVisible();
  await page.screenshot({ path: `test-results/table-handles-menu-${info.project.name}.png` });

  // Colour: the row's cells get the name, not a value.
  await menu.getByRole("menuitem", { name: "Farbe" }).click();
  await page.getByRole("menuitemradio", { name: "Gelb (Hintergrund)" }).click();
  await expect(cell("Ben")).toHaveAttribute("data-block-color", "yellow-background");
  await expect(cell("Bauen")).toHaveAttribute("data-block-color", "yellow-background");
  await expect(cell("Anna")).not.toHaveAttribute("data-block-color", /./);

  // Duplicate with ⌘D while the row is selected.
  await cell("Ben").hover();
  await page.getByRole("button", { name: "Zeile 3", exact: true }).click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+D");
  await expect.poll(() => texts(page)).toEqual(["Aufgabe Wer Wann", "Planen Anna Mo", "Bauen Ben Di", "Bauen Ben Di", "Prüfen Cem Mi"]);
  // ⌘⇧↑ moves the selected row (the copy) up.
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await expect.poll(() => column(page)).toEqual(["Aufgabe", "Bauen", "Planen", "Bauen", "Prüfen"]);
  // Delete it from its menu.
  await editor.locator("tr").nth(1).locator("td").first().hover();
  await page.getByRole("button", { name: "Zeile 2", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Zeile löschen" }).click();
  await expect.poll(() => column(page)).toEqual(["Aufgabe", "Planen", "Bauen", "Prüfen"]);

  // Dragging the "Prüfen" row's handle above "Planen".
  await cell("Prüfen").hover();
  const handle = page.getByRole("button", { name: "Zeile 4", exact: true });
  const from = (await handle.boundingBox())!;
  const planen = (await cell("Planen").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y - 20, { steps: 4 });
  await page.mouse.move(from.x + from.width / 2, planen.y + 4, { steps: 6 });
  await expect(page.locator(".table-drop-indicator")).toBeVisible();
  await page.screenshot({ path: `test-results/table-handles-drag-${info.project.name}.png` });
  await page.mouse.up();
  await expect.poll(() => column(page)).toEqual(["Aufgabe", "Prüfen", "Planen", "Bauen"]);
  // The header stays the header.
  await expect(editor.locator("tr").first().locator("th")).toHaveCount(3);

  // A column: drag "Wann" to the first place.
  await cell("Wann").hover();
  const colHandle = page.getByRole("button", { name: "Spalte 3", exact: true });
  const cfrom = (await colHandle.boundingBox())!;
  const first = (await cell("Aufgabe").boundingBox())!;
  await page.mouse.move(cfrom.x + cfrom.width / 2, cfrom.y + cfrom.height / 2);
  await page.mouse.down();
  await page.mouse.move(cfrom.x - 30, cfrom.y + cfrom.height / 2, { steps: 4 });
  await page.mouse.move(first.x + 4, cfrom.y + cfrom.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => column(page)).toEqual(["Wann", "Mi", "Mo", "Di"]);

  // "+" bars at the bottom and the right add a row and a column.
  await cell("Mo").hover();
  const addRow = page.getByRole("button", { name: "Zeile hinzufügen" });
  const addColumn = page.getByRole("button", { name: "Spalte hinzufügen" });
  await expect(addRow).toBeVisible();
  await expect(addColumn).toBeVisible();
  // Nothing of it lies over the text after the table.
  const after = (await editor.locator("p", { hasText: "Danach kommt Text." }).boundingBox())!;
  for (const control of [addRow, addColumn, page.locator(".table-handle").first()]) {
    const box = (await control.boundingBox())!;
    expect(box.y + box.height, "over the next block").toBeLessThanOrEqual(after.y + 1);
  }
  await addRow.click();
  await expect(editor.locator("table tr")).toHaveCount(5);
  await cell("Mo").hover();
  await addColumn.click();
  await expect(editor.locator("table tr").first().locator("th")).toHaveCount(4);
  // No old toolbar under the table.
  await expect(page.getByRole("toolbar", { name: "Tabelle", exact: true })).toHaveCount(0);
});

// A block of cells selected by dragging: clearly marked, with its own menu.
test("a block of selected cells gets a colour from its corner button", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "dragging with a mouse");
  test.setTimeout(120_000);
  const { editor } = await tablePage(page, "Zellen färben", TABLE);
  const a = (await editor.locator("td", { hasText: "Anna" }).boundingBox())!;
  const b = (await editor.locator("td", { hasText: "Di" }).boundingBox())!;
  await page.mouse.move(a.x + 10, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(editor.locator(".selectedCell")).toHaveCount(4);
  const button = page.getByRole("button", { name: "Zellenoptionen" });
  await expect(button).toBeVisible();
  await button.click();
  const menu = page.getByRole("menu", { name: "Zellen" });
  await menu.getByRole("menuitem", { name: "Farbe" }).click();
  await page.getByRole("menuitemradio", { name: "Rot", exact: true }).click();
  for (const text of ["Anna", "Mo", "Ben", "Di"]) await expect(editor.locator("td", { hasText: text })).toHaveAttribute("data-block-color", "red");
  await expect(editor.locator("td", { hasText: "Planen" })).not.toHaveAttribute("data-block-color", /./);
});

// Touch: a tap into a cell shows its handles; the menu is a sheet.
test("on a phone a tap into a cell shows the handles and the + bars", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phone only");
  test.setTimeout(120_000);
  const { editor } = await tablePage(page, "Tabelle Handy", TABLE);
  await editor.locator("td", { hasText: "Ben" }).tap();
  const rowHandle = page.getByRole("button", { name: "Zeile 3", exact: true });
  await expect(rowHandle).toBeVisible();
  await expect(page.getByRole("button", { name: "Zeile hinzufügen" })).toBeVisible();
  await page.screenshot({ path: `test-results/table-handles-touch-${info.project.name}.png` });
  await rowHandle.tap();
  const sheet = page.locator(".block-menu-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("menuitem", { name: "Zeile darunter einfügen" }).tap();
  await expect(editor.locator("table tr")).toHaveCount(5);
});
