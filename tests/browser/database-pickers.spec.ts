import { test, expect } from "@playwright/test";

// Databases of the same title in two spaces (#520): the relation's
// "Verknüpfte Datenbank" groups them by space, the chosen one names its
// space, and "Verschieben nach …" shows the space below each title.
test("same-named databases in two spaces are told apart in the pickers", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Right-click is a desktop action.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const stamp = Date.now();
  const home = boot.spaces[0] as { id: string; name: string };
  const family = `Familie ${stamp}`;
  const familyId = (await command({ action: "space.create", workspaceId: boot.workspace.id, name: family, private: false })).id as string;
  const create = (spaceId: string, title: string) => command({ action: "page.create", workspaceId: boot.workspace.id, spaceId, title, kind: "database" });
  const source = await create(home.id, `Projekte ${stamp}`);
  const mine = await create(home.id, `Notes ${stamp}`);
  const theirs = await create(familyId, `Notes ${stamp}`);
  await command({ action: "row.create", pageId: source.id, cells: { title: "Umzug" } });

  await page.goto(`/#page=${source.id}`);
  await page.getByRole("button", { name: "Eigenschaft hinzufügen", exact: true }).click();
  const property = page.getByRole("dialog", { name: "Eigenschaft hinzufügen", exact: true });
  await property.getByLabel("Eigenschaftsname", { exact: true }).fill("Notizen");
  await property.getByLabel("Eigenschaftstyp", { exact: true }).selectOption("relation");
  const linked = property.getByLabel("Verknüpfte Datenbank", { exact: true });
  const groupOf = (id: string) =>
    linked.evaluate((el, value) => {
      const option = [...(el as HTMLSelectElement).options].find((o) => o.value === value);
      return { group: option?.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : null, text: option?.textContent };
    }, id);
  expect(await groupOf(mine.id)).toEqual({ group: home.name, text: `Notes ${stamp}` });
  expect(await groupOf(theirs.id)).toEqual({ group: family, text: `Notes ${stamp}` });
  // The list shows both groups.
  await linked.locator("xpath=..").click();
  const list = page.locator(".fp-select-list");
  await expect(list.locator(".fp-select-group", { hasText: family })).toBeVisible();
  await expect(list).toHaveCSS("opacity", "1");
  await page.screenshot({ path: `test-results/${info.project.name}-relation-picker-520.png` });
  // Chosen from the second group: the closed select names the space.
  await list.locator(".fp-select-option", { hasText: `Notes ${stamp}` }).nth(1).click();
  await expect(linked).toHaveValue(theirs.id);
  expect((await groupOf(theirs.id)).text).toBe(`Notes ${stamp} · ${family}`);
  await expect(linked.locator("xpath=..").locator(".fp-select-value")).toHaveText(`Notes ${stamp} · ${family}`);
  await page.keyboard.press("Escape");
  await expect(property).not.toBeVisible();

  // "Verschieben nach …": the space below each title, sorted by space.
  await page.locator("tr", { hasText: "Umzug" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Verschieben nach …" }).click();
  const dialog = page.getByRole("dialog");
  const targets = dialog.locator(".transfer-target", { hasText: `Notes ${stamp}` });
  await expect(targets).toHaveCount(2);
  await expect(targets.nth(0).locator("small")).toHaveText(home.name);
  await expect(targets.nth(1).locator("small")).toHaveText(family);
  await page.screenshot({ path: `test-results/${info.project.name}-move-to-database-520.png` });
  await targets.nth(1).getByRole("radio").check();
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(page.getByText(`nach „Notes ${stamp} · ${family}“ verschoben`)).toBeVisible();
  expect(errors).toEqual([]);
});
