import { test, expect } from "@playwright/test";

test("version history marks manual versions and shows word-level changes since a version", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Verlauf ${testInfo.project.name} ${Date.now()}`,
  });
  const html = async () =>
    (await (await page.request.get(`/api/pages/${p.id}`)).json()).html;
  await page.goto(`/#page=${p.id}`);
  const editor = page.locator(".tiptap");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("Der Hund bellt laut");
  await expect.poll(html, { timeout: 15000 }).toContain("bellt");
  const openHistory = async () => {
    await page.getByRole("button", { name: "Seitenaktionen" }).click();
    await page.getByRole("menuitem", { name: "Versionsverlauf" }).click();
    return page.getByRole("dialog", { name: "Versionsverlauf" });
  };
  let history = await openHistory();
  await history
    .getByRole("button", { name: "Aktuelle Version sichern" })
    .click();
  await expect(history.getByText("Manuell gesichert").first()).toBeVisible();
  await history.getByRole("button", { name: "Schließen", exact: true }).click();

  await editor.click();
  await page.keyboard.press("End");
  for (let i = 0; i < " laut".length; i++)
    await page.keyboard.press("Backspace");
  for (let i = 0; i < "bellt".length; i++)
    await page.keyboard.press("Backspace");
  await page.keyboard.type("schläft tief");
  await expect.poll(html, { timeout: 15000 }).toContain("schläft tief");

  history = await openHistory();
  const manual = history
    .locator(".utility-row")
    .filter({ hasText: "Manuell gesichert" })
    .first();
  await manual.getByRole("button", { name: "Änderungen" }).click();
  const changes = page.getByRole("dialog", { name: /^Änderungen seit/ });
  const diff = changes.getByLabel("Textänderungen");
  await expect(diff.locator("del")).toContainText(["bellt"]);
  await expect(diff.locator("ins")).toContainText(["schläft"]);
  await page.screenshot({
    path: `test-results/version-history-verification/${testInfo.project.name}-diff.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
