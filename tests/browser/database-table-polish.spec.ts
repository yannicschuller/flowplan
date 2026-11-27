import { test, expect } from "@playwright/test";

// #606: the table's footer and headers. No "0 Einträge" above the empty
// state, "Neue Zeile" and "Berechnen" light up only as wide as their label,
// the footer rows (which do nothing) do not light up on hover, the type
// icon sits close to the column's name, and the record's versions clock
// close to the { } placeholder button.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

test("#606: table footer, headers and the record's content heading", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "hover and widths with a mouse");
  test.setTimeout(120_000);
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = (await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Tabelle 606 ${Date.now()}`,
    kind: "database",
    databaseKind: "empty",
  })) as { id: string };
  await page.goto(`/#page=${db.id}`);
  const skip = page.getByRole("dialog").getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  const table = page.locator(".data-table");
  await expect(table).toBeVisible({ timeout: 30_000 });

  // Empty: the empty state says it, no count above it.
  await expect(page.getByRole("heading", { name: "Keine Einträge" })).toBeVisible();
  await expect(table.locator(".record-count")).toHaveCount(0);

  await command({ action: "row.create", pageId: db.id, cells: {} });
  await expect(table.locator(".record-count")).toHaveText("1 Einträge");

  // "Neue Zeile": the hover is the label's width, the click target a full row high.
  const newRow = table.getByRole("button", { name: "Neue Zeile" });
  const footCell = table.locator("tfoot tr").first().locator("td");
  const button = (await newRow.boundingBox())!;
  expect(button.width).toBeLessThan((await footCell.boundingBox())!.width / 2);
  expect(button.height).toBeGreaterThanOrEqual(32);
  const calculate = table.getByRole("button", { name: /: Berechnen$/ }).first();
  const calcBox = (await calculate.boundingBox())!;
  const calcCell = (await calculate.locator("xpath=..").boundingBox())!;
  expect(calcBox.width).toBeLessThan(calcCell.width);
  expect(calcBox.height).toBeGreaterThanOrEqual(24);

  // The footer does not light up beside the button.
  const background = () => footCell.evaluate((el) => getComputedStyle(el).backgroundColor);
  const still = await background();
  await page.mouse.move(button.x + button.width + 200, button.y + button.height + 12);
  await page.waitForTimeout(150);
  expect(await background()).toBe(still);
  // Body rows still do.
  const bodyCell = table.locator("tbody tr[data-row-id] td").nth(1);
  const before = await bodyCell.evaluate((el) => getComputedStyle(el).backgroundColor);
  await bodyCell.hover();
  await expect.poll(() => bodyCell.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);

  // A column header: icon and name 5 px apart.
  const header = table.locator("thead th[data-field-id] button").first();
  const gap = await header.evaluate((el) => {
    const icon = el.querySelector(".property-type")!.getBoundingClientRect();
    const range = document.createRange();
    const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!;
    range.selectNodeContents(text);
    return range.getBoundingClientRect().left - icon.right;
  });
  expect(gap).toBeLessThanOrEqual(6);

  // The record's content heading: versions and placeholders side by side.
  await table.locator("tbody tr[data-row-id]").first().getByRole("button", { name: /^Eintrag öffnen/ }).click();
  const record = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Inhalt" }) });
  const clock = record.getByRole("button", { name: "Datensatz-Versionen" });
  const braces = record.locator(".placeholder-menu-button");
  await expect(braces).toBeVisible();
  const a = (await clock.boundingBox())!;
  const b = (await braces.boundingBox())!;
  expect(b.x - (a.x + a.width)).toBeLessThanOrEqual(4);
  await page.screenshot({ path: info.outputPath("record-heading.png") });
});
