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
  // A single paragraph comes back; the editor gets it live.
  await diff.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect.poll(html, { timeout: 15000 }).toContain("Der Hund bellt laut");
  await expect(changes.getByText(/1 Absatz\/Absätze wiederhergestellt/)).toBeVisible();
  await changes.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(editor).toContainText("Der Hund bellt laut");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});

test("record versions show changes and compare two saved versions", async ({
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
    title: `Eintragsverlauf ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Notiz" },
  });
  const html = async () =>
    (await (await page.request.get(`/api/pages/${p.id}/rows/${row.id}`)).json())
      .html;
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const doc = entry.locator(".tiptap");
  await doc.click();
  await page.keyboard.type("erste Fassung");
  await expect.poll(html, { timeout: 15000 }).toContain("erste Fassung");
  // The first edit may also create an automatic version; count relatively.
  const saved = async () =>
    (await (await page.request.get(`/api/pages/${p.id}/rows/${row.id}`)).json())
      .snapshots.length as number;
  const save = async () => {
    const before = await saved();
    await entry.getByTitle("Datensatz-Versionen").click();
    const dialog = page.getByRole("dialog", { name: "Datensatz-Versionen" });
    await dialog
      .getByRole("button", { name: "Aktuelle Version sichern" })
      .click();
    await expect.poll(saved).toBe(before + 1);
    await expect(dialog.locator(".utility-row")).toHaveCount(before + 1);
    return dialog;
  };
  let versions = await save();
  await versions
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await doc.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ergänzt");
  await expect.poll(html, { timeout: 15000 }).toContain("ergänzt");
  versions = await save();
  // Newest first: the second entry is the version saved before the addition.
  await versions
    .locator(".utility-row")
    .nth(1)
    .getByRole("button", { name: "Änderungen" })
    .click();
  const changes = page.getByRole("dialog", { name: /^Änderungen seit/ });
  await expect(
    changes.getByLabel("Textänderungen").locator("ins"),
  ).toContainText(["ergänzt"]);
  await changes.getByLabel("Vergleichen mit").selectOption({ index: 1 });
  await expect(
    changes.getByLabel("Textänderungen").locator("ins"),
  ).toContainText(["ergänzt"]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
